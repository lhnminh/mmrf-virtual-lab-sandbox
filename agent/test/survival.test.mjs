import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveVariable } from '../src/variables.mjs';
import { createSurvivalHandler, formatPValue, groupFilters } from '../src/executors/survival.mjs';
import { createRoutingExecutor } from '../src/executors/index.mjs';
import { createStrandsRunner } from '../src/strands-runner.mjs';

// Recorded from the local stack (default seed 42): High risk 339, Standard risk 661.
const fixture = JSON.parse(await readFile(new URL('./fixtures/survival-cgs.json', import.meta.url)));
const female = { in: { 'demographic.gender': ['female'] } };

function fakeFetch(body = fixture, { ok = true, status = 200 } = {}) {
  const sent = [];
  const fetchImpl = async (url, options) => {
    sent.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok, status, json: async () => body };
  };
  return { sent, fetchImpl };
}

test('catalog resolves synonyms case-insensitively and rejects unknown or ambiguous names', () => {
  for (const name of ['CGS risk', 'cgs risk category', 'Risk group', 'CGS-Risk Category']) {
    assert.equal(resolveVariable(name).key, 'cgs_risk');
  }
  for (const name of ['overall survival', 'Survival', 'OS', 'Kaplan-Meier']) {
    assert.equal(resolveVariable(name).key, 'overall_survival');
  }
  assert.equal(resolveVariable('sex').key, 'gender');
  assert.throws(() => resolveVariable('KRAS expression'), /not a supported variable.*CGS risk category/);
  assert.throws(() => resolveVariable('overall survival by risk'), /ambiguous/);
});

test('survival handler sends one filter per group and returns the SurvivalPlot shape', async () => {
  const { sent, fetchImpl } = fakeFetch();
  const survival = createSurvivalHandler({ origin: 'http://gateway.test', fetchImpl });
  const result = await survival(resolveVariable('CGS risk'));
  assert.equal(sent[0].url, 'http://gateway.test/analysis/v0/survival/');
  assert.deepEqual(sent[0].body, { filters: [
    { in: { 'cgs_risk_key_criteria.cgs_risk_category': ['High risk'] } },
    { in: { 'cgs_risk_key_criteria.cgs_risk_category': ['Standard risk'] } },
  ] });
  const { plot } = result;
  assert.equal(plot.type, 'survival');
  assert.deepEqual(plot.labels, ['High risk', 'Standard risk']);
  assert.deepEqual(plot.counts, [339, 661]);
  assert.equal(plot.survivalData, fixture.results);
  assert.equal(plot.overallStats, fixture.overallStats);
  assert.deepEqual(plot.correlation, { term1: 'overall_survival', term2: 'cgs_risk_category', filter0: null });
  assert.match(result.summary, /High risk n=339, Standard risk n=661; log-rank p=7\.1e-60/);
  assert.match(result.summary, /Synthetic data/);
});

test('survival handler combines the website cohort with each group', async () => {
  assert.deepEqual(groupFilters('demographic.race', ['asian'], female),
    [{ and: [female, { in: { 'demographic.race': ['asian'] } }] }]);
  const { sent, fetchImpl } = fakeFetch();
  const result = await createSurvivalHandler({ origin: 'http://gateway.test', fetchImpl })(resolveVariable('CGS risk'), { cohortFilter: female });
  assert.deepEqual(sent[0].body.filters[1], { and: [female, { in: { 'cgs_risk_key_criteria.cgs_risk_category': ['Standard risk'] } }] });
  assert.equal(result.plot.correlation.filter0, female);
  assert.match(result.summary, /selected cohort/);
});

