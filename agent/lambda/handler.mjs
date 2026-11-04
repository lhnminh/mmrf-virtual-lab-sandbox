import { registeredTools } from '../src/tools/index.mjs';
import { createVirtualLabFetch } from '../src/virtual-lab-fetch.mjs';

function decodeToolName(context) {
  const name = context?.clientContext?.custom?.bedrockAgentCoreToolName;
  if (typeof name !== 'string') throw new Error('Gateway did not provide a tool name');
  const separator = name.indexOf('___');
  if (separator < 1 || separator === name.length - 3) throw new Error('Invalid Gateway tool name');
  return name.slice(separator + 3);
}

export function createHandler({ tools = registeredTools, fetchFactory = createVirtualLabFetch } = {}) {
  const byName = new Map(tools.map(item => [item.spec.name, item]));
  return async (event, context) => {
    const name = decodeToolName(context);
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown Gateway tool: ${name}`);
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Tool arguments must be an object');
    const { cohortFilterJson, ...input } = event;
    let cohortFilter = null;
    if (cohortFilterJson !== undefined) {
      if (typeof cohortFilterJson !== 'string') throw new Error('cohortFilterJson must be a string');
      cohortFilter = JSON.parse(cohortFilterJson);
      if (cohortFilter !== null && (typeof cohortFilter !== 'object' || Array.isArray(cohortFilter))) {
        throw new Error('cohortFilterJson must encode an object or null');
      }
    }
    const origin = process.env.VIRTUAL_LAB_ORIGIN || 'http://127.0.0.1:3080';
    const execute = tool.createExecutor({ origin, fetchImpl: fetchFactory({ origin }) });
    const result = await execute(input, { cohortFilter });
    if (!result || typeof result.summary !== 'string' || !result.summary.trim()) {
      throw new Error(`Tool ${name} returned no summary`);
    }
    return result;
  };
}

export const handler = createHandler();
