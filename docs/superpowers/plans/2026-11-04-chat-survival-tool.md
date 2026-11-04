# Chat Survival Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `show_survival` chat tool that reports survival numbers and opens the real ProteinPaint survival chart, including the Vision document's CGS high-risk vs standard-risk comparison.

**Architecture:** A Python Lambda tool behind AgentCore Gateway calls ProteinPaint's `termdb/survival`, the endpoint the chart itself calls, and works out each group's numbers. The result's `plot` tells a new assistant-ui tool UI how to open the real chart through `CorrelationWrapper`, using the cohort filter from the existing `ChartFrame`.

**Tech Stack:** Python 3.13 and `unittest` (Lambda, agent); Next.js, React, assistant-ui and Jest (frontend); `@sjcrh/proteinpaint-client` 2.216.0; Terraform.

**Spec:** `docs/superpowers/specs/2026-11-04-chat-survival-tool-design.md`. It builds on `docs/superpowers/specs/2026-11-03-chat-cohort-lollipop-tools-design.md`.

**Repos:** both on branch `feature/chat-cohort-tools`, under `my-forks/`.
- `SANDBOX` = `mmrf-virtual-lab-sandbox`. Lambda and agent code is in `agentcore-poc/`.
- `FRONTEND` = `mmrf-data-commons`.

## Global Constraints

- The model never supplies or sees a cohort filter. Tool schemas have no cohort input. `cohortFilter` arrives in `args`, added by the agent's hook, and never goes in a result.
- Only `update_cohort` changes the cohort.
- The agent quotes only numbers from `summary`. Only `status: "error"` shows as a failed step.
- `plot` holds settings only, never case data or filters.
- Numbers and charts use the same endpoint, deployment and cohort.
- Don't commit account IDs, CloudFront hosts, Runtime or Gateway IDs, passwords or home paths. These are public forks.
- Don't read or print `terraform.tfstate`, `*.tfvars`, `.env*.local`, `access.json` or `.sandbox-access.json`.
- `terraform apply` and any push each need the user's go-ahead at that step. Commit locally only.
- Never stage FRONTEND's untracked `AGENTS.md` or `CLAUDE.md`. Stage files by name.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Jest runs with `NODE_OPTIONS=--no-experimental-strip-types`.

## Review Focus

1. **Three or more groups (Race):** every pair's p-value is reported, not just the first. Pinned in Task 2.
2. **A group whose curve never reaches 0.5:** the median reads "not reached" and isn't omitted or zero. Pinned in Task 2.
3. **A cohort built from case IDs:** no case ID appears anywhere in the result. Pinned in Task 2.
4. **`compareBy` with odd casing, spaces or a non-string:** resolves or fails cleanly, and a blank value means one curve. Pinned in Task 2.
5. **The All cases filter `{"and": []}`:** an empty but real filter reaches the chart, and isn't replaced by the page's current cohort. Pinned in Task 1.

---

### Task 1: Prove the direct chart launch

This is the riskiest assumption, so it comes first. **If the chart can't be opened this way, stop and ask the user.** Don't choose another route.

**Files:**
- Create: `FRONTEND/src/features/proteinpaint/correlationArg.ts`, moving `getCorrelationTrack` and its `Mds3Arg` and `CorrelationArgOpts` types out of `CorrelationWrapper.tsx`
- Modify: `FRONTEND/src/features/proteinpaint/CorrelationWrapper.tsx`
- Test: `FRONTEND/src/features/proteinpaint/correlationArg.unit.test.ts`

