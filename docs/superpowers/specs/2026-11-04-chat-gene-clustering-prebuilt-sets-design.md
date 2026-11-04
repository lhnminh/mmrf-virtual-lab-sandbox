# Chat gene clustering with prebuilt gene sets: design

Date: 2026-11-04
Status: design directed in conversation, awaiting review of this document. Nothing here has been built.
Builds on: [`2026-11-04-chat-gene-clustering-tool-design.md`](2026-11-04-chat-gene-clustering-tool-design.md), which is live. Its rules and result format apply unless this document says otherwise.

## Purpose

**A researcher names a gene set in chat, and the agent generates the heatmap for that set on the active cohort.** "Show gene expression clustering for MEK" now does what the journey describes: Prebuilt gene set, then MEK. Without a named set, the tool stays on the top 20 variably expressed genes.

MMRF merged what this needs to `theMMRF/mmrf-virtual-lab-sandbox`:

- **PR #20** adds MSigDB 2023.2.Hs to ProteinPaint, as `termdbs.msigdb`.
- **PR #21** adds a MEK expression program to the synthetic data.

The user confirmed these are the prebuilt sets they were waiting for. Neither is on the fork's `main` yet.

## Decisions

| Decision | Choice | Source |
| --- | --- | --- |
| "MEK" means | `MEK_UP.V1_UP`. The answer names it, and says `MEK_UP.V1_DN` is available | User, option C |
| Which sets | Any MSigDB set by name, with "MEK" as a shortcut | User, option A |
| Partly covered sets | State the set's size, and point to the chart for how many genes were drawn | User, option A |
| Clustering in the Lambda | Still none | Follows from the above |
| No set named | Top 20, as today | Default, accepted |
| Choosing a set | Only when the researcher mentions a pathway or set | Default, accepted |
| MSigDB missing on a stack | `prebuilt_unavailable`, and the agent offers top 20. No silent fallback | Default, accepted |
| Source of the gene list | The Lambda, which passes it to the chart | Default, accepted |
| Knowledge graph handoff | Out of scope | Default, accepted |
| Describing patterns or treatment meaning | Still banned. The MEK blocks are designed into the data | Default, accepted |

## Scope

**In scope:**

- Merging PRs #20 and #21 into the fork, and deploying `frontend`, `proteinpaint` and the agent
- An optional `geneSet` input on `show_gene_clustering`
- A gene list route through the Chat UI and `MatrixWrapper`
- Changing the prompt rule that declines named gene sets
- Updating the journey document

**Out of scope:**

- Custom gene lists through chat
- Showing `MEK_UP.V1_UP` and `MEK_UP.V1_DN` together
- A knowledge graph link to this tool
- Changes to the Gene Expression Clustering page

## Tool: `show_gene_clustering`

**New optional input:** `geneSet`, a string holding the name as the researcher said it.

**Steps with `geneSet`:**

1. Read the case count. Zero cases returns `no_cases`, and under 10 returns `too_few_samples`. Clustering fails on one sample and means little on a few.
2. Read `/protein-paint/genomes` on every call. No `genomes.hg38.termdbs.msigdb` returns `prebuilt_unavailable`.
3. Resolve the name:
   - "MEK", "MEK pathway", "MEK gene set" and "MEK signature", in any case, mean `MEK_UP.V1_UP`.
   - Otherwise search with `findterm` on the `msigdb` dslabel: first the name as said, then without a trailing word such as "pathway", then with spaces as underscores, because MSigDB's names use them and the search doesn't match across them. An exact match on a set's ID wins. One result is used. Several return `ambiguous`, with the total and up to 5 options. None returns `gene_set_not_found`.
4. Read the genes with `genesetByTermId`.
5. A set under or over the size limits returns `gene_set_too_small` or `gene_set_too_large`. An empty set returns `no_data`.

Without `geneSet`, the tool behaves exactly as it does today.

**Result, using the shortcut:**

```json
{
  "status": "ok",
  "summary": "167 cases. Gene expression heatmap of the MSigDB set MEK_UP.V1_UP, chosen for MEK. MEK_UP.V1_DN is also available. The set lists 195 genes, and the heatmap draws only those with expression data, so the chart shows how many. The clustering is on the chart, and red means high relative to the other samples.",
  "cohort": { "label": "Race: black or african american, Sex: male", "caseCount": 167 },
  "geneSet": { "id": "MEK_UP.V1_UP", "geneCount": 195 },
  "plot": { "type": "gene_clustering", "genes": ["..."] }
}
```

The numbers are examples. The 195 comes from the PR's description. The sentences about choosing for MEK and about `MEK_UP.V1_DN` appear only when the shortcut was used.

| New status | When | What the researcher sees |
| --- | --- | --- |
| `prebuilt_unavailable` | This stack has no MSigDB | A message offering the top 20 heatmap, with no chart |
| `ambiguous` | The name matches several sets | One question with up to 5 options, with no chart |
| `gene_set_not_found` | The name matches no set | A message, with no chart |
| `gene_set_too_large` | The set is over the limit | A message giving the set's size, with no chart |
| `gene_set_too_small` | The set lists under 15 genes, so few or none may have expression data, which the chart can't draw | A message giving the set's size, with no chart |
| `too_few_samples` | The cohort has under 10 cases | A message, with no chart |

**Size limits:** `MIN_SET_GENES` is 15 and `MAX_SET_GENES` is 500, the cutoffs MMRF's config uses for gene set analysis. The largest chart seen live has 101 genes. A set at the minimum could still have too few genes with expression data, because only the browser finds that out.

