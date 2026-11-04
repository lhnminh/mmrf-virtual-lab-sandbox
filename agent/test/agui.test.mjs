import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanResult, cohortFromState, conversationFrom, createAgUiRunner, defaultTools, promptWithCohort } from '../src/agui.mjs';
import { createAgentServer } from '../src/http.mjs';

const FILTER = { and: [{ in: { 'demographic.race': ['asian'] } }] };
const delta = text => ({ type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } } });
const stop = { type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockStopEvent' } };
const toolStart = (name, toolUseId) => ({ type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId } } });
const toolInput = input => ({ type: 'modelStreamUpdateEvent', event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input } } });

function fakeSdk(script) {
  const seen = {};
  const loadSdk = async () => ({
    tool: definition => definition,
    Agent: class {
      constructor(options) { Object.assign(seen, options); this.tools = options.tools; }
      async* stream(prompt) { seen.prompt = prompt; yield* script(this.tools); }
    },
  });
  return { seen, loadSdk, loadBedrock: async () => ({ BedrockModel: class {} }) };
}

async function collect(runner, input) {
  const events = [];
  for await (const event of runner(input)) events.push(event);
  return events;
}

const input = (state = {}, content = 'Hello') => ({ threadId: 't', runId: 'r', state, messages: [{ id: '1', role: 'user', content }] });
const types = events => events.map(event => event.type);

test('a text run follows the AG-UI event order', async () => {
  const sdk = fakeSdk(async function* () { yield delta('Hi '); yield delta('there'); yield stop; });
  const events = await collect(createAgUiRunner({ ...sdk, tools: [], newId: () => 'id' }), input());
  assert.deepEqual(types(events), ['RUN_STARTED', 'STATE_SNAPSHOT', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'STATE_SNAPSHOT', 'RUN_FINISHED']);
  assert.equal(events[0].protocolVersion, '1.0');
  assert.deepEqual(events.at(-1).outcome, { type: 'success' });
});

test('tools use gateway-style names, get the cohort, and hide filters from the model and browser', async () => {
  const received = [];
  const tool = { spec: { name: 'show_lollipop' }, wireName: 'virtual-lab___show_lollipop',
    execute: async (args, context) => { received.push(context); return { status: 'ok', summary: 's', filter: FILTER, cohort: { label: 'L', caseCount: 2 } }; } };
  let forModel;
  const sdk = fakeSdk(async function* (tools) {
    yield toolStart('show_lollipop', 'call-1'); yield toolInput('{"gene":"KRAS"}'); yield stop;
    forModel = await tools[0].callback({ gene: 'KRAS' });
    yield delta('Done'); yield stop;
  });
  const events = await collect(createAgUiRunner({ ...sdk, tools: [tool] }), input({ cohort: { filter: FILTER, revision: 2, caseCount: 2, label: 'L' } }));
  assert.deepEqual(received, [{ cohortFilter: FILTER }]);
  assert.equal(events.find(event => event.type === 'TOOL_CALL_START').toolCallName, 'virtual-lab___show_lollipop');
  const result = JSON.parse(events.find(event => event.type === 'TOOL_CALL_RESULT').content);
  assert.equal(result.filter, undefined);
  assert.equal(result.cohort.revision, 2);
  assert.equal(forModel.filter, undefined);
  assert.ok(types(events).indexOf('TOOL_CALL_END') < types(events).indexOf('TOOL_CALL_RESULT'));
});

test('update_cohort raises the revision, publishes state, and later tools see the new cohort', async () => {
  const seen = [];
  const update = { spec: { name: 'update_cohort' }, wireName: 'virtual-lab___update_cohort',
    execute: async () => ({ status: 'ok', summary: 's', filter: FILTER, changes: [{ field: 'f', op: 'set', values: ['v'] }], cohort: { label: 'L', caseCount: 5 } }) };
  const chart = { spec: { name: 'show_oncomatrix' }, wireName: 'virtual-lab___show_oncomatrix',
    execute: async (args, context) => { seen.push(context.cohortFilter); return { status: 'ok', summary: 'c', cohort: { label: 'L', caseCount: 5 } }; } };
  const sdk = fakeSdk(async function* (tools) {
    yield toolStart('update_cohort', 'a'); yield stop; await tools[0].callback({});
    yield toolStart('show_oncomatrix', 'b'); yield stop; await tools[1].callback({});
  });
  const events = await collect(createAgUiRunner({ ...sdk, tools: [update, chart] }), input({ cohort: { filter: null, revision: 3 } }));
  assert.deepEqual(seen, [FILTER]);
  const snapshots = events.filter(event => event.type === 'STATE_SNAPSHOT');
  assert.equal(snapshots[1].snapshot.cohort.revision, 4);
  assert.deepEqual(snapshots[1].snapshot.cohort.filter, FILTER);
  assert.deepEqual(snapshots[1].snapshot.cohort.changes, [{ field: 'f', op: 'set', values: ['v'] }]);
  const results = events.filter(event => event.type === 'TOOL_CALL_RESULT').map(event => JSON.parse(event.content));
  assert.deepEqual(results.map(item => item.cohort.revision), [4, 4]);
});

