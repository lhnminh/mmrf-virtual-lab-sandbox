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
| `differential_expression` | `gene`, optional `limit` (1–20) | Gen3 `genomic/gene_cases`; paged `cases/` for mutation-tested cases; ProteinPaint `termdb/DE` pre-analysis and analysis | Disjoint tested negative and mutation positive cohorts, ranked adjusted p-values, volcano PNG; reject fewer than ten cases per group, mismatched group counts, or no usable genes. |

The current frontend fork contains the Chat result renderer and Save Cohort
actions. It is not pinned in `sources.json` until its change is committed, as
the repository instructions require confirmation before commits.

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
