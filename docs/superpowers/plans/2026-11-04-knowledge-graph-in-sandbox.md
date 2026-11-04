# Knowledge Graph in the Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the myeloma knowledge graph from this repo's root Terraform stack, and let the deployed agent answer from it with cited evidence.

**Architecture:** A new `terraform/modules/knowledge-graph` creates a private VPC, one Neptune cluster, two Lambdas and a dedicated AgentCore Gateway, behind `enable_knowledge_graph`. The agent gets a second MCP client for that Gateway. The launcher builds the Lambda package and loads the graph from public sources.

**Tech Stack:** Terraform 1.13 with AWS provider `~> 6.71`, Python 3.12 Lambdas on x86_64 (`neo4j==5.28.8`, `pyyaml==6.0.3`), Strands agent on Python 3.13, `uv`, pytest, unittest.

**Spec:** `docs/superpowers/specs/2026-11-04-knowledge-graph-in-sandbox-design.md`

**Diagram:** `my-forks/diagrams/2026-11-04-knowledge-graph-in-sandbox-architecture.drawio`

**Team source repo:** `my-forks/MMRF-KnowledgeGraph`, called `$KG` below. Copy from commit `2e11be0`. The smoke test comes from `upstream/main` at `4ff2fe1`.

## Global Constraints

- No frontend changes. `mmrf-data-commons` and the `frontend` pin in `sources.json` stay as they are.
- Only Monarch and DisMech data. DisMech is pinned to commit `b1ca0b232b815a21b4ba95a62828c9979e9a49e7` (release `v0.1.46`).
- Never commit DisMech data, real account IDs, CloudFront IDs or credentials. This repo is a public fork.
- Region `us-west-2`. VPC `10.90.0.0/16`. Neptune engine `1.4.5.0`, `db.serverless`, 1 to 8 capacity units, encrypted, `iam_database_authentication_enabled = true`.
- Resource name prefix `${var.name}-kg`. Gateway target name `kg-graph`, so tools appear as `kg-graph___kg_*`.
- `handler.py` and `load_neo4j.py` stay byte-identical to the team's copies, unless Task 8's fallback says otherwise.
- Don't push. Ask the team about the missing license before any push.
- Work on branch `feature/knowledge-graph`. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Only the user approves an apply. `terraform apply` and `aws_sandbox.py deploy` run only in Task 8.

## Review Focus

1. Destroying the stack when `knowledge-graph/build/lambda.zip` is missing should still work. Terraform reads the zip during planning, so `destroy` must build it first (Task 6).
2. A launcher config with no `enable_knowledge_graph` key should behave as flag off, with nothing created and no failure (Task 6).
3. A `kg-ingest` invocation that returns `FunctionError` has exit code 0 from the AWS CLI, and must still fail `load-graph` with the rerun command (Task 6).
4. If the KG Gateway is down when the agent starts, Virtual Lab tools should keep working (Task 5).
5. A graph tool call must not change cohort state or carry a cohort filter, including one the model made up (Task 5).

---

### Task 1: Copy the Lambda code, scripts and tests

**Files:**
- Create: `knowledge-graph/pyproject.toml`, `knowledge-graph/uv.lock`, `knowledge-graph/.gitignore`
- Create: `knowledge-graph/lambda/handler.py`, `knowledge-graph/lambda/load_neo4j.py`
- Create: `knowledge-graph/scripts/fetch_monarch.py`, `fetch_dismech.py`, `build_lambda.py`, `smoke_test.py`
- Test: `knowledge-graph/tests/test_kg_tools.py`, `test_ingest.py`, `test_smoke.py`, `test_build_lambda.py`

**Interfaces:**
- Produces: `knowledge-graph/scripts/build_lambda.py` writes `knowledge-graph/build/lambda.zip`, holding `handler.py`, `load_neo4j.py` and their Linux dependencies at the zip root.
- Produces: fetch scripts write to `knowledge-graph/data/raw/`. `fetch_dismech.py` needs `--revision`.
- Produces: `smoke_test.py --gateway-url URL`. Without the flag it reads `terraform output -raw knowledge_graph_gateway_url` from `terraform/`.

