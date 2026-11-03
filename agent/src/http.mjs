import http from 'node:http';
import { parsePromptRequest } from './contract.mjs';

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new TypeError('Request body exceeds 64 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new TypeError('Request body must be valid JSON'); }
}

export function createAgentServer({ runPrompt }) {
  return http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') return sendJson(res, 200, { status: 'OK' });
    if (path !== '/v1/prompts') return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      return sendJson(res, 415, { error: 'Content-Type must be application/json' });
    }
    let request;
    try {
      request = parsePromptRequest(await readBody(req));
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
