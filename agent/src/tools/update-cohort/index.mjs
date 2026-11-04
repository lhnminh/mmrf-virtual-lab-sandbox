import { cohortProposal, createWrappedTool } from '../shared.mjs';
import { caseCount, caseIds, fieldValues } from '../virtual-lab.mjs';
import { applyChanges, cohortLabel } from './filter.mjs';
import { resolveField, resolveValues } from './match.mjs';

export const appId = 'CohortBuilder';
export const spec = Object.freeze({
  name: 'update_cohort',
  description: 'Add, replace or remove filters on the researcher\'s selected cohort, such as "only Black patients" or "drop the sex filter". Give each field and value as the researcher said it; the tool matches them to the data and says if one is ambiguous or unknown. All changes in one call apply together or not at all.',
  inputSchema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'The changes to make, applied together.',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'The field as the researcher said it, such as race, sex or ISS stage.' },
            op: { type: 'string', enum: ['set', 'remove'], description: 'set replaces any value on the field; remove clears it.' },
            values: { type: 'array', items: { type: 'string' }, description: 'The values as the researcher said them. Leave empty for remove.' },
          },
          required: ['field', 'op'],
        },
      },
    },
    required: ['changes'],
  },
});
export const promptGuidance = 'If the question changes who is in the cohort, call update_cohort before other tools. Comparing groups does not change the cohort. If update_cohort says a value is ambiguous, ask one question offering its options and run no other tools until answered. The change takes effect only when the researcher clicks the Save button under your answer, so say that and never say the cohort has already changed.';

function validChanges(changes) {
  return Array.isArray(changes) && changes.length > 0 && changes.every(change =>
    change && typeof change.field === 'string' && ['set', 'remove'].includes(change.op) &&
    (change.op === 'remove' || (Array.isArray(change.values) && change.values.length > 0 &&
      change.values.every(value => typeof value === 'string'))));
}

async function resolveChanges(changes, fetchImpl) {
  const resolved = [];
  for (const change of changes) {
    const found = resolveField(change.field);
    if (found.closest) {
      const options = found.closest.map(item => item.label).join(', ');
      return { problem: `There's no cohort field called '${change.field}'.${options ? ` Closest fields: ${options}.` : ''}` };
    }
    if (!found.supported) return { problem: `${found.label} is a number range, which isn't supported yet.` };
    let values = [];
    if (change.op === 'set') {
      const available = await fieldValues(fetchImpl, found.name);
      const match = resolveValues(change.values, available);
      if (match.ambiguous) {
        return { problem: `'${match.ambiguous}' could mean more than one ${found.label} value: ${match.options.join(', ')}.` };
      }
      if (match.unknown) {
        return { problem: `${found.label} has no value like '${match.unknown}'. Available values: ${available.join(', ')}.` };
      }
      ({ values } = match);
    }
    resolved.push({ field: found.name, label: found.label, values, op: change.op });
  }
  return { resolved };
}

export function createExecutor({ fetchImpl }) {
  return async ({ changes } = {}, { cohortFilter = null } = {}) => {
    if (!validChanges(changes)) throw new Error('changes must list a field, an op of set or remove, and values for set');
    const { resolved, problem } = await resolveChanges(changes, fetchImpl);
    if (problem) return { summary: `${problem} The cohort is unchanged.` };
    const filter = applyChanges(cohortFilter, resolved);
    const casesBefore = await caseCount(fetchImpl, cohortFilter);
    const casesAfter = await caseCount(fetchImpl, filter);
    if (casesAfter === 0) return { summary: 'That change would leave no cases, so the cohort is unchanged.' };
    const label = cohortLabel(filter);
    return {
      summary: `This change would take the cohort from ${casesBefore} to ${casesAfter} synthetic cases: ${label}.`,
      // Chat offers plot.cohort, with its case ids, through the Save cohort button.
      plot: { type: 'cohort_update', filter, label, changes: resolved, casesBefore, casesAfter,
        cohort: cohortProposal(label, await caseIds(fetchImpl, filter)) },
    };
  };
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createWrappedTool({ spec, toolFactory, execute, context, calls });
}
