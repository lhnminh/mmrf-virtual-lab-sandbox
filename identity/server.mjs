import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity } from './token.mjs';
import { bridgePayload } from './cohorts.mjs';
import { publicOrigin } from './access.mjs';
import { AGENT_ROUTE, createAgentRoute } from './runtime-client.mjs';

if (process.env.SYNTHETIC_SANDBOX !== '1') throw new Error('This service requires SYNTHETIC_SANDBOX=1');
const identity = createIdentity();
const configuredOrigin = process.env.SANDBOX_PUBLIC_ORIGIN ? publicOrigin(process.env.SANDBOX_PUBLIC_ORIGIN) : null;
const dataDir = resolve(process.env.DATA_DIR || fileURLToPath(new URL('../generated/', import.meta.url)));
const cases = JSON.parse(await readFile(join(dataDir, 'cases.json')));
const files = JSON.parse(await readFile(join(dataDir, 'files.json')));
if (!cases.length || cases.some(c => !c.synthetic || !c.case_id.startsWith('SYNTH-CASE-'))) throw new Error('Only generated synthetic cases are allowed');
const resources = ['/mmrf_metadata', ...new Set(cases.map(c => c.auth_resource_path))];
const projectAccess = Object.fromEntries([...new Set(cases.map(c => c.project_id))].map(id => [id, ['read', 'read-storage']]));
const terms = { id: 1, version: 'synthetic-v1', effective_at: '2026-01-01T00:00:00Z', terms_url: null,
  terms_content: 'Synthetic demonstration data only. No patient data or clinical interpretation.', content_format: 'plain_text' };
