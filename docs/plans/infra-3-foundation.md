# Plan: infra-3, foundation and chat plumbing

Owner: Dev 3 (TBD) · Branch: `infra-3-foundation` · Team context: [CLAUDE.md](../../CLAUDE.md) · Architecture: [agent-architecture.md](../agent-architecture.md)

Tick the boxes as you go; this file is the chunk's status.

## Why

Three developers are building the AgentCore architecture in parallel (see the
root `CLAUDE.md`). Without a shared skeleton they would all edit
`scripts/aws_sandbox.py`, the same Terraform file and the same lines in
`agent/src/strands-runner.mjs`. This chunk lays that skeleton first, gives the
team a working fallback on AWS, and then builds the chat plumbing every journey
needs.

## What changes

- **F1 Skeleton (merge first):**
  - `aws_sandbox.py deploy` calls two hooks, `scripts/deploy_runtime.py` (infra-1) and `scripts/deploy_tools.py` (infra-2), as stubs that do nothing until filled in.
  - Empty `terraform/agentcore-runtime.tf` and `terraform/agentcore-gateway.tf`, and an `enable_agentcore` variable (default false).
  - One folder per tool: `agent/src/tools/<tool>/` holds the tool's spec, executor and prompt guidance. The registry and runner pick tools up from there. `correlation_plot` moves in with no behavior change.
  - A shared data-access helper, `agent/src/virtual-lab-fetch.mjs`, that adds the team login when `SANDBOX_ACCESS_USERNAME` and `SANDBOX_ACCESS_PASSWORD` are set.
- **F2 Agent on EKS (fallback):** the agent added to the AWS image list, ECR and Helm, so Chat works on the AWS sandbox before AgentCore, and stays available as a demo fallback.
- **F3 Chat plumbing (frontend fork):** Chat sends the selected cohort; the tool rows show what each tool was asked to do; the answer separates observations from interpretation.
- **F4 End-to-end check:** `aws_sandbox.py status` asks the journey 1 question through the public URL and checks the survival result.


## Files touched

- This repo: `scripts/aws_sandbox.py`, new hook stubs, `terraform/` (two empty files, one variable, an ECR repository), `helm/` (agent workload), `agent/src/tools/`, `agent/src/tool-catalog.mjs`, `agent/src/strands-runner.mjs`, `agent/src/virtual-lab-fetch.mjs`, tests.
- Frontend fork: `src/features/chat/agentAdapter.ts` and the tool components.
- After F1 merges, infra-1 and infra-2 work only in their own files.

## Milestones and tasks

Starting prompt (paste into a fresh Claude session):

```
Read CLAUDE.md, docs/agent-architecture.md and docs/plans/infra-3-foundation.md.
I own infra-3 (foundation, then chat plumbing). Branch infra-3-foundation from origin/main.
Do milestone F1 first and stop for review: the skeleton other developers build on.
Run npm test in agent/ and the repo's npm test after each task. Don't commit until I confirm.
Never add AI attribution and never commit .claude/.
```

### F1. Skeleton (merge first; stopping point: teammates can start)

- [ ] 1.1 Move `correlation_plot` into `agent/src/tools/correlation-plot/` with spec, executor factory and prompt guidance; build the registry and runner from `agent/src/tools/index.mjs`; verify `npm test` and `LIVE=1 npm test` pass unchanged.
- [ ] 1.2 Add `agent/src/virtual-lab-fetch.mjs` and pass it to executors; verify a unit test shows the Basic auth header when username and password are set, and none when they are not.
- [ ] 1.3 Add `enable_agentcore` to `terraform/variables.tf` and empty `terraform/agentcore-runtime.tf` and `terraform/agentcore-gateway.tf` with owner comments; verify `terraform validate` and `terraform test` pass.
- [ ] 1.4 Add stub `scripts/deploy_runtime.py` and `scripts/deploy_tools.py` with `deploy(ctx)`, and call them from `aws_sandbox.py deploy` after `install()`; verify `python3 -m pytest tests/test_aws_launcher.py` passes and a dry run prints "AgentCore steps skipped".
- [ ] 1.5 Commit `CLAUDE.md`, `docs/agent-architecture.md`, `docs/journeys.md` and the three infra plans; open the PR and tell the team to rebase.

### F2. Agent on EKS (stopping point: Chat works on the AWS URL)

- [ ] 2.1 Add `agent` to `SERVICES` in `aws_sandbox.py` and to the ECR list in `terraform/main.tf`; verify `aws_sandbox.py build` produces the agent image.
- [ ] 2.2 Add the agent Deployment, Service and network policy to `helm/`, with Bedrock access from the node role or a secret; verify `tests/test_helm_schema.py` passes and `helm template` renders it.
- [ ] 2.3 Deploy and ask the journey 1 question in Chat on the AWS URL; verify the survival chart shows 339 and 661.

