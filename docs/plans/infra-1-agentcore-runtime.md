# Plan: infra-1, agent on AgentCore Runtime

Owner: Dev 1 (TBD) · Branch: `infra-1-agentcore-runtime` · Team context: [CLAUDE.md](../../CLAUDE.md) · Architecture: [agent-architecture.md](../agent-architecture.md)

Tick the boxes as you go; this file is the chunk's status.

## Where we left off (2026-11-03)

Branch `task-1-agentcore-runtime`, not pushed. It can't merge before infra-3's F1, because `terraform/agentcore-runtime.tf` needs F1's `enable_agentcore` variable.

**Update 2026-11-04, knowledge graph (done first, by team decision):** the Runtime agent answers from the sister team's gateway `mmrf-kg-gateway-hjyd9sqogd` when `KG_GATEWAY_URL` is set (`agent/src/knowledge-graph.mjs`), using four named tools. `kg_run_readonly_query` is left out. Unlike other tools, the model sees the graph, evidence and limitations as well as `summary`, because it needs ids for its next call; that is an exception to contract 1. Verified live on the Runtime; not yet in Chat, which has no knowledge graph component. The Runtime now uses the shared role `mmrf-orchestrator-agent-runtime`, the renamed smoke role, which the knowledge graph team's Terraform grants gateway access. `agentcore-runtime.tf` still creates a separate `<name>-agent-runtime` role, so decide which one the real Runtime uses. The Virtual Lab deploy started this day; check its result before the steps below.

**Working:**

- The agent runs on AgentCore Runtime as `mmrf_smoke_agent` (id `mmrf_smoke_agent-mEvkp72vEB`) in the team account 548574235556, `us-west-2`. It is chat-only, with no tools. Test it with `AWS_REGION=us-west-2 python3 scripts/runtime_smoke.py invoke "What can you do?"`.
- The real `identity` server, run locally, reaches that agent through `AGENTCORE_RUNTIME_ARN`.

**Not done:**

- The Virtual Lab isn't deployed in this account, so there is no data, Chat or `identity` on AWS yet.
- `correlation_plot` hasn't run on Runtime.
- The Helm changes, the network policy, the node role's invoke permission and pod access to the node role's credentials are untested. `helm template` and `terraform plan` haven't run.
- `deploy_runtime.py` doesn't set `agentcore.runtimeArn` (task 3.3).

**Next steps, in order:**

1. Agree who deploys the Virtual Lab to 548574235556, `us-west-2`. No throw-away data stub: the decision was to deploy the real thing.
2. To deploy: install `terraform` and `helm`, then run `aws_sandbox.py init`. It needs a named AWS profile, and expects an assumed operator role while the team key is the IAM user `hackathon-team-shared`, so it may need a small change. Set the region to `us-west-2`; `terraform/variables.tf` defaults to `us-east-1`. Review the Terraform plan before anything is created.
3. Point the Runtime at the deployed sandbox: run `scripts/runtime_smoke.py up` with `AWS_REGION=us-west-2`, `VIRTUAL_LAB_ORIGIN`, `SANDBOX_ACCESS_USERNAME` and `SANDBOX_ACCESS_PASSWORD` set. Expect the journey 1 result of 339 and 661 cases (task 2.3).
4. Rebase onto F1 when it merges. Then finish 2.1 and 2.2 through `aws_sandbox.py`, replace the stand-ins, and call `deploy_runtime.destroy(ctx)` from `aws_sandbox.py destroy` (agree this with infra-3).
5. Finish R3 on EKS: tasks 3.1 and 3.3, ending with the survival chart in Chat on the AWS URL.
6. R4 with infra-2, after its G3.

**Resources to clean up later:**