- [ ] **Step 1: Create the branch**

Run: `git switch -c feature/knowledge-graph`

- [ ] **Step 2: Copy the files**

| From `$KG` | To `knowledge-graph/` |
| --- | --- |
| `terraform/lambda_build/handler.py` | `lambda/handler.py` |
| `ingestion/load_neo4j.py` | `lambda/load_neo4j.py` |
| `ingestion/fetch_monarch.py`, `ingestion/fetch_dismech.py` | `scripts/` |
| `scripts/build_lambda.py` | `scripts/build_lambda.py` |
| `tests/test_kg_tools.py`, `tests/test_ingest.py` | `tests/` |
| `git show upstream/main:scripts/test_gateway.py` | `scripts/smoke_test.py` |
| `git show upstream/main:tests/test_smoke.py` | `tests/test_smoke.py` |

- [ ] **Step 3: Add the project files**

`pyproject.toml`: project `knowledge-graph`, `requires-python = ">=3.12"`, dependencies `neo4j>=5,<6`, `requests>=2,<3`, `pyyaml>=6,<7`, `boto3>=1.40,<2`, dev group `pytest>=8,<10`, pytest `testpaths = ["tests"]`. It's not a package, so set `[tool.uv] package = false`.

`.gitignore`: `build/`, `data/`, `.venv/`, `__pycache__/`.

- [ ] **Step 4: Write the failing build test**

In `tests/test_build_lambda.py`, patch `install` to do nothing, point `OUTPUT` at a temp path, run `main()`, and assert the zip's names include `handler.py` and `load_neo4j.py` and that two runs give identical bytes.

- [ ] **Step 5: Run it to see it fail**

Run: `cd knowledge-graph && uv run pytest tests/test_build_lambda.py -v`
Expected: FAIL, because `SOURCES` still uses the team's paths.

- [ ] **Step 6: Adapt the paths**

- `build_lambda.py`: `OUTPUT = ROOT / "build" / "lambda.zip"`, create its parent, `SOURCES = [ROOT / "lambda" / "handler.py", ROOT / "lambda" / "load_neo4j.py"]`.
- Test headers: replace `from mmrf_knowledgegraph.etl import ROOT` with `ROOT = Path(__file__).resolve().parents[1]`, and load modules from `lambda/`. Change nothing else in the test bodies except the imports the smoke test needs.
- `smoke_test.py`: read the URL from `-chdir=<repo>/terraform output -raw knowledge_graph_gateway_url`. Keep every check and the constants, including `NODES = 74` and `RELATIONSHIPS = 87`.

- [ ] **Step 7: Run all the tests**

Run: `cd knowledge-graph && uv run pytest -q`
Expected: all pass.

- [ ] **Step 8: Confirm the Lambda code is unchanged**

Run: `diff ../MMRF-KnowledgeGraph/terraform/lambda_build/handler.py knowledge-graph/lambda/handler.py && diff ../MMRF-KnowledgeGraph/ingestion/load_neo4j.py knowledge-graph/lambda/load_neo4j.py`
Expected: no output.

- [ ] **Step 9: Commit**

Include the spec and plan. Message: `feat(knowledge-graph): add the team's Lambda code, scripts and tests`

---

### Task 2: Convert the tool schemas

**Files:**
- Create: `knowledge-graph/tools.json`, `knowledge-graph/README.md`
- Test: `knowledge-graph/tests/test_tools_schema.py`

**Interfaces:**
- Produces: `knowledge-graph/tools.json`, a JSON array in the same format as `agentcore/lambda/tools.json`, with `name`, `description`, `inputSchema` and `outputSchema`.

- [ ] **Step 1: Write the failing test**

