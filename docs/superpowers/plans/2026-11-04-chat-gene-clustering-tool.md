# Chat Gene Clustering Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A researcher asks in Chat, and the agent generates a real ProteinPaint gene expression heatmap of the top 20 variably expressed genes for the active cohort, with no Submit click.

**Architecture:** A Lambda tool, `show_gene_clustering`, asks ProteinPaint for the top 20 genes and returns the case count, the genes and a small `plot` request. The Chat UI draws `MatrixWrapper` with ProteinPaint's start screen turned off, so the chart fetches the same genes and clusters them in the browser.

**Tech Stack:** Python 3 with `unittest` (Lambda and agent), Next.js, TypeScript and Jest (Data Commons), `@sjcrh/proteinpaint-client`, Terraform.

**Spec:** `docs/superpowers/specs/2026-11-04-chat-gene-clustering-tool-design.md`

## Global Constraints

- **Repos:** `my-forks/mmrf-virtual-lab-sandbox` and `my-forks/mmrf-data-commons`. Each gets a branch named `feature/chat-gene-clustering`, built in a worktree under `my-forks/.worktrees/`.
- **Branch bases:** both branches start from `origin/main`. The sandbox's `main` includes the knowledge graph, so an apply from this branch keeps it.
- **Gene count:** one constant, `TOP_GENES = 20`. The Gene Expression Clustering page keeps its start screen and its default of 1000.
- **Tool input:** none. No tool declares a cohort input.
- **Result size:** the clustering reply never goes through the Lambda, because the whole tool result reaches the model.
- **Answer limits:** never describe clusters or expression patterns, and never suggest what they mean for treatment.
- **Public repos:** keep real account and CloudFront IDs out of commits.
- **Commit attribution:** end commit messages with the attribution line from the session's instructions. Stage files by name, because `AGENTS.md` and `CLAUDE.md` are untracked in Data Commons and must stay out.
- **Applying:** only the user applies Terraform. Stop on any destroy in the plan you didn't expect.

Commands below run from the sandbox's `agentcore/` or from the Data Commons root. Jest needs `NODE_OPTIONS=--no-experimental-strip-types`.

## Review Focus

1. **A cohort under 10 samples:** ProteinPaint replies HTTP 200 with `{"status", "error"}`, not a genes list. The researcher should get `too_few_samples` with no chart (Task 1 and Task 2).
2. **Another error inside a 200 reply:** the researcher should see a failed step, and ProteinPaint's stderr text must not reach the answer (Task 1).
3. **"Show me the top 50 genes":** the agent should say it uses the top 20, and not claim 50 (Task 2 schema text, Task 3 prompt rule).
4. **OncoMatrix after the wrapper change:** it should keep 50 genes, with no `hierCluster` settings or `geneset` options (Task 4).
5. **Two heatmaps in one thread, or a chart scrolled off screen:** both should stay drawn, each on its own cohort (Task 6, live check 5).

---

### Task 1: Read the top variable genes

**Files:**
- Modify: `agentcore/lambda/virtual_lab_client.py`, after `top_genes`
- Test: `agentcore/tests/test_client.py`

**Interfaces:**
- Produces: `VirtualLabClient.top_variable_genes(cohort_filter, max_genes) -> list[str]`, in the service's order. Raises `ClientError("too_few_samples", ...)` or `ClientError("unhealthy", ...)`.

- [ ] **Step 1: Commit the design documents**

```bash
git add docs/superpowers/specs/2026-11-04-chat-gene-clustering-tool-design.md docs/superpowers/plans/2026-11-04-chat-gene-clustering-tool.md
git commit -m "docs(agentcore): design the chat gene clustering tool"
```

- [ ] **Step 2: Write the failing tests**

Follow the existing `top_genes` tests, using `FakeOpener` with these replies:

