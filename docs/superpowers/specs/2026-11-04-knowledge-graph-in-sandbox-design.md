# Knowledge graph in the sandbox stack

Date: 2026-11-04

## Goal

Run the team's myeloma knowledge graph in the operator's own sandbox account, deployed from this repo's root Terraform stack, so the deployed agent can answer questions from it with cited evidence.

The graph is rebuilt from public sources. Nothing is copied from the team's account, and the team's stack and repo are not changed.

## Scope

In scope:

- A `knowledge-graph/` code folder and a `terraform/modules/knowledge-graph` module.
- A new AgentCore Gateway dedicated to the graph tools.
- Agent changes so it can call those tools safely.
- Launcher support for building the Lambda package and loading the graph.
- Monarch and DisMech data.

Out of scope:

- **All frontend changes.** `mmrf-data-commons` and the `frontend` pin in `sources.json` don't change. Chat work starts after this spec, under its own design.
- Open Targets and CIViC.
- The graph explorer (`terraform/graph-api` in the team's repo).
- CloudWatch alarms. The account is wiped after the event.
- Automatic syncing with the team's repo.

## Decisions

| Topic | Decision | Why |
| --- | --- | --- |
| Purpose | The deployed agent answers from the graph | The combined demo is required |
| Gateway | A separate Gateway for the graph | Keeps the graph and Virtual Lab tools independent |
| Code location | Copied into this repo, unchanged where possible | Operator's choice. The source commit is recorded for traceability |
| Network | A separate private VPC with no internet route and no peering | Matches the team's AD-005, and leaves the Virtual Lab network untouched |
| Database | One Neptune cluster, with sources kept apart by `source` | Needs no code split, and costs half of two clusters |
| Sizing | Serverless, 1 to 8 capacity units, the same as the team | The budget allows it (see Cost) |
| Graph login | IAM database authentication on | Makes Neptune enforce the read-only role. The team's cluster has it off |

## Architecture

```text
Chat -> identity -> Agent -+-> existing Gateway -> Virtual Lab tool Lambda -> CloudFront
                           |
                           +-> KG Gateway -> kg-graph Lambda (read only) --+
                                                                           v
Launcher -> S3 raw/ -> kg-ingest Lambda (read and write) ------------> Neptune
```

Both graph Lambdas run in the private VPC. Nothing outside the VPC connects to Neptune. The only link between the graph and the rest of the stack is the agent's signed call to the KG Gateway.

## Components

### `knowledge-graph/`

| Path | Contents | Origin |
| --- | --- | --- |
| `lambda/handler.py` | The five `kg_*` tools | Team repo `terraform/lambda_build/handler.py`, unchanged |
| `lambda/load_neo4j.py` | The graph loader | Team repo `ingestion/load_neo4j.py`, unchanged |
| `tools.json` | Tool schemas in AWS's S3 schema format | Converted from the team's `terraform/gateway.tf` |
| `scripts/fetch_monarch.py`, `scripts/fetch_dismech.py` | Download the sources | Team repo `ingestion/`, with output paths adapted |
| `scripts/build_lambda.py` | Builds `build/lambda.zip` (Python 3.12, x86_64) | Team repo `scripts/build_lambda.py`, with paths adapted |
| `scripts/smoke_test.py` | Signed `initialize`, `tools/list` and `tools/call` | The stricter `scripts/test_gateway.py` from `upstream/main` at `4ff2fe1` |
| `tests/` | Tool and loader unit tests | Team repo `tests/test_kg_tools.py`, `tests/test_ingest.py` |
| `README.md` | Usage, source commit `2e11be0`, data terms and the rules below | New |

`build/` and `data/raw/` are git-ignored. DisMech data must not be committed (team AD-001).

The team's tool names and response format don't change. The Gateway target is named `kg-graph`, so tools appear as `kg-graph___kg_search_entities` and so on, and `docs/mcp-tools.md` in the team's repo still describes them.

### `terraform/modules/knowledge-graph/`

| File | Resources |
| --- | --- |
| `network.tf` | VPC `10.90.0.0/16`, two private subnets, a route table with no default route, an S3 gateway endpoint limited to the bucket |
| `neptune.tf` | Subnet group, security group, encrypted cluster, one `db.serverless` instance, engine `1.4.5.0`, `iam_database_authentication_enabled = true` |
| `lambdas.tf` | `kg-graph` and `kg-ingest`, their roles, security groups and 7-day log groups |
| `ingest.tf` | Bucket with a public access block and `force_destroy` |
| `gateway.tf` | Gateway, narrow trust like `modules/agentcore`, the `kg-graph` target and its schema object in S3 |
| `variables.tf`, `outputs.tf`, `versions.tf` | Inputs include `name`, `region`, `sandbox_account_id`, `lambda_zip_path`, `source_dir`. Outputs include `gateway_url`, `gateway_arn`, `ingest_bucket`, `ingest_function` |

Differences from the team's Terraform:

- A child module with no provider block, and no lookup of the team's orchestrator role.
- Terraform owns the log groups, so destroying the stack removes them.
- The bucket has a public access block.
- Schemas live in one JSON file, not about 800 lines of repeated HCL.
- The `kg-graph` Lambda has no S3 permission, and its security group allows outbound traffic only to Neptune. Only `kg-ingest` can read the bucket or write to Neptune.

### `terraform/knowledge_graph.tf`

- `enable_knowledge_graph`, a bool that defaults to `false`.
- A provider alias that repeats the root's region and account check and sets `Data = public-reference`, because the root provider tags everything `Data = synthetic-only`. The module uses this alias.
- `module.knowledge_graph`, with `count` set by the flag.
- When the flag and `enable_agentcore` are both on, a role policy granting the agent's runtime role `bedrock-agentcore:InvokeGateway` on the KG Gateway only.
- Outputs for the Gateway URL, bucket and function, which are null when the flag is off.

`modules/agentcore` gains an optional `knowledge_gateway_url` input, which sets the Runtime's `KG_GATEWAY_URL`, and a `runtime_role_name` output. With no input set, the Runtime's environment doesn't change.

### Agent (`agentcore/agent/`)

- **`main.py`:** adds a second `MCPClient` when `KG_GATEWAY_URL` is set. Without it, the agent behaves as it does today.
- **`cohort.py`:** `CohortHooks` currently adds the cohort filter to every tool call. It must only do so for `virtual-lab___` tools. Otherwise filters, which can hold case IDs, reach the graph Lambda. That Lambda writes its inputs to CloudWatch and returns them in `trace`, which the model would see. For other tools, the hooks remove any `cohortFilter` argument and leave the result unchanged.
- **System prompt:** the "say the data is synthetic" rule applies only to answers that use Virtual Lab tools. When `KG_GATEWAY_URL` is set, the prompt adds these rules for graph answers:
  - Pass on `limitations` and cite sources.
  - Keep `observations` apart from `interpretation`.
  - Say "none recorded", never "none exists".
  - Give no treatment recommendations.
  - Graph content is published knowledge and never validates a synthetic Virtual Lab result.

### Launcher (`scripts/aws_sandbox.py`)

- `init --enable-knowledge-graph`, stored as `enable_knowledge_graph` in the config and written to the tfvars. The launcher rewrites the tfvars from the config, so this is what keeps the module from being destroyed on its next run.
- `deploy` builds the Lambda package before `terraform plan` when the flag is on.
- A new `load-graph` command, which `deploy` also runs after install:
  1. Fetches Monarch, and DisMech at commit `b1ca0b232b815a21b4ba95a62828c9979e9a49e7` (release `v0.1.46`).
  2. Uploads the three raw files to `s3://<bucket>/raw/`.
  3. Invokes `kg-ingest` and prints the node and relationship counts and source versions.

## Error handling

- **Load failure:** `deploy` stops and tells the operator to run `load-graph` again. Rerunning is safe because every write is a `MERGE`.
- **Missing source version:** the loader already refuses the file.
- **Tool failure:** the Lambda returns a `limitations` entry with `isError: false`, so the agent must read `summary` and `limitations`, as the prompt requires.
- **Flag off:** no knowledge graph resources exist, and the agent runs as it does today.
- **KG Gateway unavailable when the agent starts:** the agent logs a warning and runs with only its Virtual Lab tools, so a graph outage doesn't take down Chat.

## Rollout

1. Make a dated copy of the state in `terraform-state/backups/`.
2. Set `enable_knowledge_graph` in the launcher config.
3. Run the launcher with `--skip-build`, so no images rebuild.
4. Read the plan. It should show only new knowledge graph resources, plus in-place updates to the agent Runtime and its role. **Stop on any destroy or replacement.**

Rollback: set the flag to false and deploy. This deletes the graph, which can be rebuilt.

## Testing

Unit tests, none needing AWS:

- The copied Lambda tests pass, with only their import paths changed.
- Agent tests: the hooks leave `kg-graph___` calls and results alone, Virtual Lab calls still get the filter, a model-supplied `cohortFilter` is removed from graph calls, and the second client appears only when `KG_GATEWAY_URL` is set.
- Launcher tests: the flag reaches the tfvars, and `load-graph` calls its steps in order.
- Terraform tests with mock providers: flag off creates nothing and outputs null, flag on creates the module, the grant needs both flags, and the cluster has IAM authentication on. CI runs them, along with the module's own tests.

Live acceptance:

1. `knowledge-graph/scripts/smoke_test.py` passes all five tools through the new Gateway.
2. Graph counts are 74 nodes and 87 relationships, or any difference is explained by Monarch's live data. DisMech is pinned, so its counts must match.
3. `agentcore/scripts/invoke.py` with "What leads to hypercalcemia?" returns a cited answer with limits, and no claim that the graph is synthetic.
4. A survival question still works and still says its data is synthetic.
5. The `kg-graph` Lambda's logs contain no `cohortFilter`.
6. `kg_run_readonly_query` rejects a write query through the Gateway. Neptune's own enforcement isn't tested live, because the handler's guard stops writes first. A Terraform test checks that the `kg-graph` role allows only `neptune-db:ReadDataViaQuery` for data access and that the cluster has IAM authentication on.

How the tool calls look in Chat isn't part of acceptance, because frontend work comes later.

## Risks

| Risk | Handling |
| --- | --- |
| IAM login on the cluster is untested. The team's cluster has it off, and their role policies may lack an action such as `neptune-db:connect` | Confirm the required actions in AWS's docs while planning. If signed connections still fail, turn it off, which doesn't replace the cluster, and record that the read-only role isn't enforced |
| `tools.json` in S3 may not accept `outputSchema` | Remove it if so. The Gateway still negotiates a protocol version without it, and the response is read from `content[0].text` either way |
| Workshop role may block a resource | Found at apply. Stop and report what was blocked |
| Long graph responses strain Haiku's 1,024-token output limit | Check in acceptance step 3, and raise `max_output_tokens` if answers are cut off |
| Monarch data differs from the team's `2026-10-07` version | Report the version loaded. Copy the team's raw files if an exact match is needed |
| An apply from the `lhnminh` clone destroys the graph as well as the agent | Add to the workspace `CLAUDE.md`. The graph can be rebuilt |
| Running without a teardown | Neptune bills while idle. `destroy` removes it, and the account has to be torn down before the wipe |

## Cost

On 2026-11-04 the account had spent $8.15 of its $500 budget, with no Neptune cluster yet. One cluster costs about $4 a day idle and $31 a day at a constant 8 units. These use about $0.16 per unit-hour, which comes from memory because the pricing API didn't return a serverless rate. Confirm the rate before relying on these numbers.

## Open item before pushing

The team's repo has no license file. Ask the team before pushing the copied code to this public fork.

## Docs and diagram

- A new architecture diagram in `my-forks/diagrams`, as for every architecture change.
- `knowledge-graph/README.md`, and links from `agentcore/README.md` and `docs/aws-deployment.md`.
- The workspace `CLAUDE.md`: the new flag, the module, and the `lhnminh` risk.
