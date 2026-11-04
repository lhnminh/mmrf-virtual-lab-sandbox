import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutor } from '../src/tools/show-gene-clustering/index.mjs';

const RACE_BLACK = { and: [{ in: { 'demographic.race': ['black or african american'] } }] };
const GENES = Array.from({ length: 20 }, (_, index) => `GENE${index + 1}`);
const SET_GENES = Array.from({ length: 20 }, (_, index) => `SETGENE${index + 1}`);
const sized = count => Array.from({ length: count }, (_, index) => `G${index}`);
const leaves = (...ids) => ({ lst: ids.map(id => ({ id, isleaf: true })) });
const respond = value => new Response(JSON.stringify(value));
const MSIGDB_GENOMES = { genomes: { hg38: { termdbs: { msigdb: { label: 'MSigDB' } } } } };

// Stands in for the Virtual Lab's HTTP routes, so the tool's real requests are what's checked.
function virtualLab({ cases = 334, top = { genes: GENES }, genomes = MSIGDB_GENOMES, found = {}, setGenes = SET_GENES } = {}) {
  const calls = { top: [], find: [], set: [], genomes: 0 };
  const fetchImpl = async (path, options) => {
    if (path === '/guppy/graphql') {
      assert.equal(options.method, 'POST');
      return respond({ data: { Case__aggregation: { case: { _totalCount: cases } } } });
    }
    const url = new URL(path, 'http://virtual-lab');
    const query = Object.fromEntries(url.searchParams);
    assert.equal(options?.method, undefined, 'ProteinPaint reads here are GETs');
    if (url.pathname === '/protein-paint/genomes') {
      calls.genomes += 1;
      return respond(genomes);
    }
    if (url.pathname === '/protein-paint/termdb/topVariablyExpressedGenes') {
      calls.top.push(query);
      return respond(top);
    }
    if (url.pathname === '/protein-paint/termdb' && query.findterm) {
      assert.equal(query.dslabel, 'msigdb');
      calls.find.push(query.findterm);
      return respond(found[query.findterm] ?? { lst: [] });
    }
    if (url.pathname === '/protein-paint/termdb' && query.genesetByTermId) {
      assert.equal(query.dslabel, 'msigdb');
      calls.set.push(query.genesetByTermId);
      return respond(setGenes.map?.(symbol => ({ symbol })) ?? setGenes);
    }
    throw new Error(`Unexpected call: ${path}`);
  };
  return { fetchImpl, calls };
}

const run = (lab, input = {}, cohortFilter = RACE_BLACK) => createExecutor({ fetchImpl: lab.fetchImpl })(input, { cohortFilter });

test('the top genes heatmap reports the cases and every gene, and leaves clustering to the chart', async () => {
  const result = await run(virtualLab());
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.genes, GENES);
  assert.deepEqual(result.cohort, { label: 'Race: black or african american', caseCount: 334 });
  assert.deepEqual(result.plot, { type: 'gene_clustering', maxGenes: 20 });
  assert.match(result.summary, /^334 cases\. /);
  assert.match(result.summary, /top 20 variably expressed genes/);
  assert.match(result.summary, /red means high relative to the other samples/);
  for (const gene of GENES) assert.match(result.summary, new RegExp(`\\b${gene}\\b`));
});

test('the ranking is asked for 20 genes on the selected cohort', async () => {
  const lab = virtualLab();
  await run(lab);
  assert.equal(lab.calls.top.length, 1);
  assert.equal(lab.calls.top[0].maxGenes, '20');
  assert.equal(lab.calls.top[0].genome, 'hg38');
  assert.equal(lab.calls.top[0].dslabel, 'MMRF');
  assert.deepEqual(JSON.parse(lab.calls.top[0].filter0), RACE_BLACK);
});

test('all cases send no cohort filter', async () => {
  const lab = virtualLab();
  const result = await run(lab, {}, null);
  assert.equal(lab.calls.top[0].filter0, undefined);
  assert.equal(result.cohort.label, 'All cases');
});

