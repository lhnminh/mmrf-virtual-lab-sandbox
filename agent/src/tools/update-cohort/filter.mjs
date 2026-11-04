// Merges field changes into a cohort filter of the shape {and: [{in: {field: [values]}}]}.
import { fieldLabel } from './match.mjs';

const OPAQUE_FIELD = 'case_id'; // Save Cohort builds these. They're kept as they are.
const UNSAFE = 'The cohort filter has a shape that can\'t be changed safely.';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parse(filter) {
  if (filter === null || filter === undefined) return [];
  const keys = isObject(filter) ? Object.keys(filter) : [];
  if (!keys.length) throw new Error(UNSAFE);
  let items;
  if (keys.length === 1 && keys[0] === 'and') {
    if (!Array.isArray(filter.and)) throw new Error(UNSAFE);
    items = filter.and;
  } else if (keys.length === 1 && keys[0] !== 'or') {
    items = [filter];
  } else throw new Error(UNSAFE);
  return items.map(item => {
    if (!isObject(item)) throw new Error(UNSAFE);
    const body = Object.keys(item).length === 1 ? item.in : undefined;
    if (isObject(body) && Object.keys(body).length === 1) {
      const [[name, values]] = Object.entries(body);
      const simple = Array.isArray(values) && values.every(value => typeof value === 'string');
      return { name, values: simple ? [...values] : null, item };
    }
    return { name: null, values: null, item };
  });
}

export function applyChanges(base, changes) {
  const entries = parse(structuredClone(base ?? null));
  for (const { field, op, values } of changes) {
    if (field === OPAQUE_FIELD || !['set', 'remove'].includes(op)) throw new Error('That change can\'t be applied.');
    const position = entries.findIndex(entry => entry.name === field);
    if (position >= 0 && entries[position].values === null) throw new Error(UNSAFE);
    if (op === 'remove') {
      if (position >= 0) entries.splice(position, 1);
      continue;
    }
    const entry = { name: field, values: [...values], item: { in: { [field]: [...values] } } };
    if (position < 0) entries.push(entry);
    else entries[position] = entry;
  }
  return entries.length ? { and: entries.map(entry => entry.item) } : null;
}

export function cohortLabel(filter) {
  let entries;
  try { entries = parse(filter); } catch { return 'Selected cases'; }
  if (!entries.length) return 'All cases';
  const parts = [];
  if (entries.some(entry => entry.name === OPAQUE_FIELD)) parts.push('Selected cases');
  for (const { name, values } of entries) {
    if (name && name !== OPAQUE_FIELD && values) parts.push(`${fieldLabel(name)}: ${values.join(', ')}`);
  }
  const text = parts.join('; ');
  const other = entries.some(({ name, values }) => !name || (name !== OPAQUE_FIELD && !values));
  if (other) return text ? `${text} + other filters` : 'Other filters';
  return text;
}
