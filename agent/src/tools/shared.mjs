export async function postJson(fetchImpl, path, body) {
  const response = await fetchImpl(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Virtual Lab returned HTTP ${response.status} for ${path}`);
  const result = await response.json();
  if (result?.error || result?.errors) throw new Error(`Virtual Lab rejected ${path}`);
  return result;
}

export function combineFilters(first, second) {
  return first ? { and: [first, second] } : second;
}

export function createWrappedTool({ spec, toolFactory, execute, context, calls }) {
  return toolFactory({
    ...spec,
    callback: async input => {
      const call = { name: spec.name, input, status: 'started' };
      calls.push(call);
      try {
        const result = await execute(input, context);
        if (!result || typeof result.summary !== 'string' || !result.summary.trim()) {
          throw new Error('Tool returned no summary');
        }
        call.status = 'success';
        call.result = result;
        return { summary: result.summary };
      } catch (error) {
        call.status = 'error';
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  });
}

export function cohortProposal(name, caseIds) {
  return { name, caseIds: [...new Set(caseIds)].sort() };
}
