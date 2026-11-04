import { createWrappedTool, failure, ok, outcome } from '../shared.mjs';
import { caseCount, proteinPaint } from '../virtual-lab.mjs';
import { cohortLabel } from '../update-cohort/filter.mjs';

const DEFAULT_GENES = 50;

export const appId = 'OncoMatrix';
export const spec = Object.freeze({
  name: 'show_oncomatrix',
  description: 'Shows which genes are most frequently mutated in the researcher\'s selected cohort, in OncoMatrix, with the number of cases and of samples with a mutation in the genes shown. Use it for questions such as \'which genes are most frequently mutated\', \'top mutated genes\' or \'show an OncoMatrix\'. maxGenes is optional, for requests such as \'top 3\'; it must be a whole number of 1 or more. It never takes a cohort, and only reports numbers; the chart is drawn for the researcher.',
  inputSchema: {
    type: 'object',
    properties: { maxGenes: { type: 'integer', description: 'How many top genes to show, a whole number of 1 or more. Leave out for the default.' } },
  },
});
export const promptGuidance = 'For the most frequently mutated genes or an OncoMatrix, call show_oncomatrix.';

function region(gene) {
  if (!gene.chr || !Number.isFinite(gene.start) || !Number.isFinite(gene.stop)) throw new Error('The gene has no genomic region');
  return [{ chr: gene.chr, start: gene.start, stop: gene.stop, width: 800 }];
}

export function createExecutor({ fetchImpl }) {
  return async ({ maxGenes } = {}, { cohortFilter = null } = {}) => {
    if (maxGenes !== undefined && (!Number.isInteger(maxGenes) || maxGenes < 1)) {
      return failure('invalid_input', 'maxGenes must be a whole number of 1 or more.');
    }
    const cases = await caseCount(fetchImpl, cohortFilter);
    const reply = await proteinPaint(fetchImpl, 'termdb/topMutatedGenes',
      { maxGenes: Math.max(DEFAULT_GENES, maxGenes ?? 0) }, cohortFilter);
    if (!Array.isArray(reply.genes)) return failure('unhealthy', 'The ranked genes were missing.');
    const ranking = reply.genes.map(item => ({ gene: item.gene, count: Number(item.mutationStat?.[0]?.count) }));
    const cohort = { label: cohortLabel(cohortFilter), caseCount: cases };
    if (!ranking.length) {
      return outcome('no_data', `None of the ${cases} cases in this cohort has mutation data.`, { caseCount: cases, cohort });
    }
    const genes = maxGenes ? ranking.slice(0, maxGenes) : ranking;
    const samples = new Set();
    for (const { gene } of genes) {
      const [info] = (await proteinPaint(fetchImpl, 'genelookup', { input: gene, deep: 1 })).gmlst ?? [];
      if (!info) return failure('unhealthy', `The gene lookup had no match for ${gene}.`);
      const found = await proteinPaint(fetchImpl, 'mds3',
        { variant2samples: 1, get: 'samples', rglst: region(info) }, cohortFilter);
      const list = found.variant2samples?.samples;
      if (!Array.isArray(list)) return failure('unhealthy', 'The sample list was missing.');
      for (const sample of list) samples.add(sample.sample_id);
    }
    const listing = genes.map(item => `${item.gene} (${item.count} samples)`).join(', ');
    return ok(`${cases} cases, ${samples.size} samples with a mutation in these genes. ${listing} are the most frequently mutated.`, {
      genes, caseCount: cases, sampleCount: samples.size, cohort,
      plot: { type: 'oncomatrix', ...(maxGenes ? { maxGenes } : {}) },
    });
  };
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createWrappedTool({ spec, toolFactory, execute, context, calls });
}
