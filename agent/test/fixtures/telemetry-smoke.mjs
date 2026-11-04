// Run in a child process with ADOT preloaded, just like the container entrypoint.
import assert from 'node:assert/strict';
import { Model } from '@strands-agents/sdk';
import { trace } from '@opentelemetry/api';
import { createStrandsRunner } from '../../src/strands-runner.mjs';

class ScriptedModel extends Model {
  calls = 0;
  constructor(config) { super(); this.config = config; }
  getConfig() { return this.config; }
  updateConfig(config) { Object.assign(this.config, config); }
  async *stream() {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (this.calls++ === 0) {
      yield { type: 'modelContentBlockStartEvent', start: {
        type: 'toolUseStart', name: 'correlation_plot', toolUseId: 'smoke-tool',
      } };
      yield { type: 'modelContentBlockDeltaEvent', delta: {
        type: 'toolUseInputDelta', input: JSON.stringify({
          primaryVariable: 'overall survival', secondaryVariable: 'CGS risk',
        }),
      } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Smoke complete' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
}

const run = createStrandsRunner({
  chatOnly: false,
  knowledgeGraph: false,
  loadBedrock: async () => ({ BedrockModel: ScriptedModel }),
  execute: async () => ({ summary: 'Mock tool: observability smoke test' }),
});
const result = await run({ prompt: 'Compare overall survival by CGS risk' });
assert.equal(result.message, 'Smoke complete');
assert.equal(result.toolCalls[0]?.status, 'success');
// Flush the provider ADOT registered; never create a second tracer provider.
await trace.getTracerProvider().getDelegate().forceFlush();
console.log('TELEMETRY_SMOKE_OK');
