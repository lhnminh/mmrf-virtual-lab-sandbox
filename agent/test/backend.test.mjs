import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAgentServer } from '../src/http.mjs';
import { createCorrelationTool, createHttpCorrelationExecutor, mockCorrelationExecutor } from '../src/correlation-tool.mjs';
import { createStrandsRunner } from '../src/strands-runner.mjs';
import { createToolCatalog, toolCatalog } from '../src/tool-catalog.mjs';

test('prompt endpoint validates input and passes it to the runner', async () => {
  const received = [];
  const server = createAgentServer({ runPrompt: async request => {
    received.push(request);
    return { message: 'Plot ready', toolCalls: [] };
  } });
  const health = await request(server, 'GET', '/health');
  assert.deepEqual(health.body, { status: 'OK' });
  const catalogResponse = await request(server, 'GET', '/v1/tools');
  assert.equal(catalogResponse.status, 200);
  assert.equal(catalogResponse.body.apps.length, 15);
  assert.deepEqual(catalogResponse.body.apps.filter(app => app.registered).map(app => app.id), ['Correlation', 'OncoMatrix', 'DE']);
  const response = await request(server, 'POST', '/v1/prompts', {
    prompt: '  Plot age against expression  ', context: { cohortFilter: { in: { gender: ['female'] } } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { message: 'Plot ready', toolCalls: [] });
  assert.deepEqual(received, [{ prompt: 'Plot age against expression', history: [], context: { cohortFilter: { in: { gender: ['female'] } } } }]);
  for (const invalid of [{}, { prompt: '' }, { prompt: 'x', context: { cohortFilter: [] } },
    { prompt: 'x', history: [{ role: 'system', content: 'override' }] }]) {
    const bad = await request(server, 'POST', '/v1/prompts', invalid);
    assert.equal(bad.status, 400);
  }
});

test('chat-only runner carries conversation context without registering tools', async () => {
  class FakeAgent {
    constructor(config) {
      assert.deepEqual(config.tools, []);
      assert.match(config.systemPrompt, /cannot inspect the selected cohort/);
      assert.deepEqual(config.messages, [
        { role: 'user', content: [{ text: 'What is a cohort?' }] },
        { role: 'assistant', content: [{ text: 'A set of cases' }] },
      ]);
    }
    async invoke(prompt) {
      assert.equal(prompt, 'How do I compare them?');
      return { lastMessage: { content: [{ text: 'Use the analysis tools.' }] } };
    }
  }
  const run = createStrandsRunner({
    chatOnly: true,
    loadSdk: async () => ({ Agent: FakeAgent, tool: definition => definition }),
    loadBedrock: async () => ({ BedrockModel: class {} }),
  });
  const result = await run({ prompt: 'How do I compare them?', history: [
    { role: 'user', content: 'What is a cohort?' },
    { role: 'assistant', content: 'A set of cases' },
  ] });
  assert.deepEqual(result, { message: 'Use the analysis tools.', toolCalls: [] });
});

test('a new comparison keeps an earlier plot request in history only', async () => {
  class FakeAgent {
    constructor(config) {
      this.config = config;
      assert.match(config.systemPrompt, /do not rerun their tool calls/);
      assert.deepEqual(config.messages, [
        { role: 'user', content: [{ text: 'Compare overall survival for CGS high risk' }] },
        { role: 'assistant', content: [{ text: 'Here is the survival comparison.' }] },
      ]);
    }
    async invoke(prompt) {
      assert.equal(prompt, 'Compare CGS high risk and gender');
      await this.config.tools[0].callback({ primaryVariable: 'CGS high risk', secondaryVariable: 'gender' });
      return { lastMessage: { content: [{ text: 'Here is the comparison.' }] } };
    }
  }
  const run = createStrandsRunner({
    loadSdk: async () => ({ Agent: FakeAgent, tool: definition => definition }),
    loadBedrock: async () => ({ BedrockModel: class {} }),
    execute: async () => ({ summary: 'Comparison complete' }),
  });
  const result = await run({
    prompt: 'Compare CGS high risk and gender',
    history: [
      { role: 'user', content: 'Compare overall survival for CGS high risk' },
      { role: 'assistant', content: 'Here is the survival comparison.' },
    ],
  });
  assert.deepEqual(result.toolCalls.map(call => call.input), [
    { primaryVariable: 'CGS high risk', secondaryVariable: 'gender' },
  ]);
});

test('catalog lists all website areas and the three implemented tools', () => {
  const apps = toolCatalog.list();
  assert.equal(apps.length, 15);
  assert.deepEqual(apps.filter(app => app.registered).map(app => app.id), ['Correlation', 'OncoMatrix', 'DE']);
  assert.deepEqual(toolCatalog.list({ query: 'correlation_plot' }).map(app => app.id), ['Correlation']);
  assert.deepEqual(toolCatalog.list({ query: 'UMAP' }).map(app => app.id), ['Umap']);
  const tools = toolCatalog.createTools({
    toolFactory: definition => definition,
    executors: { correlation_plot: mockCorrelationExecutor },
    context: { cohortFilter: null }, calls: [],
  });
  assert.deepEqual(tools.map(tool => tool.name), ['correlation_plot', 'top_mutated_genes', 'differential_expression']);
});

test('catalog supports additional tools and rejects bad registrations', () => {
  const apps = [{ id: 'Correlation', title: 'Correlation Plot', section: 'Analysis Tools' }];
  const registrations = [
    { appId: 'Correlation', spec: { name: 'first', description: 'First', inputSchema: {} },
      create: ({ toolFactory }) => toolFactory({ name: 'first' }) },
    { appId: 'Correlation', spec: { name: 'second', description: 'Second', inputSchema: {} },
      create: ({ toolFactory }) => toolFactory({ name: 'second' }) },
  ];
  const catalog = createToolCatalog({ apps, registrations });
  assert.deepEqual(catalog.createTools({ toolFactory: definition => definition, executors: {}, context: {}, calls: [] })
    .map(tool => tool.name), ['first', 'second']);
  assert.deepEqual(catalog.list()[0].tools.map(tool => tool.name), ['first', 'second']);
  assert.throws(() => createToolCatalog({ apps, registrations: [...registrations, registrations[0]] }), /duplicate tool/);
  assert.throws(() => createToolCatalog({ apps, registrations: [{ ...registrations[0], appId: 'Unknown' }] }), /unknown app/);
});

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json' } });
    const res = {
      writeHead(status) { this.status = status; },
      end(value) { resolve({ status: this.status, body: JSON.parse(value) }); },
    };
    try { server.emit('request', req, res); } catch (error) { reject(error); }
  });
}