- `us-west-2`: `python3 scripts/runtime_smoke.py down` with `AWS_REGION=us-west-2` deletes the `mmrf-smoke` Runtime, ECR repository and role. Keep them until step 3 is done or the real Runtime replaces them.
- CloudWatch log groups for the deleted and current runtimes stay behind; `down` doesn't remove them.
- Account 819739653272, `us-east-1`: the first `mmrf-smoke` resources may remain. That account's credentials are no longer in use.

## Why

The ORION brief requires the agent to run on Amazon Bedrock AgentCore. Today the
agent runs only as a local Compose container. This chunk hosts the existing
agent on AgentCore Runtime and connects Chat on the AWS sandbox to it. See the
root `CLAUDE.md` for how it fits with infra-2 (tools on Gateway) and infra-3
(foundation).

## What changes

- **R1 Runtime contract, locally:** the agent server also serves AgentCore Runtime's invocation and health endpoints, with the same JSON as `POST /v1/prompts`.
- **R2 Runtime deployed:** an ARM64 agent image in its own ECR repository, an execution role (Bedrock invoke, logs, image pull), and the Runtime itself, created by `terraform/agentcore-runtime.tf` and `scripts/deploy_runtime.py`. Tools still run in-process, calling the sandbox through its public URL with the team login.
- **R3 Chat through Runtime:** when `AGENTCORE_RUNTIME_ARN` is set, the gateway (`identity`) sends `/agent/v1/prompts` to the Runtime instead of the EKS agent, signing with the EKS node role.
- **R4 Tools through Gateway (with infra-2):** the Runtime's agent gets `AGENTCORE_GATEWAY_URL` from infra-2's output, so tools run through Gateway.


## Files touched

- `agent/src/http.mjs`, `agent/src/server.mjs`, `scripts/runtime_smoke.py` (temporary), an ARM64 image build (a Dockerfile or build flag for the existing `docker/agent.Dockerfile`).
- `terraform/agentcore-runtime.tf`, `scripts/deploy_runtime.py`.
- `identity/server.mjs` and its image (it has no npm dependencies today; the Runtime call needs the AWS SDK or SigV4 signing).
- Helm values for `identity` (`AGENTCORE_RUNTIME_ARN`).
- Depends on infra-3 milestone F1 (hooks, empty Terraform file, data-access helper). R4 depends on infra-2 milestone G3.

## Milestones and tasks

Starting prompt (paste into a fresh Claude session):

```
Read CLAUDE.md, docs/agent-architecture.md and docs/plans/infra-1-agentcore-runtime.md.
I own infra-1 (agent on AgentCore Runtime). Branch infra-1-agentcore-runtime from origin/main,
after infra-3's F1 skeleton has merged. Work only in my files (see CLAUDE.md "File ownership").
Start with task 1.1: verify the AgentCore Runtime contract in the current AWS docs and record what
you find in this file before writing code. Stop at each milestone for review. Don't commit until I confirm.
Never add AI attribution and never commit .claude/.
```

### R1. Runtime contract, locally (stopping point: agent answers on Runtime's endpoints)

- [x] 1.1 Check the AgentCore Runtime docs for the invocation and health paths, port, ARM64 requirement, request and response format, session header and payload limits; verify the findings are recorded in the design note, decision 1.
- [x] 1.2 Add the invocation and health endpoints to `agent/src/http.mjs`; verify a test shows the invocation endpoint returns the same JSON as `/v1/prompts` for the journey 1 body.

### R2. Runtime deployed (stopping point: AWS CLI invocation answers journey 1)

- [ ] 2.1 Add the ECR repository and execution role to `terraform/agentcore-runtime.tf`, gated by `enable_agentcore`; verify `terraform validate` and `terraform plan` show only those resources.
- [ ] 2.2 Fill in `scripts/deploy_runtime.py`: build ARM64, push, create or update the Runtime with its settings; verify `aws_sandbox.py deploy` with `enable_agentcore` true creates it, and a rerun updates it.
- [ ] 2.3 Invoke the Runtime from the AWS CLI with the journey 1 question; verify a successful `correlation_plot` call with 339 and 661 cases.

