import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeGraphClient, createKnowledgeGraphTool, knowledgeGraphRegistrations, modelView } from '../src/knowledge-graph.mjs';
import { createToolCatalog, toolCatalog, WEBSITE_APPS } from '../src/tool-catalog.mjs';
import { createStrandsRunner } from '../src/strands-runner.mjs';

const specs = [{ name: 'kg_search_entities', description: 'Search graph entities', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];

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

test('client retries with the protocol version the gateway names, and remembers it', async () => {
  const sent = [];
  const refuse = (requested, supported) => new Response(JSON.stringify({ error: { code: -32600,
    message: `Unsupported protocol version: ${requested}`, data: { requested, supported } } }), { status: 400 });
  let accepted = '2025-06-18';
  const callTool = createKnowledgeGraphClient({ url, credentials, fetchImpl: async (target, init) => {
    const version = init.headers['mcp-protocol-version'];
    sent.push(version);
    if (version !== accepted) return refuse(version ?? '2025-03-26', [accepted]);
    return reply({ isError: false, content: [{ type: 'text', text: JSON.stringify(envelope) }] });
  } });
  await callTool('kg_search_entities', { text: 'a' });
  await callTool('kg_search_entities', { text: 'b' });
  assert.deepEqual(sent, [undefined, '2025-06-18', '2025-06-18']);
  accepted = '2025-03-26'; // The gateway can change version while the agent runs.
  await callTool('kg_search_entities', { text: 'c' });
  assert.deepEqual(sent.slice(3), ['2025-06-18', '2025-03-26']);
});

test('client gives up after one retry, and on a 400 that names no version', async () => {
  let calls = 0;
  const always = createKnowledgeGraphClient({ url, credentials, fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { data: { supported: ['9'] } } }), { status: 400 });
  } });
  await assert.rejects(always('kg_get_evidence', {}), /HTTP 400/);
  assert.equal(calls, 2);
  const plain = createKnowledgeGraphClient({ url, credentials, fetchImpl: async () => new Response('nope', { status: 400 }) });
  await assert.rejects(plain('kg_get_evidence', {}), /HTTP 400/);
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
  const tool = createKnowledgeGraphTool({ spec: specs[0], toolFactory: value => value, calls,
    callTool: async () => envelope });
  const view = await tool.callback({ text: 'myeloma' });
  assert.equal(view.summary, '1 entity matches');
  assert.equal(calls[0].status, 'success');
  assert.deepEqual(calls[0].result, { summary: '1 entity matches', plot: { type: 'knowledge-graph', ...envelope } });
  const failed = createKnowledgeGraphTool({ spec: specs[0], toolFactory: value => value, calls,
    callTool: async () => { throw new Error('down'); } });
  await assert.rejects(failed.callback({}), /down/);
  assert.equal(calls[1].status, 'error');
});

test('discovered tools register when enabled, and are absent by default', async () => {
  assert.equal(toolCatalog.list().some(app => app.id === 'KnowledgeGraph'), false);
  const catalog = createToolCatalog({ apps: [...WEBSITE_APPS, { id: 'KnowledgeGraph', title: 'KG', section: 'Knowledge' }],
    registrations: await knowledgeGraphRegistrations({ callTool: Object.assign(async () => envelope, { listTools: async () => specs }) }) });
  assert.equal(catalog.list({ query: 'kg_search' }).length, 1);
  assert.equal(catalog.createTools({ toolFactory: value => value, calls: [] }).length, 1);
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

test('discovery reads every page, keeps gateway schemas, and refreshes on the next request', async () => {
  const requests = [];
  let generation = 0;
  const discovered = name => ({ name: `kg-graph___${name}`, description: `Description for ${name}`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } });
  const client = createKnowledgeGraphClient({ url, credentials, fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (!body.params.cursor) {
      generation++;
      return reply({ tools: [discovered(`kg_new_${generation}`), discovered('kg_run_readonly_query'),
        { ...discovered('other'), name: 'other-target___other' }], nextCursor: 'page2' });
    }
    return reply({ tools: [discovered('kg_more')] });
  } });
  const first = await client.listTools();
  assert.deepEqual(first.map(tool => tool.name), ['kg_new_1', 'kg_more']);
  assert.deepEqual(first[0].inputSchema, discovered('kg_new_1').inputSchema);
  assert.equal(first[0].description, 'Description for kg_new_1');
  assert.deepEqual(requests.map(body => [body.method, body.params]), [['tools/list', {}], ['tools/list', { cursor: 'page2' }]]);
  assert.equal((await client.listTools())[0].name, 'kg_new_2');
});

test('discovery rejects malformed lists, duplicate names, repeated cursors, and gateway failures', async () => {
  const tool = { name: 'kg-graph___kg_new', inputSchema: { type: 'object' } };
  for (const result of [{}, { tools: [tool, tool] }, { tools: [{ ...tool, inputSchema: {} }] }]) {
    const client = createKnowledgeGraphClient({ url, credentials, fetchImpl: async () => reply(result) });
    await assert.rejects(client.listTools(), /invalid|Invalid/);
  }
  const repeated = createKnowledgeGraphClient({ url, credentials,
    fetchImpl: async () => reply({ tools: [], nextCursor: 'same' }) });
  await assert.rejects(repeated.listTools(), /cursor/);
  const failed = createKnowledgeGraphClient({ url, credentials, fetchImpl: async () => new Response('', { status: 403 }) });
  await assert.rejects(failed.listTools(), /HTTP 403/);
});

test('discovery negotiates the protocol and reuses it for tool calls', async () => {
  const sent = [];
  const client = createKnowledgeGraphClient({ url, credentials, fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body);
    const version = init.headers['mcp-protocol-version'];
    sent.push({ method: body.method, version });
    if (version !== '2025-06-18') {
      return new Response(JSON.stringify({ error: { data: { supported: ['2025-06-18'] } } }), { status: 400 });
    }
    return reply(body.method === 'tools/list'
      ? { tools: specs.map(spec => ({ ...spec, name: `kg-graph___${spec.name}` })) }
      : { content: [{ type: 'text', text: JSON.stringify(envelope) }] });
  } });
  assert.deepEqual(await client.listTools(), specs);
  assert.deepEqual(await client('kg_search_entities', { text: 'myeloma' }), envelope);
  assert.deepEqual(sent, [
    { method: 'tools/list', version: undefined },
    { method: 'tools/list', version: '2025-06-18' },
    { method: 'tools/call', version: '2025-06-18' },
  ]);
});