```python
def test_schema_lists_exactly_the_handlers_tools():
    assert {tool["name"] for tool in TOOLS} == set(handler.TOOLS)

def test_required_inputs_match_the_team_contract():
    assert required("kg_search_entities") == ["text"]
    assert required("kg_get_phenotypes") == ["disease_id"]
    assert required("kg_get_mechanism_paths") == ["disease_id"]
    assert required("kg_get_evidence") == []
    assert required("kg_run_readonly_query") == ["query"]

def test_every_tool_declares_the_envelope():
    for tool in TOOLS:
        assert {"contract_version", "result_type", "summary", "observations", "interpretation",
                "graph", "evidence", "limitations", "trace"} <= set(tool["outputSchema"]["properties"])

def test_only_the_query_tool_declares_a_table():
    assert [t["name"] for t in TOOLS if "table" in t["outputSchema"]["properties"]] == ["kg_run_readonly_query"]
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd knowledge-graph && uv run pytest tests/test_tools_schema.py -v`
Expected: FAIL, `tools.json` not found.

- [ ] **Step 3: Write `tools.json`**

Convert the five `inline_payload` blocks in `$KG/terraform/gateway.tf`, keeping names, descriptions, property types and `required` lists exact. `aws_s3_object` uploads this file, so it must be plain JSON.

- [ ] **Step 4: Run the test**

Run: `cd knowledge-graph && uv run pytest tests/test_tools_schema.py -v`
Expected: PASS.

- [ ] **Step 5: Write `README.md`**

Cover what the folder holds, source commits `2e11be0` and `4ff2fe1`, how to run tests and the smoke test, that DisMech data stays out of git and its bulk terms are unconfirmed, and the graph answer rules from the spec.

- [ ] **Step 6: Commit**

Message: `feat(knowledge-graph): describe the five tools in one schema file`

---

### Task 3: Terraform module

**Files:**
- Create: `terraform/modules/knowledge-graph/{network,neptune,lambdas,ingest,gateway,variables,outputs,versions}.tf`
- Test: `terraform/modules/knowledge-graph/tests/knowledge_graph_unit_test.tftest.hcl`

**Interfaces:**
- Consumes: `knowledge-graph/tools.json`, and a zip path.
- Produces: inputs `sandbox_account_id`, `region`, `name`, `lambda_zip_path`, `source_dir`. Outputs `gateway_url`, `gateway_arn`, `ingest_bucket`, `ingest_function`, `graph_function`.

- [ ] **Step 1: Write the failing tests**

Use `mock_provider "aws" {}`, an `override_data` for `data.aws_availability_zones.available` with `names = ["us-west-2a", "us-west-2b"]`, and `lambda_zip_path = "../agentcore/tests/fixtures/agent.zip"`, `source_dir = "../../../knowledge-graph"`, `name = "mmrf-synthetic-kg"`. Each `run` uses `command = plan` and asserts:

| Run | Assertions |
| --- | --- |
| `network_has_no_internet_path` | VPC CIDR is `10.90.0.0/16`, two subnets, no `aws_internet_gateway` or `aws_nat_gateway` in the module (confirm by review), S3 endpoint type `Gateway` |
| `neptune_matches_the_spec` | Engine version `1.4.5.0`, `storage_encrypted`, `iam_database_authentication_enabled`, capacity `1` to `8`, instance class `db.serverless` |
| `graph_role_is_read_only` | `jsondecode(aws_iam_role_policy.graph_neptune.policy).Statement[0].Action == "neptune-db:ReadDataViaQuery"` |
| `ingest_role_reads_s3_and_writes_neptune` | Actions include `neptune-db:WriteDataViaQuery` and `s3:GetObject`, and the S3 resource ends in `/raw/*` |
| `gateway_uses_iam_and_target_is_kg_graph` | `authorizer_type == "AWS_IAM"`, `protocol_type == "MCP"`, target name `kg-graph` |
| `bucket_is_private` | All four public access block settings are true |

- [ ] **Step 2: Run them to see them fail**

Run: `cd terraform/modules/knowledge-graph && terraform init -backend=false && terraform test`
Expected: FAIL, resources not defined.

