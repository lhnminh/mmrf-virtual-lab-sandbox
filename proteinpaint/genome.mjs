// Deliberately small, synthetic coordinate models with public reference protein sequences.
export default {
  species: 'human (synthetic fixtures)',
  genomefile: 'synthetic.fa',
  genedb: { dbfile: 'genes.sqlite' },
  // Real MSigDB gene sets, keyed and configured like the public hg38 genome so the
  // clustering "Prebuilt gene set" picker matches the Virtual Lab. Genes absent from
  // the synthetic expression panel are skipped when a set is clustered.
  termdbs: {
    msigdb: {
      label: 'MSigDB (2023.2.Hs)',
      cohort: { db: { file: 'anno/msigdb/db_2023.2.Hs' }, termdb: { isGeneSetTermdb: true } },
      analysisGenesetGroups: ['-', 'BP: subset of GO', 'MF: subset of GO', 'CC: subset of GO',
        'WikiPathways subset of CP', 'REACTOME subset of CP', 'H: hallmark gene sets'].map(value => ({ label: value, value })),
      geneORAparam: { minCutoff: 15, maxCutoff: 500 },
    },
  },
  tracks: [{__isgene: true, translatecoding: true, file: 'genes.bedj.gz', type: 'bedj', name: 'Synthetic gene models', stackheight: 16, stackspace: 1, vpad: 4, color: '#1D591D'}],
  defaultcoord: { chr: 'chr17', start: 29900, stop: 32200 },
  majorchr: 'chr1\t500000\nchr7\t500000\nchr8\t500000\nchr12\t500000\nchr13\t500000\nchr17\t500000',
  minorchr: '',
};