**Result size:** `plot.genes` holds the set's symbols, which reach the model. At 500 symbols that's about 4 KB, against 8 KB for the 1000 gene reply measured earlier. The summary doesn't list the genes.

## Conversation

> **Researcher:** Show gene expression clustering for MEK in Black male patients.
>
> **Agent:** Plan: set the cohort, then generate the heatmap for the MEK gene set.
>
> *(Cohort row: Race and Sex applied, 167 cases, with Undo)*
>
> *(Heatmap, on 167 cases: Gene Expression Clustering · MEK_UP.V1_UP)*
>
> **Observed:** The cohort has 167 cases. I used the MSigDB set MEK_UP.V1_UP for MEK, and MEK_UP.V1_DN is also available. The set lists 195 genes, and the heatmap draws only those with expression data, so the chart shows how many.

**Prompt rule, replacing the current one:** after `show_gene_clustering`, report only what its summary says. Never describe clusters or expression patterns, and never suggest what they mean for treatment. Pass `geneSet` only when the researcher names a pathway or gene set, and pass the name as they said it. Without one, the tool uses the top 20 variably expressed genes, and it can't use another number. If it returns `ambiguous`, ask one question that offers its options. If it returns `prebuilt_unavailable`, say so and offer the top 20 heatmap. Never invent a gene list.

## Frontend

- **`MatrixWrapper`:** gains an optional `genes` prop, passed as `arg.genes`. ProteinPaint's `geneset` component uses a given list before it looks at top genes.
- **`GeneClusteringToolUI`:** passes `plot.genes` when present, or `plot.maxGenes` when not. With a set, the title adds its ID.

## Stack

Deployed on 2026-11-04 from `d3df43c`: `frontend`, `proteinpaint`, `identity` and `seed` rebuilt together, and the live data is on generator version 9. `scripts/smoke.py` passes, including `MEK_UP.V1_UP has 92 of 195 genes in the expression panel`. PR #21's MEK program is on the stack.

## Measured replies

On the deployed site, 2026-11-04:

| Call | Result | Time |
| --- | --- | --- |
| `findterm=MEK` or `MEK_UP` | 2 sets: `MEK_UP.V1_DN` and `MEK_UP.V1_UP` | 0.2 s |
| `findterm=mek_up.v1_up` | 1 set. The search ignores case | 0.1 s |
| `findterm=hypoxia` | 57 sets | 0.2 s |
| `findterm=HALLMARK_HYPOXIA` | 1 set | 0.2 s |
| `findterm=MEK and hypoxia`, `xyzzy` | Empty `lst` | 0.1 s |
| `genesetByTermId=MEK_UP.V1_UP` | A list of 195 objects with `symbol`, 21 KB | 0.2 s |
| `genesetByTermId=MEK_UP.V1_DN`, `HALLMARK_HYPOXIA` | 194 and 200 objects | 0.2 s |
| `genesetByTermId` with an unknown ID | A reply that isn't JSON | |

Every term returned had `isleaf: true`. The chart's time with a set this size is still to be measured.

## Acceptance checks

**Unit tests (Lambda):**

- Each spelling of the shortcut resolves to `MEK_UP.V1_UP`, and the summary names both sets.
- A named set with one result, an exact ID among several, several results, and no results.
- No MSigDB returns `prebuilt_unavailable`, with no search made.
- The check for MSigDB runs on every call.
- A set over the limit returns `gene_set_too_large`, with no `plot`.
- `plot.genes` holds the symbols, and the summary doesn't list them.
- Without `geneSet`, the result and requests are unchanged.

**Unit tests (frontend):**

- `getMatrixTrack` passes `genes`, and leaves the page's arguments as they were.
- `GeneClusteringToolUI` passes `plot.genes`, and adds the set's ID to the title.

**Live checks, on the deployed site:**

1. "Show gene expression clustering" still gives the top 20.
2. "...for MEK" gives `MEK_UP.V1_UP` with no click. The answer names both sets and the set's size.
3. "...for MEK in Black male patients" reads 167 cases and samples. The chart's gene count is recorded.
4. The heatmap fits the chat column, or scrolls without breaking the page. Its load time is recorded for 167 and 1,000 cases.
5. A set with several matches asks one question, and answering it draws the chart.
6. An unknown set returns `gene_set_not_found`, with no invented genes.
7. "What does this pattern mean for treatment?" gets no pattern description or treatment suggestion.
8. A cohort under 10 cases with a named set returns `too_few_samples`.
9. The Gene Expression Clustering page shows prebuilt sets, and still opens on its start screen.
10. `scripts/smoke.py` passes, and the earlier OncoMatrix, Lollipop and survival questions still answer.

PR #21's MEK blocks aren't checked, because they aren't on this stack.

## Unknowns to confirm while building

- **Chart limit:** whether a list this size draws through the route the top 20 uses. It's read from ProteinPaint's code, and hasn't been run.

## Sources

- `user-journey/gene-clustering-pr20-pr21-learnings.md` in the hackathon workspace. Its figures marked author-reported haven't been rerun.
- `theMMRF/mmrf-virtual-lab-sandbox` PRs #20 and #21: `proteinpaint/genome.mjs`, `proteinpaint/dataset.mjs` and `scripts/smoke.py`.
- `@sjcrh/proteinpaint-client`: `getGenes` and `getTwLst` in the `geneset` component.
