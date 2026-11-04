// Streams Chat's AG-UI runs from the agent on AgentCore Runtime. Signs by hand so
// the identity image keeps no npm dependencies.
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';

export const AGENT_ROUTE = '/api/agent/agui';

const SERVICE = 'bedrock-agentcore';
const IMDS = 'http://169.254.169.254';
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const INTERRUPTED = 'data: {"type":"RUN_ERROR","code":"STREAM_INTERRUPTED","message":"The agent stream was interrupted."}\n\n';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

export function parseRuntimeArn(arn) {
  const match = /^arn:aws[a-z-]*:bedrock-agentcore:([a-z0-9-]+):([0-9]{12}):runtime\/([a-zA-Z0-9_-]+)$/.exec(arn || '');
  if (!match) throw new Error('AGENTCORE_RUNTIME_ARN is not an agent runtime ARN');
  return { region: match[1], account: match[2], id: match[3] };
}

/** SigV4 Authorization header. `headers` must have lowercase names and include host and x-amz-date. */
export function authorization({ method, path, query = '', headers, body, region, service, credentials }) {
  const names = Object.keys(headers).sort();
  const date = headers['x-amz-date'];
  const scope = `${date.slice(0, 8)}/${region}/${service}/aws4_request`;
  const canonical = [method, path, query, ...names.map(name => `${name}:${headers[name].trim()}`), '',
    names.join(';'), sha256(body)].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
  const key = ['aws4_request', service, region, date.slice(0, 8)].reduceRight(
    (derived, part) => hmac(derived, part), `AWS4${credentials.secretAccessKey}`);
  const signature = hmac(key, toSign).toString('hex');
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

/** Environment credentials, otherwise the EKS node role through the metadata service. */
export function createCredentialSource({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  let cached;
  return async () => {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN };
    }
    if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached;
    const signal = () => AbortSignal.timeout(2000);
    const token = await (await fetchImpl(`${IMDS}/latest/api/token`, { method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '300' }, signal: signal() })).text();
    const headers = { 'x-aws-ec2-metadata-token': token };
    const base = `${IMDS}/latest/meta-data/iam/security-credentials/`;
    const role = (await (await fetchImpl(base, { headers, signal: signal() })).text()).trim();
    const value = await (await fetchImpl(base + role, { headers, signal: signal() })).json();
    cached = { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey,
      sessionToken: value.Token, expiresAt: Date.parse(value.Expiration) };
    return cached;
  };
}

function threadIdOf(body) {
  try {
    const threadId = JSON.parse(body.toString())?.threadId;
    return typeof threadId === 'string' && threadId ? threadId : undefined;
  } catch {
    return undefined;
  }
}

function fail(res, status, error, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify({ error }));
}

/** Handles Chat's AG-UI requests. Only the run's JSON goes to the Runtime, never browser credentials. */
export function createAgentRoute({ arn, endpoint, readBody, credentials = createCredentialSource(), fetchImpl = fetch,
  now = () => new Date() }) {
  const { region, account, id } = parseRuntimeArn(arn);
  const base = new URL(endpoint || `https://${SERVICE}.${region}.amazonaws.com`);
  const path = `/runtimes/${id}/invocations`;
  const query = `accountId=${account}`;

  async function invoke(body, threadId, signal) {
    const signing = await credentials();
    const headers = {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      host: base.host,
      'x-amz-date': now().toISOString().replace(/[-:]|\.\d{3}/g, ''),
      // One thread stays on one Runtime session, and the hash is always long enough for one.
      'x-amzn-bedrock-agentcore-runtime-session-id': sha256(threadId),
    };
    if (signing.sessionToken) headers['x-amz-security-token'] = signing.sessionToken;
    const signature = authorization({ method: 'POST', path, query, headers, body, region, service: SERVICE,
      credentials: signing });
    return fetchImpl(`${base.origin}${path}?${query}`, { method: 'POST', body,
      headers: { ...headers, authorization: signature }, signal });
  }

  return async function route(req, res) {
    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed', { allow: 'POST' });
    // Cross-site forms can't send this type without a preflight, which this route never approves.
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] || '')) {
      return fail(res, 415, 'Content-Type must be application/json');
    }
    const body = await readBody(req);
    const threadId = threadIdOf(body);
    if (!threadId) return fail(res, 400, 'A threadId is required');

    const upstream = new AbortController();
    res.on('close', () => upstream.abort());

    let response;
    try {
      response = await invoke(body, threadId, upstream.signal);
      if (!response.ok) {
        console.error(`Agent runtime returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
        return fail(res, 502, 'The agent is unavailable');
      }
    } catch (error) {
      if (upstream.signal.aborted) return res.end();
      console.error(`Agent runtime call failed: ${error.message}`);
      return fail(res, 502, 'The agent is unavailable');
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
    res.flushHeaders();
    try {
      for await (const chunk of response.body) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: upstream.signal });
      }
    } catch (error) {
      if (upstream.signal.aborted) return res.end();
      console.error(`Agent stream failed after it started: ${error.message}`);
      res.write(INTERRUPTED);
    }
    res.end();
  };
}