### R3. Chat through Runtime (stopping point: Chat on the AWS URL answers via Runtime)

- [ ] 3.1 Give the EKS node role permission to invoke the Runtime; verify from an `identity` pod that the credentials are reachable.
- [x] 3.2 Make `identity` call the Runtime when `AGENTCORE_RUNTIME_ARN` is set; verify a test with a stub Runtime, and that the existing gateway tests still pass.
- [ ] 3.3 Set the ARN in Helm values from `deploy_runtime.py`; verify the journey 1 question in Chat on the AWS URL shows the survival chart, and Runtime logs show the request.

### R4. Tools through Gateway (with infra-2, after its G3)

- [ ] 4.1 Pass infra-2's `agentcore_gateway_url` output to the Runtime as `AGENTCORE_GATEWAY_URL`; verify the journey 1 answer is unchanged and Gateway logs show the tool call.

## Design notes

### Context

See [CLAUDE.md](../../CLAUDE.md) and `docs/agent-architecture.md`.

- The agent (`agent/`) is Node with the Strands TypeScript SDK. `src/http.mjs` serves `GET /health`, `GET /v1/tools`, `POST /v1/prompts` on `AGENT_PORT` (8787). `docker/agent.Dockerfile` builds it for the host platform.
- The gateway (`identity/server.mjs`) forwards `POST /agent/v1/prompts` to `http://agent:8787/v1/prompts` and strips auth headers. Its image has no npm dependencies.
- EKS nodes are in public subnets, so pods can call AWS APIs. The node role is created in `terraform/main.tf`.
- After infra-3 F1: `scripts/deploy_runtime.py` is a stub `deploy(ctx)`; `terraform/agentcore-runtime.tf` is empty; `enable_agentcore` gates AgentCore resources; executors take a data-access helper configured by `VIRTUAL_LAB_ORIGIN` and the team login.

### Goals / Non-Goals

**Goals:** the agent on Runtime, invoked by Chat, with the smallest working setup.

**Non-Goals:** the Gateway and Lambda (infra-2); per-pod IAM; streaming; AgentCore Memory.

### Decisions

**1. Same server, extra endpoints.**
Add Runtime's invocation and health paths to `http.mjs`, calling the same `runPrompt`. The port comes from `AGENT_PORT`. The verified contract is below.

**Verified contract (task 1.1, AWS docs and AWS CLI 2.39.3, checked 2026-11-03).** Protocol `HTTP`, the default.