test('a non-ok update changes no state, and a thrown tool becomes a reported failure', async () => {
  const update = { spec: { name: 'update_cohort' }, wireName: 'u', execute: async () => ({ status: 'ambiguous', summary: 'which', options: ['a'] }) };
  const broken = { spec: { name: 'show_survival' }, wireName: 's', execute: async () => { throw new Error('secret detail'); } };
  const sdk = fakeSdk(async function* (tools) {
    yield toolStart('update_cohort', 'a'); yield stop; await tools[0].callback({});
    yield toolStart('show_survival', 'b'); yield stop; await tools[1].callback({});
  });
  const events = await collect(createAgUiRunner({ ...sdk, tools: [update, broken], log: () => {} }), input());
  assert.equal(events.filter(event => event.type === 'STATE_SNAPSHOT').length, 2);
  const results = events.filter(event => event.type === 'TOOL_CALL_RESULT').map(event => JSON.parse(event.content));
  assert.equal(results[0].status, 'ambiguous');
  assert.deepEqual(results[1], { status: 'error', summary: 'The tool could not finish.' });
});

test('failures become RUN_ERROR without exception text', async () => {
  const sdk = fakeSdk(async function* () { yield delta('x'); throw new Error('secret detail'); });
  const events = await collect(createAgUiRunner({ ...sdk, tools: [], log: () => {} }), input());
  assert.deepEqual(events.at(-1), { type: 'RUN_ERROR', code: 'AGENT_ERROR', message: 'The agent could not finish this run.' });
  assert.ok(types(events).includes('TEXT_MESSAGE_END'));
  const empty = await collect(createAgUiRunner({ ...sdk, tools: [], log: () => {} }), { messages: [] });
  assert.equal(empty.at(-1).type, 'RUN_ERROR');
});

test('the prompt carries cohort facts and only the safe label', () => {
  assert.equal(promptWithCohort('Hi', null), 'Hi');
  const text = promptWithCohort('Hi', { filter: null, label: 'All cases', caseCount: 1000, changedOutsideChat: true });
  assert.match(text, /Selected cohort: All cases\. Cases: 1000\./);
  assert.match(text, /Now using: /);
  assert.match(promptWithCohort('Hi', { filter: null, label: 'SYNTH-CASE-1' }), /no name available/);
});

test('state without a filter key is not a cohort, and a null filter is', () => {
  assert.equal(cohortFromState({ cohort: { label: 'x' } }), null);
  assert.deepEqual(cohortFromState({ cohort: { filter: null } }), { filter: null });
  assert.equal(cohortFromState(undefined), null);
});

test('nested filters are removed and case-id labels hidden', () => {
  const clean = cleanResult({ filter: 1, cohort: { filter: 2, label: 'SYNTH-CASE-1' }, plot: { filter: 3, gene: 'K' } }, 7);
  assert.deepEqual(clean, { cohort: { label: 'Selected cases', revision: 7 }, plot: { gene: 'K' } });
});

test('history alternates from a user turn and leaves out tool messages', () => {
  const { prompt, history } = conversationFrom([
    { role: 'assistant', content: 'skip' }, { role: 'user', content: 'a' }, { role: 'tool', content: 'x' },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] }, { role: 'user', content: 'c' },
  ]);
  assert.equal(prompt, 'c');
  assert.deepEqual(history.map(turn => turn.role), ['user', 'assistant']);
  assert.throws(() => conversationFrom([{ role: 'assistant', content: 'x' }]), /user message/);
});

test('the server streams runs as SSE on /invocations and /v1/agui, and keeps JSON prompts', async () => {
  const runAgUi = async function* (body) { yield { type: 'RUN_STARTED', threadId: body.threadId }; };
  const server = createAgentServer({ runAgUi, runPrompt: async () => ({ message: 'json', toolCalls: [] }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = path => `http://127.0.0.1:${server.address().port}${path}`;
  const post = (path, body) => fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const path of ['/invocations', '/v1/agui']) {
    const reply = await post(path, { threadId: 't', messages: [] });
    assert.equal(reply.headers.get('content-type'), 'text/event-stream');
    assert.equal(await reply.text(), 'data: {"type":"RUN_STARTED","threadId":"t"}\n\n');
  }
  assert.equal((await (await post('/invocations', { prompt: 'hi' })).json()).message, 'json');
  server.close();
});


test('Chat registers newly discovered gateway tools with descriptions and wire names', async () => {
  const spec = { name: 'kg_new_capability', description: 'New gateway capability', inputSchema: { type: 'object', properties: {} } };
  const calls = [];
  const callTool = Object.assign(async (...args) => { calls.push(args); return { summary: 'Found', graph: { nodes: [] } }; },
    { listTools: async () => [spec] });
  const tools = await defaultTools({ env: { KG_GATEWAY_URL: 'https://gateway.example/mcp' }, createClient: () => callTool });
  const sdk = fakeSdk(async function* (registered) {
    const tool = registered.find(tool => tool.name === spec.name);
    assert.equal(tool.description, spec.description);
    assert.deepEqual(tool.inputSchema, spec.inputSchema);
    yield toolStart(spec.name, 'new'); yield stop;
    await tool.callback({});
  });
  const events = await collect(createAgUiRunner({ ...sdk, tools }), input());
  assert.equal(events.find(event => event.type === 'TOOL_CALL_START').toolCallName, 'kg-graph___kg_new_capability');
  assert.deepEqual(calls, [[spec.name, {}]]);
  assert.match(sdk.seen.systemPrompt, /available gateway tools and their descriptions/);
  assert.doesNotMatch(sdk.seen.systemPrompt, /Call kg_search_entities first/);
  assert.equal(events.at(-1).type, 'RUN_FINISHED');
});
