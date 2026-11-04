import { createWrappedTool } from '../shared.mjs';
import { caseCount, proteinPaint } from '../virtual-lab.mjs';
import { cohortLabel } from '../update-cohort/filter.mjs';

const GENE_SHAPED = /^[A-Za-z][A-Za-z0-9-]{1,14}$/;
const TOP_VARIANTS = 3;
const MAX_GENES = 50;

export const appId = 'ProteinPaint';
export const spec = Object.freeze({
  name: 'show_lollipop',
  description: 'Show a Lollipop plot in ProteinPaint: where one gene\'s mutations fall along the protein and how often each occurs in the selected cohort. Use it for requests such as "Show a lollipop plot for KRAS" or "Where do KRAS mutations fall on the protein?". Give the gene as the researcher said it; aliases such as c-Myc resolve to MYC.',
  inputSchema: {
    type: 'object',
    properties: { gene: { type: 'string', description: 'The gene as the researcher said it, such as KRAS or c-Myc.' } },
    required: ['gene'],
    additionalProperties: false,
  },
});
export const promptGuidance = 'For a lollipop plot, or where a gene\'s mutations fall on the protein, call show_lollipop.';

function region(gene) {
  if (!gene.chr || !Number.isFinite(gene.start) || !Number.isFinite(gene.stop)) throw new Error('The gene has no genomic region');
  return [{ chr: gene.chr, start: gene.start, stop: gene.stop, width: 800 }];
}

async function track(fetchImpl, gene, filter) {
  const reply = await proteinPaint(fetchImpl, 'mds3', { forTrack: 1, skewer: 1, rglst: region(gene) }, filter);
  const variants = reply.skewer;
  // ProteinPaint omits the total when no sample in the cohort has a mutation in the gene.
  const total = reply.sampleTotalNumber ?? (Array.isArray(variants) && !variants.length ? 0 : null);
  if (!Array.isArray(variants) || !Number.isInteger(total) || total < 0 || (total === 0) !== !variants.length) {
    throw new Error('The lollipop data was missing');
  }
  return { samples: total, variants };
}

async function coveredGenes(fetchImpl) {
  const reply = await proteinPaint(fetchImpl, 'termdb/topMutatedGenes', { maxGenes: MAX_GENES });
  if (!Array.isArray(reply.genes)) throw new Error('Mutation service returned no gene list');
  return reply.genes.map(item => item.gene).filter(Boolean);
}

export function createExecutor({ fetchImpl }) {
  return async ({ gene: requestedGene } = {}, { cohortFilter = null } = {}) => {
    const requested = typeof requestedGene === 'string' ? requestedGene.trim() : '';
    if (!requested) throw new Error('gene must be the name of a gene, such as KRAS');
    const [gene] = (await proteinPaint(fetchImpl, 'genelookup', { input: requested, deep: 1 })).gmlst ?? [];
    if (!gene) {
      if (!GENE_SHAPED.test(requested)) return { summary: `'${requested}' doesn't look like a gene symbol. Please check the name.` };
      const covered = await coveredGenes(fetchImpl);
      return { summary: `${requested} isn't in this dataset. Genes with mutation data here: ${covered.join(', ')}.` };
    }
    if (!gene.name) throw new Error('The gene lookup had no name');
    const cases = await caseCount(fetchImpl, cohortFilter);
    const { samples, variants } = await track(fetchImpl, gene, cohortFilter);
    const cohort = { label: cohortLabel(cohortFilter), caseCount: cases };
    if (samples === 0) return { summary: `0 of ${cases} synthetic cases in this cohort have a ${gene.name} mutation.` };
    const topVariants = [...variants].sort((a, b) => (b.occurrence ?? 0) - (a.occurrence ?? 0)).slice(0, TOP_VARIANTS)
      .map(item => ({ change: item.mname, count: item.occurrence ?? 0 }));
    const listing = topVariants.map(item => `${item.change} (${item.count} samples)`).join(', ');
    return {
      summary: `${samples} samples in this synthetic cohort of ${cases} cases have a ${gene.name} mutation, across ${variants.length} variants. Most frequent: ${listing}.`,
      plot: { type: 'lollipop', gene: gene.name, sampleCount: samples, variantCount: variants.length, topVariants, cohort },
    };
  };
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createWrappedTool({ spec, toolFactory, execute, context, calls });
}
