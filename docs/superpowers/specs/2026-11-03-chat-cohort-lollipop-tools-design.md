# Chat tools for the cohort-to-Lollipop journey: design

Date: 2026-11-03
Status: amended after review against assistant-ui and AgentCore guidance, with spike results. Nothing here has been built.
Builds on: [`2026-11-03-agentcore-agui-chat-design.md`](2026-11-03-agentcore-agui-chat-design.md),
which sets the agent, tool and streaming architecture. Its "Next tool" section lists
problems this design has to solve.

## Goal

Let a researcher do this journey by asking in chat:

1. Choose patients, for example Black or African American patients.
2. See which genes are mutated in them in OncoMatrix.
3. See where one gene's mutations fall on the protein in a Lollipop plot.

Today this takes 7 clicks across Cohort Builder and OncoMatrix. In chat it takes 1
sentence, or 1 sentence and 1 follow-up button.

This document covers the experience, the tool contracts and the frontend that renders
them. Where it differs from earlier designs, this one wins.

## Decisions

| Decision | Choice | Source |
| --- | --- | --- |
| Cohort ownership | One cohort, the one selected in the dropdown. Chat and the platform read and change the same one | User |
| How chat changes the cohort | Updates the selected cohort in place | User |
| A new value on a field already filtered | Replaces the old value | Recommendation, accepted |
| Tool shape | One tool per research intent, each returning numbers and a chart | User |
| Route to the Lollipop plot | Through ProteinPaint, not through OncoMatrix | User |
| Chart context | **Prototype only: the agent has no context on clicks or control changes inside a chart.** Revisit after the prototype | User |
| Tool options | Simple default views. `maxGenes` is the only display option | User, `maxGenes` by recommendation |
| Cohort selections made inside a chart | Keep the platform's Save Cohort window | User |
| 0-case cohorts | Chat doesn't apply them | User |
| Plans | Shown, and run without waiting for approval | Recommendation, presented with the design |
| Interpretation | Left out unless the researcher asks, then labelled separately | Recommendation, presented with the design |
| How the agent reaches services | Only through Python Lambda tools behind Gateway, never directly | User |
| Chart data | Numbers come from Lambda tools. Charts stay the platform's ProteinPaint components and load their own data | User, option 3 |
| One data source | The local page and its charts read the deployed services, through a local forwarding script | Recommendation, accepted |
| Where the code lives | `rvantaylor` forks, under `my-forks/`. Account IDs and live URLs stay out of them | User |

## Scope

**In scope:**

- Tools: `update_cohort`, `show_oncomatrix` and `show_lollipop`
- Answer format: plan, tool steps, cohort labels, Observed, Limits and follow-ups
- Undo for cohort changes made in chat
- The frontend: tool UIs, cohort sync and chart wrappers
- A local forwarding script so charts read the deployed services
- The failure behavior in this document

**Out of scope for the prototype:**

- Chart-click context and chart settings beyond `maxGenes`
- Number-range filters, such as age
- Text-only answers
- Lollipop subtracks and Disco Plots
- Other Virtual Lab tools
- Chat on the deployed site. It still needs the CloudFront route and proxy

## Terminology

Use these terms in tool descriptions, step labels and answers.

| Thing | Term |
| --- | --- |
| The Virtual Lab tool | ProteinPaint |
| The visualization | Lollipop plot |
| One circle on the plot | Variant disc |
| The protein bar under the discs | Protein View |
| The tool for gene-by-sample views | OncoMatrix |
| The filter value in the data | Race: `black or african american` |

The ProteinPaint card and page never use the word "lollipop", so researchers may ask
in other words. These all need to reach `show_lollipop`:

- "Show a lollipop plot for KRAS"
- "Use ProteinPaint for KRAS"
- "Where do KRAS mutations fall on the protein?"

## Rules for every tool

1. **The model never supplies or sees a cohort filter.** Tool schemas have no cohort
   input. A filter can hold case IDs, because Save Cohort builds filters from them, so it
   stays out of the prompt, tool arguments the model sees, and tool results it reads.
2. **Only `update_cohort` changes the cohort.**
3. **The agent quotes only numbers from `summary`.** The prompt asks for this, and a
   check against recorded answers tests it.
4. **A chart keeps its cohort.** The platform's ProteinPaint page redraws when the
   cohort changes. In chat, a chart stays on the cohort it ran with.
