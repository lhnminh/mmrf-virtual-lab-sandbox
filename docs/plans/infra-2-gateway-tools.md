# Plan: infra-2, tools on AgentCore Gateway

Owner: Dev 2 (Gateway and new tool implementations) · Branch: `infra-2-gateway-tools` · Team context: [CLAUDE.md](../../CLAUDE.md) · Architecture: [agent-architecture.md](../agent-architecture.md)

Tick the boxes as you go; this file is the chunk's status.

## Why

The architecture puts the Virtual Lab tools behind Amazon Bedrock AgentCore
Gateway, so the AgentCore-hosted agent calls them over MCP and future tools
plug in the same way. Today tools run only inside the agent process. This
chunk serves the existing tool code from a Lambda behind Gateway and teaches
the agent to call it. Dispatch and schema export must work for every registered
tool; `correlation_plot` is the first deployed example. See
[CLAUDE.md](../../CLAUDE.md) for how it fits with infra-1
(agent on Runtime) and infra-3 (foundation).

## What changes

- **G1 Lambda handler, locally:** `agent/lambda/handler.mjs` runs any registered tool's executor from a Gateway event, using the shared tool folders and data-access helper.
- **G2 Gateway client in the agent:** when `AGENTCORE_GATEWAY_URL` is set, the agent's tools call Gateway instead of running in-process. The client adds the website cohort as a hidden argument and splits each result into `summary` (for the model) and `plot` (for the UI), so `/v1/prompts` is unchanged.
- **G3 Gateway deployed:** the Lambda (outside the VPC), the Gateway, a Lambda target whose tool schemas are exported from the tool specs, and IAM permissions, in `terraform/agentcore-gateway.tf` and `scripts/deploy_tools.py`. Output: `agentcore_gateway_url`.
- **G4 Joined with Runtime:** infra-1 passes the Gateway URL to the Runtime.
- **G5 Tool expansion:** Dev 2 adds the tool implementations needed for journeys 2 and 3 through the shared registry, after the journey 1 Gateway path works. Additional tools can follow a prioritized backlog.


## Files touched

- New: `agent/lambda/`, `agent/src/gateway-client.mjs`, a schema export script, tests.
- `terraform/agentcore-gateway.tf`, `scripts/deploy_tools.py`.
- The agent's runner uses the Gateway client when `AGENTCORE_GATEWAY_URL` is set (one switch point agreed with infra-3).
- For G5: new `agent/src/tools/<tool>/` folders and their tests. Cohort actions and chart components in the frontend fork need coordination with infra-3's frontend owner.
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

### Before F1 merges: tool readiness

Tool inputs, outputs, UI actions, failures, and the future tool backlog are in [the tool design note](../infra-2-tool-design.md).

- [x] Confirm the Gateway Lambda event, tool naming, JSON response requirement and published payload limit in the AWS docs (decision 1).
- [x] Inspect the installed Strands SDK for MCP support and choose IAM as the intended Gateway inbound authorization (decision 4). The SigV4 transport remains to be verified.
- [x] Map the journey 2 and 3 tool inputs, API calls, results and UI actions in a separate tool design note. Journey 2 uses the existing frontend's saved-cohort state and ProteinPaint's `/termdb/topMutatedGenes`. Journey 3 uses Gen3 case queries, saved cohorts in the frontend, and ProteinPaint's `/termdb/DE`. See [journeys](../journeys.md), [developer API](../developer-api.md), and [verification](../verification.md).
- [ ] Tell the team Dev 2 owns the new tool implementations and agree on the frontend handoff. G1–G4 provide the shared Gateway path; G5 adds the tools.

### G1. Lambda handler, locally (stopping point: handler answers a recorded event)