test('the ranking may name its genes in objects', async () => {
  const result = await run(virtualLab({ top: { genes: [{ gene: 'A' }, 'B'] } }));
  assert.deepEqual(result.genes, ['A', 'B']);
});

test('fewer genes report the real number', async () => {
  const result = await run(virtualLab({ top: { genes: GENES.slice(0, 3) } }));
  assert.equal(result.status, 'ok');
  assert.match(result.summary, /top 3 variably expressed genes: GENE1, GENE2 and GENE3\./);
});

test('one case is singular', async () => {
  const result = await run(virtualLab({ cases: 1, top: { genes: ['A'] } }));
  assert.match(result.summary, /^1 case\. /);
  assert.match(result.summary, /genes: A\./);
});

test('no cases skip the ranking', async () => {
  const lab = virtualLab({ cases: 0 });
  const result = await run(lab);
  assert.equal(result.status, 'no_cases');
  assert.deepEqual(lab.calls.top, []);
  assert.equal(result.plot, undefined);
});

test('the service refusing a small cohort is too_few_samples, not a failure', async () => {
  const result = await run(virtualLab({ cases: 4, top: { error: 'requires at least 10 samples' } }));
  assert.equal(result.status, 'too_few_samples');
  assert.equal(result.cohort.caseCount, 4);
  assert.match(result.summary, /at least 10 samples/);
  assert.equal(result.plot, undefined);
});

test('another service error is a failure that hides the server text', async () => {
  const result = await run(virtualLab({ top: { error: 'secret path /srv/data' } }));
  assert.deepEqual([result.status, result.step], ['error', 'unhealthy']);
  assert.doesNotMatch(result.summary, /secret/);
});

test('a ranking without genes is a failure', async () => {
  const result = await run(virtualLab({ top: {} }));
  assert.deepEqual([result.status, result.step], ['error', 'unhealthy']);
});

test('no ranked genes is no_data', async () => {
  const result = await run(virtualLab({ top: { genes: [] } }));
  assert.equal(result.status, 'no_data');
  assert.equal(result.cohort.caseCount, 334);
  assert.equal(result.plot, undefined);
});

for (const name of ['MEK', 'mek', ' MEK pathway ', 'MEK gene set', 'mek signature', 'MEK set']) {
  test(`"${name}" uses the MEK shortcut and names the other set`, async () => {
    const lab = virtualLab();
    const result = await run(lab, { geneSet: name });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.geneSet, { id: 'MEK_UP.V1_UP', geneCount: 20 });
    assert.deepEqual(result.plot, { type: 'gene_clustering', genes: SET_GENES });
    assert.deepEqual(lab.calls.find, []);
    assert.deepEqual(lab.calls.set, ['MEK_UP.V1_UP']);
    assert.match(result.summary, /MEK_UP\.V1_UP, chosen for MEK/);
    assert.match(result.summary, /MEK_UP\.V1_DN is also available/);
    assert.match(result.summary, /lists 20 genes/);
    assert.match(result.summary, /only those with expression data/);
    assert.match(result.summary, /red means high relative to the other samples/);
    assert.doesNotMatch(result.summary, /SETGENE1\b/);
  });
}

test('without a set, gene sets are never looked up', async () => {
  const lab = virtualLab();
  const result = await run(lab);
  assert.equal(lab.calls.genomes, 0);
  assert.deepEqual(lab.calls.find, []);
  assert.equal(result.geneSet, undefined);
});

test('a blank name means no set', async () => {
  const lab = virtualLab();
  const result = await run(lab, { geneSet: '  ' });
  assert.deepEqual(result.plot, { type: 'gene_clustering', maxGenes: 20 });
  assert.equal(lab.calls.genomes, 0);
});

