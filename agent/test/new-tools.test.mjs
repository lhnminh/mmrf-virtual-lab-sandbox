import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutor as topGenes } from '../src/tools/top-mutated-genes/index.mjs';
import { createExecutor as differentialExpression } from '../src/tools/differential-expression/index.mjs';

function fakeApi(handler) {
  const calls = [];
  const fetchImpl = async (path, options) => {
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    return { ok: true, json: async () => handler(path, body) };
  };
  return { fetchImpl, calls };
}

test('top genes tool applies the selected cohort and returns a savable cohort', async () => {
  const { fetchImpl, calls } = fakeApi(path => path === '/guppy/graphql'
    ? { data: { CaseCentric_case_centric: [{ case_id: 'C1' }, { case_id: 'C2' }] } }
    : { genes: [
      { gene: 'NRAS', mutationStat: [{ count: 1 }] },
      { gene: 'KRAS', mutationStat: [{ count: 2 }] },
    ] });
  const selected = { in: { 'demographic.gender': ['female'] } };
  const result = await topGenes({ fetchImpl })({ race: 'Black or African American', limit: 2 }, { cohortFilter: selected });
  assert.deepEqual(result.plot.genes, [{ gene: 'KRAS', count: 2 }, { gene: 'NRAS', count: 1 }]);
  assert.deepEqual(result.plot.cohort.caseIds, ['C1', 'C2']);
  assert.deepEqual(calls[0].body.variables.filter.and[0], selected);
  assert.deepEqual(calls[1].body.filter0, calls[0].body.variables.filter);
});

test('differential expression uses tested negatives and ranks adjusted p-values', async () => {
  const positive = Array.from({ length: 12 }, (_, i) => 'C' + i);
  const negative = Array.from({ length: 12 }, (_, i) => 'C' + (i + 12));
  const { fetchImpl, calls } = fakeApi((path, body) => {
    if (path.endsWith('/gene_cases')) return [...positive, 'NOT_TESTED'];
    if (path.endsWith('/cases/')) return {
      data: [...positive, ...negative].map(case_id => ({ case_id })),
      pagination: { total: 24 },
    };
    if (body.preAnalysis) return { data: { 'KRAS no mutation detected': 12, 'KRAS mutated': 12 } };
    return { data: { dots: [
      { gene_name: 'GENE_B', adjusted_p_value: 0.02, fold_change: 1 },
      { gene_name: 'GENE_A', adjusted_p_value: 0.01, fold_change: -2 },
    ], volcanoPng: 'data:image/png;base64,test' } };
  });
  const result = await differentialExpression({ fetchImpl })({ gene: 'KRAS', limit: 2 });
  assert.deepEqual(result.plot.genes.map(item => item.gene), ['GENE_A', 'GENE_B']);
  assert.deepEqual(result.plot.groups.map(item => item.caseIds.length), [12, 12]);
  assert.equal(result.plot.groups[0].caseIds.includes('NOT_TESTED'), false);
  assert.equal(calls.filter(item => item.path.endsWith('/DE')).length, 2);
  assert.equal(calls.at(-1).body.filter0, null);
});
