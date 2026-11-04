import { createWrappedTool, failure, ok, outcome } from '../shared.mjs';
import { caseCount, proteinPaintConfig } from '../virtual-lab.mjs';
import { cohortLabel } from '../update-cohort/filter.mjs';

const TOP_GENES = 20;
const MIN_SET_GENES = 15; // With MAX_SET_GENES, the cutoffs the MSigDB config uses for gene set analysis.
const MAX_SET_GENES = 500;
const MIN_SAMPLES = 10; // What the top genes service asks for. Clustering fails on one sample and means little on a few.
const MAX_OPTIONS = 5;
const GENE_SETS = { dslabel: 'msigdb' };
const MEK_SET = 'MEK_UP.V1_UP';
const OTHER_MEK_SET = 'MEK_UP.V1_DN';
// Both MEK sets match "MEK", so this picks one, and the answer names the other.
const MEK_NAMES = new Set(['mek', 'mek pathway', 'mek gene set', 'mek geneset', 'mek set', 'mek signature']);
const DESCRIPTOR = /\s+(pathway|gene\s*set|set|signature)$/i;
const CLUSTERING_NOTE = 'The clustering is on the chart, and red means high relative to the other samples.';

export const appId = 'GeneExpression';
export const spec = Object.freeze({
  name: 'show_gene_clustering',
  description: 'Generates a gene expression clustering heatmap for the researcher\'s selected cohort. Use it for gene expression clustering, or an expression heatmap. Without geneSet it uses the top 20 variably expressed genes, and it can\'t use another number. Give geneSet when the researcher names a pathway or gene set, to use that MSigDB set, such as MEK or HALLMARK_HYPOXIA. The result reports the case count and the genes or gene set used, or that a set is unavailable, unclear or not found. The heatmap is drawn for the researcher, and the result holds no clusters or expression values. It never takes a cohort.',
  inputSchema: {
    type: 'object',
    properties: { geneSet: { type: 'string', description: 'The pathway or gene set, as the researcher said it, such as MEK or HALLMARK_HYPOXIA. Leave out unless the researcher names one.' } },
  },
});
export const promptGuidance = 'For gene expression clustering or an expression heatmap, call show_gene_clustering. Report only what its summary says, and never describe clusters or expression patterns.';

const casesText = count => `${count} ${count === 1 ? 'case' : 'cases'}`;
const listing = genes => (genes.length === 1 ? genes[0] : `${genes.slice(0, -1).join(', ')} and ${genes.at(-1)}`);
const tooFewSamples = (cases, cohort, action) => outcome('too_few_samples',
  `${action} needs at least ${MIN_SAMPLES} samples with expression data, and this cohort of ${casesText(cases)} has fewer, so there's no heatmap.`, { cohort });

/** Read each time, so a stack gains prebuilt sets as soon as MSigDB is added. */
async function hasGeneSets(fetchImpl) {
  const hg38 = (await proteinPaintConfig(fetchImpl, 'genomes', {}))?.genomes?.hg38;
  if (!hg38 || typeof hg38 !== 'object') throw new MalformedReply('The genome list was missing.');
  return Boolean(hg38.termdbs?.msigdb);
}

async function findGeneSets(fetchImpl, text) {
  const reply = await proteinPaintConfig(fetchImpl, 'termdb', { ...GENE_SETS, findterm: text, targetType: 'Dictionary Variables' });
  if (!Array.isArray(reply?.lst)) throw new MalformedReply('The gene set search failed.');
  return reply.lst.filter(term => term.isleaf).map(term => term.id);
}

async function geneSetGenes(fetchImpl, termId) {
  const reply = await proteinPaintConfig(fetchImpl, 'termdb', { ...GENE_SETS, genesetByTermId: termId });
  if (!Array.isArray(reply)) throw new MalformedReply('The gene set\'s genes were missing.');
  return reply.map(gene => gene.symbol);
}

/** A reply that doesn't have the expected shape, as opposed to an unreachable Virtual Lab. */
class MalformedReply extends Error {}

/** The name as said, then without a word like "pathway", then with MSigDB's underscores. */
function searchForms(name) {
  const plain = name.replace(DESCRIPTOR, '');
  return [...new Set([name, plain, plain.replace(/\s+/g, '_')])];
}

async function find(fetchImpl, name) {
  for (const form of searchForms(name)) {
    const found = await findGeneSets(fetchImpl, form);
    if (found.length) return { form, found };
  }
  return { form: name, found: [] };
}

/** The set to draw: an exact ID wins, otherwise the only result. Null if that's not decided. */
function matchingSet(form, found) {
  const exact = found.find(id => id.toLowerCase() === form.toLowerCase());
  return exact ?? (found.length === 1 ? found[0] : null);
}

