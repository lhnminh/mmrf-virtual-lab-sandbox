import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../lambda/handler.mjs';
import { exportToolSchemas } from '../../scripts/export_tool_schemas.mjs';

const context = name => ({ clientContext: { custom: { bedrockAgentCoreToolName: 'virtual_lab___' + name } } });

test('Gateway handler dispatches any registered tool and keeps cohort in context', async () => {
  let received;
  const tools = [
    { spec: { name: 'first', description: 'First', inputSchema: { type: 'object', properties: {} } },
      createExecutor: () => async (input, ctx) => { received = { input, ctx }; return { summary: 'first' }; } },
    { spec: { name: 'second', description: 'Second', inputSchema: { type: 'object', properties: {} } },
      createExecutor: () => async () => ({ summary: 'second', plot: { type: 'test' } }) },
  ];
  const handler = createHandler({ tools, fetchFactory: () => () => {} });
  assert.deepEqual(await handler({ x: 1, cohortFilterJson: '{"in":{"demographic.race":["asian"]}}' }, context('first')),
    { summary: 'first' });
  assert.deepEqual(received, { input: { x: 1 }, ctx: { cohortFilter: { in: { 'demographic.race': ['asian'] } } } });
  assert.deepEqual(await handler({}, context('second')), { summary: 'second', plot: { type: 'test' } });
  await assert.rejects(() => handler({}, context('unknown')), /Unknown Gateway tool/);
  const schemas = exportToolSchemas(tools);
  assert.deepEqual(schemas.map(item => item.name), ['first', 'second']);
  assert.equal(schemas[0].inputSchema.properties.cohortFilterJson.type, 'string');
});