**Interfaces:**
- Produces: `getCorrelationTrack(basepath: string, callback: SelectSamplesCallback, filter0: unknown, plots?: ReadonlyArray<object>): Mds3Arg`, and `CorrelationWrapper` props `filter0Override?: object` and `plots?: ReadonlyArray<object>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('leaves the page default alone without plots', () => {
  const arg = getCorrelationTrack('/pp', callback, { and: [] });
  expect(arg.launchGdcCorrelation).toBe(true);
  expect(arg).not.toHaveProperty('state');
});

it('passes plots through as state.plots', () => {
  const plots = [{ chartType: 'survival', term: { id: 'overall_survival' } }];
  expect(getCorrelationTrack('/pp', callback, { and: [] }, plots).state).toEqual({ plots });
});

it('keeps an empty but real filter', () => {
  expect(getCorrelationTrack('/pp', callback, { and: [] }).filter0).toEqual({ and: [] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/proteinpaint/correlationArg.unit.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `correlationArg.ts` and update the wrapper**

In the wrapper, use `const filter0 = props.filter0Override ?? (isDemoMode ? null : buildCohortGqlOperator(currentCohort));`, as `ProteinPaintWrapper.tsx:35` does, and add `props.plots` to the `useDeepCompareEffect` dependencies. Keep `allow2selectSamples` as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Controller proves it in a browser**

Add an **uncommitted** page, `src/pages/survival-probe.tsx`, that renders `<CorrelationWrapper filter0Override={...} plots={[{ chartType: 'survival', term: { id: 'overall_survival' }, term2: { id: 'cgs_risk_category' } }]} />` through `next/dynamic` with `ssr: false`. If that term shape is rejected, try `term: { term: { id } }`. Open it through the Chrome DevTools MCP.

Expected, with no clicks on the Survival button:
- `{ and: [] }`: two labelled curves with 334 and 666 cases, and the "Group comparisons (log-rank test)" table.
- `{ and: [{ in: { 'demographic.race': ['black or african american'] } }] }`: 103 and 231 cases.
- Settings and Download work.

Compare with the deployed values on the day, not only these. Record the working term shape in the ledger, since Task 3 uses it. Delete the page, and confirm `git status --short` shows no probe file.

- [ ] **Step 6: Confirm the page is unchanged**

Open `/?app=Correlation`. Expected: the default panel with Correlation Input and Survival buttons, as before.

- [ ] **Step 7: Commit**

```bash
git add src/features/proteinpaint/correlationArg.ts src/features/proteinpaint/correlationArg.unit.test.ts src/features/proteinpaint/CorrelationWrapper.tsx
git commit -m "feat(proteinpaint): let CorrelationWrapper open a chosen plot on a chosen cohort"
```

---

### Task 2: The Lambda tool

**Files:**
- Modify: `SANDBOX/agentcore-poc/lambda/virtual_lab_client.py`, `lambda/handler.py`, `lambda/tools.json`
- Create: `SANDBOX/agentcore-poc/lambda/tool_show_survival.py`
- Test: `SANDBOX/agentcore-poc/tests/test_show_survival.py`, `tests/test_client.py`, `tests/test_tools_json.py`, `tests/test_handler.py`
- Create: `SANDBOX/agentcore-poc/tests/fixtures/survival-cgs-reply.json`, a short real-shaped reply with the keys listed below

**Interfaces:**
- Produces, on `VirtualLabClient`:
  - `_get(path: str, query: dict) -> dict`: GET with JSON-encoded query values, and the same error mapping as `_post`. Share that mapping rather than copying it.
  - `survival_term() -> dict`: from GET `/protein-paint/termdb/config` with `embedder=localhost`, at `termdbConfig.loneTermByType[""].survival`. **This endpoint returns 404 for POST.** A missing term raises `ClientError("unhealthy", ...)`.
  - `comparison_term(term_id: str) -> dict | None`: from GET `termdb/termchildren` with `filter={"type":"tvslst","in":true,"join":"","lst":[]}`, matching on `id` in `lst`.
  - `survival(survival_term: dict, compare_term: dict | None, cohort_filter: dict | None) -> dict`: POST `termdb/survival` through `_paint`, with `term1 = {"$id": "survival", "term": survival_term, "q": {}}`, `term2 = {"$id": "compare", "term": compare_term, "q": {"type": "values"}}` when comparing, and `cohort_filter or {"and": []}` as the filter. **The `$id` values are required.** It raises `ClientError("unhealthy", ...)` when the reply has an `error` field, or lacks `keys` or `case`, or `keys` lacks any of `seriesId`, `time`, `survival`, `nevent`, `ncensor`, `nrisk`.
- Produces, in `tool_show_survival.py`: `show_survival(args: dict, client) -> dict`, registered in `CLIENT_TOOLS`.

**Comparison list:** spellings are matched after `.strip().lower()`.

| Dataset field | Label | Spellings |
| --- | --- | --- |
| `cgs_risk_category` | CGS risk | `cgs risk`, `cgs risk category`, `cgs`, `risk`, `risk category` |
| `kras_status` | KRAS status | `kras status`, `kras`, `kras mutation status` |
| `gender` | Sex | `sex`, `gender` |
| `race` | Race | `race` |

**Numbers:** group rows by `seriesId` in first-seen order. Cases = `nrisk` on the group's first row; deaths = sum of `nevent`; censored = sum of `ncensor`; median = first `time` where `survival <= 0.5`, to 2 decimals with the term's `unit`, or "not reached". P-values come from `tests[""]`, as `series1`, `series2` and `pvalue`, passed through as given.

**Exact summary wording:**
- One curve: `"1000 cases, overall survival. 601 deaths, 399 censored, median 6.01 years. Medians are calculated from the curve."`
- Two groups: `"1000 cases, overall survival, compared by CGS risk. High risk: 334 cases, 292 deaths, 42 censored, median 3.21 years. Standard risk: 666 cases, 309 deaths, 357 censored, median 8.92 years. Log-rank P-value: 4.6e-14. Medians are calculated from the curve."`
- A `"0"` p-value replaces that sentence with: `"Log-rank P-value shows 0 on the chart, meaning too small to calculate exactly."`
- Three or more groups: `"Log-rank P-values: asian vs white 0.34, ..."`, with every pair. A `"0"` here reads `"a vs b shows 0 on the chart, meaning too small to calculate exactly"`.
- When the total cases differ from `client.case_count`: add `" The chart counts {total} cases, and the cohort has {case_count}."`
- Use "1 case", "1 death" for counts of one.

**Result fields:** `status`, `summary`, `cohort` (`{"label": label(filter), "caseCount": n}`, and the hook adds `revision`), `groups` (names only, left out for one curve), `comparedBy` (the label, left out for one curve), `plot` (`{"type": "survival", "term": <survival term id>, "compareBy": <field id>}`, with `compareBy` left out for one curve).

**Outcomes:**

| Status | When | Fields and wording |
| --- | --- | --- |
| `unsupported_comparison` | Not on the list. No Virtual Lab call is needed | `"There's no survival comparison by '{asked}' yet. Available: CGS risk, KRAS status, Sex, Race."`, `available`, no `plot` |
| `no_cases` | `case` has no rows | `"This cohort has no cases, so there's no survival curve."`, `cohort`, no `plot` |
| `one_group` | `compareBy` given, one group returned | `"Comparing by {label} leaves one group in this cohort: {name}. ..."` then that group's numbers, with `plot`, and no p-value |
| `error` | `compareBy` isn't a string: `failure("invalid_input", "compareBy must be text, such as CGS risk.")`. `ClientError`: `failure(error.step, str(error))`, logged without the filter. `comparison_term` returns `None`: `failure("unhealthy", ...)` | |

- [ ] **Step 1: Write the failing tests**

Use a `FakeClient`, as `tests/test_show_lollipop.py` does, for tool tests. Client tests use the fake opener in `tests/test_client.py`. Test names, with assertions:

```python
def test_two_groups_give_the_exact_summary(self): ...      # The two-group wording above, status ok
def test_one_curve_has_no_groups_or_compare(self): ...     # plot == {"type": "survival", "term": "overall_survival"}
def test_zero_p_value_is_explained(self): ...              # "shows 0 on the chart", and "p = 0" not in summary
def test_three_groups_list_every_pair(self): ...           # All 3 pairs of the Race reply are in summary
def test_median_not_reached(self): ...                     # Curve stays above 0.5: "median not reached"
def test_median_at_exactly_half(self): ...                 # survival == 0.5 counts as reached
def test_spellings_resolve(self): ...                      # " CGS Risk ", "kras", "GENDER", "Race" reach the right field id
def test_blank_compare_by_means_one_curve(self): ...       # "" and "  " and None
def test_non_string_is_invalid_input(self): ...            # 7 gives status error, step invalid_input
def test_unsupported_makes_no_call(self): ...              # "TP53": unsupported_comparison, client not called, no plot
def test_empty_reply_is_no_cases(self): ...                # case == []: no_cases, no plot
def test_one_group(self): ...                              # one_group, has plot, "P-value" not in summary
def test_count_mismatch_is_stated(self): ...               # Status stays ok, both numbers in summary
def test_case_ids_stay_out_of_the_result(self): ...        # Filter of SYNTH-CASE ids: "SYNTH-CASE" and "cohortFilter" not in json.dumps(result)
def test_client_error_is_a_failed_step(self): ...          # auth_failed gives status error, no numbers
def test_error_field_in_reply_is_unhealthy(self): ...      # Client test: {"error": "term1 is missing $id"} raises
def test_missing_column_is_unhealthy(self): ...            # Client test: keys without nrisk raises
def test_config_uses_get(self): ...                        # Client test: request method is GET for termdb/config
def test_all_cases_sends_an_empty_filter(self): ...        # Client test: filter0 == {"and": []} in the POST body
```

In `tests/test_tools_json.py`, add: `show_survival` exists; its description contains "Correlation Plot", "Kaplan-Meier" and "survival analysis"; `compareBy` isn't in `required`. In `tests/test_handler.py`, add: `show_survival` is in `CLIENT_TOOLS`.

- [ ] **Step 2: Run the tests to verify they fail**

Run, from `agentcore-poc`: `python3 -m unittest discover -s tests -p 'test_show_survival.py'`
Expected: FAIL, no module named `tool_show_survival`.

- [ ] **Step 3: Implement the client methods, the tool, the handler entry and the schema**

Add this to `tools.json`, in the style of `show_lollipop`:

```json
{
  "name": "show_survival",
  "description": "Shows a Kaplan-Meier survival plot from the Correlation Plot tool for the researcher's selected cohort. Use it for survival analysis, Kaplan-Meier or overall survival, such as 'Using the Correlation Plot tool, perform Kaplan Meyer survival analysis to overlay CGS high-risk versus standard-risk' or 'Compare survival for high risk vs standard risk'. To compare groups, give compareBy. The result reports cases, deaths, censored cases, median survival and log-rank P-values, or says a comparison isn't available. It never takes a cohort, and only reports numbers; the plot is drawn for the researcher.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "compareBy": {
        "type": "string",
        "description": "What to split the curve by. One of: CGS risk, KRAS status, Sex, Race. Leave out for one curve."
      }
    },
    "required": []
  }
}
```

- [ ] **Step 4: Run all Lambda tests to verify they pass**

Run: `python3 -m unittest discover -s tests -p 'test_*.py'`
Expected: all pass, except `test_scripts`, which needs the agent environment: `(cd agent && uv run python -m unittest discover -s ../tests -p 'test_scripts.py')`.

- [ ] **Step 5: Commit**

```bash
git add agentcore-poc/lambda/virtual_lab_client.py agentcore-poc/lambda/tool_show_survival.py agentcore-poc/lambda/handler.py agentcore-poc/lambda/tools.json agentcore-poc/tests/test_show_survival.py agentcore-poc/tests/test_client.py agentcore-poc/tests/test_tools_json.py agentcore-poc/tests/test_handler.py agentcore-poc/tests/fixtures/survival-cgs-reply.json
git commit -m "feat(agentcore): add the show_survival tool"
```

---

### Task 3: The tool UI

**Files:**
- Create: `FRONTEND/src/features/chat/tools/SurvivalToolUI.tsx`
- Modify: `FRONTEND/src/features/chat/toolkit.tsx`, `FRONTEND/src/features/chat/suggestedPrompts.ts`
- Test: `FRONTEND/src/features/chat/tools/SurvivalToolUI.unit.test.tsx`

**Interfaces:**
- Consumes: from Task 1, `CorrelationWrapper` with `filter0Override` and `plots`, and the term shape recorded in the ledger. From Task 2, the result fields `status`, `summary`, `cohort`, `comparedBy` and `plot`.
- Produces: `survivalPlots(plot: { term: string; compareBy?: string }): ReadonlyArray<object>`, exported and used by the default-export `SurvivalToolUI`.

Follow `LollipopToolUI.tsx`. Load `CorrelationWrapper` through `next/dynamic` with `ssr: false`. Title: `Correlation Plot · Survival`, plus ` · ${comparedBy}` when present. Register `'virtual-lab___show_survival': { type: 'backend', display: 'standalone', render: SurvivalToolUI }`. Add `'Compare survival for CGS high risk vs standard risk'` to `SUGGESTED_PROMPTS`.

- [ ] **Step 1: Write the failing tests**

Mock `./ChartFrame` to call `children({ and: [] })`, and mock `next/dynamic` to render a stub that records its props.

```ts
it('titles a comparison and draws the chart on the frame filter', ...);
// result with comparedBy 'CGS risk': text 'Correlation Plot · Survival · CGS risk'; stub got filter0Override { and: [] } and plots from survivalPlots
it('titles one curve without a comparison', ...);
it('shows Details with compareBy', ...);
it('shows the message and no chart without a plot', ...);
// unsupported_comparison: summary is visible, chart stub not rendered
it('draws the single curve for one_group', ...);
it('shows Failed with no chart on an error', ...);
it('builds plots with and without a comparison', ...);
// survivalPlots({ term: 'overall_survival' }) has no term2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/chat/tools/SurvivalToolUI.unit.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement it, and register it**

