import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorization, createCredentialSource, parseRuntimeArn } from '../identity/runtime-client.mjs';

const ARN = 'arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/mmrf_agent-abcde12345';
const ROUTE = '/api/agent/agui';
const RUN = JSON.stringify({ threadId: 'thread-1', runId: 'run-1', messages: [], state: {} });

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

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function startIdentity(t, env) {
  const dir = await mkdtemp(join(tmpdir(), 'identity-'));
  await writeFile(join(dir, 'cases.json'), JSON.stringify([{ case_id: 'SYNTH-CASE-0001', synthetic: true,
    auth_resource_path: '/synthetic', project_id: 'SYNTH' }]));
  await writeFile(join(dir, 'files.json'), '[]');
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['identity/server.mjs'], { stdio: 'ignore', env: {
    PATH: process.env.PATH, SYNTHETIC_SANDBOX: '1', DATA_DIR: dir, BIND_ADDRESS: '127.0.0.1', PORT: String(port), ...env } });
  t.after(() => child.kill());
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/_status`)).ok) return port; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new Error('identity did not start');
}

async function startRuntime(t, handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      handler(req, res);
    });
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port, received };
}

const withRuntime = (t, runtimePort) => startIdentity(t, { AGENTCORE_RUNTIME_ARN: ARN,
  AGENTCORE_ENDPOINT: `http://127.0.0.1:${runtimePort}`, AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret' });

const post = (port, init = {}) => fetch(`http://127.0.0.1:${port}${ROUTE}`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: RUN, ...init });

test('a run reaches the Runtime signed, on the session of its thread, without browser credentials', async t => {
  const runtime = await startRuntime(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"RUN_FINISHED"}\n\n');
  });
  const port = await withRuntime(t, runtime.port);
  const response = await post(port, { headers: { 'content-type': 'application/json', cookie: 'a=b', authorization: 'Bearer browser' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.equal(await response.text(), 'data: {"type":"RUN_FINISHED"}\n\n');
  const [call] = runtime.received;
  assert.equal(call.url, '/runtimes/mmrf_agent-abcde12345/invocations?accountId=111122223333');
  assert.equal(call.body, RUN);
  assert.equal(call.headers.accept, 'text/event-stream');
  assert.match(call.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-west-2\/bedrock-agentcore\/aws4_request/);
  assert.equal(call.headers.cookie, undefined);
  assert.equal(call.headers['x-amzn-bedrock-agentcore-runtime-session-id'],
    createHash('sha256').update('thread-1').digest('hex'));
});

test('events reach the browser while the run is still going', async t => {
  let finish;
  const runtime = await startRuntime(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"RUN_STARTED"}\n\n');
    finish = () => res.end('data: {"type":"RUN_FINISHED"}\n\n');
  });
  const port = await withRuntime(t, runtime.port);
  const reader = (await post(port)).body.getReader();
  const first = await Promise.race([reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('first event was held back')), 3000))]);
  assert.match(Buffer.from(first.value).toString(), /RUN_STARTED/);
  finish();
  let rest = '';
  for (let part = await reader.read(); !part.done; part = await reader.read()) rest += Buffer.from(part.value).toString();
  assert.match(rest, /RUN_FINISHED/);
});

test('a browser that leaves stops the Runtime call', async t => {
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const runtime = await startRuntime(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"RUN_STARTED"}\n\n');
    res.on('close', closed);
  });
  const port = await withRuntime(t, runtime.port);
  const abort = new AbortController();
  const reader = (await post(port, { signal: abort.signal })).body.getReader();
  await reader.read();
  abort.abort();
  await Promise.race([upstreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime call kept running')), 3000))]);
});

test('a stream cut off after it started ends in an AG-UI error event', async t => {
  const runtime = await startRuntime(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"RUN_STARTED"}\n\n');
    setTimeout(() => res.destroy(), 50);
  });
  const port = await withRuntime(t, runtime.port);
  const text = await (await post(port)).text();
  assert.match(text, /RUN_STARTED/);
  assert.match(text, /"type":"RUN_ERROR","code":"STREAM_INTERRUPTED"/);
});

test('a Runtime refusal returns a plain error without its details', async t => {
  const runtime = await startRuntime(t, (req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end('{"message":"User arn:aws:iam::111122223333:role/x is not authorized"}');
  });
  const port = await withRuntime(t, runtime.port);
  const response = await post(port);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'The agent is unavailable' });
});

test('requests that are not an AG-UI run are refused before they reach the Runtime', async t => {
  const runtime = await startRuntime(t, (req, res) => res.end());
  const port = await withRuntime(t, runtime.port);
  const url = `http://127.0.0.1:${port}${ROUTE}`;
  const get = await fetch(url);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  // A cross-site form can only send these types, so this also blocks forged runs.
  assert.equal((await post(port, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await post(port, { body: '{"runId":"no-thread"}' })).status, 400);
  assert.equal((await post(port, { body: 'not json' })).status, 400);
  assert.equal(runtime.received.length, 0);
});

test('without a Runtime ARN the route still belongs to the frontend', async t => {
  const frontend = await startRuntime(t, (req, res) => { res.writeHead(404); res.end('from frontend'); });
  const port = await startIdentity(t, { FRONTEND_ORIGIN: `http://127.0.0.1:${frontend.port}` });
  const response = await post(port);
  assert.equal(await response.text(), 'from frontend');
  assert.equal(frontend.received[0].url, ROUTE);
});

test('identity refuses an AgentCore endpoint that is not this machine', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'identity-'));
  await writeFile(join(dir, 'cases.json'), JSON.stringify([{ case_id: 'SYNTH-CASE-0001', synthetic: true,
    auth_resource_path: '/synthetic', project_id: 'SYNTH' }]));
  await writeFile(join(dir, 'files.json'), '[]');
  const child = spawn(process.execPath, ['identity/server.mjs'], { stdio: 'ignore', env: { PATH: process.env.PATH,
    SYNTHETIC_SANDBOX: '1', DATA_DIR: dir, BIND_ADDRESS: '127.0.0.1', PORT: '0', AGENTCORE_RUNTIME_ARN: ARN,
    AGENTCORE_ENDPOINT: 'https://example.com' } });
  t.after(() => child.kill());
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.notEqual(code, 0);
});
