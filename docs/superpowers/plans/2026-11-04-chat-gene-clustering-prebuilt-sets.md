# Chat Gene Clustering with Prebuilt Sets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A researcher names a gene set in Chat, and the agent generates the heatmap for that set on the active cohort.

**Architecture:** First the stack gains MSigDB and the MEK data, by merging MMRF's PRs and redeploying. Then `show_gene_clustering` gains an optional `geneSet`: the Lambda resolves the name and returns the gene list as a small `plot`, and the browser clusters it through the route the top 20 already uses.

**Tech Stack:** Python 3 with `unittest`, Next.js, TypeScript and Jest, `@sjcrh/proteinpaint-client`, Terraform, Helm.

**Spec:** `docs/superpowers/specs/2026-11-04-chat-gene-clustering-prebuilt-sets-design.md`

## Global Constraints

- **Repos:** `my-forks/mmrf-virtual-lab-sandbox` and `my-forks/mmrf-data-commons`. Code goes on a `feature/chat-gene-sets` branch in each, in worktrees under `my-forks/.worktrees/`, branched from `origin/main`.
- **Shortcut:** "MEK", "MEK pathway", "MEK gene set" and "MEK signature", in any case, mean `MEK_UP.V1_UP`.
- **Availability:** check `genomes.hg38.termdbs.msigdb` on every call, with no flag or cached value.
- **Top 20:** calls without `geneSet` keep today's results and requests. The page keeps its start screen and 1000 default.
- **Clustering:** the reply never goes through the Lambda.
- **Answer limits:** never describe clusters or expression patterns, and never suggest what they mean for treatment. Never invent a gene list.
- **Approvals:** the merge and push to `main`, each deploy and each apply need the user's approval at that step. Read every Terraform plan, and stop on any destroy you didn't expect.
- **Deploy method:** images are pushed and set directly with `kubectl`, and the agent through a reviewed `terraform apply`. The launcher isn't used, because a partial rebuild from `main` would mix data versions.
- **Commit attribution:** end commit messages with the attribution line from the session's instructions. Stage files by name.

Commands run from the sandbox's `agentcore/` or the Data Commons root. Jest needs `NODE_OPTIONS=--no-experimental-strip-types`.

## Review Focus

1. **Group terms in `findterm` results:** a category isn't a set. Only leaf terms should count (Task 3).
2. **A cohort under 10 samples with a named set:** the top 20 route rejects these, and this route may not. The answer shouldn't claim a heatmap the chart can't draw (Task 5, live check 8).
3. **A name that reads like an instruction,** such as "the MEK and hypoxia sets": it should reach `gene_set_not_found`, not a guessed set (Task 3).
4. **A stack without MSigDB:** the researcher should hear that and be offered the top 20, not an error (Task 3).
5. **An earlier chart after the redeploy:** the data changed, so a saved cohort or old thread may not match. Check the earlier journeys (Task 5, live check 10).

---

### Task 1: Bring MMRF's PRs into the fork

**Files:** `sources.json`, if the frontend pin needs it. Otherwise only the merge.

- [ ] **Step 1: Ask the user to approve merging `upstream/main` into `main` and pushing**

Stop until approved.

- [ ] **Step 2: Merge and test**

Run: `git merge upstream/main`, then `python3 -m unittest discover -s tests -p 'test_*.py'` and `npm ci && npm test`
Expected: no conflicts, and tests pass. Any failure goes to the user by name before the push.

- [ ] **Step 3: Push**

Run: `git push origin main`
Expected: `main` includes `21f896b`.

### Task 2: Deploy `proteinpaint` and measure

Scope set by the user: only `frontend`, `proteinpaint` and the agent. Top 20 keeps working throughout.

- [ ] **Step 1: Build `proteinpaint` from a local merge of `959c0be` and `8be4671`**

Expected: amd64, and `generated/provenance.json` has the same hash as the live pod's, with generator version 8.

- [ ] **Step 2: Push it under a `build-` tag, and set the deployment to its digest**

Record the current digest for rollback. Expected: the rollout completes, `guppy` and `analysis` stay healthy, and `/protein-paint/genomes` lists `termdbs.msigdb`.

- [ ] **Step 3: Measure and record the unknowns**

Record in the ledger: the `findterm` result count and shape for `MEK`, `MEK_UP`, `hypoxia` and `HALLMARK_HYPOXIA`, the `genesetByTermId` reply shape and size, and the time of each call. Set `MAX_SET_GENES` from these, and update the spec if a reply differs from it.

### Task 3: Resolve a named set in the tool

**Files:**
- Modify: `agentcore/lambda/virtual_lab_client.py`, `agentcore/lambda/tool_show_gene_clustering.py`, `agentcore/lambda/tools.json`
- Test: `agentcore/tests/test_client.py`, `agentcore/tests/test_show_gene_clustering.py`, `agentcore/tests/test_tools_json.py`