### F3. Chat plumbing (frontend fork, `../mmrf-data-commons`)

- [ ] 3.1 Send the selected cohort as `context.cohortFilter` from `agentAdapter.ts`; verify a unit test and, in the stack, that a female cohort gives 172 and 328.
- [ ] 3.2 Show each tool call's inputs and errors in `ToolRow`; verify a unit test renders a failed call with its error.
- [ ] 3.3 Ask for "Observed" and "Interpretation" sections in the base system prompt; verify with Bedrock that the journey 1 answer has both and quotes the tool's numbers.
- [ ] 3.4 Push the fork, bump `sources.json`, rebuild the frontend with the stack stopped; verify Chat at `localhost:3080` shows all three behaviors.

### F4. End-to-end check (stopping point: one command proves the demo path)

- [ ] 4.1 Extend `aws_sandbox.py status` to post the journey 1 question to `/agent/v1/prompts` through the public URL with the team login; verify it reports 339 and 661, and fails clearly when the agent is down.

## Design notes

### Context

See [CLAUDE.md](../../CLAUDE.md) and `docs/agent-architecture.md` for the team plan.
Current code (on `main`):

- `agent/src/tool-catalog.mjs` registers tools per website app; `correlation_plot` is defined in `correlation-tool.mjs` with its executor in `executors/`.
- `agent/src/strands-runner.mjs` holds one system prompt and an `executors` map.
- `scripts/aws_sandbox.py deploy` runs Terraform and the image build in parallel, then `publish()` (ECR push) and `install()` (Helm). `SERVICES` lists six images; the agent is not one of them. ECR repositories are a `for_each` list in `terraform/main.tf`.
- On AWS, `identity` forwards `POST /agent/v1/prompts` to `http://agent:8787`, but no agent runs there.
- Frontend fork: `src/features/chat/agentAdapter.ts` posts `{prompt, history}` and does not send the cohort.

### Goals / Non-Goals

**Goals:** a skeleton that lets infra-1 and infra-2 work in separate files; Chat working on AWS early; the chat behaviors every journey needs.

**Non-Goals:** AgentCore resources themselves (infra-1, infra-2); new tools.

### Decisions

**1. Hooks as separate Python modules.**
`aws_sandbox.py` imports `deploy_runtime` and `deploy_tools` and calls `deploy(ctx)` on each after `install()`. `ctx` carries Terraform outputs, profile, region, `access.json` contents and a `run()` helper. Each module owns its own build, push and AWS calls. The stubs return immediately when `enable_agentcore` is false.

**2. Terraform split by owner.**
`agentcore-runtime.tf` and `agentcore-gateway.tf` start empty. `variables.tf` gains `enable_agentcore` (bool, default false), so each owner gates resources with `count`. infra-2 defines output `agentcore_gateway_url`; infra-1 reads it.

**3. Tool folders.**
`agent/src/tools/correlation-plot/index.mjs` exports `{spec, appId, createExecutor(deps), promptGuidance}`. `tools/index.mjs` lists the folders. `tool-catalog.mjs` builds registrations from it, and `strands-runner.mjs` builds its executors map and appends each tool's `promptGuidance` to the base prompt. The Lambda (infra-2) imports the same list.

**4. Data access helper.**
`virtual-lab-fetch.mjs` exports `createVirtualLabFetch({origin, username, password})`. Executors receive it instead of reading environment variables themselves, which is also how the Lambda and Runtime configure them.

**5. Agent on EKS.**
Add `agent` to `SERVICES` and the ECR list, and an `agent` Deployment and Service to the Helm chart (port 8787, no external exposure). Network policy allows `identity` → `agent` and `agent` → `identity`. Bedrock credentials come from a Kubernetes secret created by `aws_sandbox.py` from `agent/.env` values, or the node role if it is given Bedrock access. This is the fallback when AgentCore is off.

**6. Chat plumbing.**
The adapter reads the current cohort with the existing `selectCurrentCohortCaseFilters` and `buildCohortGqlOperator` (as `MatrixWrapper` does) and sends it as `context.cohortFilter`. `ToolRow` shows the inputs. The base prompt asks for "Observed" and "Interpretation" sections.

### Risks / Trade-offs

- [Refactor lands while others start] → F1 is small and merges first; others rebase onto it.
- [Bedrock credentials for the EKS agent] → Prefer the node role with Bedrock invoke; fall back to a key in a Kubernetes secret.
- [Frontend rebuild needs disk space] → Build with the stack stopped and prune afterwards.

### Open Questions

- Who owns this chunk (Dev 3) and whether the EKS fallback should stay after AgentCore works.
