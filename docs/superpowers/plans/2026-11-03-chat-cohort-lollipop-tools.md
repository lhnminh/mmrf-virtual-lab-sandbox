# Chat Cohort-to-Lollipop Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a researcher go from a cohort to OncoMatrix to a Lollipop plot by asking in Chat, with numbers from Python Lambda tools and charts from the platform's own ProteinPaint components.

**Architecture:** The agent reaches services only through Python Lambda tools behind AgentCore Gateway. The cohort filter travels through AG-UI `state` and `invocation_state`, and Strands hooks add it to tool calls and remove it from results, so the model never sees it. The browser applies resolved changes once per revision, and charts read the deployed services through a local forwarding script.

**Tech Stack:** Python 3.13, Strands, `ag-ui-strands` 1.0.2, AgentCore Gateway and Runtime, Terraform, Next 16 Pages Router, `@assistant-ui/react` 0.15.32, `@assistant-ui/react-ag-ui` 0.1.1, ProteinPaint client, `@playwright/test` 1.58.2.

**Spec:** `docs/superpowers/specs/2026-11-03-chat-cohort-lollipop-tools-design.md`, in the sandbox fork. Read it first. It builds on `2026-11-03-agentcore-agui-chat-design.md`.

## Global Constraints

- **Sandbox work:** `my-forks/mmrf-virtual-lab-sandbox`, new branch `feature/chat-cohort-tools` from `feature/agentcore-poc`. Folder `agentcore-poc/`.
- **Frontend work:** `my-forks/mmrf-data-commons`, new branch `feature/chat-cohort-tools` from `feature/agui-chat`.
- **Both forks are public.** The account ID, CloudFront URL, Runtime and Gateway IDs, password and home-directory paths never appear in committed files. Real values live only in git-ignored files.
- **Frontend commands** need pinned tools: `NX="npx -y -p node@24.18.1 -p npm@11.16.0 --"`, then `$NX npm ...`. In zsh, call it through a function, because a variable won't word-split. Jest also needs `NODE_OPTIONS=--no-experimental-strip-types`.
- The agent reaches services only through Python Lambda tools. All tools are Python.
- Tool schemas never include a cohort input. The filter never appears in anything the model reads: prompt, tool arguments or tool results.
- Tool results are small and hold settings, never chart data or case IDs. A tool result reaches the model whole.
- Only `status: "error"` is a failed step. `ambiguous`, `no_data` and similar are results.
- Allowed values go in tool descriptions and are checked in Python, because Gateway schemas only support `type`, `description`, `properties`, `required` and `items`.
- `terraform apply` and `destroy` need the user's go-ahead at that step. Pushing needs the user's instruction, after the scan in Task 12. Commit locally only.
- Don't `git add` the frontend's untracked `AGENTS.md` and `CLAUDE.md`, which `next dev` regenerates.
- Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code, as `AGENTS.md` requires.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A replayed or reloaded message arrives after the cohort changed.** Expect no second application of that revision. Pinned in Task 9.
2. **A chart's revision has no stored filter.** Expect a "cohort unavailable" message, never a chart silently drawn on the current cohort. Pinned in Task 10.
3. **The cohort came from Save Cohort, with hundreds of case IDs.** Expect the label "Selected cases", and no case ID in any result the model reads. Pinned in Tasks 4 and 7.
4. **The researcher changes the dropdown while an answer is running.** Expect their change to survive, with only the fields the tool changed being touched. Pinned in Task 9.
5. **Undo is clicked after a manual edit, or clicked twice.** Expect no Undo offered after an edit, and a second click to do nothing. Pinned in Task 9.

---

### Task 1: Move Terraform state to the fork and branch both repos

The deployed agent's state is in `theMMRF/mmrf-virtual-lab-sandbox-agentcore-poc/agentcore-poc/terraform`. There must be one copy, and it must be next to the code that deploys from now on.

**Files:** No tracked files change.

- [ ] **Step 1: Create the branches**

In each fork: `git checkout -b feature/chat-cohort-tools <base>`. Commit the amended spec and this plan on the sandbox branch.

- [ ] **Step 2: Move the state**

Move `terraform.tfstate`, `terraform.tfstate.backup` and `poc.auto.tfvars` into `my-forks/mmrf-virtual-lab-sandbox/agentcore-poc/terraform/`. Move, don't copy. Then confirm with `git check-ignore` that all three are ignored.

- [ ] **Step 3: Prove the state still matches AWS**

Run `bash scripts/build_agent.sh`, then in `terraform/`: `terraform init` and `AWS_PROFILE=workshop terraform plan`.
Expected: no destroys. The only allowed changes are the agent zip's key and the Runtime update it causes, because a rebuilt zip gets a new hash. Stop and report anything else.

- [ ] **Step 4: Install the frontend clone**

