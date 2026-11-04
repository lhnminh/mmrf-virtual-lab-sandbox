import { createHash, createHmac } from 'node:crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SignatureV4 } from '@smithy/signature-v4';

class Sha256 {
  constructor(secret) {
    this.hash = secret ? createHmac('sha256', secret) : createHash('sha256');
  }
  update(value) { this.hash.update(value); }
  digest() { return Promise.resolve(this.hash.digest()); }
}

export function createSignedFetch({ region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
  credentials = defaultProvider(), fetchImpl = fetch } = {}) {
  const signer = new SignatureV4({ credentials, region, service: 'bedrock-agentcore', sha256: Sha256 });
  return async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
    const headers = Object.fromEntries(request.headers);
    headers.host = url.host;
    const signed = await signer.sign({
      method: request.method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: url.pathname + url.search,
      headers,
      body,
    });
    return fetchImpl(request.url, {
      method: request.method,
      headers: signed.headers,
      body,
      signal: request.signal,
      redirect: 'error',
    });
  };
}

function parseResult(result) {
  if (result?.isError) throw new Error(result.content?.map(item => item.text).filter(Boolean).join('; ') || 'Gateway tool failed');
  const value = result?.structuredContent || (() => {
    const text = result?.content?.find(item => item.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
  })();
  if (!value || typeof value.summary !== 'string' || !value.summary.trim()) {
    throw new Error('Gateway returned an invalid tool result');
  }
  return value;
}

export function createGatewayClient({ url = process.env.AGENTCORE_GATEWAY_URL,
  targetName = 'virtual-lab', fetchImpl = createSignedFetch(), clientFactory } = {}) {
  if (!url) throw new Error('AGENTCORE_GATEWAY_URL is not configured');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:') throw new Error('Gateway URL must use HTTPS');
  return async (name, input, { cohortFilter = null } = {}) => {
    const client = clientFactory
      ? clientFactory()
      : new Client({ name: 'mmrf-virtual-lab', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(endpoint, { fetch: fetchImpl });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: targetName + '___' + name,
        arguments: { ...input, cohortFilterJson: JSON.stringify(cohortFilter) },
      });
      return parseResult(result);
    } finally {
      await client.close();
    }
  };
}