- [ ] **Step 4: Run all Chat tests and lint**

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/chat` and `npx eslint src/features/chat src/features/proteinpaint/correlationArg.ts`
Expected: all pass, 0 lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/tools/SurvivalToolUI.tsx src/features/chat/tools/SurvivalToolUI.unit.test.tsx src/features/chat/toolkit.tsx src/features/chat/suggestedPrompts.ts
git commit -m "feat(chat): show the survival tool's chart and result"
```

---

### Task 4: The prompt rule

**Files:**
- Modify: `SANDBOX/agentcore-poc/agent/main.py`
- Test: `SANDBOX/agentcore-poc/agent/test_main.py`

- [ ] **Step 1: Write the failing test**

```python
def test_separates_comparing_from_filtering(self):
    for words in ("show_survival", "compareBy", "leave the cohort as it is", "never write p = 0"):
        with self.subTest(words=words):
            self.assertIn(words, main.SYSTEM_PROMPT)
```

- [ ] **Step 2: Run it to verify it fails**

Run, from `agentcore-poc/agent`: `uv run python -m unittest test_main`
Expected: FAIL on `show_survival`.

- [ ] **Step 3: Add this to `SYSTEM_PROMPT`, after the line about calling `update_cohort` first**

```text
Comparing groups isn't filtering. When the researcher compares groups, such as high risk vs standard risk, call show_survival with compareBy and leave the cohort as it is. When they ask about one group only, such as survival for high-risk patients, call update_cohort first, then show_survival without compareBy.
If a P-value shows 0, say what the summary says and never write p = 0.
```

