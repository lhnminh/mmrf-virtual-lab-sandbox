export function parsePromptRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Request must be a JSON object');
  }
  const { prompt, context } = value;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
    throw new TypeError('prompt must be a nonempty string of at most 4000 characters');
  }
  if (context !== undefined && (!context || typeof context !== 'object' || Array.isArray(context))) {
    throw new TypeError('context must be a JSON object');
  }
  const cohortFilter = context?.cohortFilter;
  if (cohortFilter !== undefined && cohortFilter !== null &&
      (typeof cohortFilter !== 'object' || Array.isArray(cohortFilter))) {
    throw new TypeError('context.cohortFilter must be a JSON object or null');
  }
  return { prompt: prompt.trim(), context: { cohortFilter: cohortFilter ?? null } };
}

export function parseCorrelationInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Correlation tool input must be an object');
  }
  const { primaryVariable, secondaryVariable } = value;
  for (const [name, variable] of Object.entries({ primaryVariable, secondaryVariable })) {
    if (typeof variable !== 'string' || !variable.trim() || variable.length > 200) {
      throw new TypeError(`${name} must be a nonempty string of at most 200 characters`);
    }
  }
  return { primaryVariable: primaryVariable.trim(), secondaryVariable: secondaryVariable.trim() };
}

export function parseCorrelationResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 4000) {
    throw new TypeError('Correlation tool must return an object with a nonempty summary');
  }
  return { summary: value.summary, ...(value.plot === undefined ? {} : { plot: value.plot }) };
}