test('survival handler refuses small groups, failed responses and too many curves', async () => {
  const tiny = { results: [{ meta: {}, donors: fixture.results[0].donors.slice(0, 9) }, fixture.results[1]], overallStats: {} };
  await assert.rejects(() => createSurvivalHandler({ fetchImpl: fakeFetch(tiny).fetchImpl })(resolveVariable('CGS risk')),
    /Not enough survival data: High risk \(n=9\)/);
  await assert.rejects(() => createSurvivalHandler({ fetchImpl: fakeFetch({}, { ok: false, status: 500 }).fetchImpl })(resolveVariable('CGS risk')),
    /HTTP 500/);
  const { sent, fetchImpl } = fakeFetch();
  const many = { ...resolveVariable('race'), values: ['a', 'b', 'c', 'd', 'e', 'f'] };
  await assert.rejects(() => createSurvivalHandler({ fetchImpl })(many), /at most 5 curves/);
  assert.equal(sent.length, 0);
});

test('p-values are formatted for the summary', () => {
  assert.equal(formatPValue(7.10631305028355e-60), '7.1e-60');
  assert.equal(formatPValue(0.04321), '0.043');
  assert.equal(formatPValue(undefined), 'not available');
});

test('routing executor accepts either order and rejects unsupported pairs', async () => {
  const groups = [];
  const execute = createRoutingExecutor({ survival: async (group, context) => {
    groups.push([group.key, context.cohortFilter]);
    return { summary: 'ok' };
  } });
  await execute({ primaryVariable: 'overall survival', secondaryVariable: 'CGS risk' }, { cohortFilter: female });
  await execute({ primaryVariable: 'CGS risk category', secondaryVariable: 'survival' }, {});
  assert.deepEqual(groups, [['cgs_risk', female], ['cgs_risk', null]]);
  await assert.rejects(() => execute({ primaryVariable: 'age at diagnosis', secondaryVariable: 'KRAS expression' }, {}),
    /Only survival comparisons .* are supported so far/);
  await assert.rejects(() => execute({ primaryVariable: 'gender', secondaryVariable: 'race' }, {}), /cannot be compared/);
  await assert.rejects(() => execute({ primaryVariable: 'PFS', secondaryVariable: 'CGS risk' }, {}), /Only overall survival/);
  assert.equal(groups.length, 2);
});

test('Strands runner uses the survival executor by default and returns the plot to the UI', async () => {
  const saved = process.env.CORRELATION_TOOL_URL;
  delete process.env.CORRELATION_TOOL_URL;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch().fetchImpl;
  try {
    let modelSaw;
    class FakeAgent {
      constructor(config) { this.config = config; }
      async invoke() {
        modelSaw = await this.config.tools[0].callback({ primaryVariable: 'overall survival', secondaryVariable: 'CGS risk' });
        return { lastMessage: { content: [{ text: 'High risk n=339 vs Standard risk n=661.' }] } };
      }
    }
    const run = createStrandsRunner({
      loadSdk: async () => ({ Agent: FakeAgent, tool: definition => definition }),
      loadBedrock: async () => ({ BedrockModel: class {} }),
    });
    const response = await run({ prompt: 'Compare survival for CGS high risk vs standard risk' });
    assert.deepEqual(Object.keys(modelSaw), ['summary']);
    assert.equal(response.toolCalls[0].status, 'success');
    assert.equal(response.toolCalls[0].result.plot.type, 'survival');
    assert.deepEqual(response.toolCalls[0].result.plot.counts, [339, 661]);
  } finally {
    globalThis.fetch = realFetch;
    if (saved !== undefined) process.env.CORRELATION_TOOL_URL = saved;
  }
});

// Opt-in check against the running local stack: LIVE=1 npm test
test('live stack returns the CGS survival comparison', { skip: !process.env.LIVE }, async () => {
  const result = await createRoutingExecutor()({ primaryVariable: 'overall survival', secondaryVariable: 'CGS risk' });
  assert.deepEqual(result.plot.counts, [339, 661]);
  assert.ok(result.plot.overallStats.pValue < 0.001);
  const limited = await createRoutingExecutor()({ primaryVariable: 'survival', secondaryVariable: 'CGS risk' }, { cohortFilter: female });
  assert.equal(limited.plot.counts.reduce((a, b) => a + b, 0), 500);
});
