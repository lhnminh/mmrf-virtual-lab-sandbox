// Calls the agent on AgentCore Runtime. Signs by hand so the identity image
// keeps no npm dependencies.
import { createHash, createHmac, randomUUID } from 'node:crypto';

const SERVICE = 'bedrock-agentcore';
const TIMEOUT_MS = 180000;
const IMDS = 'http://169.254.169.254';
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

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

// Runtime hides the agent's error body behind RuntimeClientError, so a 4xx from
// the agent can only be reported generally.
function failure(status, text) {
  const agentStatus = /Received error \((\d{3})\)/.exec(text)?.[1];
  return agentStatus?.startsWith('4')
    ? { status: 400, body: JSON.stringify({ error: 'The agent rejected the request' }) }
    : { status: 502, body: JSON.stringify({ error: 'Agent invocation failed' }) };
}

export function createRuntimeClient({ arn, endpoint, credentials = createCredentialSource(), fetchImpl = fetch,
  now = () => new Date(), sessionId = randomUUID } = {}) {
  const { region, account, id } = parseRuntimeArn(arn);
  const base = new URL(endpoint || `https://${SERVICE}.${region}.amazonaws.com`);
  const path = `/runtimes/${id}/invocations`;
  const query = `accountId=${account}`;
  return async function invoke(body) {
    try {
      const signing = await credentials();
      const headers = {
        accept: 'application/json',
        'content-type': 'application/json',
        host: base.host,
        'x-amz-date': now().toISOString().replace(/[-:]|\.\d{3}/g, ''),
        // A new session per request: the agent is stateless, and a new session
        // always runs the latest deployed version.
        'x-amzn-bedrock-agentcore-runtime-session-id': sessionId(),
      };
      if (signing.sessionToken) headers['x-amz-security-token'] = signing.sessionToken;
      const signature = authorization({ method: 'POST', path, query, headers, body, region, service: SERVICE,
        credentials: signing });
      const response = await fetchImpl(`${base.origin}${path}?${query}`, { method: 'POST', body,
        headers: { ...headers, authorization: signature }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await response.text();
      if (response.ok) return { status: 200, body: text };
      console.error(`Agent runtime returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      return failure(response.status, text);
    } catch (error) {
      console.error(`Agent runtime call failed: ${error.message}`);
      return failure(502, '');
    }
  };
}
