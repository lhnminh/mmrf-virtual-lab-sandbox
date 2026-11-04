# Infra-2 tool contract

Each tool exports `spec`, `createExecutor`, and `createTool` from one folder under
`agent/src/tools/`. The registry in `index.mjs` is the only list to edit when
adding a tool. The agent sends the selected website cohort separately as
`context.cohortFilter`; Gateway transports it as `cohortFilterJson`. Executors
return `{summary, plot}`. Only `summary` goes back to the model. Chat renders
`plot` and requires a click through the existing Save Cohort dialog before a
proposed cohort becomes active.

| Tool | Model inputs | Data calls | Result and failure checks |
| --- | --- | --- | --- |
| `correlation_plot` | `primaryVariable`, `secondaryVariable` | Existing survival executor calls ProteinPaint correlation/survival endpoint | Summary and existing survival chart; reject unsupported variables and groups with fewer than ten cases. |
| `top_mutated_genes` | `race`, optional `limit` (1–10) | Guppy case IDs for race plus selected cohort; ProteinPaint `termdb/topMutatedGenes` with the same filter | Ranked gene counts and case ID cohort proposal; reject unsupported race, empty cohort, or missing gene counts. |
| `differential_expression` | `gene`, optional `limit` (1–20) | Gen3 `genomic/gene_cases`; paged `cases/` for mutation-tested case and sample IDs; ProteinPaint `termdb/DE` pre-analysis and analysis with `samplelst.groups[].values` | Disjoint tested negative and mutation positive cohorts, ranked adjusted p-values, volcano PNG; reject fewer than ten cases per group, mismatched group counts, or no usable genes. |

Local live checks against the existing synthetic stack passed on 2026-11-03:
the Black or African American cohort has 334 cases and top genes KRAS 148,
NRAS 113, DIS3 100; the KRAS DE groups contain 520 tested negatives and
480 positives, with ten ranked genes and a volcano image. The survival
comparison live test also passed. The actual AWS Gateway and Chat flow remain
deployment checks.

The frontend fork contains the Chat result renderer and Save Cohort actions.
The `journey-oncomatrix-chat` branch adds the interactive matrix result.
`sources.json` pins its pushed commit so the sandbox build can fetch it.

For journey 2, the `top_mutated_genes` result also offers the existing
interactive OncoMatrix in Chat. It receives the same `filter0` used to rank
the genes, so clicking the KRAS gene label can open its cohort-scoped Lollipop
plot. The matrix loads when the researcher opens it.

## Next tools, in order

1. **Mutation frequency by cohort:** gene frequencies from the analysis API,
   with case counts matching the selected cohort and a chart that matches the
   Genomic Analysis page.
2. **Clinical facet summary:** selected cohort counts by a named clinical
   field, with category totals checked against the case query.
3. **Cohort comparison:** compare two saved cohorts on a named field; require
   the user to choose both cohorts and show each denominator.
4. **Gene expression clustering:** pass a selected cohort and genes to the
   existing ProteinPaint chart; verify the chart's sample count.

For each addition, add one tool folder and registry entry, regenerate schemas,
and verify a local call plus a deployed Gateway call before calling it done.
