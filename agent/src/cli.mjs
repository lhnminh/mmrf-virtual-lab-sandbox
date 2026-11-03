import { createStrandsRunner } from './strands-runner.mjs';
import { mockCorrelationExecutor } from './correlation-tool.mjs';

const args = process.argv.slice(2);
const mockTool = args.includes('--mock-tool');
const requireTool = args.includes('--require-tool');
const prompt = args.filter(arg => !['--mock-tool', '--require-tool'].includes(arg)).join(' ').trim();
if (!prompt) {
  console.error('Usage: npm run prompt -- "Plot age at diagnosis against overall survival"');
  process.exitCode = 2;
} else {
  try {
    const response = await createStrandsRunner(mockTool ? { execute: mockCorrelationExecutor } : {})({ prompt });
    console.log(JSON.stringify({ ...response, ...(mockTool ? { mockTool: true } : {}) }, null, 2));
    if (requireTool && !response.toolCalls.some(call => call.status === 'success')) {
      console.error('The agent did not complete a correlation_plot tool call');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
