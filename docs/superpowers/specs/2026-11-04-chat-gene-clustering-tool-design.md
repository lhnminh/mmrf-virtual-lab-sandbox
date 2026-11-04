# Chat gene clustering tool: design

Date: 2026-11-04
Status: design directed in conversation, awaiting review of this document. Nothing here has been built.
Builds on: [`2026-11-03-chat-cohort-lollipop-tools-design.md`](2026-11-03-chat-cohort-lollipop-tools-design.md).
Its rules, result format and cohort path apply here unless this document says otherwise.

## Purpose

**The agent generates a gene expression heatmap for the active cohort.** A researcher asks in chat, and the heatmap appears in
the conversation with no further clicks.

The tool does what the researcher does by hand on the Gene Expression Clustering page: choose **Top 20 variably expressed
genes**, then click **Submit**. The page's default is 1000, and chat uses 20 so the heatmap is quick and readable in the
conversation. The result is the real ProteinPaint chart, so the researcher can still zoom, hover, change genes and download it.

The journey is written up in `user-journey/user-journey-gene-clustering.md` in the hackathon workspace, outside this repository.

## Decisions

| Decision | Choice | Source |
| --- | --- | --- |
| Who generates the heatmap | The agent. The researcher doesn't click **Submit** | User |
| Gene set | Top 20 variably expressed genes, fixed for now | User |
| Tool inputs | None | Follows from the above |
| Chart | The real ProteinPaint chart, not a redrawn copy | Same as the other chart tools |
| Which patients | The active cohort, labelled on the answer and chart. A fresh page means all cases | Same as `show_survival` |
| Numbers in the answer | The cohort's case count, and all the genes on the heatmap | Recommendation |
| Clustering in the Lambda | None. The browser runs it, as it does on the page | Recommendation |
| Prebuilt gene sets | A later option, not part of this tool yet | User |

## Scope

**In scope:**

- The `show_gene_clustering` tool
- A prompt rule that limits what the answer says about the heatmap
- `GeneClusteringToolUI`, one optional prop on `MatrixWrapper`, and a suggested prompt
- Unit tests and live browser checks

**Out of scope:**

- Choosing the number of genes or a custom gene list through chat. The researcher can change genes in the chart's **Genes** menu
- Describing clusters or patterns. The agent doesn't receive the clustering, and can't see the chart
- Changes to the Gene Expression Clustering page, which keeps its start screen

## How it works

**By hand today,** **Submit** makes two requests:

1. `GET termdb/topVariablyExpressedGenes` with `maxGenes` and the cohort as `filter0`. It returns the gene symbols.
2. `POST termdb/cluster` with those genes. It returns the clustering.

Measured on the local sandbox, from clicking **Submit** to the heatmap's control panel appearing:

| Genes | Cases | Time | Clustering reply |
| --- | --- | --- | --- |
| 20 | 167 | 2.1 seconds | 88 KB |
| 20 | 1,000 | 2.5 seconds | 519 KB |
| 1000 | 167 | 4.2 seconds | 3.4 MB |
| 1000 | 1,000 | 16 seconds | Not measured |

**Through chat:**

1. The agent calls `show_gene_clustering`, and the agent's existing hook adds the cohort filter.
2. The Lambda makes request 1 with `maxGenes=20`, and returns the case count and the genes.
3. The browser draws the chart on that cohort. ProteinPaint makes requests 1 and 2 itself, with no start screen.
4. The agent writes its answer from the tool's summary.

The clustering reply stays in the browser even at 20 genes, because the whole tool result reaches the model through Gateway, and 88 to 519 KB is still too large.

## Tool: `show_gene_clustering`

**Input:** none. Optional inputs can be added later, without changing how existing calls behave.

**Description for the model:** generates a gene expression clustering heatmap for the researcher's selected cohort, using the
top 20 variably expressed genes. Use it for gene expression clustering, an expression heatmap, or the most variably expressed
genes. The result reports the case count and the genes on the heatmap. The heatmap is drawn for the researcher, and the result
holds no clusters or expression values. It never takes a cohort.

**Result:**

