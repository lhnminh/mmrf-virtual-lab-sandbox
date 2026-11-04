import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeGraphClient, createKnowledgeGraphTool, knowledgeGraphRegistrations, KNOWLEDGE_GRAPH_TOOL_SPECS, modelView } from '../src/knowledge-graph.mjs';
import { createToolCatalog, toolCatalog, WEBSITE_APPS } from '../src/tool-catalog.mjs';
import { createStrandsRunner } from '../src/strands-runner.mjs';

const url = 'https://mmrf-kg-gateway-abc.gateway.bedrock-agentcore.us-west-2.amazonaws.com/mcp';
const credentials = async () => ({ accessKeyId: 'AKID', secretAccessKey: 'secret' });
const envelope = { contract_version: '0.2', summary: '1 entity matches', observations: [], interpretation: [],
  graph: { nodes: [{ id: 'MONDO:0009693' }], edges: [] }, evidence: [], query: { text: 'MATCH (n)' }, limitations: ['partial'],
  trace: { request_id: 'x' } };
const reply = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result }));

test('client signs an MCP tool call and returns the envelope', async () => {
  const calls = [];
  const callTool = createKnowledgeGraphClient({ url, credentials, fetchImpl: async (target, init) => {
    calls.push({ target, init });
    return reply({ isError: false, content: [{ type: 'text', text: JSON.stringify(envelope) }] });
  } });
  assert.deepEqual(await callTool('kg_search_entities', { text: 'myeloma' }), envelope);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.method, 'tools/call');
  assert.deepEqual(body.params, { name: 'kg-graph___kg_search_entities', arguments: { text: 'myeloma' } });
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-west-2\/bedrock-agentcore\/aws4_request/);
});

test('client rejects non-gateway URLs and reports gateway and tool failures', async () => {
  assert.throws(() => createKnowledgeGraphClient({ url: 'https://example.com/mcp', credentials }));
  assert.throws(() => createKnowledgeGraphClient({ url: url.replace('https', 'http'), credentials }));
  const failing = fetchImpl => createKnowledgeGraphClient({ url, credentials, fetchImpl })('kg_get_evidence', {});
  await assert.rejects(failing(async () => new Response('', { status: 403 })), /HTTP 403/);
  await assert.rejects(failing(async () => new Response(JSON.stringify({ error: { message: 'bad' } }))), /bad/);
  await assert.rejects(failing(async () => reply({ isError: true, content: [{ type: 'text', text: 'no such edge' }] })), /no such edge/);
  await assert.rejects(failing(async () => reply({ content: [{ type: 'text', text: '{}' }] })), /invalid result/);
});

test('the model gets findings without query or trace, and large results are bounded', () => {
  const view = modelView(envelope);
  assert.deepEqual(view.graph.nodes[0], { id: 'MONDO:0009693' });
  assert.equal(view.query, undefined);
  assert.equal(view.trace, undefined);
  const large = modelView({ ...envelope, evidence: ['x'.repeat(30000)] });
  assert.ok(JSON.stringify(large).length < 21000);
  assert.deepEqual(large.limitations, ['partial']);
  assert.match(large.truncated, /too large/);
});

test('a tool records its call for the UI and returns the model view', async () => {
  const calls = [];
  const tool = createKnowledgeGraphTool({ spec: KNOWLEDGE_GRAPH_TOOL_SPECS[0], toolFactory: value => value, calls,
    callTool: async () => envelope });
  const view = await tool.callback({ text: 'myeloma' });
  assert.equal(view.summary, '1 entity matches');
  assert.equal(calls[0].status, 'success');
  assert.deepEqual(calls[0].result, { summary: '1 entity matches', plot: { type: 'knowledge-graph', ...envelope } });
  const failed = createKnowledgeGraphTool({ spec: KNOWLEDGE_GRAPH_TOOL_SPECS[0], toolFactory: value => value, calls,
    callTool: async () => { throw new Error('down'); } });
  await assert.rejects(failed.callback({}), /down/);
  assert.equal(calls[1].status, 'error');
});

test('the four named tools register when enabled, and are absent by default', () => {
  assert.deepEqual(KNOWLEDGE_GRAPH_TOOL_SPECS.map(spec => spec.name).sort(),
    ['kg_get_evidence', 'kg_get_mechanism_paths', 'kg_get_phenotypes', 'kg_search_entities']);
  assert.equal(toolCatalog.list().some(app => app.id === 'KnowledgeGraph'), false);
  const catalog = createToolCatalog({ apps: [...WEBSITE_APPS, { id: 'KnowledgeGraph', title: 'KG', section: 'Knowledge' }],
    registrations: knowledgeGraphRegistrations({ callTool: async () => envelope }) });
  assert.equal(catalog.list({ query: 'kg_get' }).length, 1);
  assert.equal(catalog.createTools({ toolFactory: value => value, calls: [] }).length, 4);
});

test('the system prompt separates knowledge graph findings from synthetic data only when enabled', async () => {
  const prompts = [];
  const loadSdk = async () => ({ tool: value => value, Agent: class {
    constructor(options) { prompts.push(options.systemPrompt); }
    async invoke() { return { lastMessage: 'ok' }; }
  } });
  const limits = [];
  const loadBedrock = async () => ({ BedrockModel: class { constructor(options) { limits.push(options.maxTokens); } } });
  await createStrandsRunner({ execute: async () => {}, loadSdk, loadBedrock, knowledgeGraph: true })({ prompt: 'hi' });
  await createStrandsRunner({ execute: async () => {}, loadSdk, loadBedrock, knowledgeGraph: false })({ prompt: 'hi' });
  assert.match(prompts[0], /never present knowledge graph findings as results about the synthetic cohort/);
  assert.doesNotMatch(prompts[1], /knowledge graph/);
  assert.deepEqual(limits, [4096, 1024]);
});
