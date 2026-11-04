// Matches what a researcher said to Cohort Builder fields and to values in the data.
import { readFileSync } from 'node:fs';

const CATALOG = JSON.parse(readFileSync(new URL('./cohort-fields.json', import.meta.url)));
const { fields: FIELDS, synonyms: SYNONYMS, valueSynonyms: VALUE_SYNONYMS } = CATALOG;
const CLOSE_MATCH = 0.5;

const key = text => String(text).toLowerCase().replace(/[_.]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
const valueKey = text => String(text).toLowerCase().replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsWord = (text, word) => new RegExp(`\\b${escape(word)}\\b`).test(text);

export function fieldLabel(name) {
  return FIELDS[name]?.label ?? name.split('.').pop().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const spellingsOf = name => new Set([key(name), key(FIELDS[name].label), key(name.split('.').pop())]);
const asField = name => ({ name, label: fieldLabel(name), supported: FIELDS[name].supported });

function bigrams(text) {
  return new Set(Array.from({ length: Math.max(text.length - 1, 0) }, (_, i) => text.slice(i, i + 2)));
}

function similarity(a, b) {
  const first = bigrams(a);
  const second = bigrams(b);
  if (!first.size || !second.size) return a === b ? 1 : 0;
  return 2 * [...first].filter(pair => second.has(pair)).length / (first.size + second.size);
}

/** Returns { name, label, supported }, or { closest: [{ field, label }] } when no field matches. */
export function resolveField(text) {
  const wanted = key(text);
  const synonym = Object.keys(SYNONYMS).find(name => key(name) === wanted);
  if (synonym) return asField(SYNONYMS[synonym]);
  const exact = Object.keys(FIELDS).filter(name => spellingsOf(name).has(wanted));
  if (exact.length === 1) return asField(exact[0]);

  const spellings = new Map();
  for (const name of Object.keys(FIELDS)) for (const spelling of spellingsOf(name)) spellings.set(spelling, name);
  for (const [spelling, name] of Object.entries(SYNONYMS)) if (!spellings.has(key(spelling))) spellings.set(key(spelling), name);

  const whole = [...new Set([...spellings].filter(([spelling, name]) =>
    wanted && FIELDS[name] && containsWord(spelling, wanted)).map(([, name]) => name))];
  // Only number-range fields use this word, such as "age": say so rather than "no such field".
  if (whole.length && !whole.some(name => FIELDS[name].supported)) return asField(whole.sort()[0]);

  const ranked = [...spellings].map(([spelling, name]) => ({ name, score: similarity(wanted, spelling), spelling }))
    .filter(item => item.score >= CLOSE_MATCH || (wanted && (item.spelling.includes(wanted) || wanted.includes(item.spelling))))
    .sort((a, b) => b.score - a.score);
  const closest = [...new Set(ranked.map(item => item.name))]
    .filter(name => FIELDS[name]?.supported ?? true).slice(0, 5);
  return { closest: closest.map(field => ({ field, label: fieldLabel(field) })) };
}

/** Returns { values }, { ambiguous, options } or { unknown }. */
export function resolveValues(requested, available) {
  const byLower = new Map(available.map(value => [value.toLowerCase(), value]));
  const byKey = available.map(value => [valueKey(value), value]);
  const values = [];
  for (const text of requested) {
    const lowered = String(text).trim().toLowerCase();
    const wanted = VALUE_SYNONYMS[lowered] ?? lowered;
    let match = byLower.get(wanted);
    if (match === undefined) {
      const target = valueKey(wanted);
      let partial = byKey.filter(([value]) => target && value === target).map(([, value]) => value);
      if (!partial.length) {
        partial = byKey.filter(([value]) => target && containsWord(value, target)).map(([, value]) => value);
        if (partial.length !== 1) partial = byKey.filter(([value]) => target && value.includes(target)).map(([, value]) => value);
      }
      if (partial.length > 1) return { ambiguous: String(text), options: partial };
      if (!partial.length) return { unknown: String(text) };
      [match] = partial;
    }
    if (!values.includes(match)) values.push(match);
  }
  return { values };
}