Change "Follow-up buttons appear under each chart" to "Follow-up buttons appear under some charts". Keep `buttons` in the prompt, since a test requires it.

- [ ] **Step 4: Run the agent tests to verify they pass**

Run: `uv run python -m unittest discover -p 'test_*.py'`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add agentcore-poc/agent/main.py agentcore-poc/agent/test_main.py
git commit -m "feat(agentcore): separate comparing groups from filtering in the prompt"
```

---

### Task 5: Deploy and live checks

The controller runs this task, through the Chrome DevTools MCP. It needs the user at two points.

**Files:**
- Modify: `SANDBOX/agentcore-poc/README.md`
- Create: `SANDBOX/agentcore-poc/tests/fixtures/survival-cgs.sse`, `survival-one-group.sse`
- Modify: `SANDBOX/agentcore-poc/tests/fixtures/journey-oncomatrix.sse`

- [ ] **Step 1: Confirm why the p-value is `"0"`**

Read the published `@sjcrh/proteinpaint-server` survival code, in a new empty directory, without running it. If it confirms underflow or rounding, keep the wording. If it can't be confirmed, change the wording in Task 2's code and tests to: `"Log-rank P-value shows 0 on the chart. The service gives no more exact value."`

- [ ] **Step 2: Get the user's go-ahead, then deploy**

Confirm `workshop` credentials are valid, and ask the user to refresh them if not. Copy state to `terraform-state/backups/`, run `scripts/build_agent.sh` and `terraform plan`, and show the user the plan. Apply only with their go-ahead. The only expected destroy is the old agent zip in S3. This also ships the five final-review fixes. Restart `next dev` if credentials changed.

- [ ] **Step 3: Walk the spec's acceptance table**

Record what the page showed for each row, comparing with the chart and cohort bar. Turn on Median Survival to check medians against the dashed lines. If they disagree, treat it as a defect in Task 2's median and stop to fix it.

- [ ] **Step 4: Check the final-review fixes on the deployed agent**

Top 3 sample counts agree with the chart. "ISS stage I" resolves without asking. "Patients over 60" reports not supported. "Now using" doesn't repeat. Update the README's pending-deploy paragraph to match.

- [ ] **Step 5: Wrong-login check, with the user's go-ahead**

As in the earlier plan: fake login in the secret, restart the Lambda by changing the timeout from 60 to 61, check for a Failed step with no numbers, restore the login, set the timeout back to 60, and confirm health and that `terraform plan` shows no changes.

- [ ] **Step 6: Record streams and results**

Record with `scripts/invoke.py --save`, check them with `agent/test_answers.py`'s `check_numbers`, and confirm no filter outside `STATE_SNAPSHOT`. Add results to the README, and document `show_survival`.

```bash
git add agentcore-poc/README.md agentcore-poc/tests/fixtures/survival-cgs.sse agentcore-poc/tests/fixtures/survival-one-group.sse agentcore-poc/tests/fixtures/journey-oncomatrix.sse
git commit -m "docs(agentcore): record live checks for the survival tool"
```

- [ ] **Step 7: Final review, secrets scan, then ask before pushing**

Run the whole-branch review on the most capable model. Rerun the outgoing secrets scan on both forks, as in the earlier plan's Task 12. Report the results, and ask the user whether to push.
