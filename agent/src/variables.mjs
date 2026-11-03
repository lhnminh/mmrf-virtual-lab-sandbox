// Variable names the Correlation Plot executor can resolve, matching the synthetic
// Gen3 case index and the ProteinPaint termdb. Add a field by adding an entry.
export const CATALOG = [
  {
    key: 'overall_survival', kind: 'outcome', label: 'Overall survival',
    synonyms: ['survival', 'os', 'overall survival time', 'survival time', 'kaplan meier', 'km'],
    ppTerm: 'overall_survival',
  },
  {
    key: 'progression_free_survival', kind: 'unsupported_outcome', label: 'Progression-free survival',
    synonyms: ['pfs', 'progression free survival', 'progression-free survival'],
  },
  {
    key: 'cgs_risk', kind: 'group', label: 'CGS risk category',
    synonyms: ['cgs risk', 'cgs', 'risk', 'risk group', 'risk category', 'cgs risk group',
      'cytogenetic risk', 'high risk vs standard risk', 'cgs high risk vs standard risk'],
    gen3Field: 'cgs_risk_key_criteria.cgs_risk_category', ppTerm: 'cgs_risk_category',
    values: ['High risk', 'Standard risk'],
  },
  {
    key: 'gender', kind: 'group', label: 'Gender', synonyms: ['sex'],
    gen3Field: 'demographic.gender', ppTerm: 'gender', values: ['female', 'male'],
  },
  {
    key: 'race', kind: 'group', label: 'Race', synonyms: [],
    gen3Field: 'demographic.race', ppTerm: 'race', values: ['asian', 'black or african american', 'white'],
  },
];

export const normalize = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function names(entry) {
  return [entry.key, entry.label, ...entry.synonyms].map(normalize);
}

export function supportedVariables() {
  return CATALOG.filter(entry => entry.kind !== 'unsupported_outcome').map(entry => entry.label);
}

/** Resolve a user-supplied variable name to exactly one catalog entry, or throw. */
export function resolveVariable(name) {
  const wanted = normalize(name);
  const exact = CATALOG.filter(entry => names(entry).includes(wanted));
  if (exact.length === 1) return exact[0];
  // A name such as "CGS risk category status" still names one field.
  const partial = exact.length ? exact : CATALOG.filter(entry => names(entry).some(n => n.length > 2 &&
    (` ${wanted} `.includes(` ${n} `) || ` ${n} `.includes(` ${wanted} `))));
  const unique = [...new Set(partial)];
  if (unique.length === 1) return unique[0];
  const options = supportedVariables().join(', ');
  if (unique.length > 1) {
    throw new Error(`"${name}" is ambiguous; it could mean ${unique.map(e => e.label).join(' or ')}. Supported variables: ${options}`);
  }
  throw new Error(`"${name}" is not a supported variable. Supported variables: ${options}`);
}
