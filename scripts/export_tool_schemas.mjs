import { writeFile } from 'node:fs/promises';
import { registeredTools } from '../agent/src/tools/index.mjs';

export function exportToolSchemas(tools = registeredTools) {
  return tools.map(item => {
    const schema = item.spec.inputSchema;
    if (schema?.type !== 'object') throw new Error(`Invalid schema for ${item.spec.name}`);
    return {
      name: item.spec.name,
      description: item.spec.description,
      inputSchema: {
        type: 'object',
        properties: {
          ...schema.properties,
          cohortFilterJson: { type: 'string', description: 'Selected website cohort, supplied by the agent' },
        },
        required: schema.required || [],
      },
    };
  });
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const file = new URL('../terraform/agentcore-tool-schemas.json', import.meta.url);
  await writeFile(file, JSON.stringify(exportToolSchemas(), null, 2) + '\n');
  process.stdout.write(file.pathname + '\n');
}