`$NX npm install`, then `git checkout -- public/mockServiceWorker.js` if the install changed it. Copy `.env.development.local` from the `theMMRF/mmrf-data-commons-agui` worktree, and confirm it's git-ignored.
Expected: `NODE_OPTIONS=--no-experimental-strip-types $NX npx jest --runInBand src/features/chat src/lib/agentRuntime` passes 49 tests.

---

### Task 2: Forwarding script and Playwright fast tier

Both are needed before any frontend change can be checked quickly, so this comes first.

**Files:**
- Create: `scripts/dev-forward.mjs`, `test/dev-forward.test.mjs`, `playwright.config.ts`, `e2e/support/session.ts`, `e2e/support/agentStream.ts`, `e2e/chat-health.spec.ts`
- Modify: `package.json` (`@playwright/test` at exactly 1.58.2, plus scripts `test:e2e` and `test:e2e:live`), `.gitignore` (`test-results/`, `playwright-report/`, `e2e/.auth/`)

**Interfaces:**
- Produces: `dev-forward.mjs` reads `SANDBOX_ACCESS_FILE`, JSON with `origin`, `username` and `password`. Port 3090 forwards to `origin`. Port 3091 forwards to `origin + "/protein-paint"`. Both add Basic auth and listen on 127.0.0.1 only.
- Produces: `.env.development.local` values `NEXT_PUBLIC_GEN3_API_TARGET=http://localhost:3090` and `PROTEINPAINT_API=http://localhost:3091`.
- Produces: `mockAgent(page, events: AgentEvent[], options?: { delayMs?: number }): Promise<PostedRun[]>` in `e2e/support/agentStream.ts`. It fulfils `POST /api/agent/agui` with SSE and records each posted `RunAgentInput`.
- Produces: `signIn(page)` in `e2e/support/session.ts`. It reads `/sandbox/session` through port 3090 and sets the `credentials_token` cookie for `localhost`.

- [ ] **Step 1: Write failing tests in `test/dev-forward.test.mjs`** (`node --test`, against a local fake upstream)

| Test | Assertion |
| --- | --- |
| `adds Basic auth` | The upstream receives the correct `authorization` header |
| `replaces any incoming authorization` | A caller's own header doesn't reach upstream |
| `drops incoming cookies` | The upstream gets no `cookie` header |
| `maps the ProteinPaint port` | `POST :3091/termdb/topMutatedGenes` reaches `/protein-paint/termdb/topMutatedGenes` |
| `passes method, body and status through` | A POST body arrives intact, and a 404 stays 404 |
| `streams the response` | Chunks arrive before the upstream ends |
| `binds to loopback` | The listening address is `127.0.0.1` |
| `refuses a bad access file` | Missing fields exit non-zero, and the message doesn't contain the file's contents |
| `never logs the password` | Captured output contains no password |

- [ ] **Step 2: Run them to see them fail, then implement `scripts/dev-forward.mjs`**

Node standard library only. Run: `$NX node --test test/dev-forward.test.mjs`
Expected: FAIL, then PASS.

- [ ] **Step 3: Prove charts work through it (design gate)**

With the script running and the new settings, open `/?app=CohortBuilder`, `/?app=OncoMatrix` and `/?app=ProteinPaint` in a browser session.
Expected: all three load with no 4xx or 5xx from `/guppy`, `/analysis` or `/protein-paint`, and OncoMatrix shows DIS3 at the deployed copy's count, which differs from the local stack's. **If this fails, stop and report**, because the spec's fallback is a user decision.

- [ ] **Step 4: Write `playwright.config.ts`**

`testDir: "e2e"`, Chromium only. `webServer` starts the forwarding script and `next dev --turbopack -H 127.0.0.1 -p 3000`, reusing existing servers. Fast tier is the default project; tests tagged `@live` run only in project `live`. `workers: 1`, screenshots and traces on failure. Don't commit anything from `test-results/`.

- [ ] **Step 5: Write `e2e/chat-health.spec.ts`**

```ts
test('shows a tool row, then streamed text, from a recorded run', async ({ page }) => {
  await signIn(page);
  const posted = await mockAgent(page, healthyRun, { delayMs: 50 });
  await page.goto('/?app=Chat');
  await page.getByRole('button', { name: 'Is the Virtual Lab healthy?' }).click();
  await expect(page.getByText('check_virtual_lab_health')).toBeVisible();
  await expect(page.getByText(/1,000 synthetic cases/)).toBeVisible();
  expect(posted[0].messages.at(-1).role).toBe('user');
});

test('shows a plain message when the agent is unreachable', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/agent/agui', (r) => r.fulfill({ status: 502, json: { error: 'x' } }));
  await page.goto('/?app=Chat');
  await page.getByRole('button', { name: 'Is the Virtual Lab healthy?' }).click();
  await expect(page.getByText('The research agent is unavailable. Please try again.')).toBeVisible();
  await expect(page.getByText(/HTTP 502/)).toHaveCount(0);
});
```

This also closes the browser check still open from the last slice: add a third test for a tool that returns `{ "status": "error" }`, expecting the row to show "Failed" with its reason.