- [x] 1.1 Check the AgentCore Gateway docs for the Lambda target event format, the response format and size limits; findings are recorded in design note 1 below. Confirm the actual response and plot size with a deployed call in G3.
- [x] 1.2 Add `agent/lambda/handler.mjs` running registered tools from a Gateway event; verify a test with a recorded event returns the journey 1 summary and plot, a second test registration dispatches without handler changes, and an unknown tool returns an error.
- [x] 1.3 Add `scripts/export_tool_schemas.mjs`; verify its output lists `correlation_plot`, adds the optional transport-only `cohortFilterJson` to the Gateway schema, and picks up a second test registration without exporter changes.

### G2. Gateway client in the agent (stopping point: same response through a fake Gateway)

- [x] 2.1 Check MCP client support in the Strands TypeScript SDK and Gateway's inbound auth options; verify the choice is recorded in the design note, decision 4.
- [x] 2.2 Add `agent/src/gateway-client.mjs` and switch tools to it when `AGENTCORE_GATEWAY_URL` is set; verify a test against a fake MCP server gives the same `/v1/prompts` response as in-process, with the cohort sent and only `summary` reaching the model.

### G3. Gateway deployed (stopping point: a script calls the deployed tool)

`terraform validate` passes. A plan and deployment still require the sandbox AWS account configuration and credentials. `scripts/verify_gateway.mjs` is the post-deploy probe.

- [ ] 3.1 Add the Lambda, Gateway, target, roles and `agentcore_gateway_url` output to `terraform/agentcore-gateway.tf`, gated by `enable_agentcore`; verify `terraform validate` and `terraform plan`.
- [ ] 3.2 Fill in `scripts/deploy_tools.py`: zip, update code, set the Lambda's settings from the Terraform output and `access.json`; verify `aws_sandbox.py deploy` creates and then updates them.
- [ ] 3.3 Call the deployed Gateway's `correlation_plot` from a script; verify the journey 1 summary and plot with 339 and 661 cases.

### G4. Joined with Runtime (with infra-1)

- [ ] 4.1 With infra-1, confirm the Runtime picks up `agentcore_gateway_url`; verify the journey 1 question in Chat on the AWS URL is served through Gateway (Lambda logs show the call).

### G5. More tools (after the journey 1 Gateway path works)

The two new executors pass local tests. Their expected synthetic counts and frontend actions still need live checks against the sandbox and deployed Gateway.

- [x] 5.1 Write specs for the journey 2 and 3 tools: model-facing inputs, hidden cohort context, exact API calls, `{summary, plot}` outputs, frontend actions and failure cases. Keep the specs in the shared registry format from F1.
- [ ] 5.2 Implement the journey 2 tool logic for demographic cohort selection and top mutated genes. Verify the synthetic Black or African American cohort has 334 cases and the top three genes are KRAS 148, NRAS 113 and DIS3 100; confirm the frontend can save/select the cohort and render the result.
- [ ] 5.3 Implement the journey 3 tool logic for KRAS mutation cohorts and differential expression. Verify the case lists are disjoint and mutation tested, the analysis returns ten ranked genes with group sizes and significance measures, and the frontend can save/select the cohorts and display the visualization.
- [ ] 5.4 Run each new tool locally and through the deployed Gateway. Confirm adding each tool requires only its registry entry and schema update, with no new Gateway dispatch or client branch.
- [x] 5.5 Maintain a prioritized list of further tools after journeys 2 and 3. Define a success check for each before implementation.

## Design notes

### Context

See [CLAUDE.md](../../CLAUDE.md) and `docs/agent-architecture.md`.

- After infra-3 F1: each tool lives in `agent/src/tools/<tool>/` and exports its spec, an executor factory and prompt guidance; `agent/src/tools/index.mjs` lists them; executors take a data-access helper (`virtual-lab-fetch.mjs`) configured by `VIRTUAL_LAB_ORIGIN` and the team login.
- Each tool call is wrapped by the agent (today `createCorrelationTool`): it validates input, records the call in `toolCalls`, and returns only `summary` to the model.
- The sandbox URL is the Terraform output `https_url`; the team login is in `generated/aws/access.json`, created by `aws_sandbox.py`.