- [ ] **Step 3: Implement the module**

Follow `modules/agentcore` for style and use the team's Terraform for resource settings, with these decisions:

- `network.tf`: route table with no default route, S3 gateway endpoint policy limited to `s3:ListBucket` and `s3:GetObject` on the bucket and `raw/*`.
- `neptune.tf`: `skip_final_snapshot = true`, `deletion_protection = false`, `apply_immediately = true`. Rules are separate resources. Port 8182 inbound only from the two Lambda security groups. No outbound rules.
- `lambdas.tf`:
  - Functions `${var.name}-graph` (handler `handler.handler`, timeout 60) and `${var.name}-ingest` (handler `load_neo4j.lambda_handler`, timeout 300). Both use Python 3.12, x86_64, 256 MB, and `NEPTUNE_IAM_AUTH = "true"`, and set `NEPTUNE_URI` to `bolt://<endpoint>:8182`.
  - The ingest function also sets `INGEST_BUCKET`.
  - Terraform-managed log groups with 7-day retention, and functions `depends_on` them.
  - Graph security group outbound: Neptune only. Ingest security group outbound: Neptune and the S3 prefix list.
- `ingest.tf`: bucket `${var.name}-ingest-${var.sandbox_account_id}`, `force_destroy = true`, public access block.
- `gateway.tf`: same shape as `modules/agentcore/gateway.tf`, with schema key `schemas/tools-<md5>.json`, and a role allowing only `lambda:InvokeFunction` on the graph function and `s3:GetObject` on that key. Trust limited to `gateway/${var.name}-*`.
- Use `var.sandbox_account_id` for ARNs, not a caller identity lookup.

- [ ] **Step 4: Run the tests**

Run: `cd terraform/modules/knowledge-graph && terraform fmt -check && terraform validate && terraform test`
Expected: all pass.

- [ ] **Step 5: Commit**

Don't commit `.terraform.lock.hcl` changes unless the module needs its own lock file, as `modules/agentcore` does. Message: `feat(terraform): add the knowledge graph module`

---

### Task 4: Wire the module into the root stack

**Files:**
- Create: `terraform/knowledge_graph.tf`
- Modify: `terraform/variables.tf`, `terraform/agentcore.tf:6-12`, `terraform/modules/agentcore/agent.tf:134-140`, `terraform/modules/agentcore/variables.tf`, `terraform/modules/agentcore/outputs.tf`
- Modify: `terraform/tests/sandbox.tftest.hcl`, `terraform/tests/agentcore_unit_test.tftest.hcl`, `.github/workflows/validate.yaml`
- Test: `terraform/tests/knowledge_graph_unit_test.tftest.hcl`

**Interfaces:**
- Consumes: the module from Task 3.
- Produces: `var.enable_knowledge_graph` (bool, default false), `var.knowledge_graph_zip_path` (string, default null), root outputs `knowledge_graph_gateway_url`, `knowledge_graph_ingest_bucket`, `knowledge_graph_ingest_function`, null when off.
- Produces: `modules/agentcore` input `knowledge_gateway_url` (string, default null), output `runtime_role_name`. The Runtime gets `KG_GATEWAY_URL` only when the input is set.

- [ ] **Step 1: Write the failing tests**

| Run | Variables | Assertions |
| --- | --- | --- |
| `off_by_default` | Defaults | `length(module.knowledge_graph) == 0`, outputs null, `length(aws_iam_role_policy.agent_invoke_knowledge_graph) == 0` |
| `on_without_agent` | KG on, agent off | Module count 1, grant count 0 |
| `on_with_agent` | KG on, agent on, HTTPS on | Module count 1, grant count 1 |
| `agent_without_graph_has_no_url` | Agent on, KG off | `KG_GATEWAY_URL` isn't in the Runtime's `environment_variables` |
| `agent_with_graph_has_url` | Both on | `KG_GATEWAY_URL` is in `environment_variables` |