const targets = {
  frontend: process.env.FRONTEND_ORIGIN || 'http://frontend:3000',
  guppy: process.env.GUPPY_ORIGIN || 'http://guppy:8080',
  analysis: process.env.ANALYSIS_ORIGIN || 'http://analysis:8000',
  proteinpaint: process.env.PROTEINPAINT_ORIGIN || 'http://proteinpaint:3000',
};
// This launcher can only route to its own service names or loopback. It cannot
// point its disposable identity at a real commons through environment settings.
for (const [name, value] of Object.entries(targets)) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || ![name, 'localhost', '127.0.0.1'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Invalid sandbox ${name} origin`);
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
// AGENTCORE_ENDPOINT exists for tests, so it can only name this machine.
const runtimeEndpoint = process.env.AGENTCORE_ENDPOINT;
if (runtimeEndpoint && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(runtimeEndpoint)) throw new Error('Invalid AgentCore endpoint');
const agentRoute = process.env.AGENTCORE_RUNTIME_ARN
  ? createAgentRoute({ arn: process.env.AGENTCORE_RUNTIME_ARN, endpoint: runtimeEndpoint, readBody: body }) : null;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://sandbox.invalid');
    const path = url.pathname;
    if (path === AGENT_ROUTE && agentRoute) return await agentRoute(req, res);
    if (path === '/_status' || path === '/sandbox/status') return json(res, { status: 'OK', synthetic: true, cases: cases.length, csrf: 'synthetic-only' });
    if (path === '/sandbox/session') return json(res, { access_token: identity.issue(), expires_in: 1800, synthetic: true });
    if (path.startsWith('/sandbox/files/')) {
      const file = files.find(f => path === `/sandbox/files/${f.file_id}`);
      if (!file || !/^SYNTH-SAMPLE-[0-9]+\.synthetic\.(fasta|bam|fastq|tsv|vcf|csv)$/.test(file.file_name)) return json(res, {error: 'Unknown synthetic file'}, 404);
      const content = await readFile(join(dataDir, file.file_name));
      res.writeHead(200, {'content-type': file.data_format === 'BAM' ? 'application/octet-stream' : 'text/plain', 'content-disposition': `attachment; filename="${file.file_name}"`});
      return res.end(content);
    }
    if (path.startsWith('/index/index/')) {
      const file = files.find(f => path === `/index/index/${f.file_id}`);
      if (!file) return json(res, {error: 'Unknown synthetic file'}, 404);
      return json(res, {did: file.file_id, file_name: file.file_name, size: file.file_size, hashes: {md5: file.md5sum},
        urls: [`${configuredOrigin || `http://${req.headers.host}`}/sandbox/files/${file.file_id}`], acl: file.acl});
    }
    if (path.startsWith('/user/data/download/')) {
      const file = files.find(f => path === `/user/data/download/${f.file_id}`);
      if (file && url.searchParams.get('redirect') === 'true') {
        res.writeHead(302, {location: `/sandbox/files/${file.file_id}`, 'cache-control': 'no-store'});
        return res.end();
      }
      return file ? json(res, {url: `${configuredOrigin || `http://${req.headers.host}`}/sandbox/files/${file.file_id}`}) : json(res, {error: 'Unknown synthetic file'}, 404);
    }
    if (['/user/jwt/keys', '/jwt/keys'].includes(path)) return json(res, { keys: [['synthetic', identity.pem]] });
    if (path === '/.well-known/jwks.json') return json(res, { keys: [identity.jwk] });
    if (path === '/auth/request') {
      const input = JSON.parse((await body(req)).toString() || '{}');
      const token = req.headers.authorization?.replace(/^Bearer /i, '') || input.user?.token;
      const allowed = identity.valid(token) && input.requests?.length && input.requests.every(r => resources.includes(r.resource) && ['guppy', 'gen3-analysis'].includes(r.action?.service) && r.action?.method === 'read');
      return json(res, { auth: Boolean(allowed) }, allowed ? 200 : 403);
    }
    if (path === '/auth/resources' || path === '/auth/mapping') {
      const token = req.headers.authorization?.replace(/^Bearer /i, '');
      if (!identity.valid(token)) return json(res, { error: 'Synthetic token required' }, 401);
      return json(res, path.endsWith('/mapping') ? Object.fromEntries(resources.map(r => [r, [{ service: '*', method: 'read' }]])) : resources);
    }
    if (path.startsWith('/user/')) {
      if (path === '/user/user') return json(res, { user_id: 1, username: 'synthetic@example.invalid', name: 'Synthetic Developer',
        email: 'synthetic@example.invalid', is_admin: false, project_access: projectAccess,
        authz: Object.fromEntries(resources.map(r => [r, [{ service: '*', method: 'read' }]])) });
      if (path === '/user/csrf') return json(res, { csrf: 'synthetic-only' });
      if (path === '/user/credentials/cdis/access_token') return json(res, { error: 'Real credentials are not supported' }, 404);
      return json(res, {}, 404);
    }
    if (path.startsWith('/analysis/v0/terms/')) {
      if (path.endsWith('/current')) return json(res, terms);
      if (path.endsWith('/status')) return json(res, { has_accepted_latest_terms: true, current_terms: terms });
      return json(res, { accepted: true, has_accepted_latest_terms: true, terms_version_id: 1 });
    }
    let target = targets.frontend;
    let targetPath = req.url;
    let targetMethod = req.method;
    if (path.startsWith('/guppy/')) { target = targets.guppy; targetPath = req.url.slice('/guppy'.length); }
    if (path.startsWith('/analysis/')) target = targets.analysis;
    let ppBody;
    if (path.startsWith('/protein-paint/')) {
      // Older PP clients emit both Content-Type and content-type on long
      // requests. JSON uses UTF-8; repair duplicates with the same encoding
      // before bridging, without accepting conflicting or unknown media types.
      const jsonTypes = (req.headers['content-type'] || '').split(',').map(type => type.trim());
      if (jsonTypes.length > 1 && jsonTypes.every(type =>
        /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type))) {
        req.headers['content-type'] = 'application/json';
      }
      target = targets.proteinpaint;
      const ppUrl = new URL(req.url.slice('/protein-paint'.length), target);
      if (['filter0', 'filter', 'samplelst'].some(key => ppUrl.searchParams.has(key))) {
        const payload = Object.fromEntries([...ppUrl.searchParams].map(([key, value]) => {
          try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
        }));
        const bridged = bridgePayload(payload, cases);
        // Expanded sample lists can exceed Node's HTTP request-line/header limit.
        // Public ProteinPaint query routes accept the same read operation as JSON POST.
        if (req.method === 'GET') {
          targetMethod = 'POST';
          ppBody = Buffer.from(JSON.stringify(bridged));
          ppUrl.search = '';
        } else {
          for (const key of ['filter0', 'filter', 'samplelst']) {
            if (bridged[key] === undefined) ppUrl.searchParams.delete(key);
            else ppUrl.searchParams.set(key, JSON.stringify(bridged[key]));
          }
        }
      }
      targetPath = ppUrl.pathname + ppUrl.search;
      if (req.method === 'POST' && /^application\/json(?:\s*;[^,]*)?$/i.test(req.headers['content-type'] || '')) {
        ppBody = Buffer.from(JSON.stringify(bridgePayload(JSON.parse((await body(req)).toString()), cases)));
      }
    }
    if (path.startsWith('/authz/')) {
      if (path.endsWith('/resources')) return json(res, resources);
      if (path.endsWith('/mapping')) return json(res, Object.fromEntries(resources.map(r => [r, [{ service: '*', method: 'read' }]])));
      return json(res, {}, 404);
    }
    if (path.startsWith('/lw-workspace/')) return json(res, { status: 'Stopped' });
    const token = identity.issue();
    const headers = { ...req.headers, host: new URL(target).host, authorization: `Bearer ${token}`,
      cookie: `access_token=${token}`, 'x-forwarded-host': configuredOrigin ? new URL(configuredOrigin).host : req.headers.host,
      'x-forwarded-proto': configuredOrigin ? 'https' : 'http' };
    delete headers['proxy-authorization'];
    if (ppBody) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(ppBody.length);
      delete headers['transfer-encoding'];
    }
    const destination = new URL(targetPath, target);
    if (destination.origin !== new URL(target).origin) return json(res, { error: 'Invalid sandbox path' }, 400);
    const upstream = http.request(destination, { method: targetMethod, headers }, response => {
      // Cookies are shared across localhost ports. Keep this disposable identity
      // inside the proxy instead of replacing a normal development login cookie.
      const responseHeaders = {...response.headers};
      delete responseHeaders['set-cookie'];
      res.writeHead(response.statusCode || 502, responseHeaders);
      response.pipe(res);
    });
    upstream.setTimeout(180000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) json(res, { error: 'Sandbox service unavailable' }, 502); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    if (ppBody) upstream.end(ppBody);
    else req.pipe(upstream);
  } catch (err) {
    console.error(err.message);
    if (!res.headersSent) json(res, { error: 'Invalid sandbox request' }, 400);
    else res.destroy();
  }
});
server.listen(Number(process.env.PORT || 8080), process.env.BIND_ADDRESS || '0.0.0.0');
