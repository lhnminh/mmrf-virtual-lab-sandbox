# Plan: infra-2, tools on AgentCore Gateway

Owner: Dev 2 (TBD) · Branch: `infra-2-gateway-tools` · Team context: [CLAUDE.md](../../CLAUDE.md) · Architecture: [agent-architecture.md](../agent-architecture.md)

Tick the boxes as you go; this file is the chunk's status.

## Why

The architecture puts the Virtual Lab tools behind Amazon Bedrock AgentCore
Gateway, so the AgentCore-hosted agent calls them over MCP and future tools
plug in the same way. Today tools run only inside the agent process. This
chunk serves the existing tool code from a Lambda behind Gateway and teaches
the agent to call it. See [CLAUDE.md](../../CLAUDE.md) for how it fits with infra-1
(agent on Runtime) and infra-3 (foundation).

## What changes

- **G1 Lambda handler, locally:** `agent/lambda/handler.mjs` runs any registered tool's executor from a Gateway event, using the shared tool folders and data-access helper.
- **G2 Gateway client in the agent:** when `AGENTCORE_GATEWAY_URL` is set, the agent's tools call Gateway instead of running in-process. The client adds the website cohort as a hidden argument and splits each result into `summary` (for the model) and `plot` (for the UI), so `/v1/prompts` is unchanged.
- **G3 Gateway deployed:** the Lambda (outside the VPC), the Gateway, a Lambda target whose tool schemas are exported from the tool specs, and IAM permissions, in `terraform/agentcore-gateway.tf` and `scripts/deploy_tools.py`. Output: `agentcore_gateway_url`.
- **G4 Joined with Runtime:** infra-1 passes the Gateway URL to the Runtime.


## Files touched

- New: `agent/lambda/`, `agent/src/gateway-client.mjs`, a schema export script, tests.
- `terraform/agentcore-gateway.tf`, `scripts/deploy_tools.py`.
- The agent's runner uses the Gateway client when `AGENTCORE_GATEWAY_URL` is set (one switch point agreed with infra-3).
- Depends on infra-3 milestone F1 (tool folders, data-access helper, hooks, empty Terraform file).

## Milestones and tasks

Starting prompt (paste into a fresh Claude session):

```
Read CLAUDE.md, docs/agent-architecture.md and docs/plans/infra-2-gateway-tools.md.
I own infra-2 (tools on AgentCore Gateway). Branch infra-2-gateway-tools from origin/main,
after infra-3's F1 skeleton has merged. Work only in my files (see CLAUDE.md "File ownership").
Start with task 1.1: verify how AgentCore Gateway passes tool calls to a Lambda target and its size
limits, and record what you find in this file before writing code. Stop at each milestone for review.
Don't commit until I confirm. Never add AI attribution and never commit .claude/.
```

### G1. Lambda handler, locally (stopping point: handler answers a recorded event)

- [ ] 1.1 Check the AgentCore Gateway docs for the Lambda target event format, the response format and size limits; verify the findings are recorded in the design note, decision 1.
- [ ] 1.2 Add `agent/lambda/handler.mjs` running registered tools from a Gateway event; verify a test with a recorded event returns the journey 1 summary and plot, and an unknown tool returns an error.
- [ ] 1.3 Add `scripts/export_tool_schemas.mjs`; verify its output lists `correlation_plot` without `cohortFilter`.

### G2. Gateway client in the agent (stopping point: same response through a fake Gateway)

- [ ] 2.1 Check MCP client support in the Strands TypeScript SDK and Gateway's inbound auth options; verify the choice is recorded in the design note, decision 4.
- [ ] 2.2 Add `agent/src/gateway-client.mjs` and switch tools to it when `AGENTCORE_GATEWAY_URL` is set; verify a test against a fake MCP server gives the same `/v1/prompts` response as in-process, with the cohort sent and only `summary` reaching the model.

### G3. Gateway deployed (stopping point: a script calls the deployed tool)