- [ ] **Step 6: Run, then commit**

Run: `$NX npx playwright install chromium && $NX npx playwright test`
Expected: PASS. Commit: `test(chat): add local forwarding and Playwright tests`.

---

### Task 3: Tool contract, client and Gateway schema

**Files:**
- Create: `agentcore-poc/lambda/virtual_lab_client.py`, `agentcore-poc/lambda/results.py`, `agentcore-poc/tests/test_client.py`
- Modify: `lambda/handler.py`, `lambda/tools.json`, `terraform/gateway.tf`, `terraform/tool.tf`, `terraform/agent.tf`, `terraform/tests/poc.tftest.hcl`, `tests/test_handler.py`

**Interfaces:**
- Produces in `results.py`: `ok(summary, **fields) -> dict`, `outcome(status, summary, **fields) -> dict`, `failure(step, summary) -> dict`. All return `{"status": ..., "summary": ...}`. `failure` sets `status: "error"` and `step`.
- Produces in `virtual_lab_client.py`: `class ClientError(Exception)` with `.step`, and `class VirtualLabClient(origin, login, opener=None)` with:

```python
case_count(cohort_filter: dict | None) -> int
field_values(field: str, cohort_filter: dict | None = None) -> list[tuple[str, int]]
top_genes(cohort_filter: dict | None, max_genes: int = 50) -> list[tuple[str, int]]
lookup_gene(name: str) -> dict | None           # None when gmlst is empty
sample_ids(gene_info: dict, cohort_filter: dict | None) -> set[str]
lollipop_track(gene_info: dict, cohort_filter: dict | None) -> dict  # sampleTotalNumber, skewer
```

- Produces: `tools.json` becomes a full tool schema array, in AWS's format, with nested properties.

- [ ] **Step 1: Write failing tests in `test_client.py`** with a fake opener, using the request shapes in the spec's "Data sources for numbers":

`test_case_count_query`, `test_top_genes_sends_filter0_and_dslabel_MMRF`, `test_lookup_gene_empty_is_none`, `test_lollipop_uses_forTrack_and_skewer`, `test_sample_ids_uses_variant2samples`, `test_field_values_reads_histogram`, `test_http_error_raises_client_error_with_step`, `test_error_never_holds_password`.

- [ ] **Step 2: Find the `field_values` query**

Try `Case__aggregation{case(filter:$f,accessibility:all){<field>{histogram{key count}}}}` with `demographic.race` against `localhost:3080`, including how dotted names are written.
Expected: the race values with counts. Record the working query in the test's fixture.

- [ ] **Step 3: Run tests to see them fail, then implement**

Timeout per HTTP call: 20 seconds. Reuse `read_login` from `handler.py`. Migrate `check_virtual_lab_health` to `results`: `status`, `summary`, `cases`, `latency_ms`. Its old error codes become `failure(step=...)`, keeping `auth_failed` and `config_error` as `step` values.

Run: `python3 -m unittest discover -s agentcore-poc/tests -p 'test_*.py'`, with `test_scripts` still run through uv.
Expected: FAIL, then PASS, and no test still expects `ok`.

- [ ] **Step 4: Move the schema to S3 in Terraform**

Upload `tools.json` as an `aws_s3_object`, with its hash in the key, and use `tool_schema { s3 { uri = ... } }`. Grant the Gateway role `s3:GetObject` on it. Delete the `dynamic` blocks. Set the Lambda `timeout` to 60. Include all Python modules in the archive.

- [ ] **Step 5: Update `poc.tftest.hcl` and validate**

Assert the target's S3 URI contains `filemd5("../lambda/tools.json")`, and the Lambda timeout is 60. Add a Python test that `tools.json` parses, and that no tool declares `cohortFilter` or any property named like a cohort.
Run: `terraform fmt -check && terraform validate && terraform test`. Expected: PASS.

- [ ] **Step 6: Commit** `feat(agentcore): add tool result contract and Virtual Lab client`.

---

### Task 4: `update_cohort`

**Files:**
- Create: `lambda/cohort_filter.py`, `lambda/cohort_fields.py`, `lambda/cohort_fields.json`, `lambda/tool_update_cohort.py`, `tests/test_cohort_filter.py`, `tests/test_update_cohort.py`
- Modify: `lambda/handler.py`, `lambda/tools.json`

**Interfaces:**
- Consumes: `VirtualLabClient`, `results`.
- Produces in `cohort_filter.py`: `apply_changes(base: dict | None, changes: list[Change]) -> dict | None`, `label(cohort_filter: dict | None) -> str`, `simple_fields(cohort_filter) -> dict[str, list[str]]`. `Change` is `{"field": gen3_field, "values": [...], "op": "set" | "remove"}`.
- Produces in `cohort_fields.py`: `resolve_field(name) -> Field | Closest`, `resolve_values(field, requested, available) -> Resolved | Ambiguous | Unknown`.
- Produces tool: `update_cohort(args, client)`. `args` holds `changes` plus `cohortFilter`, which the hook adds. Result fields on `ok`: `changes` (resolved, with labels), `casesBefore`, `casesAfter`, `filter`, `cohort: {label, caseCount}`, `summary`. `filter` is removed by the agent hook.
- `update_cohort` statuses are exactly those in the spec.