```json
{
  "status": "ok",
  "summary": "167 cases. Gene expression heatmap of the top 20 variably expressed genes: IGLC2, IGKC, IGLC3, IGHA1, IGHG1, B2M, IGHG3, IGHG2, IGHA2, IGHM, IGHG4, GAPDH, IGLC1, ACTB, HSPA5, RPS7, PRDM1, RPS6KA1, IRF4 and RPL21. The clustering is on the chart, and red means high relative to the other samples.",
  "cohort": { "label": "Race: black or african american, Sex: male", "caseCount": 167 },
  "genes": ["IGLC2", "IGKC", "IGLC3", "IGHA1", "IGHG1", "B2M", "IGHG3", "IGHG2", "IGHA2", "IGHM", "IGHG4", "GAPDH", "IGLC1", "ACTB", "HSPA5", "RPS7", "PRDM1", "RPS6KA1", "IRF4", "RPL21"],
  "plot": { "type": "gene_clustering", "maxGenes": 20 }
}
```

`plot.maxGenes` is what the chart uses, so the tool and the chart always ask for the same number. The number is one constant in the tool.

The numbers and label are examples from synthetic data. The label text comes from the existing `cohort_filter.label`.

| Status | When | What the researcher sees |
| --- | --- | --- |
| `ok` | The service returned at least one gene | The heatmap. With fewer than 20 genes, the summary gives the real number |
| `no_cases` | The cohort has no cases | A message, with no chart |
| `too_few_samples` | The service needs at least 10 samples to rank genes, and this cohort has fewer | A message saying so, with no chart |
| `no_data` | The cohort has cases, but no genes came back | A message saying there's no expression data for these cases, with no chart |
| Failure, through `failure` in `results.py` | A Virtual Lab call fails | The tool row's error message, with no chart |

## Conversation

> **Researcher:** Show gene expression clustering for Black male patients.
>
> **Agent:** Plan: set the cohort, then generate the heatmap.
>
> *(Cohort row: Race and Sex applied, 167 cases, with Undo)*
>
> *(Heatmap, on 167 cases)*
>
> **Observed:** The cohort has 167 cases. The heatmap uses the top 20 variably expressed genes: IGLC2, IGKC, IGLC3, IGHA1, IGHG1, B2M, IGHG3, IGHG2, IGHA2, IGHM, IGHG4, GAPDH, IGLC1, ACTB, HSPA5, RPS7, PRDM1, RPS6KA1, IRF4 and RPL21.

**Other requests:**

- **"Which patients cluster together?"** The agent says it can see the gene list but not the clusters, and points to the chart.
- **"Show the MEK gene set."** The agent says it can only use the top variable genes for now, and doesn't invent a gene list. It offers the top 20 heatmap.
- **"Would this patient benefit from treatment?"** The heatmap can't answer that, and the agent says so.

**Prompt rule to add:** after `show_gene_clustering`, report only what the summary says. Never describe clusters or expression
patterns, and never suggest what they mean for treatment.

## Frontend

- **`MatrixWrapper`:** gains an optional prop, `generateTopGenes`, which sets `opts.geneset.showEditUI` to `false`. ProteinPaint then fetches the top genes and draws the heatmap by itself (`getGenes` in its `geneset` component). The default stays `true`, so the page keeps its start screen.
- **`GeneClusteringToolUI`:** follows `OncoMatrixToolUI`, and renders `MatrixWrapper` with `chartType="hierCluster"`, `filter0Override` and `generateTopGenes` inside `ChartFrame`.
- **`maxGenes`:** the wrapper's existing prop only sets `settings.matrix.maxGenes`, so it needs to set `settings.hierCluster.maxGenes` as well. Without that, ProteinPaint uses 1000 while the tool reports 20. The page doesn't pass the prop, so it keeps 1000.
- **`toolkit.tsx`:** adds `virtual-lab___show_gene_clustering` with `display: 'standalone'`.
- **`numberLinks.ts`:** adds the tool's display name, `Gene Expression Clustering`.
- **`suggestedPrompts.ts`:** adds "Show gene expression clustering", labelled `Gene Expression Clustering`.

## Later: prebuilt gene sets

Not built now. The later expansion is an option to use a prebuilt set, and two findings keep that cheap:

