# Chat survival tool: design

Date: 2026-11-04
Status: design approved in conversation, awaiting review of this document. Nothing here has been built.
Builds on: [`2026-11-03-chat-cohort-lollipop-tools-design.md`](2026-11-03-chat-cohort-lollipop-tools-design.md).
Its rules, result format and cohort path apply here unless this document says otherwise.

## Goal

Let a researcher ask for a survival analysis in chat, instead of taking 6 clicks and
the adjustments in the Correlation Plot. The journey is written up in
`user-journey/user-journey-correlation-plot-survival.md` in the hackathon workspace, outside this repository.

The main case is the survival question in MMRF's Vision document. It comes in two wordings,
and both must lead to the same analysis:

- "Using the Correlation Plot tool, please perform Kaplan Meyer survival analysis to overlay
  outcomes of patients diagnosed with CGS high-risk versus CGS standard-risk disease."
- "Please perform survival analysis to compare outcomes of patients diagnosed with CGS
  high-risk versus CGS standard-risk disease."

The Vision document's expected outcome: "displays the overlaid survival curves with group
labels, case counts, and available statistics."

All numbers in this document come from the deployed synthetic data on 2026-11-04. They
have no clinical meaning, and tests compare with the live chart, not with these values.

## Decisions

| Decision | Choice | Source |
| --- | --- | --- |
| Scope | One curve, or a comparison through an optional `compareBy`. No chart settings as tool options | User, option A |
| Chart | The real ProteinPaint survival chart, opened directly in the state the tool chose | User, approach 1 |
| Source of numbers | `termdb/survival`, the endpoint the chart itself calls, not Gen3 Analysis | Recommendation, accepted |
| Which patients | The active cohort, labelled on the answer and chart. A fresh page means all cases | User, option A |
| "A vs B" | A comparison on the current cohort. The cohort doesn't change, and no cohorts are saved | Recommendation, accepted |
| "Survival for high-risk patients" | `update_cohort`, then one curve. The cohort stays changed and offers Undo, as "only women" does | Recommendation, accepted |
| A p-value of `"0"` | Report what the chart shows and explain it. Never write "p = 0" as if exact | Recommendation, accepted |
| Race as a comparison | Kept, if it passes a live check | Recommendation, accepted |

The Vision document says the agent "selects" two cohorts. This design uses one overlay on
the active cohort, which gives the same two curves and matches the journey's route. Nothing
is saved. The user chose this over saving two named cohorts, and the demo should say so out
loud, because a literal reading could ask where the cohorts are. With a filter active, the
answer covers only those patients, so clear the cohort before showing this question.

## Scope

**In scope:**

- The `show_survival` tool
- A prompt rule that separates comparing groups from filtering to one
- `SurvivalToolUI`, optional props on `CorrelationWrapper`, and a suggested prompt
- Unit tests and live browser checks

**Out of scope:**

- Gene comparisons beyond KRAS
- Progression-free survival, which the sandbox doesn't offer
- Divide By, and chart settings as tool options
- Number-range groups, such as age
- Naming the cohort in downloaded chart files, which ProteinPaint controls
- Follow-up buttons on the result

## Tool: `show_survival`

### Input

One optional string, `compareBy`. There is no cohort input, per the existing rules. Allowed
values go in the schema description, and Python checks them, because Gateway schemas can't
enforce values.

| Researcher says | `compareBy` | Dataset field |
| --- | --- | --- |
| Nothing to compare | Left out | One curve |
| CGS risk, high vs standard risk | CGS risk | `cgs_risk_category` |
| KRAS mutated vs not | KRAS status | `kras_status` |
| Men vs women | Sex | `gender` |
| Across races | Race | `race`, if it passes the live check |

Fields left out on purpose:

- `vital_status`: part of the outcome being measured, so comparing by it is circular.
- `age_at_index`: a number, so it would need groups someone has to define.
- `therapeutic_agents`: one patient can have several values.

Matching is case-insensitive and accepts the spellings in the table. Anything else returns
`unsupported_comparison`.

The tool's description names "Correlation Plot", "Kaplan-Meier" and "survival analysis", so
that both wordings of the Vision question reach it. The Vision document says the open-ended
wording tests whether the agent can select the tool.

### Numbers

The Lambda calls `termdb/survival` with the filter the hook supplies. The survival term comes
from the dataset's config (`loneTermByType`), not a hardcoded name, because "Synthetic overall
survival" may be named differently in production. It sends `$id` on each term, which the
service requires.