- [ ] **Step 1: Generate `cohort_fields.json`**

From the frontend's `src/features/apps/config/tabbedCohortBuilder.json`: each field's Gen3 name, label and whether it's `numeric_range`. Add synonyms: `sex` for `demographic.gender`, and values `women`→`female`, `men`→`male`. Commit the generated file, not a script.

- [ ] **Step 2: Write failing tests**

`test_cohort_filter.py`, using fixtures of the real output of the frontend's `buildCohortGqlOperator`:

```python
def test_set_adds_a_new_field(self): ...          # base race + set gender keeps both
def test_set_replaces_the_same_field(self): ...   # set race white replaces black
def test_remove_drops_a_field(self): ...
def test_removing_the_last_field_gives_none(self): ...
def test_case_id_filter_is_kept_opaque(self): ...  # case_id survives a set on race
def test_unknown_shape_raises(self): ...           # no silent loss of a filter it can't read
def test_label_lists_simple_fields(self):
    self.assertEqual(label(RACE_BLACK), "Race: black or african american")
def test_label_never_lists_case_ids(self):
    self.assertEqual(label(FIVE_HUNDRED_CASE_IDS), "Selected cases")
def test_label_of_no_filter(self): self.assertEqual(label(None), "All cases")
```

`test_update_cohort.py`, with a fake client:

| Test | Expected |
| --- | --- |
| `test_black_maps_to_the_data_value` | `ok`, value `black or african american`, 1000 → 334 |
| `test_hispanic_is_ambiguous` | `ambiguous`, options `hispanic or latino` and `not hispanic or latino`, no `filter` |
| `test_smokers_is_unknown_field` | `unknown_field`, with closest fields |
| `test_unknown_value_lists_available` | `unknown_value` |
| `test_age_is_unsupported` | `unsupported_field` |
| `test_zero_cases_would_be_empty` | `would_be_empty`, no `filter` |
| `test_changes_apply_together_or_not_at_all` | One bad change in two gives no `filter` |
| `test_invalid_op_is_rejected_in_python` | `error`, because Gateway can't enforce it |
| `test_client_failure_names_the_step` | `error`, with `step` |
| `test_results_hold_no_case_ids` | With a case ID base filter, the JSON minus `filter` contains no `SYNTH-CASE-` |
| `test_only_filter_key_holds_the_filter` | No other field contains the filter's values as a nested filter |

- [ ] **Step 3: Run to fail, implement, run to pass**

Value matching: case-insensitive exact, then synonyms, then a unique substring. Several substring matches give `ambiguous`.
Run: `python3 -m unittest discover -s agentcore-poc/tests -p 'test_*cohort*.py'`. Expected: FAIL, then PASS.

- [ ] **Step 4: Add the schema and description to `tools.json`**

Description: what it does, that it changes the selected cohort shown in the dropdown, when to use it, that `op` is `set` or `remove`, and that it never takes a cohort. Register in `TOOLS`.

- [ ] **Step 5: Commit** `feat(agentcore): add update_cohort tool`.

---

### Task 5: `show_oncomatrix`

**Files:**
- Create: `lambda/tool_show_oncomatrix.py`, `tests/test_show_oncomatrix.py`
- Modify: `lambda/handler.py`, `lambda/tools.json`

**Interfaces:**
- Consumes: `VirtualLabClient`, `cohort_filter.label`.
- Produces: result fields `genes: [{gene, count}]`, `caseCount`, `sampleCount`, `cohort: {label, caseCount}`, `plot: {type: "oncomatrix", maxGenes}`, `summary`. No `followUps`, and `plot` holds no filter.

- [ ] **Step 1: Write failing tests** with a fake client

```python
def test_ok_states_cases_and_samples_separately(self):
    r = run({"cohortFilter": RACE_BLACK})
    self.assertEqual((r["caseCount"], r["sampleCount"]), (334, 282))
    self.assertIn("334 cases", r["summary"]); self.assertIn("282 samples", r["summary"])

def test_samples_are_the_union_across_genes(self): ...  # overlapping fake sets count once
def test_max_genes_limits_ranking(self): ...            # maxGenes 3 gives 3 genes
def test_max_genes_below_one_is_an_error(self): ...
def test_no_genes_is_no_data_without_a_plot(self): ...
def test_no_cohort_means_all_cases(self): ...
def test_client_failure_names_the_step(self): ...
def test_no_sample_or_case_ids_in_result(self): ...
def test_summary_holds_every_number_in_the_result(self): ...
```

