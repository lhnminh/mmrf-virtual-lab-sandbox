import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayClient, createSignedFetch } from '../src/gateway-client.mjs';

test('Gateway client sends hidden cohort and returns plot without changing the model input', async () => {
  let sent;
  const client = createGatewayClient({
    url: 'https://gateway.example/mcp',
    fetchImpl: async () => { throw new Error('test client should not use network'); },
    clientFactory: () => ({
      async connect() {},
      async callTool(value) {
        sent = value;
        return { content: [{ type: 'text', text: JSON.stringify({ summary: 'Done', plot: { type: 'test' } }) }] };
      },
      async close() {},
    }),
  });
  const input = { primaryVariable: 'survival', secondaryVariable: 'CGS risk' };
  const cohortFilter = { in: { 'demographic.gender': ['female'] } };
  assert.deepEqual(await client('correlation_plot', input, { cohortFilter }),
    { summary: 'Done', plot: { type: 'test' } });
  assert.equal(sent.name, 'virtual-lab___correlation_plot');
  assert.deepEqual(sent.arguments, { ...input, cohortFilterJson: JSON.stringify(cohortFilter) });
  assert.deepEqual(input, { primaryVariable: 'survival', secondaryVariable: 'CGS risk' });
});

test('Gateway HTTP fetch signs each request', async () => {
  const seen = [];
  const signedFetch = createSignedFetch({
    credentials: async () => ({ accessKeyId: 'TESTKEY', secretAccessKey: 'TESTSECRET' }),
    fetchImpl: async (url, options) => {
      seen.push({ url, headers: options.headers });
      return new Response('{}', { status: 200 });
    },
  });
  await signedFetch('https://gateway.example/mcp', { method: 'POST', body: '{}' });
  await signedFetch('https://gateway.example/mcp', { method: 'POST', body: '{}' });
  assert.equal(seen.length, 2);
  assert.match(seen[0].headers.authorization, /AWS4-HMAC-SHA256/);
  assert.match(seen[0].headers.authorization, /Credential=TESTKEY/);
});

test('Gateway client completes an MCP initialize and tool-call round trip', async () => {
  const methods = [];
  const client = createGatewayClient({
    url: 'https://gateway.example/mcp',
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      methods.push(request.method);
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-gateway', version: '1' } }
        : { content: [{ type: 'text', text: JSON.stringify({ summary: 'Done', plot: { type: 'test' } }) }] };
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  });
  assert.deepEqual(await client('correlation_plot', { primaryVariable: 'survival', secondaryVariable: 'risk' }),
    { summary: 'Done', plot: { type: 'test' } });
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call']);
});