| Item | Finding | Effect on us |
| --- | --- | --- |
| Invocation | `POST /invocations`, JSON in, JSON or SSE out. The body is ours; Runtime doesn't impose a shape. | Same JSON as `/v1/prompts`, so contract 3 holds. No streaming. |
| Health | `GET /ping` returns 200, `application/json`, `{"status":"Healthy"}`. `HealthyBusy` is for background work. | Add `/ping`. Never send `time_of_last_update` on every ping: it stops idle sessions from ending. The doc's FastAPI sample returns lowercase `healthy`; use the contract's `Healthy`. |
| Host and port | `0.0.0.0:8080` by default. Configurable with `protocolConfiguration.port` (8000-12000, 8443 reserved) in the API and CLI. | The image already sets `AGENT_HOST=0.0.0.0`. Set `AGENT_PORT=8080` in the Runtime's environment, so the image stays shared with the EKS fallback. |
| Architecture | `linux/arm64`, image in ECR, 2 GB maximum. | As decision 2. |
| Compute | Up to 2 vCPU and 8 GB per session. | No setting needed. |
| Session id | `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` (`runtimeSessionId`), at least 33 characters. A UUID is 36. If left empty, Runtime generates one. | `identity` sets it in R3. Each session gets its own microVM, and a running session keeps the code it started with until it ends. |
| Payload | 100 MB request or response. 15-minute synchronous timeout. | A 150 KB `plot` fits. The agent's own 64 KiB request limit is stricter and stays. |
| Sessions | Idle timeout 15 minutes, maximum 8 hours, both adjustable through `lifecycleConfiguration`. | The agent is stateless (history is in the body), so short timeouts are safe. |
| Environment | 4 KB total across all variables per agent. | Enough for decision 4. Recheck when R4 adds the Gateway URL. |
| Errors | A 4xx or 5xx from the container reaches the caller as `424 RuntimeClientError`. | Our 400 and 502 won't pass through unchanged. `identity` must map them in R3. |
| Auth | SigV4 by default. Caller needs `bedrock-agentcore:InvokeAgentRuntime`. | As decision 5. |
| MMDSv2 | Since 2026-06-30 invocations fail with `ValidationException` unless the runtime has `metadataConfiguration.requireMMDSV2=true`. | Must be set; see below. |
| Platform version | `V1` is the default and reaches `READY` in seconds. `V2` takes minutes and restores from a snapshot, which requires healthy within 120 seconds and affects when SDK clients load credentials. | Stay on `V1`. |
| Execution role | Trust `bedrock-agentcore.amazonaws.com` with `aws:SourceAccount` and `aws:SourceArn` conditions. Permissions: ECR pull and token, logs under `/aws/bedrock-agentcore/runtimes/*`, X-Ray, `cloudwatch:PutMetricData` (namespace `bedrock-agentcore`), workload access tokens, Bedrock invoke. | Copy this policy into task 2.1, not just the three items in decision 3. |
| Region | Runtime and Gateway are both available in `us-east-1`, the Terraform default. | No region change. |

