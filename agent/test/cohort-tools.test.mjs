import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, cohortLabel } from '../src/tools/update-cohort/filter.mjs';
import { resolveField, resolveValues } from '../src/tools/update-cohort/match.mjs';
import { createExecutor as updateCohort } from '../src/tools/update-cohort/index.mjs';
import { createExecutor as showLollipop } from '../src/tools/show-lollipop/index.mjs';
import { createExecutor as showSurvival } from '../src/tools/show-survival/index.mjs';
import { createExecutor as showOncomatrix } from '../src/tools/show-oncomatrix/index.mjs';

const RACE = 'demographic.race';
const RACES = ['white', 'black or african american', 'asian', 'not reported'];
const respond = value => new Response(JSON.stringify(value));

function virtualLab({ counts = [1000, 334], track, gene = { name: 'KRAS', chr: 'chr12', start: 1, stop: 2 } } = {}) {
  const calls = [];
  const remaining = [...counts];
  const fetchImpl = async (path, options) => {
    const body = JSON.parse(options.body);
    calls.push({ path, body });
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

test('update_cohort returns the merged filter and cohort', async () => {
  const { fetchImpl } = virtualLab();
  const result = await updateCohort({ fetchImpl })({ changes: [{ field: 'race', op: 'set', values: ['Black'] }] }, {});
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, 'The cohort went from 1000 to 334 cases.');
  assert.deepEqual(result.filter, { and: [{ in: { [RACE]: ['black or african american'] } }] });
  assert.equal(result.cohort.caseCount, 334);
  assert.equal(result.casesBefore, 1000);
  assert.equal(result.changes[0].field, RACE);
});

test('update_cohort reports each outcome with its details', async () => {
  const run = (changes, lab = virtualLab()) => updateCohort({ fetchImpl: lab.fetchImpl })({ changes }, {});
  const set = values => [{ field: 'race', op: 'set', values }];
  const ambiguous = await run(set(['an']));
  assert.equal(ambiguous.status, 'ambiguous');
  assert.ok(ambiguous.options.includes('asian'));
  assert.equal(ambiguous.field, RACE);
  assert.equal((await run(set(['martian']))).status, 'unknown_value');
  assert.equal((await run(set(['asian']), virtualLab({ counts: [1000, 0] }))).status, 'would_be_empty');
  assert.equal((await run([{ field: 'age', op: 'remove' }])).status, 'unsupported_field');
  assert.equal((await run([{ field: 'zzzzzz', op: 'remove' }])).status, 'unknown_field');
  assert.equal((await run([])).status, 'error');
  assert.equal((await updateCohort(virtualLab())({ changes: [{ field: 'race', op: 'remove' }] }, { cohortFilter: { or: [] } })).status, 'error');
});

test('show_lollipop reports samples, variants and the most frequent, within the cohort', async () => {
  const filter = { and: [{ in: { [RACE]: ['asian'] } }] };
  const track = { sampleTotalNumber: 148, skewer: [{ mname: 'p.G12C', occurrence: 5 }, { mname: 'p.Q61H', occurrence: 38 },
    { mname: 'p.G12V', occurrence: 27 }, { mname: 'p.G12D', occurrence: 23 }, { mname: 'p.X1' }] };
  const lab = virtualLab({ counts: [334], track });
  const result = await showLollipop({ fetchImpl: lab.fetchImpl })({ gene: ' kras ' }, { cohortFilter: filter });
  assert.equal(result.status, 'ok');
  assert.match(result.summary, /148 samples in this cohort of 334 cases have a KRAS mutation, across 5 variants/);
  assert.match(result.summary, /Most frequent: p\.Q61H \(38 samples\), p\.G12V \(27 samples\), p\.G12D \(23 samples\)/);
  assert.deepEqual(result.plot, { type: 'lollipop', gene: 'KRAS' });
  assert.equal(result.cohort.caseCount, 334);
  assert.deepEqual(lab.calls.find(call => call.path.endsWith('/mds3')).body.filter0, filter);
});

test('show_lollipop treats a gene with no cohort mutations as a result, including a missing total', async () => {
  const lab = virtualLab({ counts: [334], track: { skewer: [] } });
  const result = await showLollipop({ fetchImpl: lab.fetchImpl })({ gene: 'KRAS' }, {});
  assert.equal(result.status, 'none_in_cohort');
  assert.match(result.summary, /0 of 334 cases/);
  assert.equal(result.plot, undefined);
});

test('show_lollipop explains unknown genes and rejects malformed data', async () => {
  const run = (gene, lab) => showLollipop({ fetchImpl: lab.fetchImpl })({ gene }, {});
  const missing = await run('BRCA1', virtualLab({ gene: null }));
  assert.equal(missing.status, 'no_data_for_gene');
  assert.deepEqual(missing.coveredGenes, ['KRAS', 'NRAS']);
  assert.equal((await run('not a gene!', virtualLab({ gene: null }))).status, 'unknown_gene');
  assert.equal((await run('', virtualLab())).status, 'error');
  await assert.rejects(run('KRAS', virtualLab({ counts: [1], track: { sampleTotalNumber: 3, skewer: [] } })), /lollipop data/);
});

const survivalReply = {
  keys: ['seriesId', 'time', 'survival', 'nevent', 'ncensor', 'nrisk'],
  case: [['High risk', 1, 0.8, 2, 1, 3], ['High risk', 2, 0.4, 1, 0, 1], ['Standard risk', 1, 0.9, 1, 3, 4]],
  tests: { '': [{ series1: 'High risk', series2: 'Standard risk', pvalue: 0 }] },
};

function survivalLab(reply = survivalReply) {
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, body: options.body && JSON.parse(options.body) });
    if (path.includes('termdb/config')) return respond({ termdbConfig: { loneTermByType: { '': { survival: { id: 'overall_survival', unit: 'years' } } } } });
    if (path.includes('termdb/termchildren')) return respond({ lst: [{ id: 'cgs_risk_category' }] });
    if (path.includes('termdb/survival')) return respond(reply);
    return respond({ data: { Case__aggregation: { case: { _totalCount: 7 } } } });
  };
  return { calls, execute: showSurvival({ fetchImpl }) };
}