5. **Numbers and charts must agree.** Both use the same deployment and the same cohort.
6. **Business outcomes aren't failures.** `ambiguous` or `none_in_cohort` are results.
   Only `status: "error"` shows as a failed step.
7. **Gateway schemas can't enforce values.** AWS's Lambda schema reference lists only
   `type`, `description`, `properties`, `required` and `items`, so allowed values go in
   descriptions, and Python checks them.

### Result format

What the model and the tool UI receive:

```json
{
  "status": "ok",
  "summary": "Text with every number the agent may quote",
  "cohort": { "label": "Race: black or african american", "caseCount": 334, "revision": 2 },
  "plot": { "type": "lollipop", "gene": "KRAS" }
}
```

| Field | Purpose |
| --- | --- |
| `status` | The outcome. The values are listed under each tool |
| `summary` | Numbers and limits for the agent to report |
| `cohort` | The cohort used, shown on the result. `revision` identifies its filter |
| `plot` | What the frontend needs to request the chart. Settings only, never case data or filters |

Other tool-specific fields stay small. The health tool moves to this format too.

Follow-up buttons aren't in the result. The tool UI builds them from the ranked genes.

### How the cohort travels

```text
Browser ──RunAgentInput.state.cohort──► agent (invocation_state, not the prompt)
Agent hook ──adds cohortFilter to a copy of the tool call──► Gateway ──► Lambda
Lambda ──result with filter──► agent hook ──removes filter──► model sees the rest
                                   └── STATE_SNAPSHOT ──► browser
```

`state.cohort` holds `{ filter, label, caseCount, revision, changedOutsideChat }`.

- **Not `RunAgentInput.context`:** `ag_ui_strands` renders context into the model prompt.
- **`invocation_state`:** per the adapter's docs, it's available to hooks and tools but
  not added to model context.
- **The argument isn't in the schema:** Gateway delivered it in a live test, but AWS only
  describes declared properties, so a live test guards this.
- **Prompt text:** a state context builder adds only the label, count and manual-change
  flag, never the filter.

## Tools

### `update_cohort`

**Description for the agent:** Adds, replaces or removes filters on the researcher's
selected cohort. The change appears in the platform's cohort dropdown.

**Input:**

```json
{ "changes": [{ "field": "race", "values": ["Black"], "op": "set" }] }
```

| Input | Rule |
| --- | --- |
| `field` | As the researcher said it. Matched against Cohort Builder's fields |
| `values` | As the researcher said them. Matched only against values in the data. Not used for `remove` |
| `op` | `set` or `remove`. `set` replaces any existing value on that field |

Mapping happens in the tool, so the model can't invent a filter value. The tool changes
nothing itself. It returns resolved changes, which the browser applies, so it's safe to
retry.

A `case_id` filter from Save Cohort stays as it is, and its label reads "Selected cases"
rather than listing IDs.

| `status` | Cohort changes? | Returned |
| --- | --- | --- |
| `ok` | Yes | The mapping, the resolved changes, and cases before and after. The new filter goes to state only |
| `ambiguous` | No | Possible values, as options to ask about |
| `unknown_field` | No | The closest available fields |
| `unknown_value` | No | The field's available values |
| `unsupported_field` | No | "Not supported yet", for number-range fields |
| `would_be_empty` | No | The filters tried and the 0 count |
| `error` | No | Which step failed |

Example of `ambiguous`: "Hispanic" matches both `hispanic or latino` and
`not hispanic or latino`.

All changes in one call apply together or not at all.

### `show_oncomatrix`

**Description for the agent:** Shows which genes are most frequently mutated in the
selected cohort, in OncoMatrix.

**Input:** `maxGenes` (optional integer of 1 or more), for requests such as "top 3".

| `status` | Returned |
| --- | --- |
| `ok` | Cases and samples stated separately, genes ranked with counts, the chart and follow-ups |
| `no_data` | A statement that no case in the cohort has mutation data. No chart |
| `error` | Which step failed |

The tool UI offers a Lollipop plot for each of the top 3 genes shown.

### `show_lollipop`

**Description for the agent:** Shows a Lollipop plot in ProteinPaint: where one gene's
mutations fall along the protein, and how often each occurs in the selected cohort.

