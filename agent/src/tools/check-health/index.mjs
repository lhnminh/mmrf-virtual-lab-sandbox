import { createWrappedTool, failure, ok } from '../shared.mjs';
import { caseCount } from '../virtual-lab.mjs';

export const appId = 'Projects';
export const spec = Object.freeze({
  name: 'check_virtual_lab_health',
  description: 'Check whether the Virtual Lab is healthy, and report how many synthetic cases it holds. Takes no input.',
  inputSchema: { type: 'object', properties: {} },
});
export const promptGuidance = 'To check whether the Virtual Lab is working, call check_virtual_lab_health.';

export function createExecutor({ fetchImpl }) {
  return async () => {
    try {
      const cases = await caseCount(fetchImpl, null);
      return ok(`The Virtual Lab is healthy and holds ${cases} synthetic cases.`, { caseCount: cases });
    } catch {
      return failure('unhealthy', 'The Virtual Lab is not responding.');
    }
  };
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createWrappedTool({ spec, toolFactory, execute, context, calls });
}