`sampleCount` always counts across the full ranking the matrix would show, not the `maxGenes` subset, so the sample total stays the same when a researcher asks for fewer genes.

- [ ] **Step 2: Run to fail, implement, run to pass**

Run: `python3 -m unittest discover -s agentcore-poc/tests -p 'test_show_oncomatrix.py'`. Expected: FAIL, then PASS.

- [ ] **Step 3: Add the schema and description, then commit** `feat(agentcore): add show_oncomatrix tool`.

Description must use the spec's terminology: "OncoMatrix", and when to use it, such as "most frequently mutated genes".

---

### Task 6: `show_lollipop`

**Files:**
- Create: `lambda/tool_show_lollipop.py`, `tests/test_show_lollipop.py`
- Modify: `lambda/handler.py`, `lambda/tools.json`

**Interfaces:**
- Consumes: `VirtualLabClient`, `cohort_filter.label`.
- Produces: result fields `gene`, `sampleCount`, `variantCount`, `topVariants: [{change, count}]`, `coveredGenes` when relevant, `cohort`, `plot: {type: "lollipop", gene}`, `summary`.

- [ ] **Step 1: Write failing tests**

| Test | Expected |
| --- | --- |
| `test_ok_reports_samples_variants_and_top_three` | 148, 14, then `p.Q61H` 38, `p.G12V` 27, `p.G12D` 23 |
| `test_alias_uses_the_resolved_name` | c-Myc gives `gene: "MYC"` and `plot.gene: "MYC"` |
| `test_gene_shaped_name_is_no_data_for_gene` | `BRCA1` gives `no_data_for_gene`, with `coveredGenes` and no `plot` |
| `test_no_data_wording_makes_no_claim_it_is_real` | `summary` says it isn't in this dataset |
| `test_other_text_is_unknown_gene` | `not a gene!` gives `unknown_gene` |
| `test_zero_samples_is_none_in_cohort` | `0 of 334 cases` in `summary`, no `plot` |
| `test_missing_gene_is_an_error` | `error` |
| `test_client_failure_names_the_step` | `error`, with `step` |
| `test_no_case_or_sample_ids_in_result` | No `SYNTH-` in the JSON |

Gene-shaped means `^[A-Za-z][A-Za-z0-9-]{1,14}$`.

- [ ] **Step 2: Run to fail, implement, run to pass**

Run: `python3 -m unittest discover -s agentcore-poc/tests -p 'test_show_lollipop.py'`. Expected: FAIL, then PASS.

- [ ] **Step 3: Add the schema and description, then commit** `feat(agentcore): add show_lollipop tool`.

The description must reach this tool for all three phrasings in the spec's Terminology section: "lollipop", "ProteinPaint" and "where mutations fall on the protein".

---

### Task 7: Agent: cohort hooks, state and prompt

Build on the working spike in `.superpowers/sdd/2026-11-03-agentcore-agui-chat/spike/spike_hook.py`, in the `theMMRF` worktree.

**Files:**
- Create: `agentcore-poc/agent/cohort.py`, `agentcore-poc/agent/test_cohort.py`
- Modify: `agent/runs.py`, `agent/main.py`, `agent/test_runs.py`, `scripts/build_agent.sh`, `scripts/invoke.py`

**Interfaces:**
- Consumes: `update_cohort`'s `filter` result field.
- Produces in `cohort.py`:

```python
UPDATE_TOOL = "virtual-lab___update_cohort"
class CohortHooks(HookProvider): ...      # Before: adds cohortFilter to a COPY of tool_use.
                                          # After update_cohort: removes filter, moves it on.
def state_from_update(ctx) -> dict | None # {"cohort": {filter, label, caseCount, revision, changes}}
def prompt_context(run_input, message) -> str  # adds label, count and manual-change flag only
def cohort_from_state(state) -> dict | None
```

- Produces on the wire: `STATE_SNAPSHOT` with `snapshot.cohort.revision` one above the run's starting revision, for each successful `update_cohort`.

- [ ] **Step 1: Write failing tests in `test_cohort.py`**, using a scripted model and fake tools as in the spike

```python
def test_model_never_sees_filter_or_case_ids(self): ...      # all model calls, all 3 turns
def test_tools_receive_the_run_cohort(self): ...
def test_later_tool_receives_the_updated_cohort(self): ...
def test_failed_update_leaves_cohort_unchanged(self): ...    # ambiguous gives no snapshot
def test_tool_call_args_events_hold_no_filter(self): ...
def test_tool_result_events_hold_no_filter(self): ...
def test_messages_snapshot_holds_no_filter(self): ...
def test_state_snapshot_carries_filter_and_next_revision(self): ...
def test_prompt_context_has_label_but_no_filter(self): ...
def test_prompt_context_flags_a_manual_change(self): ...
def test_runs_do_not_share_cohorts(self): ...                 # two concurrent runs stay apart
def test_missing_state_means_no_cohort(self): ...
```

