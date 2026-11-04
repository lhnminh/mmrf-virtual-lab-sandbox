import { getJson, postJson } from './shared.mjs';

const GENOME = { genome: 'hg38', dslabel: 'MMRF' };
const FIELD_PART = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function aggregate(fetchImpl, selection, filter) {
  const reply = await postJson(fetchImpl, '/guppy/graphql', {
    query: `query($f:JSON){Case__aggregation{case(filter:$f,accessibility:all){${selection}}}}`,
    variables: { f: filter },
  });
  const node = reply?.data?.Case__aggregation?.case;
  if (!node || typeof node !== 'object') throw new Error('The Virtual Lab data response was incomplete');
  return node;
}

export async function caseCount(fetchImpl, filter) {
  const count = (await aggregate(fetchImpl, '_totalCount', filter))._totalCount;
  if (!Number.isInteger(count)) throw new Error('The case count was missing');
  return count;
}

export async function fieldValues(fetchImpl, field) {
  const parts = field.split('.');
  if (!parts.every(part => FIELD_PART.test(part))) throw new Error(`Invalid field name: ${field}`);
  const selection = parts.reduceRight((inner, part) => `${part}{${inner}}`, 'histogram{key count}');
  const node = parts.reduce((value, part) => value?.[part], await aggregate(fetchImpl, selection, null));
  if (!Array.isArray(node?.histogram)) throw new Error('The field values were missing');
  return node.histogram.map(row => String(row.key));
}

export async function proteinPaintConfig(fetchImpl, route, query) {
  const params = Object.entries({ ...GENOME, ...query }).map(([name, value]) =>
    [name, typeof value === 'string' ? value : JSON.stringify(value)]);
  return getJson(fetchImpl, `/protein-paint/${route}?${new URLSearchParams(params)}`);
}

export async function proteinPaint(fetchImpl, route, body, filter = null) {
  return postJson(fetchImpl, `/protein-paint/${route}`, { ...GENOME, ...body, ...(filter ? { filter0: filter } : {}) });
}
