import { createWrappedTool, failure, ok, outcome } from '../shared.mjs';
import { caseCount, fieldValues } from '../virtual-lab.mjs';
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
export const promptGuidance = 'If the question changes who is in the cohort, call update_cohort before other tools. Comparing groups does not change the cohort. If update_cohort says a value is ambiguous, ask one question offering its options and run no other tools until answered.';

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
      return { problem: outcome('unknown_field', `There's no cohort field called '${change.field}'.`, { closest: found.closest }) };
    }
    if (!found.supported) {
      return { problem: outcome('unsupported_field', `${found.label} is a number range, which isn't supported yet.`,
        { field: found.name, label: found.label }) };
    }
    let values = [];
    if (change.op === 'set') {
      const available = await fieldValues(fetchImpl, found.name);
      const match = resolveValues(change.values, available);
      const details = { field: found.name, label: found.label };
      if (match.ambiguous) {
        return { problem: outcome('ambiguous', `'${match.ambiguous}' could mean more than one ${found.label} value.`,
          { ...details, requested: match.ambiguous, options: match.options }) };
      }
      if (match.unknown) {
        return { problem: outcome('unknown_value', `${found.label} has no value like '${match.unknown}'.`,
          { ...details, requested: match.unknown, available }) };
      }
      ({ values } = match);
    }
    resolved.push({ field: found.name, label: found.label, values, op: change.op });
  }
  return { resolved };
}

export function createExecutor({ fetchImpl }) {
  return async ({ changes } = {}, { cohortFilter = null } = {}) => {
    if (!validChanges(changes)) return failure('invalid_input', 'changes must list a field, an op of set or remove, and values for set.');
    const { resolved, problem } = await resolveChanges(changes, fetchImpl);
    if (problem) return problem;
    let filter;
    try {
      filter = applyChanges(cohortFilter, resolved);
    } catch {
      return failure('unsupported_filter', 'This cohort has a filter chat can\'t edit. Change it in Cohort Builder.');
    }
    const casesBefore = await caseCount(fetchImpl, cohortFilter);
    const casesAfter = await caseCount(fetchImpl, filter);
    if (casesAfter === 0) {
      return outcome('would_be_empty', 'That change would leave no cases, so the cohort is unchanged.',
        { changes: resolved, caseCount: 0 });
    }
    return ok(`The cohort went from ${casesBefore} to ${casesAfter} cases.`, {
      changes: resolved, casesBefore, casesAfter, filter,
      cohort: { label: cohortLabel(filter), caseCount: casesAfter },
    });
  };
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createWrappedTool({ spec, toolFactory, execute, context, calls });
}