Mock both `aws` and `aws.knowledge_graph`, override `module.knowledge_graph[0].data.aws_availability_zones.available`, and use the existing fixture zip for both zip paths.

- [ ] **Step 2: Run them to see them fail**

Run: `cd terraform && terraform test -filter=tests/knowledge_graph_unit_test.tftest.hcl`
Expected: FAIL, `enable_knowledge_graph` isn't declared.

- [ ] **Step 3: Implement the wiring**

`knowledge_graph.tf`:

- `provider "aws"` with `alias = "knowledge_graph"`, the same `region` and `allowed_account_ids` as the root, and default tags `Project = "mmrf-virtual-lab-sandbox"`, `Data = "public-reference"`, `Environment = "sandbox"`.
- `module "knowledge_graph"` with `count = var.enable_knowledge_graph ? 1 : 0`, `providers = { aws = aws.knowledge_graph }`, `name = "${var.name}-kg"`, `lambda_zip_path = coalesce(var.knowledge_graph_zip_path, "${path.module}/../knowledge-graph/build/lambda.zip")`, `source_dir = "${path.module}/../knowledge-graph"`.
- `aws_iam_role_policy.agent_invoke_knowledge_graph`, `count = var.enable_knowledge_graph && var.enable_agentcore ? 1 : 0`, on `module.agentcore[0].runtime_role_name`, allowing `bedrock-agentcore:InvokeGateway` on the module's `gateway_arn` only.

`agentcore.tf`: pass `knowledge_gateway_url = one(module.knowledge_graph[*].gateway_url)`.

`agent.tf`: wrap `environment_variables` in `merge(...)`, adding `KG_GATEWAY_URL` only when the input isn't null.

- [ ] **Step 4: Fix the existing tests for the new provider**

Add `mock_provider "aws" { alias = "knowledge_graph" }` to both existing test files.

- [ ] **Step 5: Add CI**

In `validate.yaml`, add `terraform/modules/knowledge-graph` as a Terraform step like the `agentcore` one, and a new job that installs `uv` with `astral-sh/setup-uv` and runs `uv run pytest -q` in `knowledge-graph`.

- [ ] **Step 6: Run everything**

Run: `cd terraform && terraform fmt -check -recursive && terraform validate && terraform test && (cd modules/agentcore && terraform init -backend=false && terraform test)`
Expected: all pass.

- [ ] **Step 7: Check a real plan is unaffected**

Run: `cd terraform && AWS_PROFILE=workshop terraform plan -detailed-exitcode`
Expected: exit code 0 with no changes, because the flag is off in the tfvars. If anything else appears, stop and report it. This reads AWS but changes nothing, and `terraform.tfstate` is a symlink that must stay in place.

- [ ] **Step 8: Commit**

Check that `terraform/.terraform.lock.hcl` isn't staged unless the provider set really changed. Message: `feat(terraform): deploy the knowledge graph behind a flag`

---

### Task 5: Agent changes

**Files:**
- Modify: `agentcore/agent/cohort.py`, `agentcore/agent/main.py`
- Test: `agentcore/agent/test_cohort.py`, `agentcore/agent/test_main.py`

**Interfaces:**
- Produces: `cohort.VIRTUAL_LAB_PREFIX = "virtual-lab___"`.
- Produces: `main.KNOWLEDGE_GRAPH_RULES: str`, `main.system_prompt() -> str`, `main.gateway_clients() -> list[MCPClient]`.

- [ ] **Step 1: Write the failing hook tests in `test_cohort.py`**

Use the file's existing fake-tool setup.

```python
def test_graph_tool_receives_no_cohort_filter(self): ...
    # Run with a cohort in state and call "kg-graph___kg_get_phenotypes".
    # Assert FILTER_INPUT isn't in the arguments the tool received.

def test_model_cannot_send_a_filter_to_a_graph_tool(self): ...
    # The model's input includes FILTER_INPUT. Assert the tool didn't receive it.

def test_graph_tool_result_is_returned_unchanged(self): ...
    # The result text contains the key "cohortFilter" inside trace. Assert the hook leaves the result object as it was.

def test_graph_tool_call_leaves_the_cohort_unchanged(self): ...
    # The state's revision and filter are the same after the call.

def test_virtual_lab_tool_still_gets_the_filter(self): ...
```

