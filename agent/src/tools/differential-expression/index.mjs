import { combineFilters, cohortProposal, createWrappedTool, postJson } from '../shared.mjs';

export const appId = 'DE';
export const spec = Object.freeze({
  name: 'differential_expression',
  description: 'Compare expression between mutation-positive and mutation-tested negative cases for a gene.',
  inputSchema: {
    type: 'object',
    properties: {
      gene: { type: 'string', description: 'Mutation gene symbol, such as KRAS' },
      limit: { type: 'integer', description: 'Number of leading expression genes, from 1 to 20' },
    },
    required: ['gene'],
    additionalProperties: false,
  },
});
export const promptGuidance = 'For expression differences between mutation-positive and mutation-negative cases, call differential_expression.';

const GENE_IDS = Object.freeze({
  KRAS: 'ENSG00000133703', NRAS: 'ENSG00000213281', TP53: 'ENSG00000141510',
  BRAF: 'ENSG00000157764', DIS3: 'ENSG00000083520', MYC: 'ENSG00000136997',
});

function savedFilter(name, ids) {
  return { type: 'tvs', tvs: { term: {
    type: 'cohort', id: name, name, filter0: { in: { case_id: ids } },
  } } };
}

export function createExecutor({ fetchImpl }) {
  return async ({ gene, limit = 10 } = {}, { cohortFilter = null } = {}) => {
    const symbol = String(gene || '').trim().toUpperCase();
    const geneId = GENE_IDS[symbol];
    if (!geneId) throw new Error('This synthetic dataset supports KRAS, NRAS, TP53, BRAF, DIS3 and MYC mutation groups');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer from 1 to 20');
    const carriers = await postJson(fetchImpl, '/analysis/v0/genomic/gene_cases', {
      cohort_filter: cohortFilter || {},
      gene_filter: { and: [{ in: { gene_id: [geneId] } }] },
      ssm_filter: {},
    });
    if (!Array.isArray(carriers)) throw new Error('Gene case query returned an unexpected response');
    const tested = [];
    let total;
    do {
      const response = await postJson(fetchImpl, '/analysis/v0/cases/', {
        filter: combineFilters(cohortFilter, { in: { available_variation_data: ['ssm'] } }),
        fields: ['case_id'], size: 1000, offset: tested.length,
      });
      if (!Array.isArray(response?.data) || !Number.isInteger(response?.pagination?.total)) {
        throw new Error('Tested case query returned an unexpected response');
      }
      total = response.pagination.total;
      if (!response.data.length && tested.length < total) throw new Error('Tested case query did not advance');
      tested.push(...response.data.map(item => item.case_id));
    } while (tested.length < total);
    const testedSet = new Set(tested);
    const positive = [...new Set(carriers)].filter(id => testedSet.has(id)).sort();
    const positiveSet = new Set(positive);
    const negative = [...testedSet].filter(id => !positiveSet.has(id)).sort();
    if (positive.length < 10 || negative.length < 10) {
      throw new Error('Differential expression needs at least 10 tested cases in each group');
    }
    const negativeName = `${symbol} no mutation detected`;
    const positiveName = `${symbol} mutated`;
    const groups = [
      { name: negativeName, filter: savedFilter(negativeName, negative) },
      { name: positiveName, filter: savedFilter(positiveName, positive) },
    ];
    const base = {
      genome: 'hg38', dslabel: 'MMRF', filter0: null, samplelst: { groups },
      method: 'wilcoxon', min_count: 10, min_total_count: 15, cpm_cutoff: 0,
    };
    const pre = await postJson(fetchImpl, '/protein-paint/termdb/DE', { ...base, preAnalysis: true });
    if (pre?.data?.[negativeName] !== negative.length || pre?.data?.[positiveName] !== positive.length) {
      throw new Error('Differential expression group counts do not match the tested case lists');
    }
    const analysis = await postJson(fetchImpl, '/protein-paint/termdb/DE', base);
    const dots = analysis?.data?.dots;
    if (!Array.isArray(dots) || !dots.length) throw new Error('Differential expression returned no ranked genes');
    const genes = dots.filter(item => typeof item.gene_name === 'string' && Number.isFinite(item.adjusted_p_value))
      .sort((a, b) => a.adjusted_p_value - b.adjusted_p_value || a.gene_name.localeCompare(b.gene_name))
      .slice(0, limit).map(item => ({
        gene: item.gene_name, adjustedPValue: item.adjusted_p_value, log2FoldChange: item.fold_change,
      }));
    if (!genes.length) throw new Error('Differential expression returned no usable ranked genes');
    return {
      summary: `Synthetic ${symbol} comparison: ${negativeName} n=${negative.length}, ${positiveName} n=${positive.length}; Wilcoxon top ${genes.length} by adjusted p-value: ${genes.map(item => item.gene).join(', ')}. These are demonstration results, not clinical estimates.`,
      plot: {
        type: 'differential_expression', gene: symbol, method: 'wilcoxon',
        groups: [
          cohortProposal(negativeName, negative),
          cohortProposal(positiveName, positive),
        ],
        genes,
        volcanoPng: analysis.data.volcanoPng,
      },
    };
  };
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createWrappedTool({ spec, toolFactory, execute, context, calls });
}
