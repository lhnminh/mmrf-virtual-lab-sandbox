import http from 'node:http';
import { parsePromptRequest } from './contract.mjs';
import { toolCatalog } from './tool-catalog.mjs';

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

const AGUI_BODY_LIMIT = 1024 * 1024; // A run carries the conversation and the cohort.

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new TypeError(`Request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new TypeError('Request body must be valid JSON'); }
}

async function sendRun(res, body, runAgUi) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
  try {
    for await (const event of runAgUi(body)) {
      if (res.destroyed) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } finally {
    res.end();
  }
}

export function createAgentServer({ runPrompt, runAgUi, catalog = toolCatalog }) {
  return http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { status: 'OK' });
    if (req.method === 'GET' && path === '/ping') return sendJson(res, 200, { status: 'Healthy' });
    if (req.method === 'GET' && path === '/v1/tools') return sendJson(res, 200, { apps: catalog.list() });
    if (!['/v1/prompts', '/v1/agui', '/invocations'].includes(path)) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      return sendJson(res, 415, { error: 'Content-Type must be application/json' });
    }
    let body;
    let request;
    try {
      body = await readBody(req, runAgUi ? AGUI_BODY_LIMIT : undefined);
      // Runtime has one path, so a run is told from a prompt by its threadId.
      if (runAgUi && (path === '/v1/agui' || (path === '/invocations' && body && typeof body.threadId === 'string'))) {
        return await sendRun(res, body, runAgUi);
      }
      request = parsePromptRequest(body);
    } catch (error) {
      if (error instanceof TypeError) return sendJson(res, 400, { error: error.message });
      throw error;
    }
    try {
      sendJson(res, 200, await runPrompt(request));
    } catch (error) {
      console.error('Agent invocation failed:', error);
      sendJson(res, 502, { error: 'Agent invocation failed' });
    }
  });
}