Existing tests that use a tool name without the `virtual-lab___` prefix need that prefix added. Don't weaken any assertion.

- [ ] **Step 2: Write the failing client and prompt tests in `test_main.py`**

```python
def test_one_gateway_client_without_a_graph_url(self):
    with mock.patch.dict(os.environ): os.environ.pop("KG_GATEWAY_URL", None); self.assertEqual(len(main.gateway_clients()), 1)

def test_two_gateway_clients_with_a_graph_url(self):
    # KG_GATEWAY_URL is set, and the probe succeeds (patched). Assert 2 clients.

def test_graph_outage_leaves_virtual_lab_tools_and_warns(self):
    # The probe raises. Assert 1 client and a logged warning.

def test_graph_rules_only_when_the_graph_is_configured(self):
    # system_prompt() contains KNOWLEDGE_GRAPH_RULES only with KG_GATEWAY_URL set.

def test_graph_rules_say_what_the_spec_requires(self):
    for words in ("limitations", "none recorded", "none exists", "treatment", "observations", "interpretation",
                  "published knowledge", "summary"):
        self.assertIn(words, main.KNOWLEDGE_GRAPH_RULES)

def test_synthetic_notice_applies_to_virtual_lab_answers(self):
    self.assertIn("When you used Virtual Lab tools", main.SYSTEM_PROMPT)
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd agentcore/agent && uv run python -m unittest test_cohort test_main`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement `cohort.py`**

In `CohortHooks.before`, always pop `FILTER_INPUT`, then add the cohort filter only when the tool name starts with `VIRTUAL_LAB_PREFIX`. In `after`, return at once for other tools.

- [ ] **Step 5: Implement `main.py`**

- Change the Limits line to begin: "When you used Virtual Lab tools, say the data is synthetic and has no clinical meaning, and say...". Keep the rest of the sentence and the existing test phrases.
- `KNOWLEDGE_GRAPH_RULES`: rules for answers using `kg-graph___` tools:
  - Tools report failures in `summary` and `limitations`, not as tool errors.
  - Report `observations` under Observed and `interpretation` only as labelled explanation.
  - Pass on `limitations` under Limits, and cite each source and version.
  - Say "none recorded", never "none exists".
  - Give no treatment recommendations.
  - Graph content is published knowledge and never validates a synthetic Virtual Lab result.
  - Don't use the word "filter", because `test_does_not_mention_a_filter` applies to the base prompt and the same reason applies here.
- `gateway_clients()`: always builds the existing client. When `KG_GATEWAY_URL` is set, it probes with a short-lived client (`with client: client.list_tools_sync()`), and on any exception logs a warning and returns only the first client. On success it returns a fresh second client, because a stopped MCP client isn't reused.
- `build_adapter`: use `tools=gateway_clients()` and `system_prompt=system_prompt()`.

- [ ] **Step 6: Run the agent tests**

Run: `cd agentcore/agent && uv run python -m unittest test_runs test_main test_cohort test_answers`
Expected: all pass.

- [ ] **Step 7: Commit**

Message: `feat(agent): call the knowledge graph tools, and keep cohort filters away from them`

---

### Task 6: Launcher

**Files:**
- Modify: `scripts/aws_sandbox.py:97-105` (`init_terraform`), `:257-274` (`deploy`), `:300` (`destroy`), `:423` (`initialize`), and the parser and dispatch in `main`
- Test: `tests/test_aws_launcher.py`

**Interfaces:**
- Consumes: `build_lambda.py` and the fetch scripts from Task 1, and the root outputs from Task 4.
- Produces: `Operator.build_knowledge_graph() -> None`, `Operator.load_graph(outputs: dict | None = None) -> dict`, CLI `init --enable-knowledge-graph`, CLI `load-graph`.

