import test from 'node:test';
import assert from 'node:assert/strict';
import { withTeamLogin } from '../src/team-login.mjs';

const login = { origin: 'https://abc.cloudfront.net', username: 'sandbox', password: 'secret' };

test('team login is added only for the Virtual Lab origin', async () => {
  const calls = [];
  const fetchImpl = withTeamLogin(async (input, init) => { calls.push({ input, init }); }, login);
  await fetchImpl(new URL('https://abc.cloudfront.net/analysis/v0/survival/'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
  });
  await fetchImpl('https://bedrock-runtime.us-east-1.amazonaws.com/model', { headers: { accept: 'x' } });
  const headers = calls[0].init.headers;
  assert.equal(headers.get('authorization'), `Basic ${Buffer.from('sandbox:secret').toString('base64')}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[1].init, { headers: { accept: 'x' } });
});

test('without a full login the fetch is unchanged', () => {
  const fetchImpl = async () => {};
  assert.equal(withTeamLogin(fetchImpl, { ...login, password: undefined }), fetchImpl);
  assert.equal(withTeamLogin(fetchImpl, { ...login, origin: undefined }), fetchImpl);
});
