import { parseCorrelationInput } from '../contract.mjs';
import { resolveVariable } from '../variables.mjs';
import { createSurvivalHandler } from './survival.mjs';

const NOT_YET = 'Only survival comparisons (overall survival against a grouping variable) are supported so far.';

/** Correlation Plot executor: resolves both variables and dispatches by pair type. */
export function createRoutingExecutor({ survival = createSurvivalHandler() } = {}) {
  return async (rawInput, context = {}) => {
    const { primaryVariable, secondaryVariable } = parseCorrelationInput(rawInput);
    let pair;
    try {
      pair = [primaryVariable, secondaryVariable].map(resolveVariable);
    } catch (error) {
      throw new Error(`${error.message}. ${NOT_YET}`);
    }
    if (pair.some(entry => entry.kind === 'unsupported_outcome')) {
      throw new Error('Only overall survival is available; progression-free survival is not in this dataset yet.');
    }
    const outcome = pair.find(entry => entry.kind === 'outcome');
    const group = pair.find(entry => entry.kind === 'group');
    if (!outcome || !group) throw new Error(`${pair[0].label} and ${pair[1].label} cannot be compared. ${NOT_YET}`);
    return survival(group, { cohortFilter: context.cohortFilter ?? null });
  };
}
