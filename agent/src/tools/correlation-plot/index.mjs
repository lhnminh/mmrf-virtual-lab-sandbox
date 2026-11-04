import { CORRELATION_TOOL_SPEC, createCorrelationTool, createHttpCorrelationExecutor } from '../../correlation-tool.mjs';
import { createRoutingExecutor } from '../../executors/index.mjs';
import { createSurvivalHandler } from '../../executors/survival.mjs';

export const spec = CORRELATION_TOOL_SPEC;
export const appId = 'Correlation';
export const promptGuidance = 'For survival comparisons, use correlation_plot with overall survival and the grouping variable.';

export function createExecutor({ origin, fetchImpl } = {}) {
  if (process.env.CORRELATION_TOOL_URL) return createHttpCorrelationExecutor();
  return createRoutingExecutor({
    survival: createSurvivalHandler({ origin, fetchImpl }),
  });
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createCorrelationTool({ toolFactory, execute, context, calls });
}