`PENDING` from the spike must not survive as a shared unbounded global: key by `tool_use_id`, and remove on read.

- [ ] **Step 2: Run to fail, implement, run to pass**

`handle_run` reads `state.cohort` and calls `adapter.run(run_input, invocation_state={"cohort": ...})`. `LazyAdapter.run` passes `invocation_state` through. In `main.py`, pass `hooks=[CohortHooks()]`, plus `state_context_builder` and `tool_behaviors` in `StrandsAgentConfig`. Set the MCP client `timeout` to 60. `build_agent.sh` copies `cohort.py`.

Run: `cd agentcore-poc/agent && uv run --frozen python -m unittest test_runs test_main test_cohort`. Expected: FAIL, then PASS.

- [ ] **Step 3: Rewrite `SYSTEM_PROMPT`**

It says: one-line plan before any tool runs; call `update_cohort` first when the question changes who's in the cohort; quote only numbers from `summary`; sections Observed and Limits, always including synthetic data and "numbers are for the default view and don't reflect changes made in the chart"; interpretation only on request and labelled separately; start with "Now using: ..." when the manual-change flag is set; state cases and samples separately; report failures as failures; ask one question for `ambiguous`; don't repeat the buttons shown under a chart.

- [ ] **Step 4: Add a recorded-answer check**

`test_answers.py`, with `check_numbers(answer: str, summaries: list[str]) -> list[str]`, returns numbers in the answer that aren't in any summary. Test it, then use it against saved streams in Task 8.

- [ ] **Step 5: Commit** `feat(agentcore): keep the cohort out of the model with hooks and state`.

---

### Task 8: Deploy and prove the backend live

**Files:**
- Create: `agentcore-poc/tests/fixtures/journey-*.sse`, recorded, then copied to `e2e/fixtures/` in the frontend
- Modify: `agentcore-poc/README.md`, `scripts/invoke.py` (`--cohort-file`, to send `state.cohort`)

- [ ] **Step 1: Get the user's go-ahead, then apply**

`bash scripts/build_agent.sh && AWS_PROFILE=workshop terraform apply`.
Expected: Gateway target and Lambda update, with no destroys of the Runtime or Gateway.

- [ ] **Step 2: Check tools through Gateway**

`tools/list` shows 4 tools with nested `changes`, and none offers a cohort. Call `show_lollipop` with `gene: KRAS` and a `cohortFilter` for a race. Expected: the count changes with the filter, proving a tool that **declares** properties still receives the argument. **If it doesn't arrive**, use the spec's fallback: declare it in Gateway and remove it from the spec the model gets.

- [ ] **Step 3: Run the journey through Runtime with the real model**

Run `invoke.py` on "What's mutated in Black patients?", with `--save`. Expected: `update_cohort`, then `show_oncomatrix`, then `RUN_FINISHED`, and a `STATE_SNAPSHOT` with revision 2. Then grep the saved stream's `TOOL_CALL_*` and `MESSAGES_SNAPSHOT` events for `cohortFilter`, `SYNTH-CASE-` and `"filter"`. Expected: no matches. Also check the Runtime logs for the same strings in model request logging.

- [ ] **Step 4: Check a case ID cohort**

Send a `state.cohort` with a `case_id` filter of 200 IDs and ask for top genes. Expected: the same absence in the stream, a label of "Selected cases", and counts that reflect those cases.

- [ ] **Step 5: Save streams and check answers**

Save fixtures for: the journey, Lollipop follow-up, `ambiguous`, `unknown_field`, `none_in_cohort`, `no_data_for_gene` and a tool failure. Scan each for the Global Constraints' forbidden values and replace any with placeholders. Run `check_numbers` on each.
Expected: no unsupported numbers. Report any as prompt fixes.

- [ ] **Step 6: Commit** `docs(agentcore): record live tool checks and sample streams`.

---

### Task 9: Frontend: toolkit, cohort sync and Undo

**Files:**
- Create: `src/features/chat/toolkit.tsx`, `src/features/chat/cohortSync.ts`, `src/features/chat/useCohortSync.ts`, `src/features/chat/tools/CohortToolUI.tsx`, their unit tests, `e2e/chat-cohort.spec.ts`
- Modify: `src/features/chat/ChatRuntimeProvider.tsx`, `src/features/chat/ChatThread.tsx`, `src/features/chat/tools/ToolCallRow.tsx`

**Interfaces:**
- Consumes: `STATE_SNAPSHOT` `cohort` from Task 7, `useAgUiState`, `useAgUiSetState`, `removeCohortFilter`, `updateCohortFilter`, `clearCohortFilters`, `selectSelectedCohortFilter`.
- Produces in `toolkit.tsx`: `toolkit = defineToolkit({ "virtual-lab___check_virtual_lab_health": ..., "virtual-lab___update_cohort": ..., "virtual-lab___show_oncomatrix": ..., "virtual-lab___show_lollipop": ... })`, with `type: "backend"` and `render`. Registered once by `AuiConfig({ tools: Tools({ toolkit }) })`.
- Produces in `cohortSync.ts`, pure: `planApply(applied: number, incoming: CohortState | undefined) -> Change[] | null`; `CohortHistory` with `record(revision, filter, filterSet)`, `filterFor(revision) -> object | undefined`, `undoTarget(revision) -> FilterSet | undefined`.
- Produces in `useCohortSync.ts`: `CohortProvider` and `useCohortFilterForRevision(revision)`, used by Task 10.
- Produces: `result.status` drives the row: `"error"` shows "Failed", with `summary`.

