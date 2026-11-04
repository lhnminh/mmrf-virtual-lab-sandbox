import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

test('ADOT exports native Strands spans from both JSON and AG-UI ESM runners', async () => {
  // Keep the smoke test offline even when the developer has AWS/OTEL settings.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(AWS_|OTEL_|AGENT_|AGENTCORE_|KG_GATEWAY_URL)/.test(key)));
  Object.assign(env, {
    AGENT_OBSERVABILITY_ENABLED: 'true',
    AWS_REGION: 'us-west-2',
    AWS_EC2_METADATA_DISABLED: 'true',
    OTEL_SERVICE_NAME: 'mmrf-telemetry-test',
    OTEL_NODE_RESOURCE_DETECTORS: 'env',
    OTEL_NODE_ENABLED_INSTRUMENTATIONS: 'http,undici',
    OTEL_TRACES_EXPORTER: 'console',
    OTEL_TRACES_SAMPLER: 'always_on',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'false',
  });
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--require', '@aws/aws-distro-opentelemetry-node-autoinstrumentation/register',
    'test/fixtures/telemetry-smoke.mjs',
  ], { cwd: new URL('..', import.meta.url), env, timeout: 20000 });
  assert.match(stdout, /TELEMETRY_SMOKE_OK/);
  for (const operation of ['invoke_agent', 'chat', 'execute_tool']) {
    assert.ok([...stdout.matchAll(new RegExp(`'gen_ai.operation.name': '${operation}'`, 'g'))].length >= 2,
      `both runners must export ${operation} spans`);
  }
  assert.match(stdout, /'service.name': 'mmrf-telemetry-test'/);
  assert.doesNotMatch(stderr, /Error initializing|Attempted duplicate registration/);
});