- **Detecting them:** ProteinPaint only offers prebuilt sets when `genome.termdbs.msigdb` exists, and `/protein-paint/genomes` has no `termdbs` for hg38 today. The tool should make the same check on each call, rather than use a flag.
- **Drawing them:** ProteinPaint's `geneset` component already draws a given `genes` list without a start screen, so the same route can carry a prebuilt set's genes.

The expansion would add an optional `geneSet` input, and calls without it keep today's behavior. It still has to settle what happens when a name matches several sets.

## Build plan

Each step is tested before the next. A full implementation plan follows once this document is approved.

1. **Lambda, in the sandbox repo:** add `top_variable_genes` to `virtual_lab_client.py`, `tool_show_gene_clustering.py`, the `CLIENT_TOOLS` entry and the `tools.json` schema.
2. **Agent, in the sandbox repo:** add the prompt rule, and check how the cohort hook picks up the new tool.
3. **Chart, in Data Commons:** add the `MatrixWrapper` prop, and confirm the heatmap draws in Chat.
4. **Chat, in Data Commons:** add `GeneClusteringToolUI`, then the toolkit, label and suggested prompt entries.
5. **Deploy and check:** rebuild the agent, review the Terraform plan with the user, apply, then run the live checks below.

## Acceptance checks

**Unit tests (Lambda):**

- `ok` returns the case count, the genes and `plot`, and asks the service for 20 genes.
- Fewer than 20 genes reports the real number in the summary.
- `no_cases`, `too_few_samples` and `no_data` return no `plot`.
- A failed Virtual Lab call returns a failure, with no `plot`.
- `tools.json` lists the tool with no required inputs.

**Unit tests (frontend):**

- A result with `plot` renders the chart with `chartType="hierCluster"`, `generateTopGenes` and `plot.maxGenes`, and passes the chart frame's filter.
- `MatrixWrapper` sets `settings.hierCluster.maxGenes` when `maxGenes` is given, and leaves it unset when it isn't.
- A result without `plot` renders only the tool row.
- `MatrixWrapper` still shows the start screen when the prop isn't set.

**Live browser checks, on the local Chat against the deployed agent:**

1. Ask with no cohort. The heatmap draws with no click, reads 20 Genes, and the chart label reads 1,000 cases.
2. Check that the heatmap fits the chat column, and scrolls if it doesn't.
3. Set the cohort to Black male patients and ask again. The label reads 167 cases and the heatmap reads 167 Samples.
4. The chart's first request returns the same genes the tool reported, in the same order.
5. Change the cohort afterwards. The earlier chart keeps its own cohort.
6. The Gene Expression Clustering page still opens on its start screen, with 1000 as its default.
7. Ask "Which patients cluster together?" and "Show the MEK gene set". The answers follow the rules above.

## Unknowns to confirm while building

- **Fit inside chat:** on a 1,440 pixel page, the 20 gene heatmap measured about 1,510 pixels wide at both 167 and 1,000 cases, and about 810 to 880 pixels tall. That's probably wider than the chat column, so it may need to scroll or zoom. The chart's width in a narrower column hasn't been tested.
- **Gene order:** the summary lists genes in the service's order and doesn't claim a ranking. Top 20 matched the first 20 of Top 1000 for all cases, in the same order, so 20 is a true cut of the longer list.
- **Time limits:** the Lambda's calls have a 20 second timeout. The top genes request took about 1 second for all cases locally, and hasn't been timed on the deployed site.
- **What top 20 shows:** on the sandbox it's mostly immunoglobulin, ribosomal and housekeeping genes such as GAPDH and ACTB. That's the real result of ranking by variability, but it may not make an interesting demo.

## Sources

- Gene Expression Clustering page on the local sandbox, 2026-11-04: the requests, their sizes, and a heatmap with 167 samples.
- `@sjcrh/proteinpaint-client`: `gdc/geneExpClustering.js`, and `getGenes` in the `geneset` component.
- `src/features/proteinpaint/MatrixWrapper.tsx` and `src/features/chat/tools/OncoMatrixToolUI.tsx` in Data Commons.
- `agentcore/lambda/tool_show_survival.py` and `tool_show_oncomatrix.py`, for the tool pattern.