- [ ] **Step 1: Confirm the toolkit works with the AG-UI runtime**

Replace `components.tools.by_name` with the toolkit, keeping the Fallback for unknown tools. Run: `$NX npx playwright test e2e/chat-health.spec.ts`. Expected: PASS. **If `Tools()` doesn't render backend tool calls on this runtime**, keep `by_name` and record the ruling. It's an internal choice, and the tool UIs don't change.

- [ ] **Step 2: Write failing unit tests in `cohortSync.unit.test.ts`**

```ts
it('applies a newer revision once', () => { ... });
it('ignores a replayed or older revision', () => {
  expect(planApply(3, { revision: 2, changes: [c] } as CohortState)).toBeNull();
});
it('touches only the changed fields', () => { ... });
it('keeps a filter for each revision', () => { ... });
it('offers no undo target after a manual edit', () => { ... });
it('offers an undo target only for the latest change', () => { ... });
```

- [ ] **Step 3: Run to fail, implement, run to pass**

`useCohortSync` sends `state.cohort` before each run: filter, label, case count, revision and `changedOutsideChat`. It applies each new revision once through the platform's cohort actions, and records revision → filter from the snapshot, so charts use the same filter as the tool. A dropdown change raises `revision` and sets `changedOutsideChat`.

- [ ] **Step 4: Write `CohortToolUI`**

Running: skeleton. Incomplete: failure. Complete by status:

| `status` | Shows |
| --- | --- |
| `ok` | "Cohort Builder · Updated cohort", the mapping, before → after, and Undo |
| `ambiguous` | Options as buttons, each sending a visible message |
| Other non-error results | The tool's `summary` |
| `error` | Failed, with `summary` |

Undo restores the filter from just before that change, adds "Cohort restored: N cases.", and becomes "Undone".

- [ ] **Step 5: Write `e2e/chat-cohort.spec.ts`**, using recorded streams

| Test | Assertion |
| --- | --- |
| `chat changes the dropdown` | After the stream, the filter panel shows Race, and "334" appears |
| `state goes out on the next run` | The next `RunAgentInput.state.cohort.revision` is the new one, and `context` holds no filter |
| `a replayed snapshot doesn't reapply` | Remove the filter manually, replay the old revision: the filter stays removed |
| `a manual change during a run survives` | Add Gender while the stream is held, then finish: both Race and Gender remain |
| `manual change is flagged` | After a dropdown change, the next posted state has `changedOutsideChat: true` |
| `undo restores and records` | Click Undo: the filter is gone, "Undone" shows, and a second click does nothing |
| `no undo after a manual edit` | Undo isn't offered |
| `ambiguous asks with buttons` | Clicking one posts a visible user message, and the cohort is unchanged until then |
| `a failed run reports it` | A stream with a `status: "error"` tool shows "Failed", and the cohort doesn't change |
| `no cohort data in the prompt path` | No posted `context` entry contains `demographic.race` or a filter |

- [ ] **Step 6: Run and commit**

Run: `NODE_OPTIONS=--no-experimental-strip-types $NX npx jest --runInBand src/features/chat && $NX npx playwright test`. Expected: PASS.
Commit: `feat(chat): sync the cohort with the agent through AG-UI state`.

---

### Task 10: Frontend: chart wrappers and chart tool UIs

**Files:**
- Create: `src/features/chat/tools/OncoMatrixToolUI.tsx`, `src/features/chat/tools/LollipopToolUI.tsx`, `src/features/chat/tools/ChartFrame.tsx`, `e2e/chat-charts.spec.ts`
- Modify: `src/features/proteinpaint/MatrixWrapper.tsx`, `src/features/proteinpaint/ProteinPaintWrapper.tsx`, `src/features/chat/toolkit.tsx`, `src/features/chat/ChatThread.tsx`

**Interfaces:**
- Consumes: `useCohortFilterForRevision`, tool results from Tasks 5 and 6.
- Produces: `MatrixWrapper` optional props `filter0Override?: object`, `maxGenes?: number`. `ProteinPaintWrapper` optional props `filter0Override?: object`, `gene?: string`. With an override, the wrapper ignores the selected cohort. Without one, behavior is unchanged.

- [ ] **Step 1: Prove each chart can be driven by props (design gate)**

