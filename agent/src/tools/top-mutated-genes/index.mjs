import { combineFilters, cohortProposal, createWrappedTool, postJson } from '../shared.mjs';

export const appId = 'OncoMatrix';
export const spec = Object.freeze({
  name: 'top_mutated_genes',
  description: 'Find the most frequently mutated genes in a demographic cohort and prepare that cohort for saving.',
  inputSchema: {
    type: 'object',
    properties: {
      race: { type: 'string', description: 'Race category, such as Black or African American' },
      limit: { type: 'integer', description: 'Number of top genes, from 1 to 10' },
    },
    required: ['race'],
    additionalProperties: false,
  },
});
export const promptGuidance = 'For a question about top mutated genes in a race group, call top_mutated_genes.';

const RACES = new Map([
  ['black or african american', 'black or african american'],
  ['black', 'black or african american'],
  ['african american', 'black or african american'],
  ['white', 'white'],
  ['asian', 'asian'],
]);

export function createExecutor({ fetchImpl }) {
  return async ({ race, limit = 3 } = {}, { cohortFilter = null } = {}) => {
    const value = RACES.get(String(race || '').trim().toLowerCase());
    if (!value) throw new Error('Use a supported race category: Black or African American, White, or Asian');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be an integer from 1 to 10');
    const filter = combineFilters(cohortFilter, { in: { 'demographic.race': [value] } });
    const cases = await postJson(fetchImpl, '/guppy/graphql', {
      query: 'query($filter:JSON){CaseCentric_case_centric(first:1000,filter:$filter){case_id}}',
      variables: { filter },
    });
    const caseIds = cases?.data?.CaseCentric_case_centric?.map(item => item.case_id);
    if (!Array.isArray(caseIds)) throw new Error('Cohort query returned no case list');
    if (!caseIds.length) throw new Error('No cases match the requested cohort');
    const result = await postJson(fetchImpl, '/protein-paint/termdb/topMutatedGenes', {
      genome: 'hg38', dslabel: 'MMRF', filter0: filter,
    });
    if (!Array.isArray(result.genes)) throw new Error('Mutation service returned no gene list');
    const genes = result.genes.map(item => ({
      gene: item.gene,
      count: item.mutationStat?.[0]?.count,
    })).filter(item => typeof item.gene === 'string' && Number.isFinite(item.count))
      .sort((a, b) => b.count - a.count || a.gene.localeCompare(b.gene)).slice(0, limit);
    if (!genes.length) throw new Error('No mutated genes were found in the cohort');
    return {
      summary: `${caseIds.length} synthetic cases with race ${value}; top mutated genes: ${genes.map(item => `${item.gene} ${item.count}`).join(', ')}. These are demonstration results, not clinical estimates.`,
      plot: {
        type: 'top_mutated_genes',
        genes,
        cohort: cohortProposal(`${value} cohort`, caseIds),
        filter,
      },
    };
  };
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createWrappedTool({ spec, toolFactory, execute, context, calls });
}