async function geneSetResult(fetchImpl, name, cases, cohort) {
  if (!await hasGeneSets(fetchImpl)) {
    return outcome('prebuilt_unavailable', `Prebuilt gene sets aren't available on this Virtual Lab. The top ${TOP_GENES} variably expressed genes can be used instead.`, { cohort });
  }
  const isShortcut = MEK_NAMES.has(name.toLowerCase());
  let termId = MEK_SET;
  if (!isShortcut) {
    const { form, found } = await find(fetchImpl, name);
    if (!found.length) return outcome('gene_set_not_found', `No MSigDB gene set matches '${name}'.`, { cohort });
    termId = matchingSet(form, found);
    if (termId === null) {
      const options = found.slice(0, MAX_OPTIONS);
      return outcome('ambiguous', `${found.length} MSigDB sets match '${name}'. Some of them: ${listing(options)}.`,
        { options, matchCount: found.length, cohort });
    }
  }
  const genes = await geneSetGenes(fetchImpl, termId);
  if (!genes.length) return outcome('no_data', `The MSigDB set ${termId} lists no genes, so there's no heatmap.`, { cohort });
  if (genes.length < MIN_SET_GENES) {
    return outcome('gene_set_too_small', `The MSigDB set ${termId} lists ${genes.length} genes, and many may have no expression data here. A heatmap needs a set of at least ${MIN_SET_GENES}, so there's no heatmap.`, { cohort });
  }
  if (genes.length > MAX_SET_GENES) {
    return outcome('gene_set_too_large', `The MSigDB set ${termId} lists ${genes.length} genes, which is more than the ${MAX_SET_GENES} that can be drawn here, so there's no heatmap.`, { cohort });
  }
  const chosen = isShortcut ? `, chosen for MEK. ${OTHER_MEK_SET} is also available` : '';
  return ok(`${casesText(cases)}. Gene expression heatmap of the MSigDB set ${termId}${chosen}. The set lists ${genes.length} genes, and the heatmap draws only those with expression data, so the chart shows how many. ${CLUSTERING_NOTE}`,
    { cohort, geneSet: { id: termId, geneCount: genes.length }, plot: { type: 'gene_clustering', genes } });
}

async function topGenesResult(fetchImpl, cohortFilter, cases, cohort) {
  const reply = await proteinPaintConfig(fetchImpl, 'termdb/topVariablyExpressedGenes',
    { maxGenes: TOP_GENES, ...(cohortFilter ? { filter0: cohortFilter } : {}) });
  // A reply's error text can hold server details, so it isn't passed on.
  if (reply?.error) {
    if (String(reply.error).includes(`at least ${MIN_SAMPLES} sample`)) return tooFewSamples(cases, cohort, 'Ranking genes');
    return failure('unhealthy', 'The gene ranking failed.');
  }
  if (!Array.isArray(reply?.genes)) return failure('unhealthy', 'The ranked genes were missing.');
  const genes = reply.genes.map(gene => (typeof gene === 'string' ? gene : gene.gene));
  if (!genes.length) return outcome('no_data', `The ${casesText(cases)} in this cohort have no gene expression data, so there's no heatmap.`, { cohort });
  return ok(`${casesText(cases)}. Gene expression heatmap of the top ${genes.length} variably expressed genes: ${listing(genes)}. ${CLUSTERING_NOTE}`,
    { cohort, genes, plot: { type: 'gene_clustering', maxGenes: TOP_GENES } });
}

export function createExecutor({ fetchImpl }) {
  return async ({ geneSet } = {}, { cohortFilter = null } = {}) => {
    if (geneSet !== undefined && geneSet !== null && typeof geneSet !== 'string') {
      return failure('invalid_input', 'geneSet must be text, such as MEK.');
    }
    const name = (geneSet ?? '').trim();
    const cases = await caseCount(fetchImpl, cohortFilter);
    const cohort = { label: cohortLabel(cohortFilter), caseCount: cases };
    if (cases === 0) return outcome('no_cases', 'This cohort has no cases, so there\'s no heatmap.', { cohort });
    if (!name) return topGenesResult(fetchImpl, cohortFilter, cases, cohort);
    if (cases < MIN_SAMPLES) return tooFewSamples(cases, cohort, 'Gene expression clustering');
    try {
      return await geneSetResult(fetchImpl, name, cases, cohort);
    } catch (error) {
      if (error instanceof MalformedReply) return failure('unhealthy', error.message);
      throw error;
    }
  };
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createWrappedTool({ spec, toolFactory, execute, context, calls });
}