**Input:** `gene` (required), as the researcher said it. Aliases resolve as they do in
the ProteinPaint search box, such as c-Myc to MYC.

| `status` | Meaning | Returned |
| --- | --- | --- |
| `ok` | There are mutations to plot | Samples, variants, top variants with counts, and the chart |
| `unknown_gene` | The name doesn't look like a gene symbol | A request to check the name |
| `no_data_for_gene` | It looks like a gene symbol, but isn't in this dataset | The genes covered. In the sandbox: KRAS, NRAS, TP53, BRAF, DIS3 and MYC |
| `none_in_cohort` | The gene has data, but no case in this cohort has a mutation | "0 of N cases". No chart |
| `error` | The tool failed | Which step failed |

`no_data_for_gene` and `none_in_cohort` must stay separate. "No data" and "no mutations
found" mean different things scientifically.

The sandbox's gene lookup returns nothing for both BRCA1 and a made-up name, so it can't
confirm that a gene is real. A gene-shaped name therefore gets "isn't in this dataset",
never a claim that it's a real gene.

## Conversation

The journey on sandbox data:

> **Researcher:** What's mutated in Black patients?
>
> **Plan:** Set the cohort, then show OncoMatrix.
>
> ✓ **Cohort Builder · Updated cohort**
> Race: `black or african american` · 1,000 → **334 cases** · [Undo]
>
> ✓ **OncoMatrix · 6 genes**
> *Cohort: Race: black or african american, 334 cases*
> *[Interactive OncoMatrix]*
>
> **Observed:** KRAS (148), NRAS (113) and DIS3 (100) are the most frequently mutated.
> The matrix shows 282 of the 334 cases.
> **Limits:** Synthetic data with no clinical meaning. Only 6 genes have mutation data.
> Numbers are for the default view and don't reflect changes made in the chart.
>
> [Lollipop for KRAS] [Lollipop for NRAS] [Lollipop for DIS3]

Clicking **Lollipop for KRAS** sends a visible message:

> **Researcher:** Show the Lollipop plot for KRAS.
>
> ✓ **ProteinPaint · Lollipop plot · KRAS**
> *Cohort: Race: black or african american, 334 cases*
> *[Interactive Lollipop plot]*
>
> **Observed:** 148 samples carry 14 KRAS variants. The most frequent are p.Q61H (38),
> p.G12V (27) and p.G12D (23).
> **Limits:** Synthetic data with no clinical meaning. Numbers are for the default view
> and don't reflect changes made in the chart.

A question that names the gene takes the short route. "Where do KRAS mutations fall in
Black patients?" calls `update_cohort`, then `show_lollipop`, and skips the matrix.

| Part of an answer | Rule |
| --- | --- |
| Plan | One line before any tool runs |
| Tool step | Uses the platform's names. Expands to show settings and any error |
| Cohort label | On every chart, with the cohort that chart ran on |
| Observed | Only numbers from `summary` |
| Interpretation | Only on request, and labelled separately from Observed |
| Limits | Always included. Synthetic data, plus anything specific to this result |
| Follow-ups | Up to 3 buttons, each sending a visible message |

**Other request types:**

- **Naming a tool:** "Use OncoMatrix to..." uses that tool. Named and open-ended
  requests reach the same analysis.
- **Asking only for a number:** the answer still includes the chart behind it.
- **Needing clarification:** chat asks one question and offers the options as buttons.

## Keeping chat and the cohort in sync

**Within a run:** the agent starts with the cohort sent with the request. When
`update_cohort` returns `ok`, later tools in that run use the new cohort. This is what
makes "show the top genes in Black patients" work in one request.

**On the page:** the frontend applies the resolved changes through the platform's cohort
actions when `STATE_SNAPSHOT` raises `revision`, so the dropdown and filter panel update
straight away. It applies each revision once, so reloads, edits and replayed snapshots
can't apply a change twice. Charts look up their filter by `revision`.

**Manual changes:** the browser sends the selected cohort as `state.cohort` at each
message, with `changedOutsideChat` set if it changed outside chat. The next answer then
starts with "Now using: Race: white, 334 cases."

**Undo:**

- Restores the cohort from just before that change, and chat adds a line such as
  "Cohort restored: 1,000 cases."
- Is offered only on the latest change, and not after a manual edit, because undoing
  could then erase the researcher's work.
