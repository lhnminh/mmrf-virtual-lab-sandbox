import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorization, createCredentialSource, createRuntimeClient, parseRuntimeArn } from '../identity/runtime-client.mjs';

const ARN = 'arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/mmrf_agent-abcde12345';
const credentials = async () => ({ accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'token' });

test('signature matches the AWS SigV4 get-vanilla test vector', () => {
  const value = authorization({ method: 'GET', path: '/', body: '', region: 'us-east-1', service: 'service',
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' } });
  assert.equal(value, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
    'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('runtime ARNs are parsed and anything else is refused', () => {
  assert.deepEqual(parseRuntimeArn(ARN), { region: 'us-west-2', account: '111122223333', id: 'mmrf_agent-abcde12345' });
  assert.throws(() => parseRuntimeArn('arn:aws:iam::111122223333:role/x'));
});

test('invoke sends a signed JSON request with a new valid session each time', async () => {
  const calls = [];
  const invoke = createRuntimeClient({ arn: ARN, credentials, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response('{"message":"ok","toolCalls":[]}');
  } });
  const body = Buffer.from('{"prompt":"hi"}');
  assert.deepEqual(await invoke(body), { status: 200, body: '{"message":"ok","toolCalls":[]}' });
  await invoke(body);
  assert.equal(calls[0].url,
    'https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/mmrf_agent-abcde12345/invocations?accountId=111122223333');
  const headers = calls[0].init.headers;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-amz-security-token'], 'token');
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-west-2\/bedrock-agentcore\/aws4_request/);
  const session = headers['x-amzn-bedrock-agentcore-runtime-session-id'];
  assert.ok(session.length >= 33);
  assert.notEqual(session, calls[1].init.headers['x-amzn-bedrock-agentcore-runtime-session-id']);
});

test('Runtime failures become the agent API errors without leaking details', async () => {
  const replying = (status, message) => createRuntimeClient({ arn: ARN, credentials,
    fetchImpl: async () => new Response(JSON.stringify({ message }), { status }) });
  const body = Buffer.from('{}');
  const rejected = await replying(424, 'Received error (400) from runtime.')(body);
  assert.deepEqual(rejected, { status: 400, body: '{"error":"The agent rejected the request"}' });
  const failed = await replying(424, 'Received error (502) from runtime. secret detail')(body);
  assert.deepEqual(failed, { status: 502, body: '{"error":"Agent invocation failed"}' });
  const denied = await replying(403, 'User is not authorized')(body);
  assert.equal(denied.status, 502);
  const unreachable = await createRuntimeClient({ arn: ARN, credentials,
    fetchImpl: async () => { throw new Error('network'); } })(body);
  assert.equal(unreachable.status, 502);
});

test('node role credentials come from the metadata service and are cached', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (url.endsWith('/api/token')) return new Response('imds-token');
    assert.equal(init.headers['x-aws-ec2-metadata-token'], 'imds-token');
    if (url.endsWith('/security-credentials/')) return new Response('node-role\n');
    return new Response(JSON.stringify({ AccessKeyId: 'ASIA', SecretAccessKey: 's', Token: 't',
      Expiration: '2030-01-01T00:00:00Z' }));
  };
  const source = createCredentialSource({ env: {}, fetchImpl, now: () => Date.parse('2029-01-01T00:00:00Z') });
  assert.equal((await source()).accessKeyId, 'ASIA');
  await source();
  assert.equal(calls.length, 3);
  assert.equal(calls[0], 'PUT http://169.254.169.254/latest/api/token');
});

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startIdentity(env) {
  const dir = await mkdtemp(join(tmpdir(), 'identity-'));
  await writeFile(join(dir, 'cases.json'), JSON.stringify([{ case_id: 'SYNTH-CASE-0001', synthetic: true,
    auth_resource_path: '/synthetic', project_id: 'SYNTH' }]));
  await writeFile(join(dir, 'files.json'), '[]');
  const port = await freePort();
  const child = spawn(process.execPath, ['identity/server.mjs'], { stdio: 'ignore', env: {
    PATH: process.env.PATH, SYNTHETIC_SANDBOX: '1', DATA_DIR: dir, BIND_ADDRESS: '127.0.0.1', PORT: String(port), ...env } });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/_status`)).ok) return { child, port }; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  child.kill();
  throw new Error('identity did not start');
}

function capture(reply) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(reply);
    });
  });
  return { server, received };
}

const prompt = { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic browser', cookie: 'a=b' },
  body: JSON.stringify({ prompt: 'Compare survival', context: { cohortFilter: null } }) };

test('with a Runtime ARN, identity sends prompts to the Runtime and drops browser credentials', async t => {
  const reply = '{"message":"from runtime","toolCalls":[]}';
  const runtime = capture(reply);
  const local = capture('{"message":"from local agent","toolCalls":[]}');
  const runtimePort = await listen(runtime.server);
  const localPort = await listen(local.server);
  t.after(() => { runtime.server.close(); local.server.close(); });
  const { child, port } = await startIdentity({ AGENTCORE_RUNTIME_ARN: ARN, AGENTCORE_ENDPOINT: `http://127.0.0.1:${runtimePort}`,
    AGENT_ORIGIN: `http://127.0.0.1:${localPort}`, AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret' });
  t.after(() => child.kill());
  const response = await fetch(`http://127.0.0.1:${port}/agent/v1/prompts`, prompt);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), reply);
  assert.equal(local.received.length, 0);
  assert.equal(runtime.received[0].body, prompt.body);
  assert.match(runtime.received[0].headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(runtime.received[0].headers.cookie, undefined);
});

test('the Chat route streams to the Runtime with one session per thread', async t => {
  const events = 'data: {"type":"RUN_STARTED"}\n\n';
  const runtime = capture(events);
  const runtimePort = await listen(runtime.server);
  t.after(() => runtime.server.close());
  const { child, port } = await startIdentity({ AGENTCORE_RUNTIME_ARN: ARN, AGENTCORE_ENDPOINT: `http://127.0.0.1:${runtimePort}`,
    AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret' });
  t.after(() => child.kill());
  const post = body => fetch(`http://127.0.0.1:${port}/api/agent/agui`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reply = await post({ threadId: 'thread-1', messages: [] });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('content-type'), 'text/event-stream');
  assert.equal(await reply.text(), events);
  await post({ threadId: 'thread-1', messages: [] });
  await post({ threadId: 'thread-2', messages: [] });
  const sessions = runtime.received.map(call => call.headers['x-amzn-bedrock-agentcore-runtime-session-id']);
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[0], sessions[2]);
  assert.ok(sessions[0].length >= 33);
  assert.equal(runtime.received[0].headers.accept, 'text/event-stream');
  assert.equal((await post({ messages: [] })).status, 400);
});

test('without a Runtime ARN, identity still uses the local agent', async t => {
  const local = capture('{"message":"from local agent","toolCalls":[]}');
  const localPort = await listen(local.server);
  t.after(() => local.server.close());
  const { child, port } = await startIdentity({ AGENT_ORIGIN: `http://127.0.0.1:${localPort}` });
  t.after(() => child.kill());
  const response = await fetch(`http://127.0.0.1:${port}/agent/v1/prompts`, prompt);
  assert.equal((await response.json()).message, 'from local agent');
  assert.equal(local.received[0].url, '/v1/prompts');
});
