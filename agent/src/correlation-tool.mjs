import { parseCorrelationInput, parseCorrelationResult } from './contract.mjs';

export const CORRELATION_TOOL_SPEC = Object.freeze({
  name: 'correlation_plot',
  description: 'Run the existing Correlation Plot for two clinical or genomic variables. Ask the user to clarify missing or ambiguous variables before calling.',
  inputSchema: {
    type: 'object',
    properties: {
      primaryVariable: { type: 'string', description: 'First variable as named by the user' },
      secondaryVariable: { type: 'string', description: 'Second variable as named by the user' },
    },
    required: ['primaryVariable', 'secondaryVariable'],
    additionalProperties: false,
  },
});

export function createHttpCorrelationExecutor({ url = process.env.CORRELATION_TOOL_URL, fetchImpl = fetch } = {}) {
  if (!url) {
    return async () => { throw new Error('CORRELATION_TOOL_URL is not configured'); };
  }
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('CORRELATION_TOOL_URL must be an HTTP(S) URL without credentials');
  }
  return async (input, context) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...parseCorrelationInput(input), cohortFilter: context.cohortFilter }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Correlation tool returned HTTP ${response.status}`);
    const raw = await response.text();
    if (raw.length > 1024 * 1024) throw new Error('Correlation tool response is too large');
    return parseCorrelationResult(JSON.parse(raw));
  };
}

export async function mockCorrelationExecutor(input) {
  const { primaryVariable, secondaryVariable } = parseCorrelationInput(input);
  return {
    summary: `Mock tool received ${primaryVariable} and ${secondaryVariable}. No correlation was computed.`,
    plot: { mock: true, primaryVariable, secondaryVariable },
  };
}

export function createCorrelationTool({ toolFactory, execute, context, calls }) {
  return toolFactory({
    ...CORRELATION_TOOL_SPEC,
    callback: async (rawInput) => {
      const input = parseCorrelationInput(rawInput);
      const call = { name: 'correlation_plot', input, status: 'started' };
      calls.push(call);
      try {
        const result = parseCorrelationResult(await execute(input, context));
        call.status = 'success';
        call.result = result;
        // The model needs a concise description; the HTTP response retains plot data.
        return { summary: result.summary };
      } catch (error) {
        call.status = 'error';
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  });
}