- Is a browser action, not a tool call. The agent sees the result at the next message.
- Leaves older charts and labels unchanged.
- Becomes a plain record such as "Undone" after use, not a live button.

**A failure partway through a run:** an earlier cohort change stays, and the answer
says so.

## Chart context limitation

For the prototype, charts behave as the platform built them, and the agent can't see
anything done inside them. This includes:

- Sorting, hiding mutation classes, adding variables or changing the layout
- The matrix's own Lollipop button
- Changing the gene in the ProteinPaint search box
- Starting a Disco Plot

**What we accept:**

- A question asked after changing a chart is answered from the tool's default result.
  The Limits line says so.
- A Lollipop plot opened from inside the matrix leaves no tool step, which is a small
  gap against the brief's "see the tool calls". The plan and tool steps still cover
  everything chat itself runs.

**Why:** OncoMatrix has many controls that affect the display. Tracking them isn't
worth the cost for a prototype.

**Saving a cohort from a chart:** the ProteinPaint table's Create cohort button keeps
opening the platform's Save Cohort window. Any resulting cohort change is picked up as a
manual change.

## Acceptance checks

Run on one deployment. Compare numbers with that deployment's own data, not the values
in this document.

| Check | Expected |
| --- | --- |
| "What's mutated in Black patients?" | The dropdown filter updates. Case count, samples and gene ranking match the Cohort Builder and OncoMatrix pages |
| "Top 3 genes" | The answer and the matrix show the same 3 genes and counts |
| Lollipop for KRAS | `summary` matches the chart's sample and variant counts, and only the cohort's samples are listed |
| Named and open-ended versions | Both reach the same result |
| Change the dropdown, then ask again | The answer opens with "Now using..." and uses the new cohort |
| Undo | The cohort is restored and older charts keep their labels |
| "Only women", then "white patients" | The first adds Sex. The second replaces any existing Race value |
| "Smokers" | `unknown_field`, and the cohort doesn't change |
| "Hispanic" | `ambiguous`, chat asks, and the cohort doesn't change |
| A filter combination matching nobody | `would_be_empty`, and the cohort doesn't change |
| BRCA1 in the sandbox | `no_data_for_gene`, with the genes covered |
| A covered gene with no mutation in a small cohort | `none_in_cohort`, stated as a result and not an error |
| A tool failure | The step shows as failed, and the answer gives no numbers from it |
| Model behavior | The tool schemas offer no way to pass a cohort |

## Testing

Playwright is the main way to check Chat in a browser, so changes can be tested without
clicking through by hand.

| Tier | Agent | Covers | Runs when |
| --- | --- | --- | --- |
| Fast | Recorded AG-UI streams, served at the agent route | Tool UIs, cohort sync, Undo, failures and real chart rendering | Every frontend change |
| Live | The deployed agent | The acceptance checks above that depend on the model and tools | After a deploy, on request |

Live tests compare the answer's numbers with the chart on the page, not with fixed values,
because data differs between deployments.

## Frontend

**Registration:** a plain `defineToolkit` with `type: "backend"` entries, registered once
through `AuiConfig({ tools: Tools({ toolkit }) })`. Keys use Gateway's names, such as
`virtual-lab___show_lollipop`. This replaces `components.tools.by_name`. The
`"use generative"` compiler isn't used, because it needs a build plugin on this Next config.

**Every tool UI** handles running, incomplete and complete, and shows its failure.

| Tool UI | Job |
| --- | --- |
| `update_cohort` | Reports the change and offers Undo. For `ambiguous`, shows the options as buttons that send a visible message |
| `show_oncomatrix` | Shows the chart, with its cohort label and Lollipop buttons |
| `show_lollipop` | Shows the chart, with its cohort label |

**Charts:** `display: "standalone"`. `MatrixWrapper` and `ProteinPaintWrapper` gain optional
props for the filter, gene and `maxGenes`. Passing a filter means the wrapper ignores the
selected cohort, which is how a chart keeps its own. Without the props they behave as
today. Charts can use the full thread width, because they don't fit a 660px column.

AG-UI interrupts stay out, because they're experimental.

## Data sources for numbers

All tested from the deployed Lambda, and in about 1.2 seconds in total.

