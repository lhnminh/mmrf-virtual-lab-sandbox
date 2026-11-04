// Kaplan-Meier overall survival through the Gen3 analysis service, returned in
// the shape the Virtual Lab's SurvivalPlot component renders.
export const MINIMUM_CASES = 10; // Matches the frontend SurvivalPlot.
export const MAXIMUM_CURVES = 5;
const SURVIVAL_PATH = '/analysis/v0/survival/';

export function groupFilters(field, values, cohortFilter) {
  return values.map(value => {
    const group = { in: { [field]: [value] } };
    return cohortFilter ? { and: [cohortFilter, group] } : group;
  });
}

export function formatPValue(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return 'not available';
  if (p === 0) return '<1e-300';
  return p < 0.001 ? p.toExponential(1) : String(Number(p.toPrecision(2)));
}

export function createSurvivalHandler({ origin = process.env.VIRTUAL_LAB_ORIGIN || 'http://127.0.0.1:3080',
  fetchImpl = fetch } = {}) {
  const endpoint = new URL(SURVIVAL_PATH, origin);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('VIRTUAL_LAB_ORIGIN must be an HTTP(S) origin without credentials');
  }
  return async function survival(group, { cohortFilter = null } = {}) {
    const values = group.values;
    if (values.length > MAXIMUM_CURVES) {
      throw new Error(`${group.label} has ${values.length} values; at most ${MAXIMUM_CURVES} curves are supported`);
    }
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filters: groupFilters(group.gen3Field, values, cohortFilter) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Survival service returned HTTP ${response.status}`);
    const data = await response.json();
    const results = data?.results;
    if (!Array.isArray(results) || results.length !== values.length) {
      throw new Error('Survival service returned an unexpected response');
    }
    const counts = results.map(curve => curve.donors?.length ?? 0);
    const small = values.flatMap((value, i) => counts[i] < MINIMUM_CASES ? [`${value} (n=${counts[i]})`] : []);
    if (small.length) {
      throw new Error(`Not enough survival data: ${small.join(', ')}; each group needs at least ${MINIMUM_CASES} cases`);
    }
    const pValue = data.overallStats?.pValue;
    const groups = values.map((value, i) => `${value} n=${counts[i]}`).join(', ');
    return {
      summary: `Overall survival by ${group.label}: ${groups}; log-rank p=${formatPValue(pValue)}. ` +
        `${cohortFilter ? 'Limited to the selected cohort. ' : ''}Synthetic data with no clinical meaning.`,
      plot: {
        type: 'survival',
        field: group.key,
        outcome: 'overall_survival',
        unit: 'days',
        labels: values,
        counts,
        survivalData: results,
        overallStats: data.overallStats ?? {},
        correlation: { term1: 'overall_survival', term2: group.ppTerm, filter0: cohortFilter },
      },
    };
  };
}