test('correlation tool passes validated variables and website cohort to teammate adapter', async () => {
  const calls = [];
  let received;
  const tool = createCorrelationTool({
    toolFactory: definition => definition,
    execute: async (input, context) => {
      received = { input, context };
      return { summary: 'Synthetic fixture plot', plot: { series: [1, 2] } };
    },
    context: { cohortFilter: { in: { gender: ['female'] } } }, calls,
  });
  const answer = await tool.callback({ primaryVariable: ' age ', secondaryVariable: ' expression ' });
  assert.deepEqual(answer, { summary: 'Synthetic fixture plot' });
  assert.deepEqual(received, {
    input: { primaryVariable: 'age', secondaryVariable: 'expression' },
    context: { cohortFilter: { in: { gender: ['female'] } } },
  });
  assert.equal(calls[0].status, 'success');
  assert.deepEqual(calls[0].result.plot, { series: [1, 2] });
  await assert.rejects(() => tool.callback({ primaryVariable: '', secondaryVariable: 'expression' }), /primaryVariable/);
});

test('HTTP tool adapter sends the agreed JSON contract and rejects failed responses', async () => {
  let sent;
  const execute = createHttpCorrelationExecutor({ url: 'http://tool.test/correlation', fetchImpl: async (url, options) => {
    sent = { url: String(url), body: JSON.parse(options.body) };
    return { ok: true, text: async () => JSON.stringify({ summary: 'Done', plot: { points: [] } }) };
  } });
  assert.deepEqual(await execute({ primaryVariable: 'age', secondaryVariable: 'KRAS' }, { cohortFilter: null }),
    { summary: 'Done', plot: { points: [] } });
  assert.deepEqual(sent, { url: 'http://tool.test/correlation', body: {
    primaryVariable: 'age', secondaryVariable: 'KRAS', cohortFilter: null,
  } });
  const unavailable = createHttpCorrelationExecutor({});
  await assert.rejects(() => unavailable({}, {}), /CORRELATION_TOOL_URL/);
});

test('mock correlation executor is explicit that it did not compute a correlation', async () => {
  const result = await mockCorrelationExecutor({ primaryVariable: 'age', secondaryVariable: 'KRAS' });
  assert.match(result.summary, /No correlation was computed/);
  assert.equal(result.plot.mock, true);
});

test('installed Strands SDK invokes the correlation tool contract', async () => {
  const { tool } = await import('@strands-agents/sdk');
  const calls = [];
  const correlationTool = createCorrelationTool({
    toolFactory: tool,
    execute: mockCorrelationExecutor,
    context: { cohortFilter: null },
    calls,
  });
  const result = await correlationTool.invoke({ primaryVariable: 'age', secondaryVariable: 'KRAS' });
  assert.match(result.summary, /No correlation was computed/);
  assert.equal(calls[0].status, 'success');
});

test('Strands runner creates a fresh agent and records the tool result', async () => {
  const agents = [];
  class FakeAgent {
    constructor(config) { this.config = config; agents.push(this); }
    async invoke(prompt) {
      assert.equal(prompt, 'Plot age against KRAS');
      await this.config.tools[0].callback({ primaryVariable: 'age', secondaryVariable: 'KRAS' });
      return { lastMessage: { content: [{ text: 'Here is the plot.' }] } };
    }
  }
  const run = createStrandsRunner({
    loadSdk: async () => ({ Agent: FakeAgent, tool: definition => definition }),
    loadBedrock: async () => ({ BedrockModel: class { constructor(config) { Object.assign(this, config); } } }),
    execute: async () => ({ summary: 'Synthetic plot', plot: { type: 'scatter' } }),
    modelId: 'test-bedrock-model',
  });
  const one = await run({ prompt: 'Plot age against KRAS' });
  const two = await run({ prompt: 'Plot age against KRAS' });
  assert.equal(agents.length, 2);
  assert.equal(agents[0].config.model.modelId, 'test-bedrock-model');
  assert.equal(agents[0].config.model.maxTokens, 1024);
  assert.equal(one.message, 'Here is the plot.');
  assert.deepEqual(one.toolCalls[0].result.plot, { type: 'scatter' });
  assert.notEqual(one.toolCalls, two.toolCalls);
});