In a scratch page or test:
- **Lollipop:** try the wrapper's commented `geneSymbol`, then `state.userSelection`.
- **OncoMatrix:** try `settings.matrix.maxGenes: 3`, and render outside `?app=OncoMatrix`.

Expected: each works, or use the spec's fallback from "To confirm before building" and record a ruling. Remove the scratch code.

- [ ] **Step 2: Write `e2e/chat-charts.spec.ts`**, using recorded streams and real charts

| Test | Assertion |
| --- | --- |
| `oncomatrix renders in chat` | The matrix appears, with the cohort label above it |
| `lollipop renders for the gene` | The plot shows KRAS without using the search box |
| `chart requests carry the revision's filter` | Captured `/protein-paint/` requests include `filter0` with the race |
| `an old chart keeps its cohort` | Change the dropdown: no new chart request from the old chart, and the label is unchanged |
| `unknown revision is not drawn on the current cohort` | A result with no stored revision shows "This chart's cohort is no longer available", and no chart request is made |
| `standard pages are unchanged` | `?app=OncoMatrix` and `?app=ProteinPaint` still follow the dropdown |
| `lollipop buttons send a visible message` | Clicking "Lollipop for KRAS" posts "Show the Lollipop plot for KRAS." |
| `no_data shows no chart` | Only the `summary` |
| `re-render makes no extra requests` | Typing in the composer adds no chart requests |
| `charts fit` | No horizontal page scroll at 1280px wide |

- [ ] **Step 3: Run to fail, implement, run to pass**

Both tool UIs use `display: "standalone"`. `ChartFrame` shows the cohort label and holds the chart's own loading and error states. Charts may use the thread's full width, with internal scrolling.

Run: `$NX npx playwright test e2e/chat-charts.spec.ts`. Expected: FAIL, then PASS.

- [ ] **Step 4: Check nothing else broke**

Run: `NODE_OPTIONS=--no-experimental-strip-types $NX npx jest --runInBand src/features/chat src/features/proteinpaint src/lib/agentRuntime && $NX npx tsc --noEmit -p tsconfig.json && $NX npm run lint && $NX npm run build`.
Expected: PASS. Report unrelated existing failures, without fixing them.

- [ ] **Step 5: Commit** `feat(chat): render OncoMatrix and Lollipop plots from tool results`.

---

### Task 11: Live acceptance checks

The Playwright suite was removed by user decision after Task 10. These run through the Chrome DevTools MCP, driven by the controller, against the deployed agent.

- [ ] **Step 1: Get the user's go-ahead, then redeploy**

Refresh credentials, run `scripts/build_agent.sh`, re-plan, and apply. Re-record `none-in-cohort.sse` and `journey-oncomatrix.sse`.

- [ ] **Step 2: Walk the spec's acceptance table in a browser**

For each row, record what the page showed. Compare the answer's numbers with the chart and the cohort bar, not with fixed values. Include a second turn in one thread, since `MESSAGES_SNAPSHOT` replaces on-screen messages, and check no earlier message or chart is lost or refetched.

- [ ] **Step 3: Wrong-login check, with the user's go-ahead**

Set a wrong login, confirm the step shows Failed with no numbers from it, restore the login, and force a new Lambda instance.

- [ ] **Step 4: Record results in the README and commit** `docs(agentcore): record live acceptance checks`.

---

### Task 12: Update docs and prepare to push

**Files:**
- Modify: `agentcore-poc/README.md`, `docs/superpowers/specs/2026-11-03-agentcore-agui-chat-architecture.drawio` and its `.png`
- Create: `docs/superpowers/specs/2026-11-03-chat-cohort-lollipop-tools-architecture.drawio` only if the existing diagram can't show this clearly

- [ ] **Step 1: Update the README**

Cover the forwarding script, `SANDBOX_ACCESS_FILE`, browser checks with the Chrome DevTools MCP, adding a Python tool, the live results, and that swapping Lambda code outside Terraform isn't detected by `terraform plan`.

- [ ] **Step 2: Update the diagram**

Use the `aws-architecture-diagram` skill: add the forwarding script and cohort state path, and show charts reading the deployed services rather than the local stack. Run its check script and export the PNG.

- [ ] **Step 3: Scan everything going out, in both forks**

```bash
T=$(mktemp); git log origin/<base>..HEAD -p --text > "$T"
LC_ALL=C grep -aEc '<account-id-regex>|<distribution-id>|<runtime-id>|<gateway-id>|<password-prefix>|/Users/' "$T"
```

Build the pattern from the git-ignored `poc.auto.tfvars`, Terraform outputs and access file, without printing it. Also add a control search for a known string, and check that no `tfstate`, `tfvars`, `.env` or `test-results` file is tracked. Decode embedded PNG text as well.
Expected: 0 hits, with the control above 0. Replace any hit in history before pushing, because a later commit doesn't remove it.

- [ ] **Step 4: Commit, then ask before pushing**

Commit `docs: update the guide and diagram for the cohort tools`. Report the scan results and ask the user whether to push each branch.