The reply has `keys` and `case` rows (`seriesId`, `time`, `survival`, `lower`, `upper`,
`nevent`, `ncensor`, `nrisk`), `refs.orderedKeys.series`, and `tests` when there is an overlay.
For each group, the tool works out:

| Number | How |
| --- | --- |
| Cases | `nrisk` on the group's first row |
| Deaths | Sum of `nevent` |
| Censored | Sum of `ncensor` |
| Median survival | First `time` where `survival` is 0.5 or below, or "not reached" |

The p-value is passed through exactly as the service returns it.

The chart doesn't print a median, so the summary says medians are calculated from the curve.

**A p-value of `"0"`:** the chart prints 0 for CGS risk on all cases, in its "Group comparisons
(log-rank test)" table. The summary says the chart shows 0 and that it's too small to calculate
exactly. That reason is an inference from how far apart the curves are, so the build must
confirm it in the server's code and correct the wording if it's wrong.

**Check against the cohort:** the tool compares the total starting count with the Guppy case
count for the cohort. They matched at 1,000 and 334 on the live data. If they differ, the
summary states both numbers. It isn't treated as a failure, because ProteinPaint can
legitimately count fewer: OncoMatrix shows 287 samples for 334 cases. A live check confirms
that a filter on a field ProteinPaint can't read doesn't silently give all cases. If it does,
that case must become a failed step.

### Result

```json
{
  "status": "ok",
  "summary": "1000 cases, overall survival, compared by CGS risk. High risk: 334 cases, 292 deaths, 42 censored, median 3.21 years. Standard risk: 666 cases, 309 deaths, 357 censored, median 8.92 years. Log-rank P-value shows 0 on the chart, meaning too small to calculate exactly. Medians are calculated from the curve.",
  "cohort": { "label": "All cases", "caseCount": 1000, "revision": 1 },
  "groups": ["High risk", "Standard risk"],
  "plot": { "type": "survival", "compareBy": "cgs_risk_category" }
}
```

`plot` holds settings only, never case data or filters. The time unit comes from the dataset's
config.

### Outcomes

| Status | When | What the researcher sees |
| --- | --- | --- |
| `ok` | One curve or a comparison | Chart and numbers |
| `no_cases` | The cohort has no cases | Says so, with no chart |
| `one_group` | Comparing leaves one group, such as CGS risk in a High-risk-only cohort | Says so and shows the single curve, with no p-value |
| `unsupported_comparison` | The group isn't on the list, such as TP53 or age | Lists what's available, with no chart |
| `error` | See Failures | Failed step, with no numbers |

## Conversation

Answers keep the existing format: plan, tool step, chart with cohort label, Observed, Limits.

The system prompt gains a rule, because the main risk is confusing two similar requests:

| Researcher asks | What the agent does |
| --- | --- |
| "High risk vs standard risk" | `show_survival` with `compareBy`. The cohort doesn't change |
| "Survival for high-risk patients" | `update_cohort` to High risk, then `show_survival` for one curve |
| "Now split that by KRAS" | `show_survival` with KRAS status, on the current cohort |

Interpretation stays out unless the researcher asks, and is then labelled separately from what
was observed. The difference between CGS groups is a designed effect in the synthetic data, so
the answer doesn't describe it as a cause.

Limits include that the data is synthetic, that numbers are for the default view and don't
reflect changes made in the chart, and that medians are calculated from the curve.

## Frontend

| File | Change |
| --- | --- |
| `src/features/proteinpaint/CorrelationWrapper.tsx` | Optional `filter0Override` and `plots` props. Without them, the Correlation Plot page behaves as it does today. `plots` passes through as `state.plots` to the launcher |
| `src/features/chat/tools/SurvivalToolUI.tsx` (new) | Tool row, the existing `ChartFrame` with its cohort label, and the chart. The row reads "Correlation Plot · Survival", plus the comparison when there is one, such as "· CGS risk". Its Details show `compareBy`, so the researcher can see the tool and settings used. Without a `plot`, only the row and message |
| `src/features/chat/toolkit.tsx` | Registers `virtual-lab___show_survival` with `display: "standalone"` |
| `src/features/chat/suggestedPrompts.ts` | Adds "Compare survival for CGS high risk vs standard risk" |

ProteinPaint's launcher (`gdc/correlation.ts`, in client 2.216.0) uses `arg.state?.plots` when
given, so `plots: [{ chartType: "survival", term, term2 }]` should open the chart directly.
**This hasn't been run.** It's the first build step.

