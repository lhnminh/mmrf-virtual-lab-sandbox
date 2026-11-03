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
