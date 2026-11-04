import { createAgentServer } from './http.mjs';
import { createStrandsRunner } from './strands-runner.mjs';

const host = process.env.AGENT_HOST || '127.0.0.1';
const port = Number(process.env.AGENT_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AGENT_PORT must be a valid port');
createAgentServer({ runPrompt: createStrandsRunner() }).listen(port, host, () => {
  console.log(`Agent listening on http://${host}:${port}`);
});