The chart keeps the cohort it ran with, per rule 4 of the earlier design. Settings and Download
come with the real chart, and the agent can't see changes made there.

## Failures

| What goes wrong | What the researcher sees |
| --- | --- |
| Login refused, service down or timeout | Failed step, with no numbers |
| Reply missing `keys` or `case`, or a column is absent | Failed step. Partial numbers are never reported |
| The service returns an `error` field | Failed step, with the detail in the Lambda log and a plain message on screen |
| The chart fails to draw but the numbers succeed | `ChartFrame`'s existing handling. The numbers still come through |

An empty reply (`case` with no rows) for a valid cohort is `no_cases`, not a failure.

## Acceptance checks

Run in a browser through the Chrome DevTools MCP against the deployed agent. Compare numbers
with the chart on the same page, not with values in this document.

| Check | Expected |
| --- | --- |
| Both wordings of the Vision question | Same tool call. Two labelled curves. Group sizes, and the p-value as shown, match the chart |
| One curve on a filtered cohort | Starting count matches the cohort bar |
| "Survival for high-risk patients", then Undo | Cohort changes, one curve, and Undo restores it. The older chart keeps its label |
| CGS comparison in a High-risk-only cohort | `one_group`, with no p-value |
| TP53 comparison | `unsupported_comparison`, listing what's available |
| Empty cohort | `no_cases`, with no chart. Chat won't apply a 0-case cohort, so this is checked in a unit test, and live only if a route to it exists |
| Race comparison | Works, or Race is removed from the list |
| Wrong login | Failed step, with no numbers from it |
| Second turn in one thread | Earlier charts stay on screen and don't refetch |
| Medians | Match the chart's dashed lines with Median Survival turned on |
| Model behavior | The tool schema offers no way to pass a cohort |

## Testing

| Check | Covers |
| --- | --- |
| Python unit tests | Summary numbers from a recorded reply, median including "not reached", each outcome, p-value `"0"` vs a normal one, `compareBy` spellings, malformed replies |
| Existing schema test | No tool schema offers a cohort |
| Agent tests | The filter never reaches the prompt or results, and the "vs" rule is in the prompt |
| Frontend tests | `SurvivalToolUI` row, chart and failure states. `CorrelationWrapper` unchanged without the new props |
| Browser checks | The acceptance table |

## Build order

1. Prove the direct launch: `CorrelationWrapper` with `plots` opens the survival chart with the
   overlay and the cohort. **If this fails, stop and ask the user** before choosing another route.
2. Lambda tool and tests.
3. Frontend tool UI.
4. Prompt rule.
5. Deploy and live checks.

`terraform apply` and any push each need the user's go-ahead at that step. The deploy also carries
the five final-review fixes from the earlier work, which are committed and not yet deployed.

## Known limits

- The downloaded chart file doesn't name the cohort. Chat shows the label on screen only.
- "+Add new filter" and Divide By may still appear in the embedded chart, as they do on the page.
  Neither was tested in chat.
- The agent can't see changes made inside the chart.

## Team impact

This is in the Python agent on the `rvantaylor` forks, so it doesn't change the team's Node agent
contract. The earlier decision that this agent replaces the Node one in infra-1 and infra-2 still
needs telling to the team.

## Evidence

Run on 2026-11-04 against the deployed services, through the local forwarder:

| Request | Result |
| --- | --- |
| `termdb/config` | Advertises `survival` and the `overall_survival` term |
| `termdb/survival`, no overlay, all cases | 1,000 cases, 601 deaths, 399 censored, median 6.01 |
| Same, Race = black or african american | 334 cases, 195 deaths, 139 censored, median 6.28 |
| CGS risk, all cases | 334 and 666 cases. `pvalue: "0"`. The chart prints 0 and shows 334 and 666 |
| CGS risk, Race cohort | 103 and 231 cases, p = 4.6e-14. The journey doc's local run shows 98 and 236, p = 7.1e-14 |
| KRAS status, Race cohort | 148 and 186 cases, p = 6.4e-08 |
| Gender, Race cohort | 167 and 167 cases, p = 0.49 |
| Gene overlay, TP53, attempted term shape | One group only, with no comparison or p-value |
| Empty filter match | `case` empty, with no error |
| Term without `$id` | HTTP 200 with `error: "term1 is missing $id"` |
