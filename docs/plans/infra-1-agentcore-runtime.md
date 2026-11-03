# Plan: infra-1, agent on AgentCore Runtime

Owner: Dev 1 (TBD) · Branch: `infra-1-agentcore-runtime` · Team context: [CLAUDE.md](../../CLAUDE.md) · Architecture: [agent-architecture.md](../agent-architecture.md)

Tick the boxes as you go; this file is the chunk's status.

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

- `agent/src/http.mjs`, `agent/src/server.mjs`, an ARM64 image build (a Dockerfile or build flag for the existing `docker/agent.Dockerfile`).
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

- [ ] 1.1 Check the AgentCore Runtime docs for the invocation and health paths, port, ARM64 requirement, request and response format, session header and payload limits; verify the findings are recorded in the design note, decision 1.
- [ ] 1.2 Add the invocation and health endpoints to `agent/src/http.mjs`; verify a test shows the invocation endpoint returns the same JSON as `/v1/prompts` for the journey 1 body.

### R2. Runtime deployed (stopping point: AWS CLI invocation answers journey 1)

- [ ] 2.1 Add the ECR repository and execution role to `terraform/agentcore-runtime.tf`, gated by `enable_agentcore`; verify `terraform validate` and `terraform plan` show only those resources.
- [ ] 2.2 Fill in `scripts/deploy_runtime.py`: build ARM64, push, create or update the Runtime with its settings; verify `aws_sandbox.py deploy` with `enable_agentcore` true creates it, and a rerun updates it.
- [ ] 2.3 Invoke the Runtime from the AWS CLI with the journey 1 question; verify a successful `correlation_plot` call with 339 and 661 cases.

### R3. Chat through Runtime (stopping point: Chat on the AWS URL answers via Runtime)

- [ ] 3.1 Give the EKS node role permission to invoke the Runtime; verify from an `identity` pod that the credentials are reachable.
- [ ] 3.2 Make `identity` call the Runtime when `AGENTCORE_RUNTIME_ARN` is set; verify a test with a stub Runtime, and that the existing gateway tests still pass.
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
Add Runtime's invocation and health paths to `http.mjs`, calling the same `runPrompt`. The port comes from `AGENT_PORT` (Runtime expects a fixed port; set it in the image). **Verify first** against the current AgentCore Runtime docs: paths (expected `POST /invocations`, `GET /ping`), port (expected 8080), ARM64 requirement, request and response framing, session id header, and payload limits.

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

- Runtime region and AgentCore availability in the sandbox account.
- Owner (Dev 1).