test('show_survival summarizes a comparison and says what the chart should draw', async () => {
  const { execute, calls } = survivalLab();
  const result = await execute({ compareBy: 'CGS risk' }, {});
  assert.equal(result.status, 'ok');
  assert.match(result.summary, /^7 cases, overall survival, compared by CGS risk\. High risk: 3 cases, 3 deaths, 1 censored, median 2\.00 years\./);
  assert.match(result.summary, /Log-rank P-value shows 0 on the chart/);
  assert.deepEqual(result.plot, { type: 'survival', term: 'overall_survival', compareBy: 'cgs_risk_category' });
  assert.deepEqual(result.groups, ['High risk', 'Standard risk']);
  assert.equal(result.comparedBy, 'CGS risk');
  assert.deepEqual(calls.find(call => call.path.includes('survival/') || call.path.includes('termdb/survival')).body.filter0, { and: [] });
});

test('show_survival handles one curve, one group, unknown comparisons and bad replies', async () => {
  const single = await survivalLab().execute({}, {});
  assert.deepEqual(single.plot, { type: 'survival', term: 'overall_survival' });
  const oneGroup = { ...survivalReply, case: survivalReply.case.slice(0, 2) };
  assert.equal((await survivalLab(oneGroup).execute({ compareBy: 'risk' }, {})).status, 'one_group');
  const unknown = await survivalLab().execute({ compareBy: 'height' }, {});
  assert.equal(unknown.status, 'unsupported_comparison');
  assert.ok(unknown.available.includes('Race'));
  await assert.rejects(survivalLab({ error: 'x' }).execute({}, {}), /rejected/);
  assert.equal((await survivalLab({ keys: [], case: [] }).execute({}, {})).status, 'error');
  assert.equal((await survivalLab({ ...survivalReply, case: [] }).execute({}, {})).status, 'no_cases');
});

test('show_oncomatrix ranks genes, counts samples and limits to maxGenes', async () => {
  const fetchImpl = async (path, options) => {
    const body = JSON.parse(options.body);
    if (path.includes('topMutatedGenes')) return respond({ genes: [{ gene: 'KRAS', mutationStat: [{ count: 5 }] }, { gene: 'NRAS', mutationStat: [{ count: 3 }] }] });
    if (path.includes('genelookup')) return respond({ gmlst: [{ name: body.input, chr: 'chr1', start: 1, stop: 2 }] });
    if (path.includes('mds3')) return respond({ variant2samples: { samples: [{ sample_id: 'a' }, { sample_id: body.rglst[0].chr }] } });
    return respond({ data: { Case__aggregation: { case: { _totalCount: 10 } } } });
  };
  const execute = showOncomatrix({ fetchImpl });
  const result = await execute({ maxGenes: 1 }, {});
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, '10 cases, 2 samples with a mutation in these genes. KRAS (5 samples) are the most frequently mutated.');
  assert.deepEqual(result.genes, [{ gene: 'KRAS', count: 5 }]);
  assert.deepEqual(result.plot, { type: 'oncomatrix', maxGenes: 1 });
  assert.equal((await execute({ maxGenes: 0 }, {})).status, 'error');
  assert.deepEqual((await execute({}, {})).plot, { type: 'oncomatrix' });
});
