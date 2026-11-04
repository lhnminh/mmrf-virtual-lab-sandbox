import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, cohortLabel } from '../src/tools/update-cohort/filter.mjs';
import { resolveField, resolveValues } from '../src/tools/update-cohort/match.mjs';
import { createExecutor as updateCohort } from '../src/tools/update-cohort/index.mjs';
import { createExecutor as showLollipop } from '../src/tools/show-lollipop/index.mjs';

const RACE = 'demographic.race';
const RACES = ['white', 'black or african american', 'asian', 'not reported'];
const respond = value => new Response(JSON.stringify(value));

function virtualLab({ counts = [1000, 334], track, gene = { name: 'KRAS', chr: 'chr12', start: 1, stop: 2 } } = {}) {
  const calls = [];
  const remaining = [...counts];
  const fetchImpl = async (path, options) => {
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    if (path === '/guppy/graphql' && body.query.includes('CaseCentric')) {
      return respond({ data: { CaseCentric_case_centric: [{ case_id: 'b' }, { case_id: 'a' }] } });
    }
    if (path === '/guppy/graphql' && body.query.includes('_totalCount')) {
      return respond({ data: { Case__aggregation: { case: { _totalCount: remaining.shift() } } } });
    }
    if (path === '/guppy/graphql') {
      return respond({ data: { Case__aggregation: { case: { demographic: { race: {
        histogram: RACES.map(key => ({ key, count: 1 })) } } } } } });
    }
    if (path.endsWith('/genelookup')) return respond({ gmlst: gene ? [gene] : [] });
    if (path.endsWith('/termdb/topMutatedGenes')) return respond({ genes: [{ gene: 'KRAS' }, { gene: 'NRAS' }] });
    if (path.endsWith('/mds3')) return respond(track);
    throw new Error(`Unexpected call: ${path}`);
  };
  return { fetchImpl, calls };
}

test('fields resolve by name and synonym, and report unsupported or close matches', () => {
  assert.equal(resolveField('race').name, RACE);
  assert.equal(resolveField('Race').supported, true);
  assert.equal(resolveField('age').supported, false);
  assert.ok(resolveField('racce').closest.some(item => item.field === RACE));
  assert.deepEqual(resolveField('zzzzzz').closest, []);
});

test('values resolve by case, punctuation and unique word, and report ambiguity', () => {
  const risks = ['High risk', 'Standard risk'];
  assert.deepEqual(resolveValues(['HIGH RISK'], risks), { values: ['High risk'] });
  assert.deepEqual(resolveValues(['high-risk', 'high_risk'], risks), { values: ['High risk'] });
  assert.deepEqual(resolveValues(['black'], RACES), { values: ['black or african american'] });
  assert.deepEqual(resolveValues(['risk'], risks), { ambiguous: 'risk', options: risks });
  assert.deepEqual(resolveValues(['martian'], RACES), { unknown: 'martian' });
});

test('changes replace, add and remove fields, keeping other filters', () => {
  const nested = { nested: { path: 'x' } };
  const base = { and: [{ in: { [RACE]: ['white'] } }, nested] };
  assert.deepEqual(applyChanges(base, [{ field: RACE, op: 'set', values: ['asian'] }]),
    { and: [{ in: { [RACE]: ['asian'] } }, nested] });
  assert.deepEqual(applyChanges(null, [{ field: RACE, op: 'set', values: ['asian'] }]), { and: [{ in: { [RACE]: ['asian'] } }] });
  assert.equal(applyChanges({ and: [{ in: { [RACE]: ['white'] } }] }, [{ field: RACE, op: 'remove' }]), null);
  assert.deepEqual(base.and[0], { in: { [RACE]: ['white'] } });
});

