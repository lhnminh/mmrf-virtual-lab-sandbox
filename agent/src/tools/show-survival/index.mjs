import { createWrappedTool, failure, ok, outcome } from '../shared.mjs';
import { caseCount, proteinPaint, proteinPaintConfig } from '../virtual-lab.mjs';
import { cohortLabel } from '../update-cohort/filter.mjs';

const COMPARISONS = [
  { field: 'cgs_risk_category', name: 'CGS risk', spellings: ['cgs risk', 'cgs risk category', 'cgs', 'risk', 'risk category'] },
  { field: 'kras_status', name: 'KRAS status', spellings: ['kras status', 'kras', 'kras mutation status'] },
  { field: 'gender', name: 'Sex', spellings: ['sex', 'gender'] },
  { field: 'race', name: 'Race', spellings: ['race'] },
];
const AVAILABLE = COMPARISONS.map(item => item.name);
const COLUMNS = ['seriesId', 'time', 'survival', 'nevent', 'ncensor', 'nrisk'];
const TOO_SMALL = 'shows 0 on the chart, meaning too small to calculate exactly';
const MEDIANS = 'Medians are calculated from the curve.';

export const appId = 'Correlation';
export const spec = Object.freeze({
  name: 'show_survival',
  description: 'Shows a Kaplan-Meier survival plot from the Correlation Plot tool for the researcher\'s selected cohort. Use it for survival analysis, Kaplan-Meier or overall survival, such as \'Using the Correlation Plot tool, perform Kaplan Meyer survival analysis to overlay CGS high-risk versus standard-risk\' or \'Compare survival for high risk vs standard risk\'. To compare groups, give compareBy. The result reports cases, deaths, censored cases, median survival and log-rank P-values, or says a comparison isn\'t available. It never takes a cohort, and only reports numbers; the plot is drawn for the researcher.',
  inputSchema: {
    type: 'object',
    properties: { compareBy: { type: 'string', description: 'What to split the curve by. One of: CGS risk, KRAS status, Sex, Race. Leave out for one curve.' } },
  },
});
export const promptGuidance = 'For survival analysis, call show_survival.';

const count = (number, singular, plural) => `${number} ${number === 1 ? singular : plural}`;

function readGroups(reply, unit) {
  const at = name => reply.keys.indexOf(name);
  const groups = new Map();
  for (const row of reply.case) {
    const name = row[at('seriesId')];
    if (!groups.has(name)) groups.set(name, { name, cases: Number(row[at('nrisk')]), deaths: 0, censored: 0, median: null });
    const group = groups.get(name);
    group.deaths += Number(row[at('nevent')]);
    group.censored += Number(row[at('ncensor')]);
    if (group.median === null && Number(row[at('survival')]) <= 0.5) group.median = `${Number(row[at('time')]).toFixed(2)} ${unit}`;
  }
  return [...groups.values()];
}

const outcomes = group => `${count(group.deaths, 'death', 'deaths')}, ${group.censored} censored, median ${group.median ?? 'not reached'}`;
const isZero = value => Number(value) === 0 && value !== null && value !== '';

function pValues(reply) {
  const pairs = reply.tests?.[''] ?? [];
  if (!pairs.length) return 'The service gave no log-rank P-value.';
  if (pairs.length === 1) return isZero(pairs[0].pvalue) ? `Log-rank P-value ${TOO_SMALL}.` : `Log-rank P-value: ${pairs[0].pvalue}.`;
  const listed = pairs.map(pair => `${pair.series1} vs ${pair.series2} ${isZero(pair.pvalue) ? TOO_SMALL : pair.pvalue}`);
  return `Log-rank P-values: ${listed.join(', ')}.`;
}

function summarize(groups, comparison, reply) {
  const total = groups.reduce((sum, group) => sum + group.cases, 0);
  const head = `${count(total, 'case', 'cases')}, overall survival`;
  if (!comparison) return { total, summary: `${head}. ${outcomes(groups[0])}. ${MEDIANS}` };
  if (groups.length === 1) {
    return { total, summary: `Comparing by ${comparison} leaves one group in this cohort: ${groups[0].name}. ${head}. ${outcomes(groups[0])}. ${MEDIANS}` };
  }
  const parts = groups.map(group => `${group.name}: ${count(group.cases, 'case', 'cases')}, ${outcomes(group)}.`).join(' ');
  return { total, summary: `${head}, compared by ${comparison}. ${parts} ${pValues(reply)} ${MEDIANS}` };
}

export function createExecutor({ fetchImpl }) {
  return async ({ compareBy } = {}, { cohortFilter = null } = {}) => {
    if (compareBy !== undefined && compareBy !== null && typeof compareBy !== 'string') {
      return failure('invalid_input', 'compareBy must be text, such as CGS risk.');
    }
    const asked = compareBy?.trim();
    const comparison = asked ? COMPARISONS.find(item => item.spellings.includes(asked.toLowerCase())) : null;
    if (asked && !comparison) {
      return outcome('unsupported_comparison', `There's no survival comparison by '${asked}' yet. Available: ${AVAILABLE.join(', ')}.`, { available: AVAILABLE });
    }
    const config = await proteinPaintConfig(fetchImpl, 'termdb/config', { embedder: 'localhost' });
    const term = config.termdbConfig?.loneTermByType?.['']?.survival;
    if (!term) return failure('unhealthy', 'The dataset doesn\'t offer a survival term.');
    let compareTerm = null;
    if (comparison) {
      const children = await proteinPaintConfig(fetchImpl, 'termdb/termchildren', { filter: { type: 'tvslst', in: true, join: '', lst: [] } });
      if (!Array.isArray(children.lst)) return failure('unhealthy', 'The dataset\'s field list was incomplete.');
      compareTerm = children.lst.find(item => item?.id === comparison.field) ?? null;
      if (!compareTerm) return failure('unhealthy', `The dataset doesn't list ${comparison.name}.`);
    }
    const reply = await proteinPaint(fetchImpl, 'termdb/survival', {
      term1: { $id: 'survival', term, q: {} },
      ...(compareTerm ? { term2: { $id: 'compare', term: compareTerm, q: { type: 'values' } } } : {}),
    }, cohortFilter ?? { and: [] });
    if (reply.error || !Array.isArray(reply.case) || !Array.isArray(reply.keys) || COLUMNS.some(name => !reply.keys.includes(name))) {
      return failure('unhealthy', 'The survival response was incomplete.');
    }
    const cases = await caseCount(fetchImpl, cohortFilter);
    const groups = readGroups(reply, term.unit || 'years');
    const cohort = { label: cohortLabel(cohortFilter), caseCount: cases };
    if (!groups.length) return outcome('no_cases', 'This cohort has no cases, so there\'s no survival curve.', { cohort });
    const { summary, total } = summarize(groups, comparison?.name, reply);
    const text = total === cases ? summary : `${summary} The chart counts ${total} cases, and the cohort has ${cases}.`;
    const plot = { type: 'survival', term: term.id };
    if (!comparison) return ok(text, { cohort, plot });
    const fields = { cohort, groups: groups.map(group => group.name), comparedBy: comparison.name, plot: { ...plot, compareBy: comparison.field } };
    return groups.length === 1 ? outcome('one_group', text, fields) : ok(text, fields);
  };
}

export function createTool({ toolFactory, execute, context, calls }) {
  return createWrappedTool({ spec, toolFactory, execute, context, calls });
}
