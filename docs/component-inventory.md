# Components

| Component | Source | License |
| --- | --- | --- |
| Virtual Lab frontend | [mmrf-data-commons](https://github.com/theMMRF/mmrf-data-commons) | Apache-2.0 |
| Guppy | [theMMRF/guppy](https://github.com/theMMRF/guppy) | Apache-2.0 |
| Gen3 Analysis | [gen3-analysis](https://github.com/theMMRF/gen3-analysis) | Apache-2.0 |
| ProteinPaint client/server | [stjude/proteinpaint](https://github.com/stjude/proteinpaint) | Academic-use license |
| Elasticsearch | Elastic 7.17.29 public image | Upstream distribution terms |
| Reference protein annotations | [UniProt](https://www.uniprot.org/) | CC BY 4.0; [attribution and sources](synthetic-data.md) |
| MSigDB 2023.2.Hs gene sets | [St. Jude ProteinPaint build](https://proteinpaint.stjude.org/ppSupport/msigdb/db_2023.2.Hs) of [MSigDB](https://www.gsea-msigdb.org/gsea/msigdb/) | CC BY 4.0; [attribution](synthetic-data.md#prebuilt-gene-sets-in-clustering) |
| Ras-domain annotations | [Pfam through InterPro](https://www.ebi.ac.uk/interpro/entry/pfam/PF00071/) | CC0; [attribution and sources](synthetic-data.md) |

`sources.json` pins the first three source revisions. Dockerfiles pin the
ProteinPaint and Elasticsearch bases. This repository supplies the gateway,
synthetic generator, dataset configuration, Compose stack, Helm chart, and
Terraform configuration.

`scripts/patch_proteinpaint.mjs` corrects cohort filtering for uncolored
prebuilt scatter plots in the pinned server version. It checks the expected
version and implementation before applying the patch. The client remains the
frontend's public npm dependency.

ProteinPaint and Elasticsearch retain their upstream licenses. New sandbox code
is Apache-2.0; see the repository LICENSE.