- [ ] **Step 1: Write the failing tests**

Use `Mock` methods and `operator.run` capture, as the existing tests do. No subprocess or AWS calls.

| Test | Asserts |
| --- | --- |
| `test_knowledge_graph_flag_reaches_the_tfvars` | Config true writes `"enable_knowledge_graph": true` |
| `test_config_without_the_flag_means_off` | No key writes `false`, and `deploy` calls neither `build_knowledge_graph` nor `load_graph` |
| `test_deploy_builds_the_package_before_planning` | With the flag on, `build_knowledge_graph` runs before the first `tf("plan", ...)` |
| `test_deploy_loads_the_graph_after_install` | `load_graph` runs after `install` |
| `test_load_failure_tells_the_operator_how_to_rerun` | When `load_graph` raises, `ValueError` mentions `load-graph` |
| `test_load_graph_steps_run_in_order` | Monarch fetch, DisMech fetch with the pinned commit, three `s3 cp` calls to `s3://<bucket>/raw/`, then `lambda invoke` |
| `test_fetch_failure_uploads_nothing` | When a fetch raises `CalledProcessError`, no `s3 cp` or `lambda invoke` runs |
| `test_lambda_function_error_fails_the_load` | `FunctionError` in the invoke JSON raises `ValueError`, even though the command succeeded |
| `test_load_graph_reports_counts_and_versions` | Returns the parsed response from the outfile |
| `test_destroy_builds_the_missing_package_first` | With the flag on, `build_knowledge_graph` runs before `init_terraform` |
| `test_load_graph_needs_the_flag` | With the flag off, raises `ValueError` |

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m unittest discover -s tests -p 'test_aws_launcher.py'`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**

- Add `DISMECH_REVISION = "b1ca0b232b815a21b4ba95a62828c9979e9a49e7"` and `KG_ROOT = ROOT / "knowledge-graph"`.
- `build_knowledge_graph`: `self.run(["uv", "run", "--project", KG_ROOT, "python", KG_ROOT / "scripts/build_lambda.py"])`.
- `load_graph`:
  - Reads outputs if none are passed, and calls `self.identity()` first when run alone.
  - Fetches, then uploads each file in `monarch_mm.json`, `dismech_mm.yaml`, `dismech_mm.yaml.provenance.json` with `self.run(["aws", "s3", "cp", ..., "--profile", ..., "--region", ...])`.
  - Invokes with `--cli-read-timeout 300` and outfile `self.directory / "kg-ingest.json"`.
  - Checks `FunctionError`, prints counts and versions, and returns the parsed response.
- `deploy`: build before `init_terraform` when the flag is on. After `fill_agent_secret`, run `load_graph(outputs)`, turning `CalledProcessError` and `ValueError` into a `ValueError` naming `python3 scripts/aws_sandbox.py load-graph`.
- `destroy`: build first when the flag is on and the zip is missing.
- Add the `load-graph` subcommand, and add `uv` to the required-tools check only when the flag is on.

- [ ] **Step 4: Run all the Python tests**

Run: `python3 -m unittest discover -s tests -p 'test_*.py'`
Expected: all pass. Node and Helm contracts aren't touched by this task.

- [ ] **Step 5: Commit**

Message: `feat(launcher): build the knowledge graph package and load the graph`

---

### Task 7: Documentation

**Files:**
- Modify: `agentcore/README.md`, `docs/aws-deployment.md`
- Modify (not in git): the workspace `CLAUDE.md` at `/Users/ryan/Desktop/AWS-Breaking-Barriers-Hackathon/CLAUDE.md`

- [ ] **Step 1: Update the repo docs**

- `docs/aws-deployment.md`: under Deploy, how to enable the graph, `load-graph`, and the cost note. Under Tear down, that `destroy` removes the graph with no snapshot.
- `agentcore/README.md`: the second Gateway, `KG_GATEWAY_URL`, and a link to `knowledge-graph/README.md`.

- [ ] **Step 2: Update the workspace `CLAUDE.md`**

- Terraform state table: the root now also deploys the knowledge graph, with `enable_knowledge_graph`.
- The rule that `enable_agentcore` must be true in both files applies to this flag too.
- The `lhnminh` warning: applying from that clone destroys the graph as well as the agent.
- Commands: `knowledge-graph` tests, smoke test and `load-graph`.

- [ ] **Step 3: Check for leaked identifiers**

Run: `git diff main --name-only | xargs grep -n -E '[0-9]{12}|AKIA' | grep -v -E '123456789012|uv.lock'`
Expected: only the DisMech commit SHA and the like. Remove any real account ID.

- [ ] **Step 4: Commit**

Commit the repo docs only. Message: `docs: describe the knowledge graph deployment`

---

### Task 8: Deploy and accept (needs the user at each gate)

**Files:** none, unless a fallback below applies.

Don't start until the branch has been reviewed, and the user has said whether to deploy from this branch or merge to `main` first. The workspace rule is to apply from this clone on `main`.

- [ ] **Step 1: Back up the state**

Run: `cp terraform-state/sandbox/terraform.tfstate terraform-state/backups/terraform.tfstate.$(date +%Y%m%d-%H%M%S).pre-knowledge-graph` from the workspace root.

- [ ] **Step 2: Set the flag**

Add `"enable_knowledge_graph": true` to `generated/aws/config.json`, and confirm `enable_agentcore` is still true.

- [ ] **Step 3: Plan and read it with the user**

Run: `python3 scripts/aws_sandbox.py deploy --skip-build` without `--yes`, so it stops at the typed confirmation.
Expected: only new `module.knowledge_graph` resources, the new policy, and in-place updates to the agent Runtime and its objects. **Stop on any destroy or replacement.** The user decides whether to confirm.

- [ ] **Step 4: Handle apply and load failures**

| Symptom | Action |
| --- | --- |
| A resource is denied by the workshop role | Stop and report what was blocked |
| `kg-ingest` or `kg-graph` gets `AccessDenied` from Neptune on signed Bolt | First check the policy actions in the Neptune docs. `SET` in the loader may need `neptune-db:DeleteDataViaQuery` on the ingest role only, and `neptune-db:connect` may be needed on both. Add what's needed and rerun, keeping `kg-graph` free of write and delete |
| Signed connections still fail | Set `iam_database_authentication_enabled = false`, which doesn't replace the cluster, and record that the read-only role isn't enforced. Report it to the user |
| The Gateway rejects `outputSchema` | Remove `outputSchema` from `tools.json` and its test, and rerun |
| `load-graph` fails | Read the error and rerun `python3 scripts/aws_sandbox.py load-graph` |

- [ ] **Step 5: Run the graph checks**

Run: `cd knowledge-graph && AWS_PROFILE=workshop uv run python scripts/smoke_test.py`
Expected: all checks pass, with 74 nodes and 87 relationships. If Monarch's data changed, compare DisMech's counts, report the Monarch version, and update the smoke test constants only after the user agrees.

- [ ] **Step 6: Run the agent checks**

```sh
cd agentcore/agent
uv run python ../scripts/invoke.py "What leads to hypercalcemia?"
uv run python ../scripts/invoke.py "Compare overall survival for high risk vs standard risk"
```

Expected:
- The first answer cites sources, states limits and doesn't call the graph synthetic.
- The second still says its data is synthetic.
- If answers are cut off, raise `max_output_tokens` and redeploy.

- [ ] **Step 7: Check the logs**

Search `/aws/lambda/mmrf-synthetic-kg-graph` for `cohortFilter` using a CloudWatch Logs filter.
Expected: no matches.

- [ ] **Step 8: Check the budget and report**

Report actual Neptune spend from Cost Explorer, each acceptance result, and any fallback used. Remind the user that the stack must be torn down before the account wipe, and ask whether the team has answered about the license before any push.