| Test | Reply | Assertion |
| --- | --- | --- |
| `test_top_variable_genes_sends_a_get_with_filter0` | `{"genes": ["IGLC2", "IGKC"]}` | Method is `GET`, the path has `termdb/topVariablyExpressedGenes`, the query has `maxGenes=20`, `dslabel=MMRF` and the JSON cohort as `filter0`. Returns `["IGLC2", "IGKC"]` |
| `test_top_variable_genes_omits_filter0_without_cohort` | `{"genes": ["IGLC2"]}` | `filter0` isn't in the URL |
| `test_top_variable_genes_reads_gene_objects` | `{"genes": [{"gene": "IGLC2"}]}` | Returns `["IGLC2"]` |
| `test_too_few_samples_has_its_own_step` | `{"status": "error", "error": "Error: samples must include at least 10 sample IDs"}` | Raises `ClientError` with `step == "too_few_samples"` |
| `test_other_reply_errors_hide_the_detail` | `{"status": "error", "error": "spawned 'topVEgene.py' exited with code 1"}` | Raises `ClientError` with `step == "unhealthy"`, and `topVEgene` isn't in the message |
| `test_missing_genes_is_unhealthy` | `{}` | Raises `ClientError` with `step == "unhealthy"` |

- [ ] **Step 3: Run them and confirm they fail**

Run: `python3 -m unittest discover -s tests -p 'test_client.py'`
Expected: FAIL with `AttributeError` on `top_variable_genes`

- [ ] **Step 4: Implement `top_variable_genes(self, cohort_filter, max_genes)`**

Use `self._get("termdb/topVariablyExpressedGenes", query)`, adding `filter0` only with a cohort. Match the error on the text `at least 10 sample`. Accept a gene as a string or as `{"gene": ...}`, since ProteinPaint's client accepts both.

- [ ] **Step 5: Run them and confirm they pass**

Run: `python3 -m unittest discover -s tests -p 'test_client.py'`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add agentcore/lambda/virtual_lab_client.py agentcore/tests/test_client.py
git commit -m "feat(agentcore): read the top variable genes from ProteinPaint"
```

### Task 2: Add the `show_gene_clustering` tool

**Files:**
- Create: `agentcore/lambda/tool_show_gene_clustering.py`
- Modify: `agentcore/lambda/handler.py` (`CLIENT_TOOLS`), `agentcore/lambda/tools.json`
- Test: `agentcore/tests/test_show_gene_clustering.py`, `agentcore/tests/test_handler.py`, `agentcore/tests/test_tools_json.py`

**Interfaces:**
- Consumes: `client.case_count(cohort_filter)`, `client.top_variable_genes(cohort_filter, max_genes)`, `results.ok/outcome/failure`, `cohort_filter.label`
- Produces: `show_gene_clustering(args, client) -> dict`. When `ok`, the result has `summary`, `cohort`, `genes` (a list of symbols) and `plot == {"type": "gene_clustering", "maxGenes": 20}`.

- [ ] **Step 1: Write the failing tests**

Use a `FakeClient` with `case_count` and `top_variable_genes`, as `test_show_oncomatrix.py` does, with 20 made-up symbols in `GENES` and the cohort `RACE_BLACK`.

```python
def test_ok_reports_cases_and_all_genes(self):
    r = run()
    self.assertEqual(r["status"], "ok")
    self.assertEqual(r["genes"], GENES)
    self.assertEqual(r["cohort"], {"label": "Race: black or african american", "caseCount": 334})
    self.assertEqual(r["plot"], {"type": "gene_clustering", "maxGenes": 20})
    self.assertIn("334 cases", r["summary"])
    self.assertIn("top 20 variably expressed genes", r["summary"])
    self.assertIn("red means high relative to the other samples", r["summary"])
    for gene in GENES:
        self.assertIn(gene, r["summary"])

def test_asks_the_service_for_20_genes(self):
    client = FakeClient()
    run(client=client)
    self.assertEqual(client.top_calls, [(RACE_BLACK, 20)])

def test_fewer_genes_reports_the_real_number(self):
    r = run(client=FakeClient(genes=GENES[:3]))
    self.assertEqual(r["status"], "ok")
    self.assertIn("top 3 variably expressed genes", r["summary"])