| Number | Source |
| --- | --- |
| Case count | Guppy `Case__aggregation.case(filter).\_totalCount` |
| Ranked genes and counts | ProteinPaint `termdb/topMutatedGenes` with `filter0` |
| Samples in the matrix | The union of `mds3` `variant2samples` samples across the ranked genes. It matched the matrix locally and in project records for the deployed copy. IDs stay in the Lambda |
| Gene name and aliases | ProteinPaint `genelookup`. An empty `gmlst` means `unknown_gene` |
| Lollipop samples, variants and top variants | ProteinPaint `mds3` with `forTrack` and `skewer`. About 6 KB, with no case IDs |

## To confirm before building

| Item | Known so far | If it fails |
| --- | --- | --- |
| Hook path with the real MCP tool and model | Passed with a scripted model and fake tool: model saw no filter, later tools saw the new one | Wrap the MCP tools in a local tool that adds the argument |
| Undeclared argument with a tool that declares properties | Delivered when a tool's schema was empty | Declare it in Gateway and remove it from the spec the model gets |
| Opening ProteinPaint on a given gene | Wrapper has a commented `geneSymbol`, and the client accepts `state.userSelection`. Neither run | Pre-fill the search box |
| Limiting OncoMatrix to `maxGenes` | `settings.matrix.maxGenes` exists. Limiting to 3 hasn't been run | Show the default view, and name the top genes only in the answer |
| OncoMatrix outside `?app=OncoMatrix` | The earlier brief records that it aborts. Not rerun | Render from a wrapper that supplies what it checks |
| Page and charts through the forwarding script | Settings support it. Not run | Fix the script, or regenerate the local data to match |
| Save Cohort behavior | Opens from `updateFilters`. Whether saving also switches the selected cohort hasn't been tested | Either result is handled as a manual change |

## Known data differences

- **The two stacks hold different data.** For this cohort, deployed gives DIS3 98, BRAF 76,
  MYC 62, TP53 38 and 287 samples. Local gives DIS3 100, BRAF 52, MYC 66, TP53 28 and 282
  samples. KRAS and NRAS match. This explains the numbers that disagreed earlier, so this
  document's numbers are examples only.
- **Case vs sample counts:** KRAS at 148 is 44% of 334 cases and 52% of 282 samples.
  Answers state both totals, so a percentage can't be read against the wrong one.

## Team impact

- **Tool name:** `docs/journeys.md` and `docs/agent-architecture.md` on the team fork
  name `create_cohort` and `top_mutated_genes`. This design uses `update_cohort` and
  `show_oncomatrix`, so the team needs to agree the names.
- **Language:** the AG-UI spec requires Python tools, while the team's current tools
  are JavaScript. The same question is already open between the two agent designs.
- **Missing spec:** `docs/journeys.md` on the team fork refers to
  `openspec/changes/tool-2-cohort-oncomatrix/`, which wasn't found. If someone has it,
  it should be compared with this design.

## Evidence

| Claim | Source |
| --- | --- |
| Same plot and counts from OncoMatrix and ProteinPaint for one cohort | Local sandbox walkthrough and headless run, 2026-11-03: 148 samples and 14 variants on both |
| Create cohort appears only on the ProteinPaint route | Same runs |
| Both routes build an `mds3` track with the cohort filter | `@sjcrh/proteinpaint-client` 2.216.0, `lollipop-*.js` and `GB-*.js` |
| Chart selections save as case IDs through a window | `src/features/proteinpaint/updateFilters.tsx` in `mmrf-data-commons` |
| Race values and tabs | `src/features/apps/config/tabbedCohortBuilder.json`, and the local sandbox |
| Whole tool result reaches the model through Gateway | `2026-11-03-agentcore-agui-chat-design.md`, "Next tool" |
| Context reaches the prompt; `invocation_state` doesn't | `ag_ui_strands` 1.0.2 source |
| Undeclared arguments reach the Lambda | Live Gateway call and Lambda log, 2026-11-03 |
| Hook injection, result stripping and state sync | Offline spike with a scripted model and fake tool, 2026-11-03 |
| Toolkit registration and tool UI guidance | assistant-ui docs: toolkit migration, Tool UI, AG-UI runtime options and agent state |
| Allowed schema fields | AWS guide, Lambda function targets |
| Brief's requirements: visible plan, observations kept separate, stated limitations | `Vision_ORION-revised.docx`, Workstream 2 |