### Goals / Non-Goals

**Goals:** existing tools served from Gateway with the response unchanged; adding a registered tool needs no Gateway dispatch or client code changes. Dev 2 also implements the journey 2 and 3 tool logic after the shared F1 interface and journey 1 Gateway path work. Keep tool additions in separate small changes so the infrastructure milestone can be reviewed independently.

**Non-Goals:** the Runtime (infra-1); per-user auth; VPC networking (the Lambda calls the public sandbox URL).

### Decisions

**1. One Lambda for all tools.**
`agent/lambda/handler.mjs` imports `agent/src/tools/index.mjs`, builds executors with the data-access helper from its environment, and returns `{summary, plot}` as JSON. AWS documents the Lambda `event` as the arguments object and the tool name in `context.clientContext.custom.bedrockAgentCoreToolName`, prefixed as `<target>___<tool>`. The handler strips that prefix and rejects unknown names. AWS requires a JSON-parseable Lambda response. Gateway's maximum tool-call payload is 6 MB; the Lambda synchronous invoke limit also applies. A roughly 150 KB survival plot appears to fit, but verify the serialized response at G3. Sources: [Lambda target format](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-lambda.html), [Gateway quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html).

**2. Schemas exported from specs.**
`scripts/export_tool_schemas.mjs` writes the Gateway target's tool schema JSON from every registered spec. The model-facing spec omits `cohortFilter`; the Gateway schema adds it as an optional transport field, because Gateway validates call arguments against its input schema. Terraform or `deploy_tools.py` reads the exported file. Verify that Gateway accepts the injected field during G3. Source: [Gateway tool calls and validation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-call.html).

**3. Hidden cohort argument.**
The Lambda accepts an optional `cohortFilterJson` argument containing serialized JSON. The agent's Gateway client sends it from the request context; it is not in the schema the model sees. The wrapper keeps model input and transport arguments separate so `toolCalls.input` retains the existing API shape.

**4. Agent-side client.**
`agent/src/gateway-client.mjs` connects to `AGENTCORE_GATEWAY_URL` over MCP and calls tools by name. The runner gives each tool's wrapper an executor that calls the client instead of the in-process executor, so `toolCalls` and the model's view are unchanged. The agent uses the MCP SDK Streamable HTTP client with a SigV4-signed fetch for IAM inbound authorization. Runtime still needs `bedrock-agentcore:InvokeGateway` on its execution role. Source: [Gateway inbound authorization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-inbound-auth.html).

**5. Deployment.**
`terraform/agentcore-gateway.tf`, gated by `enable_agentcore`: the Lambda (Node 22, not attached to the VPC), its role, the Gateway, the Lambda target, the Gateway's role to invoke the Lambda, and output `agentcore_gateway_url`. The repo locks AWS provider 6.69.1, and the provider documents Gateway and Gateway target resources; validate the exact resource fields against that installed version before writing Terraform. `deploy_tools.py` zips the handler's sources and only the production dependencies it imports, updates the Lambda code, and sets `VIRTUAL_LAB_ORIGIN`, `SANDBOX_ACCESS_USERNAME` and `SANDBOX_ACCESS_PASSWORD` with `aws lambda update-function-configuration`, so the password stays out of Terraform state. Source: [AWS provider Gateway target](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway_target).

### Risks / Trade-offs

- [Gateway or Lambda response limit below the serialized plot size] → Return the plot by reference (store it and send an id), or trim donor fields.
- [Gateway rejects the injected cohort field] → Test an actual `tools/call` before integrating Runtime; revise the schema or transport if validation differs from the documented behavior.
- [Large Lambda package (Strands SDK)] → Zip only what the executors import; the handler does not need the SDK.
- [Data calls through the public URL] → Accepted hackathon shortcut.

### Open Questions

- Frontend owner and handoff for saving/selecting cohorts and rendering the new tool results.
- Which additional tools should follow journeys 2 and 3?
- Owner (Dev 2).
