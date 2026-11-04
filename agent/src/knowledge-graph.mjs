// Read-only tools on the sister team's knowledge graph gateway. Active only when
// KG_GATEWAY_URL is set. Their tools return the "AD-004 envelope".
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';

const SERVICE = 'bedrock-agentcore';
const TARGET = 'kg-graph';
const TIMEOUT_MS = 60000;
const MAX_MODEL_CHARS = 20000;

export const KNOWLEDGE_GRAPH_APP = Object.freeze({ id: 'KnowledgeGraph', title: 'Knowledge Graph', section: 'Knowledge' });

// Copied from the gateway target. kg_run_readonly_query is left out on purpose.
export const KNOWLEDGE_GRAPH_TOOL_SPECS = Object.freeze([
  {"name": "kg_search_entities", "description": "Find diseases, phenotypes and mechanisms in the knowledge graph by name or exact id. Use first to resolve a plain-language term to a graph id.", "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "description": "Maximum entities to return, 1-200 (default 20)"}, "text": {"type": "string", "description": "Name fragment (case-insensitive), or an exact id such as MONDO:0009693 or HP:0000938"}}, "required": ["text"]}},
  {"name": "kg_get_phenotypes", "description": "Phenotypes recorded for a disease (Monarch has_phenotype associations), with their knowledge sources and publications.", "inputSchema": {"type": "object", "properties": {"disease_id": {"type": "string", "description": "MONDO identifier of the disease, e.g. MONDO:0009693"}, "limit": {"type": "integer", "description": "Maximum associations to return, 1-200 (default 50)"}}, "required": ["disease_id"]}},
  {"name": "kg_get_mechanism_paths", "description": "DisMech pathophysiology mechanisms for a disease and the causal leads_to edges between them, with the cited evidence for each edge.", "inputSchema": {"type": "object", "properties": {"disease_id": {"type": "string", "description": "MONDO identifier of the disease, e.g. MONDO:0009693"}}, "required": ["disease_id"]}},
  {"name": "kg_get_evidence", "description": "Evidence for one edge (by the edge id returned in graph.edges[].id), or every edge that cites a reference such as PMID:34201396. Pass exactly one of edge_id or reference.", "inputSchema": {"type": "object", "properties": {"reference": {"type": "string", "description": "Citation or knowledge source, e.g. PMID:34201396 or infores:orphanet"}, "edge_id": {"type": "string", "description": "Edge id from a previous result, e.g. dismech:Clonal Plasma Cell Proliferation|leads_to|Bone Marrow Failure"}}}}
]);

export const KNOWLEDGE_GRAPH_PROMPT = `You can also query a multiple myeloma knowledge graph (DisMech mechanism paths and Monarch associations) with the kg_ tools.
Use them for questions about disease mechanisms, phenotypes, and published evidence. Call kg_search_entities first to turn a plain-language term into a graph id.
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
  return async function callTool(name, input) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
      params: { name: `${TARGET}___${name}`, arguments: input } });
    const signed = await signer.sign({
      method: 'POST', protocol: endpoint.protocol, hostname: endpoint.hostname, path: endpoint.pathname, body,
      headers: { accept: 'application/json', 'content-type': 'application/json', host: endpoint.host },
    });
    const response = await fetchImpl(endpoint, { method: 'POST', headers: signed.headers, body,
      signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) throw new Error(`Knowledge graph gateway returned HTTP ${response.status}`);
    const reply = await response.json();
    if (reply.error) throw new Error(`Knowledge graph gateway error: ${reply.error.message}`);
    const text = reply.result?.content?.find(item => item.type === 'text')?.text;
    if (reply.result?.isError) throw new Error(text || 'Knowledge graph tool failed');
    const envelope = text ? JSON.parse(text) : null;
    if (typeof envelope?.summary !== 'string' || !envelope.summary.trim()) {
      throw new Error('Knowledge graph returned an invalid result');
    }
    return envelope;
  };
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

export function knowledgeGraphRegistrations({ callTool = createKnowledgeGraphClient() } = {}) {
  return KNOWLEDGE_GRAPH_TOOL_SPECS.map(spec => ({
    appId: KNOWLEDGE_GRAPH_APP.id,
    spec,
    create: ({ toolFactory, calls }) => createKnowledgeGraphTool({ spec, toolFactory, callTool, calls }),
  }));
}