**Terraform (decision 3).** `aws_bedrockagentcore_agent_runtime` exists in the locked provider, 6.69.1, but neither its schema (checked on the provider's `main`) nor its docs have `metadataConfiguration`, a port or a path. A Terraform-created runtime therefore can't set the required MMDSv2 flag. It would also need the image to exist before `terraform apply`, and would put the team password in Terraform state, which `agent-architecture.md` rules out. **Proposal:** Terraform owns the ECR repository and the execution role; `deploy_runtime.py` owns the Runtime through the AWS CLI, matching how `aws_sandbox.py` already works. `deploy_runtime.py` runs `create-agent-runtime`, waits for `READY`, then runs `update-agent-runtime --metadata-configuration requireMMDSV2=true`.

**Not verified; check in R2:**

- Whether a new runtime enables MMDSv2 by default. `CreateAgentRuntime` has no `metadataConfiguration` in the API reference or CLI 2.39.3, only `UpdateAgentRuntime` does, hence the two steps above.
- Whether `update-agent-runtime` keeps environment variables it isn't given. Send the full set on every update.
- How long a `V1` container has to start. The docs give only the `V2` limit.

**Verified live (2026-11-03, `scripts/runtime_smoke.py`, chat-only). First in account 819739653272, `us-east-1`; now running as `mmrf_smoke_agent` in the team account 548574235556, `us-west-2`:**

- The ARM64 image, port 8080 through `AGENT_PORT`, the role and create-then-update all work. The runtime reports `requireMMDSV2: true` and `V1`.
- In the team account, `global.anthropic.claude-sonnet-4-6` also needs `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe` on the role, which the documented policy doesn't include. Without them calls failed with 502, and they passed about 5 minutes after adding them. Both are now in `terraform/agentcore-runtime.tf`.
- First invocation of a new session took 7.4 s, a repeat in that session 1.9 s. Both include the model call.
- Omitting `Content-Type` reaches the container as a 415, so every caller must set `application/json`.
- A 400 from the agent comes back as `RuntimeClientError`, "Received error (400) from runtime". The agent's error body is lost, so `identity` can't show it to Chat.
- Logs are in `/aws/bedrock-agentcore/runtimes/<runtime id>-DEFAULT`.

Sources: [service contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html), [HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html), [port and path](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-configure-invocation.html), [quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html), [sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), [platform versions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html), [troubleshooting](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-troubleshooting.html), [permissions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html), [regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html), [InvokeAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html).

**2. ARM64 image in its own repository.**
`deploy_runtime.py` builds `docker/agent.Dockerfile` with `docker buildx build --platform linux/arm64` and pushes to an ECR repository defined in `agentcore-runtime.tf` (for example `<name>/agent-runtime`). The EKS fallback image from infra-3 stays amd64.

**3. Runtime resources.**
In `agentcore-runtime.tf`, gated by `enable_agentcore`: the ECR repository, the execution role (Bedrock invoke, CloudWatch Logs, ECR pull), and the Runtime if the AWS provider supports it. **Verify** provider support; if missing, `deploy_runtime.py` creates or updates the Runtime with the AWS CLI or SDK and records its ARN in `generated/aws/`.

**4. Runtime settings.**
`BEDROCK_MODEL_ID`, `AWS_REGION`, `VIRTUAL_LAB_ORIGIN` (the `https_url` output) and the team login (from `access.json`), set by `deploy_runtime.py`. No `AWS_BEARER_TOKEN_BEDROCK`. `AGENTCORE_GATEWAY_URL` is added in R4 from infra-2's output.

**5. Gateway → Runtime call.**
`identity` checks `AGENTCORE_RUNTIME_ARN`. When set, `POST /agent/v1/prompts` calls Runtime's invoke API with the request body and returns the response. Signing uses the node role through the instance metadata service. Give `identity` a small `package.json` with the AWS SDK client and update its Dockerfile, or sign with SigV4 by hand if the SDK is too heavy. The node role gets permission to invoke this Runtime (in `agentcore-runtime.tf`). `deploy_runtime.py` sets the ARN in the Helm values and upgrades the release.

### Risks / Trade-offs

- [Pods can't reach the node role's credentials (metadata hop limit)] → Check early; if blocked, raise the hop limit on the node group or use EKS Pod Identity.
- [Runtime contract differs from assumptions] → Task R1.1 verifies it before any code.
- [ARM64 build is slow or fails on the developer's Mac] → Apple silicon builds ARM64 natively; Intel Macs need `buildx` emulation.

### Open Questions

- The team uses account 548574235556 in `us-west-2`, but `terraform/variables.tf` defaults `region` to `us-east-1`. The real deploy must set `us-west-2`.
- R3 code status: `identity/runtime-client.mjs` signs SigV4 by hand, uses a new session id per request, and was tested through the real `identity` server against the live Runtime (2.3 s, and a 400 for a bad body). Not yet tested on EKS: reading the node role from a pod (metadata hop limit), the `identity-agentcore` network policy, and the node role's invoke policy. `helm template` and `terraform plan` haven't run. `deploy_runtime.py` doesn't set `agentcore.runtimeArn` yet (task 3.3), because that needs F1's `ctx`.
- Tasks 2.1 and 2.2 stay unticked until they run through `aws_sandbox.py`. `terraform/agentcore-runtime.tf` passes `terraform validate` only with a temporary `enable_agentcore` variable, which F1 will provide, and `terraform plan` hasn't run. `scripts/deploy_runtime.py` has run live through `scripts/runtime_smoke.py`, so check that F1's `ctx` matches the fields in its docstring.
- Stand-in for F1, to remove when it lands: `scripts/runtime_smoke.py` (repository, role and `ctx`; keep its role policy in step with Terraform). `agent/src/team-login.mjs` is gone; `agent/src/virtual-lab-fetch.mjs` replaced it.
- Task 2.3 needs a deployed sandbox: the live run was chat-only, so `correlation_plot` hasn't run on Runtime.
- `aws_sandbox.py destroy` must call `deploy_runtime.destroy(ctx)` before Terraform's destroy. Terraform doesn't own the Runtime, so it would otherwise be left behind. This is outside infra-1's files; agree it with infra-3.
- Owner (Dev 1).