- [ ] 3.1 Add the Lambda, Gateway, target, roles and `agentcore_gateway_url` output to `terraform/agentcore-gateway.tf`, gated by `enable_agentcore`; verify `terraform validate` and `terraform plan`.
- [ ] 3.2 Fill in `scripts/deploy_tools.py`: zip, update code, set the Lambda's settings from the Terraform output and `access.json`; verify `aws_sandbox.py deploy` creates and then updates them.
- [ ] 3.3 Call the deployed Gateway's `correlation_plot` from a script; verify the journey 1 summary and plot with 339 and 661 cases.

### G4. Joined with Runtime (with infra-1)

- [ ] 4.1 With infra-1, confirm the Runtime picks up `agentcore_gateway_url`; verify the journey 1 question in Chat on the AWS URL is served through Gateway (Lambda logs show the call).

## Design notes

### Context

See [CLAUDE.md](../../CLAUDE.md) and `docs/agent-architecture.md`.

- After infra-3 F1: each tool lives in `agent/src/tools/<tool>/` and exports its spec, an executor factory and prompt guidance; `agent/src/tools/index.mjs` lists them; executors take a data-access helper (`virtual-lab-fetch.mjs`) configured by `VIRTUAL_LAB_ORIGIN` and the team login.
- Each tool call is wrapped by the agent (today `createCorrelationTool`): it validates input, records the call in `toolCalls`, and returns only `summary` to the model.
- The sandbox URL is the Terraform output `https_url`; the team login is in `generated/aws/access.json`, created by `aws_sandbox.py`.

### Goals / Non-Goals

**Goals:** existing tools served from Gateway with the response unchanged; adding a tool needs no Gateway code changes.

**Non-Goals:** the Runtime (infra-1); per-user auth; VPC networking (the Lambda calls the public sandbox URL).

### Decisions

**1. One Lambda for all tools.**
`agent/lambda/handler.mjs` imports `agent/src/tools/index.mjs`, builds executors with the data-access helper from its environment, reads the tool name and arguments from the Gateway event, and returns `{summary, plot}` as JSON. **Verify** in the current AgentCore Gateway docs how a Lambda target receives the tool name and arguments, and the response size limit (a survival `plot` is about 150 KB).

**2. Schemas exported from specs.**
`scripts/export_tool_schemas.mjs` writes the Gateway target's tool schema JSON from the registered specs, leaving out `cohortFilter`. Terraform or `deploy_tools.py` reads that file.

**3. Hidden cohort argument.**
The Lambda accepts an optional `cohortFilter` argument. The agent's Gateway client always sends it from the request context; it is not in the schema the model sees.

**4. Agent-side client.**
`agent/src/gateway-client.mjs` connects to `AGENTCORE_GATEWAY_URL` over MCP and calls tools by name. The runner gives each tool's wrapper an executor that calls the client instead of the in-process executor, so `toolCalls` and the model's view are unchanged. **Verify** MCP client support in the Strands TypeScript SDK; otherwise use the MCP TypeScript SDK client directly. **Verify** Gateway's inbound auth options and pick the simplest that works from Runtime.

**5. Deployment.**
`terraform/agentcore-gateway.tf`, gated by `enable_agentcore`: the Lambda (Node 22, not attached to the VPC), its role, the Gateway, the Lambda target, the Gateway's role to invoke the Lambda, and output `agentcore_gateway_url`. **Verify** provider support for Gateway resources; if missing, `deploy_tools.py` creates them with the AWS CLI or SDK. `deploy_tools.py` zips `agent/` (sources and production dependencies), updates the Lambda code, and sets `VIRTUAL_LAB_ORIGIN`, `SANDBOX_ACCESS_USERNAME` and `SANDBOX_ACCESS_PASSWORD` with `aws lambda update-function-configuration`, so the password stays out of Terraform state.

### Risks / Trade-offs

- [Gateway response limit below the plot size] → Return the plot by reference (store it and send an id), or trim donor fields.
- [Large Lambda package (Strands SDK)] → Zip only what the executors import; the handler does not need the SDK.
- [Data calls through the public URL] → Accepted hackathon shortcut.

### Open Questions

- Gateway inbound auth from Runtime (IAM or OAuth).
- Owner (Dev 2).