test('filters that cannot be edited safely are refused', () => {
  assert.throws(() => applyChanges({ or: [] }, [{ field: RACE, op: 'remove' }]), /safely/);
  assert.throws(() => applyChanges({ and: [{ in: { [RACE]: [1] } }] }, [{ field: RACE, op: 'remove' }]), /safely/);
  assert.throws(() => applyChanges(null, [{ field: 'case_id', op: 'set', values: ['x'] }]), /can't be applied/);
});

test('labels describe the cohort', () => {
  assert.equal(cohortLabel(null), 'All cases');
  assert.match(cohortLabel({ and: [{ in: { [RACE]: ['asian'] } }] }), /: asian$/);
  assert.equal(cohortLabel({ and: [{ in: { case_id: ['a'] } }] }), 'Selected cases');
  assert.equal(cohortLabel({ or: [] }), 'Selected cases');
});

test('update_cohort applies a change and returns the new filter for the UI', async () => {
  const { fetchImpl } = virtualLab();
  const result = await updateCohort({ fetchImpl })({ changes: [{ field: 'race', op: 'set', values: ['Black'] }] }, {});
  assert.match(result.summary, /from 1000 to 334 synthetic cases/);
  assert.doesNotMatch(result.summary, /went from/);
  assert.deepEqual(result.plot.filter, { and: [{ in: { [RACE]: ['black or african american'] } }] });
  assert.equal(result.plot.type, 'cohort_update');
  // Chat's Save button reads plot.cohort.name and plot.cohort.caseIds.
  assert.deepEqual(result.plot.cohort.caseIds, ['a', 'b']);
  assert.equal(typeof result.plot.cohort.name, 'string');
});

test('update_cohort reports ambiguous, unknown and empty results without changing the cohort', async () => {
  const run = (changes, lab = virtualLab()) => updateCohort({ fetchImpl: lab.fetchImpl })({ changes }, {});
  const set = values => [{ field: 'race', op: 'set', values }];
  const ambiguous = await run(set(['an']));
  assert.match(ambiguous.summary, /could mean more than one/);
  assert.match(ambiguous.summary, /asian/);
  assert.equal(ambiguous.plot, undefined);
  const unknown = await run(set(['martian']));
  assert.match(unknown.summary, /Available values: white/);
  assert.equal(unknown.plot, undefined);
  const empty = await run(set(['asian']), virtualLab({ counts: [1000, 0] }));
  assert.match(empty.summary, /would leave no cases/);
  assert.equal(empty.plot, undefined);
  assert.match((await run([{ field: 'age', op: 'remove' }])).summary, /number range/);
  await assert.rejects(run([]), /changes must list/);
  await assert.rejects(run([{ field: 'race', op: 'set', values: [] }]), /changes must list/);
});

test('show_lollipop reports samples, variants and the most frequent, within the cohort', async () => {
  const filter = { and: [{ in: { [RACE]: ['asian'] } }] };
  const track = { sampleTotalNumber: 148, skewer: [{ mname: 'p.G12C', occurrence: 5 }, { mname: 'p.Q61H', occurrence: 38 },
    { mname: 'p.G12V', occurrence: 27 }, { mname: 'p.G12D', occurrence: 23 }, { mname: 'p.X1' }] };
  const lab = virtualLab({ counts: [334], track });
  const result = await showLollipop({ fetchImpl: lab.fetchImpl })({ gene: ' kras ' }, { cohortFilter: filter });
  assert.match(result.summary, /148 samples in this synthetic cohort of 334 cases have a KRAS mutation, across 5 variants/);
  assert.match(result.summary, /Most frequent: p\.Q61H \(38 samples\), p\.G12V \(27 samples\), p\.G12D \(23 samples\)/);
  assert.equal(result.plot.type, 'lollipop');
  // Chat treats plot.cohort as a saveable cohort, so this result must not set it.
  assert.equal(result.plot.cohort, undefined);
  assert.equal(result.plot.selectedCohort.caseCount, 334);
  assert.deepEqual(lab.calls.find(call => call.path.endsWith('/mds3')).body.filter0, filter);
});

test('show_lollipop treats a gene with no cohort mutations as a result, including a missing total', async () => {
  const lab = virtualLab({ counts: [334], track: { skewer: [] } });
  const result = await showLollipop({ fetchImpl: lab.fetchImpl })({ gene: 'KRAS' }, {});
  assert.match(result.summary, /0 of 334 synthetic cases/);
  assert.equal(result.plot, undefined);
});

test('show_lollipop explains unknown genes and rejects malformed data', async () => {
  const run = (gene, lab) => showLollipop({ fetchImpl: lab.fetchImpl })({ gene }, {});
  assert.match((await run('BRCA1', virtualLab({ gene: null }))).summary, /isn't in this dataset.*KRAS, NRAS/);
  assert.match((await run('not a gene!', virtualLab({ gene: null }))).summary, /doesn't look like a gene/);
  await assert.rejects(run('', virtualLab()), /gene must be/);
  await assert.rejects(run('KRAS', virtualLab({ counts: [1], track: { sampleTotalNumber: 3, skewer: [] } })), /lollipop data/);
});
