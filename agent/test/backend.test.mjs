import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAgentServer } from '../src/http.mjs';
import { createCorrelationTool, createHttpCorrelationExecutor, mockCorrelationExecutor } from '../src/correlation-tool.mjs';
import { createStrandsRunner } from '../src/strands-runner.mjs';

test('prompt endpoint validates input and passes it to the runner', async () => {
  const received = [];
  const server = createAgentServer({ runPrompt: async request => {
    received.push(request);
    return { message: 'Plot ready', toolCalls: [] };
  } });
  const health = await request(server, 'GET', '/health');
  assert.deepEqual(health.body, { status: 'OK' });
  const response = await request(server, 'POST', '/v1/prompts', {
    prompt: '  Plot age against expression  ', context: { cohortFilter: { in: { gender: ['female'] } } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { message: 'Plot ready', toolCalls: [] });
  assert.deepEqual(received, [{ prompt: 'Plot age against expression', context: { cohortFilter: { in: { gender: ['female'] } } } }]);
  for (const invalid of [{}, { prompt: '' }, { prompt: 'x', context: { cohortFilter: [] } }]) {
    const bad = await request(server, 'POST', '/v1/prompts', invalid);
    assert.equal(bad.status, 400);
  }
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