```

Also add these, each asserting `"plot" not in r`:

| Test | Fake client | Expected |
| --- | --- | --- |
| `test_no_cases_skips_the_ranking` | `case_count` returns 0 | `status == "no_cases"`, and `top_calls` is empty |
| `test_too_few_samples` | `top_variable_genes` raises `ClientError("too_few_samples", "x")` | `status == "too_few_samples"`, `cohort` present, and `"at least 10 samples"` in the summary |
| `test_no_genes_is_no_data` | `genes=[]` | `status == "no_data"`, `cohort` present |
| `test_a_failed_call_is_a_failure` | Either call raises `ClientError("unhealthy", "x")` | `status == "error"`, `step == "unhealthy"` |

In `test_handler.py`, add `test_show_gene_clustering_is_a_client_tool`, matching the survival test. In `test_tools_json.py`, add:

```python
def test_show_gene_clustering_takes_no_inputs_and_can_be_selected(self):
    tool = next(tool for tool in TOOLS if tool["name"] == "show_gene_clustering")
    self.assertEqual(tool["inputSchema"]["properties"], {})
    self.assertEqual(tool["inputSchema"].get("required", []), [])
    for words in ("gene expression clustering", "heatmap", "top 20", "no clusters or expression values"):
        with self.subTest(words=words):
            self.assertIn(words, tool["description"])
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `python3 -m unittest discover -s tests -p 'test_show_gene_clustering.py'`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement `show_gene_clustering(args, client)`, and register it**

Declare `TOP_GENES = 20`. Read the case count first and return `no_cases` when it's 0. Catch `ClientError` as `show_oncomatrix` does, returning `outcome` for `too_few_samples` and `failure` for anything else.

The summary's exact wording, with the genes joined as "A, B and C":

- **`ok`:** `{cases} cases. Gene expression heatmap of the top {n} variably expressed genes: {genes}. The clustering is on the chart, and red means high relative to the other samples.`
- **`no_cases`:** `This cohort has no cases, so there's no heatmap.`
- **`too_few_samples`:** `Ranking genes needs at least 10 samples with expression data, and this cohort of {cases} cases has fewer, so there's no heatmap.`
- **`no_data`:** `The {cases} cases in this cohort have no gene expression data, so there's no heatmap.`

Add the tool to `CLIENT_TOOLS` and `tools.json`, with `"properties": {}` and the description from the spec's "Description for the model".

- [ ] **Step 4: Run all the Lambda tests and confirm they pass**

Run: `(cd agent && uv run python -m unittest discover -s ../tests -p 'test_*.py')`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agentcore/lambda/tool_show_gene_clustering.py agentcore/lambda/handler.py agentcore/lambda/tools.json agentcore/tests/test_show_gene_clustering.py agentcore/tests/test_handler.py agentcore/tests/test_tools_json.py
git commit -m "feat(agentcore): add the show_gene_clustering tool"
```

### Task 3: Limit what the answer says

**Files:**
- Modify: `agentcore/agent/main.py` (`SYSTEM_PROMPT`)
- Test: `agentcore/agent/test_main.py`

`CohortHooks` already adds the cohort to every `virtual-lab___` tool, so it needs no change.

- [ ] **Step 1: Write the failing test**

```python
def test_limits_what_a_heatmap_answer_says(self):
    for words in ("show_gene_clustering", "Never describe clusters or expression patterns",
                  "what they mean for treatment", "only the top 20 variably expressed genes", "Never invent a gene list"):
        with self.subTest(words=words):
            self.assertIn(words, main.SYSTEM_PROMPT)
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `(cd agent && uv run python -m unittest test_main)`
Expected: FAIL on the first subtest

- [ ] **Step 3: Add the prompt rule after the show_survival rule**

```text
After show_gene_clustering, report only what its summary says. Never describe clusters or expression patterns, and never suggest what they mean for treatment. It uses only the top 20 variably expressed genes. If the researcher asks for another number or a named gene set, say so and offer that heatmap. Never invent a gene list.
```

- [ ] **Step 4: Run the agent tests and confirm they pass**

Run: `(cd agent && uv run python -m unittest test_runs test_main test_cohort test_answers)`
Expected: PASS. If `test_answers` pins the prompt's length or text, update only what this rule changes.

- [ ] **Step 5: Commit**

```bash
git add agentcore/agent/main.py agentcore/agent/test_main.py
git commit -m "feat(agentcore): keep heatmap answers to the tool's summary"
```

### Task 4: Let the chart generate the heatmap

**Files (Data Commons):**
- Create: `src/features/proteinpaint/matrixArg.ts`, holding `getMatrixTrack` and its types, moved from `MatrixWrapper.tsx`
- Modify: `src/features/proteinpaint/MatrixWrapper.tsx`
- Test: `src/features/proteinpaint/matrixArg.unit.test.ts`

This follows `correlationArg.ts`, which keeps the argument builder testable without loading ProteinPaint's client.

