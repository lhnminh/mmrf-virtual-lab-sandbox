import * as correlationPlot from './correlation-plot/index.mjs';
import * as topMutatedGenes from './top-mutated-genes/index.mjs';
import * as differentialExpression from './differential-expression/index.mjs';
import * as updateCohort from './update-cohort/index.mjs';
import * as showLollipop from './show-lollipop/index.mjs';
import * as showSurvival from './show-survival/index.mjs';
import * as showOncomatrix from './show-oncomatrix/index.mjs';
import * as checkHealth from './check-health/index.mjs';

// Add one import and one entry for each tool. Gateway and Lambda use this list.
export const registeredTools = [correlationPlot, topMutatedGenes, differentialExpression, updateCohort,
  showLollipop, showSurvival, showOncomatrix, checkHealth];

export function createExecutors(deps = {}) {
  return Object.fromEntries(registeredTools.map(item => [item.spec.name, item.createExecutor(deps)]));
}
