// Read-only tools on the sister team's knowledge graph gateway. Active only when
// KG_GATEWAY_URL is set. Their tools return the "AD-004 envelope".
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';

const SERVICE = 'bedrock-agentcore';
const TARGET = 'kg-graph';
const TIMEOUT_MS = 60000;
const MAX_MODEL_CHARS = 20000;
const MCP_PROTOCOL_VERSION = '2025-06-18'; // The only version the gateway accepts.

export const KNOWLEDGE_GRAPH_APP = Object.freeze({ id: 'KnowledgeGraph', title: 'Knowledge Graph', section: 'Knowledge' });

export const KNOWLEDGE_GRAPH_PROMPT = `You can also query a multiple myeloma knowledge graph (DisMech mechanism paths and Monarch associations) with the kg_ tools.
Use the available gateway tools and their descriptions for questions about disease mechanisms, phenotypes, and published evidence. Follow their input schemas and resolve identifiers with an available search tool when needed.
Report observations as recorded facts, interpretation as added explanation, and always state the limitations. Cite identifiers such as PMIDs exactly as returned. Use only what the tools return; do not fill gaps from memory.
Knowledge graph results come from curated published sources, not from this sandbox's synthetic cases. The statement that all sandbox data are synthetic applies only to the cohort data. Say which source each finding comes from, and never present knowledge graph findings as results about the synthetic cohort. Keep answers concise: a short summary, the key findings with citations, and the limitations. Do not give clinical advice.`;

class Sha256 {
  constructor(secret) { this.hash = secret ? createHmac('sha256', secret) : createHash('sha256'); }
  update(value) { this.hash.update(value); }
  digest() { return Promise.resolve(this.hash.digest()); }
}

function gatewayRegion(url) {
  const match = /\.gateway\.bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com$/.exec(url.hostname);
  if (url.protocol !== 'https:' || !match) throw new Error('KG_GATEWAY_URL must be an AgentCore Gateway HTTPS URL');
  return match[1];
}

export function createKnowledgeGraphClient({ url = process.env.KG_GATEWAY_URL, credentials = defaultProvider(),
  fetchImpl = fetch } = {}) {
  const endpoint = new URL(url);
  const signer = new SignatureV4({ credentials, region: gatewayRegion(endpoint), service: SERVICE, sha256: Sha256 });
  async function request(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
    const signed = await signer.sign({
      method: 'POST', protocol: endpoint.protocol, hostname: endpoint.hostname, path: endpoint.pathname, body,
      headers: { accept: 'application/json', 'content-type': 'application/json', host: endpoint.host,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION },
    });
    const response = await fetchImpl(endpoint, { method: 'POST', headers: signed.headers, body,
      signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) throw new Error(`Knowledge graph gateway returned HTTP ${response.status}`);
    const reply = await response.json();
    if (reply.error) throw new Error(`Knowledge graph gateway error: ${reply.error.message}`);
    if (!reply.result || typeof reply.result !== 'object') throw new Error('Knowledge graph gateway returned an invalid response');
    return reply.result;
  }
  async function callTool(name, input) {
    const result = await request('tools/call', { name: `${TARGET}___${name}`, arguments: input });
    const text = result.content?.find(item => item.type === 'text')?.text;
    if (result.isError) throw new Error(text || 'Knowledge graph tool failed');
    const envelope = result.structuredContent ?? (text ? JSON.parse(text) : null);
    if (typeof envelope?.summary !== 'string' || !envelope.summary.trim()) {
      throw new Error('Knowledge graph returned an invalid result');
    }
    return envelope;
  }
  callTool.listTools = async () => {
    const specs = [];
    const names = new Set();
    const cursors = new Set();
    let cursor;
    do {
      const result = await request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw new Error('Knowledge graph gateway returned an invalid tool list');
      for (const tool of result.tools) {
        if (typeof tool.name !== 'string') throw new Error('Gateway tool is missing a name');
        if (!tool.name.startsWith(`${TARGET}___`)) continue;
        const name = tool.name.slice(`${TARGET}___`.length);
        // Preserve the existing exclusion of arbitrary graph queries.
        if (name === 'kg_run_readonly_query') continue;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || names.has(name) || tool.inputSchema?.type !== 'object') {
          throw new Error(`Invalid or duplicate gateway tool: ${name}`);
        }
        names.add(name);
        specs.push({ name, description: tool.description || '', inputSchema: tool.inputSchema });
      }
      cursor = result.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) {
        throw new Error('Knowledge graph gateway returned an invalid pagination cursor');
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return specs;
  };
  return callTool;
}

// The envelope's summary alone can omit ids the model needs for its next call,
// so the model also gets the findings. query and trace stay out of its context.
export function modelView({ summary, observations, interpretation, graph, evidence, limitations }) {
  const view = { summary, observations, interpretation, graph, evidence, limitations };
  const text = JSON.stringify(view);
  if (text.length <= MAX_MODEL_CHARS) return view;
  return { summary, limitations, truncated: 'Result too large; narrow the question or lower the limit.',
    partialResult: text.slice(0, MAX_MODEL_CHARS) };
}

export function createKnowledgeGraphTool({ spec, toolFactory, callTool, calls }) {
  return toolFactory({
    ...spec,
    callback: async (rawInput) => {
      const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
      const call = { name: spec.name, input, status: 'started' };
      calls.push(call);
      try {
        const envelope = await callTool(spec.name, input);
        call.status = 'success';
        call.result = { summary: envelope.summary, plot: { type: 'knowledge-graph', ...envelope } };
        return modelView(envelope);
      } catch (error) {
        call.status = 'error';
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  });
}

export async function knowledgeGraphRegistrations({ callTool = createKnowledgeGraphClient() } = {}) {
  const specs = await callTool.listTools();
  return specs.map(spec => ({
    appId: KNOWLEDGE_GRAPH_APP.id,
    spec,
    create: ({ toolFactory, calls }) => createKnowledgeGraphTool({ spec, toolFactory, callTool, calls }),
  }));
}