**Interfaces:**
- Produces: on `VirtualLabClient`, `has_gene_sets() -> bool`, `find_gene_sets(text) -> list[str]` (leaf term IDs) and `gene_set_genes(term_id) -> list[str]`. The result's `plot` is `{"type": "gene_clustering", "genes": [...]}`, and it adds `geneSet: {"id", "geneCount"}`.

- [ ] **Step 1: Write the failing client tests**

| Test | Reply | Assertion |
| --- | --- | --- |
| `test_has_gene_sets_reads_the_genome` | `{"genomes": {"hg38": {"termdbs": {"msigdb": {}}}}}` | `True`, and the path is `/protein-paint/genomes` |
| `test_has_no_gene_sets` | `{"genomes": {"hg38": {}}}` | `False` |
| `test_find_gene_sets_uses_the_msigdb_dslabel` | `{"lst": [{"id": "A", "isleaf": true}, {"id": "GROUP"}]}` | Query has `dslabel=msigdb`, `findterm=MEK_UP` and `targetType=Dictionary Variables`. Returns `["A"]` |
| `test_gene_set_genes_accepts_a_list_reply` | `[{"symbol": "DUSP4"}, {"symbol": "ETV5"}]` | Returns `["DUSP4", "ETV5"]` |
| `test_an_unreadable_gene_set_is_unhealthy` | `{"error": "x"}` | `ClientError` with `step == "unhealthy"`, and no `x` in the message |

Use the field that marks a set from Task 2's measurement, if it isn't `isleaf`.

- [ ] **Step 2: Write the failing tool tests**

```python
def test_mek_shortcut_uses_the_up_set_and_names_the_other(self):
    for name in ("MEK", "mek", "MEK pathway", "MEK gene set", "mek signature"):
        with self.subTest(name=name):
            r = run(geneSet=name)
            self.assertEqual(r["geneSet"], {"id": "MEK_UP.V1_UP", "geneCount": 3})
            self.assertEqual(r["plot"], {"type": "gene_clustering", "genes": SET_GENES})
            self.assertIn("chosen for MEK", r["summary"])
            self.assertIn("MEK_UP.V1_DN is also available", r["summary"])
            self.assertIn("lists 3 genes", r["summary"])
            self.assertNotIn(SET_GENES[0], r["summary"])

def test_without_a_set_the_top_20_is_unchanged(self):
    client = FakeClient()
    r = run(client=client)
    self.assertEqual(r["plot"], {"type": "gene_clustering", "maxGenes": 20})
    self.assertEqual(client.availability_checks, 0)
```

Also add these, each asserting `"plot" not in r` unless stated:

| Test | Fake client | Expected |
| --- | --- | --- |
| `test_one_search_result_is_used` | `find` returns one ID | `ok` with `plot`, and no "chosen for" sentence |
| `test_an_exact_id_wins` | `find` returns several, including the name in another case | `ok` with `plot` |
| `test_several_results_are_ambiguous` | `find` returns 7 IDs | `ambiguous`, with 5 `options` |
| `test_no_result_is_not_found` | `find` returns `[]` | `gene_set_not_found`, and `genes` not called |
| `test_no_msigdb_is_unavailable` | `has_gene_sets` is `False` | `prebuilt_unavailable`, `find` not called, and "top 20" in the summary |
| `test_availability_is_checked_on_each_call` | Two calls | Two checks |
| `test_a_large_set_is_refused` | `genes` over `MAX_SET_GENES` | `gene_set_too_large`, with the size in the summary |
| `test_an_empty_set_is_no_data` | `genes` returns `[]` | `no_data` |
| `test_no_cases_comes_first` | `case_count` is 0 | `no_cases`, and no gene set calls |
| `test_a_non_text_name_is_invalid` | `geneSet=5` | `invalid_input` failure |
| `test_a_failed_search_is_a_failure` | `find` raises `ClientError` | `status == "error"` |

Add to `test_tools_json.py`: `geneSet` is in the tool's properties and not in `required`, and the description has "MSigDB".

- [ ] **Step 3: Run them and confirm they fail**

Run: `python3 -m unittest discover -s tests -p 'test_show_gene_clustering.py'`
Expected: FAIL

- [ ] **Step 4: Implement the client methods and the tool's steps**

Send the requests through a helper that accepts a list reply, leaving `_get`'s dictionary check for its other callers. Pass `dslabel: "msigdb"` in the query, which `_get` already lets override `_GENOME`. Use the spec's steps, statuses and summary wording. Split the set path into a function, so the top 20 path stays as it is.

- [ ] **Step 5: Run all the Lambda tests and commit**

Run: `(cd agent && uv run python -m unittest discover -s ../tests -p 'test_*.py')`
Expected: PASS

```bash
git add agentcore/lambda/virtual_lab_client.py agentcore/lambda/tool_show_gene_clustering.py agentcore/lambda/tools.json agentcore/tests/test_client.py agentcore/tests/test_show_gene_clustering.py agentcore/tests/test_tools_json.py
git commit -m "feat(agentcore): generate the heatmap for a named gene set"
```