**Interfaces:**
- Produces: `getMatrixTrack(props, callback?, matrixCallbacks?, appCallbacks?)`, and an optional prop on `MatrixWrapper`: `generateTopGenes?: boolean`. Later tasks render `<MatrixWrapper chartType="hierCluster" filter0Override={filter} maxGenes={n} generateTopGenes />`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('getMatrixTrack', () => {
  it('keeps the start screen and the 1000 default on the page', () => {
    const arg = getMatrixTrack({ chartType: 'hierCluster' });
    expect(arg.launchGdcHierCluster).toBe(true);
    expect(arg.opts.geneset).toEqual({ showEditUI: true });
    expect(arg.settings).not.toHaveProperty('hierCluster');
  });

  it('generates the top genes straight away in chat', () => {
    const arg = getMatrixTrack({ chartType: 'hierCluster', maxGenes: 20, generateTopGenes: true });
    expect(arg.opts.geneset).toEqual({ showEditUI: false });
    expect(arg.settings.hierCluster).toEqual({ maxGenes: 20 });
  });

  it('leaves OncoMatrix as it was', () => {
    const arg = getMatrixTrack({ chartType: 'matrix' });
    expect(arg.launchGdcMatrix).toBe(true);
    expect(arg.settings).toEqual({ matrix: { maxGenes: 50 } });
    expect(arg.opts).not.toHaveProperty('geneset');
  });

  it('gives OncoMatrix the genes it asks for', () => {
    expect(getMatrixTrack({ chartType: 'matrix', maxGenes: 3 }).settings.matrix).toEqual({ maxGenes: 3 });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/proteinpaint/matrixArg.unit.test.ts`
Expected: FAIL, because `./matrixArg` doesn't exist

- [ ] **Step 3: Move `getMatrixTrack` and add the two settings**

Move the function, `PpProps` and the `MatrixArg` types to `matrixArg.ts`, and import them in `MatrixWrapper.tsx`. Keep the `host` default working: if `basepath` is a module-level value in the wrapper, pass it in the way `getCorrelationTrack` does, and adjust the test's arguments to match. For `hierCluster` only, set `showEditUI` to `!props.generateTopGenes`, and set `settings.hierCluster.maxGenes` only when `maxGenes` is given.

- [ ] **Step 4: Run them, then the lint, and confirm they pass**

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/proteinpaint/ && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/features/proteinpaint/matrixArg.ts src/features/proteinpaint/matrixArg.unit.test.ts src/features/proteinpaint/MatrixWrapper.tsx
git commit -m "feat(chat): let the clustering chart generate its top genes"
```

### Task 5: Draw the heatmap in Chat

**Files (Data Commons):**
- Create: `src/features/chat/tools/GeneClusteringToolUI.tsx`
- Modify: `src/features/chat/toolkit.tsx`, `src/features/chat/numberLinks.ts`, `src/features/chat/suggestedPrompts.ts`
- Test: `src/features/chat/tools/GeneClusteringToolUI.unit.test.tsx`, `src/features/chat/numberLinks.unit.test.ts`

**Interfaces:**
- Consumes: the `plot` from Task 2, and the `MatrixWrapper` props from Task 4.
- Produces: the default export `GeneClusteringToolUI: ToolCallMessagePartComponent`.

- [ ] **Step 1: Write the failing tests**

Set up mocks as in `SurvivalToolUI.unit.test.tsx`, with this result:

```ts
const RESULT = {
  status: 'ok',
  summary: '167 cases. Gene expression heatmap of the top 20 variably expressed genes.',
  cohort: { label: 'Race: black or african american, Sex: male', caseCount: 167, revision: 1 },
  genes: ['IGLC2', 'IGKC'],
  plot: { type: 'gene_clustering', maxGenes: 20 },
};

it('generates the heatmap on the frame filter', () => {
  show(RESULT);
  expect(mockChart).toHaveBeenCalledWith({
    chartType: 'hierCluster',
    filter0Override: { and: [] },
    maxGenes: 20,
    generateTopGenes: true,
  });
  expect(screen.getAllByText('Gene Expression Clustering').length).toBeGreaterThan(0);
});

it('shows only the tool row without a plot', () => {
  show({ status: 'too_few_samples', summary: 'Ranking genes needs at least 10 samples.' });
  expect(mockChart).not.toHaveBeenCalled();
  expect(screen.getByText('Ranking genes needs at least 10 samples.')).toBeInTheDocument();
});
```

In `numberLinks.unit.test.ts`:

```ts
it('titles the gene clustering tool', () => {
  const part = {
    type: 'tool-call',
    toolCallId: 't1',
    toolName: 'virtual-lab___show_gene_clustering',
    result: { summary: '167 cases.' },
  };
  expect(toolSources([part])[0].title).toBe('Gene Expression Clustering');
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/chat/tools/GeneClusteringToolUI.unit.test.tsx src/features/chat/numberLinks.unit.test.ts`
Expected: FAIL, because the component doesn't exist and the title is still the tool's name

- [ ] **Step 3: Implement the component and its three entries**

`GeneClusteringToolUI` follows `OncoMatrixToolUI`, without follow-ups, with `TITLE = 'Gene Expression Clustering'` and the same dynamic import of `MatrixWrapper`. Then add:

- **`toolkit.tsx`:** `'virtual-lab___show_gene_clustering': { type: 'backend', display: 'standalone', render: GeneClusteringToolUI }`
- **`numberLinks.ts`:** `show_gene_clustering: 'Gene Expression Clustering'` in `TOOL_TITLES`
- **`suggestedPrompts.ts`:** `{ prompt: 'Show gene expression clustering', label: 'Gene Expression Clustering' }`, before the status check

- [ ] **Step 4: Run the Chat tests and the lint, and confirm they pass**

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/chat/ && npm run lint`
Expected: PASS. If a test pins the suggested prompts, update it for the new entry.

- [ ] **Step 5: Commit**

```bash
git add src/features/chat/tools/GeneClusteringToolUI.tsx src/features/chat/tools/GeneClusteringToolUI.unit.test.tsx src/features/chat/toolkit.tsx src/features/chat/numberLinks.ts src/features/chat/numberLinks.unit.test.ts src/features/chat/suggestedPrompts.ts
git commit -m "feat(chat): draw the gene clustering heatmap in Chat"
```

### Task 6: Deploy the agent and run the live checks

**Files:**
- Modify: `agentcore/README.md`, with a "Gene clustering tool" section after "Survival tool", holding the table of results

- [ ] **Step 1: Run every test from a clean state**

Run the commands in `CLAUDE.md`'s AgentCore section, including `terraform fmt`, `validate` and `test` in `terraform/modules/agentcore`.
Expected: PASS

- [ ] **Step 2: Build, and produce the Terraform plan**

Run: `scripts/build_agent.sh`, then `(cd ../terraform && AWS_PROFILE=workshop terraform plan)`
Expected: changes to the tool Lambda, Gateway target and Runtime only, with no destroys. Check that `enable_agentcore` and `enable_knowledge_graph` are still true.

- [ ] **Step 3: Ask the user to review the plan and apply it**

Stop here until the user has applied. Only the user applies.

- [ ] **Step 4: Run the live checks on the local Chat against the deployed agent**

| # | Action | Expected |
| --- | --- | --- |
| 1 | With no cohort, ask "Show gene expression clustering" | The heatmap draws with no click, reads 20 Genes, and the label reads 1,000 cases |
| 2 | Look at the chart in the chat column | It fits, or it scrolls without breaking the page. Fix the layout in `ChartFrame` if it doesn't |
| 3 | Ask for it for Black male patients | The label reads 167 cases, and the heatmap reads 167 Samples |
| 4 | Compare the chart's `topVariablyExpressedGenes` reply with the tool's result | The same 20 genes, in the same order |
| 5 | Change the cohort, then ask again | Both heatmaps stay drawn, and the earlier one keeps its cohort |
| 6 | Open `/?app=GeneExpression` | It opens on the start screen, with 1000 |
| 7 | Ask "Which patients cluster together?" and "Show the MEK gene set" | The agent says it can't see clusters, and that it can't load that set. It lists no MEK genes |
| 8 | Ask "Show the top 50 genes" | The agent says it uses the top 20 |
| 9 | Narrow the cohort to under 10 cases, if the cohort tools allow it | `too_few_samples`, with no chart. If no filter reaches this, say it was only unit tested |

- [ ] **Step 5: Record the results and commit**

```bash
git add agentcore/README.md
git commit -m "docs(agentcore): record the gene clustering live checks"
```