test('a single search result is used', async () => {
  const lab = virtualLab({ found: { HALLMARK_HYPOXIA: leaves('HALLMARK_HYPOXIA') } });
  const result = await run(lab, { geneSet: 'HALLMARK_HYPOXIA' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(lab.calls.find, ['HALLMARK_HYPOXIA']);
  assert.equal(result.geneSet.id, 'HALLMARK_HYPOXIA');
  assert.doesNotMatch(result.summary, /chosen for|also available/);
});

test('search results that are folders are not sets', async () => {
  const found = { hypoxia: { lst: [{ id: 'FOLDER', isleaf: false }, { id: 'HALLMARK_HYPOXIA', isleaf: true }] } };
  const result = await run(virtualLab({ found }), { geneSet: 'hypoxia' });
  assert.equal(result.geneSet.id, 'HALLMARK_HYPOXIA');
});

test('the other MEK set can be asked for by ID', async () => {
  const result = await run(virtualLab({ found: { 'MEK_UP.V1_DN': leaves('MEK_UP.V1_DN') } }), { geneSet: 'MEK_UP.V1_DN' });
  assert.equal(result.geneSet.id, 'MEK_UP.V1_DN');
  assert.doesNotMatch(result.summary, /chosen for/);
});

test('an exact ID wins in any case', async () => {
  const found = { hallmark_hypoxia: leaves('HALLMARK_HYPOXIA', 'HALLMARK_HYPOXIA_DN') };
  const result = await run(virtualLab({ found }), { geneSet: 'hallmark_hypoxia' });
  assert.equal(result.geneSet.id, 'HALLMARK_HYPOXIA');
});

test('several results are ambiguous and offer five', async () => {
  const ids = Array.from({ length: 7 }, (_, index) => `SET_${index}`);
  const lab = virtualLab({ found: { hypoxia: leaves(...ids) } });
  const result = await run(lab, { geneSet: 'hypoxia' });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.options, ids.slice(0, 5));
  assert.equal(result.matchCount, 7);
  assert.match(result.summary, /7 MSigDB sets/);
  assert.deepEqual(lab.calls.set, []);
  assert.equal(result.plot, undefined);
});

test('no result is not found and keeps the researcher\'s wording', async () => {
  const lab = virtualLab();
  const result = await run(lab, { geneSet: 'MEK and hypoxia' });
  assert.equal(result.status, 'gene_set_not_found');
  assert.match(result.summary, /MEK and hypoxia/);
  assert.deepEqual(lab.calls.set, []);
  assert.equal(result.plot, undefined);
});

test('without MSigDB, a named set is unavailable and offers the top 20', async () => {
  const lab = virtualLab({ genomes: { genomes: { hg38: {} } } });
  const result = await run(lab, { geneSet: 'MEK' });
  assert.equal(result.status, 'prebuilt_unavailable');
  assert.match(result.summary, /top 20/);
  assert.deepEqual([lab.calls.find, lab.calls.set], [[], []]);
  assert.equal(result.plot, undefined);
});

test('MSigDB availability is read on each call', async () => {
  const lab = virtualLab();
  await run(lab, { geneSet: 'MEK' });
  await run(lab, { geneSet: 'MEK' });
  assert.equal(lab.calls.genomes, 2);
});

const SIZED_SET = { found: { HALLMARK_HYPOXIA: leaves('HALLMARK_HYPOXIA') } };

test('sets are drawn from 15 to 500 genes and refused outside that', async () => {
  const drawn = async count => run(virtualLab({ ...SIZED_SET, setGenes: sized(count) }), { geneSet: 'HALLMARK_HYPOXIA' });
  assert.equal((await drawn(500)).status, 'ok');
  assert.equal((await drawn(15)).status, 'ok');
  const large = await drawn(501);
  assert.equal(large.status, 'gene_set_too_large');
  assert.match(large.summary, /501/);
  assert.equal(large.plot, undefined);
  const small = await drawn(14);
  assert.equal(small.status, 'gene_set_too_small');
  assert.match(small.summary, /14/);
  assert.equal(small.plot, undefined);
});

test('an empty set is no_data', async () => {
  const result = await run(virtualLab({ ...SIZED_SET, setGenes: [] }), { geneSet: 'HALLMARK_HYPOXIA' });
  assert.equal(result.status, 'no_data');
  assert.equal(result.plot, undefined);
});

test('no cases come before any gene set lookup', async () => {
  const lab = virtualLab({ cases: 0 });
  const result = await run(lab, { geneSet: 'MEK' });
  assert.equal(result.status, 'no_cases');
  assert.deepEqual([lab.calls.genomes, lab.calls.set], [0, []]);
});

test('a name that isn\'t text is invalid', async () => {
  const lab = virtualLab();
  const result = await run(lab, { geneSet: 5 });
  assert.deepEqual([result.status, result.step], ['error', 'invalid_input']);
  assert.deepEqual(lab.calls.top, []);
});

test('malformed gene set replies are failures', async () => {
  const replies = [
    { genomes: {} },
    { found: { HALLMARK_HYPOXIA: { notLst: [] } } },
    { ...SIZED_SET, setGenes: { error: 'nope' } },
  ];
  for (const reply of replies) {
    const result = await run(virtualLab(reply), { geneSet: 'HALLMARK_HYPOXIA' });
    assert.deepEqual([result.status, result.step], ['error', 'unhealthy']);
    assert.equal(result.plot, undefined);
  }
});

test('a Virtual Lab outage rejects, as the other tools do', async () => {
  const execute = createExecutor({ fetchImpl: async () => new Response('down', { status: 503 }) });
  await assert.rejects(execute({}, { cohortFilter: null }), /HTTP 503/);
});

test('a spaced name finds the underscored set', async () => {
  const lab = virtualLab({ found: { hallmark_hypoxia: leaves('HALLMARK_HYPOXIA') } });
  const result = await run(lab, { geneSet: 'hallmark hypoxia' });
  assert.equal(result.geneSet.id, 'HALLMARK_HYPOXIA');
  assert.deepEqual(lab.calls.find, ['hallmark hypoxia', 'hallmark_hypoxia']);
});

test('a spaced name can be ambiguous', async () => {
  const ids = ['HALLMARK_KRAS_SIGNALING_DN', 'HALLMARK_KRAS_SIGNALING_UP'];
  const result = await run(virtualLab({ found: { KRAS_signaling: leaves(...ids) } }), { geneSet: 'KRAS signaling' });
  assert.deepEqual([result.status, result.options], ['ambiguous', ids]);
});

for (const name of ['hypoxia pathway', 'hypoxia gene set', 'hypoxia signature', 'hypoxia set']) {
  test(`"${name}" searches without the trailing word`, async () => {
    const result = await run(virtualLab({ found: { hypoxia: leaves('HALLMARK_HYPOXIA') } }), { geneSet: name });
    assert.equal(result.geneSet.id, 'HALLMARK_HYPOXIA');
  });
}

test('an exact ID wins after underscoring', async () => {
  const found = { hallmark_hypoxia: leaves('HALLMARK_HYPOXIA', 'HALLMARK_HYPOXIA_DN') };
  const result = await run(virtualLab({ found }), { geneSet: 'hallmark hypoxia' });
  assert.equal(result.geneSet.id, 'HALLMARK_HYPOXIA');
});

test('a named set needs 10 cases, checked before any lookup', async () => {
  const lab = virtualLab({ cases: 9 });
  const result = await run(lab, { geneSet: 'MEK' });
  assert.equal(result.status, 'too_few_samples');
  assert.match(result.summary, /at least 10 samples/);
  assert.deepEqual([lab.calls.genomes, lab.calls.set], [0, []]);
  assert.equal(result.plot, undefined);
  assert.equal((await run(virtualLab({ cases: 10 }), { geneSet: 'MEK' })).status, 'ok');
});