### Task 4: Update the prompt, and draw the list in Chat

**Files:**
- Modify: `agentcore/agent/main.py`, `agentcore/agent/test_main.py`
- Modify (Data Commons): `src/features/proteinpaint/matrixArg.ts`, `src/features/proteinpaint/matrixArg.unit.test.ts`, `src/features/proteinpaint/MatrixWrapper.tsx`, `src/features/chat/tools/GeneClusteringToolUI.tsx`, `src/features/chat/tools/GeneClusteringToolUI.unit.test.tsx`, `src/features/chat/suggestedPrompts.ts`

- [ ] **Step 1: Write the failing tests**

In `test_main.py`, extend `test_limits_what_a_heatmap_answer_says` with "Pass `geneSet` only when the researcher names a pathway or gene set" and "Never invent a gene list". Assert `"say so and offer that heatmap"` is gone.

In `matrixArg.unit.test.ts`:

```ts
it('passes a gene list through', () => {
  const arg = getMatrixTrack({ chartType: 'hierCluster', genes: ['DUSP4'], generateTopGenes: true }, '/pp');
  expect(arg.genes).toEqual(['DUSP4']);
  expect(arg.opts.geneset).toEqual({ showEditUI: false });
});

it('leaves genes out without a list', () => {
  expect(getMatrixTrack({ chartType: 'hierCluster' }, '/pp')).not.toHaveProperty('genes');
});
```

In `GeneClusteringToolUI.unit.test.tsx`:

```ts
it('draws a named set and titles it', () => {
  show({ ...RESULT, geneSet: { id: 'MEK_UP.V1_UP', geneCount: 2 }, plot: { type: 'gene_clustering', genes: ['A', 'B'] } });
  expect(mockChart).toHaveBeenCalledWith({
    chartType: 'hierCluster', filter0Override: { and: [] }, genes: ['A', 'B'], generateTopGenes: true,
  });
  expect(screen.getAllByText('Gene Expression Clustering · MEK_UP.V1_UP').length).toBeGreaterThan(0);
});
```

Keep the existing top 20 test exactly as it is, so it pins that path.

- [ ] **Step 2: Run them and confirm they fail**

Run the agent and Jest commands from the earlier plan's Tasks 3 to 5.
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

Replace the prompt rule with the spec's text. Add `genes?: ReadonlyArray<string>` to `MatrixProps`, and set `arg.genes` only when given. In the UI, pass `genes` or `maxGenes` from `plot`, never both. Add the suggested prompt "Show gene expression clustering for MEK", labelled `Gene Expression Clustering`, before the status check.

- [ ] **Step 4: Run the tests and lint, and commit in each repo**

Run: `(cd agentcore/agent && uv run python -m unittest test_runs test_main test_cohort test_answers)`, then `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/chat/ src/features/proteinpaint/ && npm run lint`
Expected: PASS, with no lint errors

```bash
git add agentcore/agent/main.py agentcore/agent/test_main.py
git commit -m "feat(agentcore): let the agent name a gene set for the heatmap"
git add src/features/proteinpaint/matrixArg.ts src/features/proteinpaint/matrixArg.unit.test.ts src/features/proteinpaint/MatrixWrapper.tsx src/features/chat/tools/GeneClusteringToolUI.tsx src/features/chat/tools/GeneClusteringToolUI.unit.test.tsx src/features/chat/suggestedPrompts.ts
git commit -m "feat(chat): draw the heatmap for a named gene set"
```

### Task 5: Deploy, check live and record

**Files:**
- Modify: `agentcore/README.md`, `sources.json`
- Modify, outside git: `user-journey/user-journey-gene-clustering.md`

- [ ] **Step 1: Ask the user to approve pushing both branches to `main`, then push and pin**

Push Data Commons first, then update the frontend pin in `sources.json` and push the sandbox. If the user wants to test before merging, swap this with Step 2 and build from the branch's commit.

- [ ] **Step 2: Deploy the frontend image and the agent**

Build the frontend from the pushed commit, push it under a `build-` tag and set the deployment to its digest. Build the agent and read the Terraform plan before applying. Expected: the plan changes only the agent package, tool schema and Lambda, plus their hash-named S3 objects.

- [ ] **Step 3: Run the spec's live checks**

Run all 10 of the spec's live checks on the deployed site, and read the answers. A failure gets a failing test, a fix and a rerun.

- [ ] **Step 4: Record the results**

Add a "Prebuilt gene sets" section with the results table to `agentcore/README.md`. In the journey, replace "Prebuilt shows nothing" and "We don't know of any MEK signal" with what's now true, keeping the original notes unchanged. Report any check that wasn't run.

- [ ] **Step 5: Commit and push**

```bash
git add agentcore/README.md
git commit -m "docs(agentcore): record the prebuilt gene set live checks"
git push origin HEAD:main
```
