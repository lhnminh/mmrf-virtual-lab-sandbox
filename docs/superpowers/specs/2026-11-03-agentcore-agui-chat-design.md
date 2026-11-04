# AgentCore AG-UI chat, health check slice: design

Date: 2026-11-03
Status: awaiting review. Nothing here has been built or deployed.
Extends: [`2026-11-03-agentcore-poc-design.md`](2026-11-03-agentcore-poc-design.md).
That spec still applies except where this one differs.

## Goal

Ask a question in the Chat page on a local `next dev` server and watch the answer
stream from an agent on AgentCore Runtime, using AG-UI from end to end. The agent
answers from one Python tool, `check_virtual_lab_health`, called through AgentCore
Gateway.

## Decisions

| Decision | Choice | Source |
| --- | --- | --- |
| Streaming | Required | User |
| Protocol to the browser | AG-UI, required | User |
| Agent | Python, Strands, `ag-ui-strands` | Follows from AG-UI |
| Tool language | All tools in Python, now and later | User |
| First tool | `check_virtual_lab_health` | User |
| Browser access | Local dev route with SigV4; no Cognito | Recommendation |
| Conversation history | Browser resends it; no AgentCore Memory | Recommendation |
| Runtime to Gateway auth | IAM | Recommendation; documented, not yet run |

## Success criteria

All of these must be seen on the deployed agent, through `next dev`:

1. "Is the Virtual Lab healthy?" in Chat returns an answer with the live `cases`
   value from `GET /sandbox/status`, which should be 1000.
2. A tool row for the health check appears before the answer finishes.
3. Answer text arrives in several separate chunks. Timestamps at the dev route show
   them spread over time, not delivered together.
4. A follow-up question in the same thread uses the earlier conversation.
5. A tool failure, such as a wrong password, is reported in Chat as a failure.
6. No AWS credentials or Virtual Lab login reach the browser.
7. `terraform destroy` removes everything this work created and the live Virtual
   Lab keeps running.

## Out of scope

- Deployed Chat: CloudFront, the Lambda proxy, the `/agent/*` route and the CloudFront
  Function
- Cognito, AgentCore Memory, VPC networking and Neptune
- `correlation_plot`, charts and the selected cohort filter; see "Next tool"
- Changes to the team's Node agent in `agent/`, or to the live Virtual Lab

## Architecture

```text
assistant-ui with useAgUiRuntime and HttpAgent (next dev :3000)
  | POST RunAgentInput, SSE response
  v
Dev-only API route: signs with the local AWS profile, passes the stream through
  | InvokeAgentRuntime, SigV4
  v
Python agent on Runtime, protocol AGUI ---> Bedrock
  | MCP over HTTPS, SigV4
  v
Gateway, AWS_IAM inbound auth
  | lambda:InvokeFunction, Gateway service role
  v
Lambda, Python, outside the VPC ---> Secrets Manager (team login)
  | HTTPS, Basic auth
  v
CloudFront ---> internal ALB ---> access pod ---> identity pod: GET /sandbox/status
```

## Where the code lives

| Repo and branch | Folder | Contents |
| --- | --- | --- |
| Sandbox, `feature/agentcore-poc` | `agentcore-poc/` | Agent, Lambda, Terraform, scripts |
| `mmrf-data-commons`, new `feature/agui-chat` from `chat-core-tool` | `src/features/chat/`, `src/pages/api/` | AG-UI runtime and dev route |

`chat-core-tool` stays as it is, so the Compose agent and its chart rendering keep
working there.

## Terraform

The file layout, own root, local state, variables, IAM roles and teardown settings
come from the POC spec. Its Runtime gains one setting:

```hcl
protocol_configuration {
  server_protocol = "AGUI"
}
```

Runtime has no `authorizer_configuration`, so callers use IAM. Its default port 8080
and path `/invocations` are used, because the provider docs for 6.69.1 list no port
or path argument.

`terraform/` at the repo root is not touched. Its live state is in a different
checkout.

## Agent (`agentcore-poc/agent/main.py`)

Keeps from the AG-UI spike (`worstream-2-agent-orchestration/spikes/agui-compat`,
currently in `~/.Trash`):

- `BedrockAgentCoreApp` with an async generator entry point, dumping each event with
  `model_dump(mode="json", by_alias=True, exclude_none=True)`
- One `StrandsAgent` adapter per process
- `aclose()` on the run stream in a `finally` block
- `RUN_ERROR` with `INVALID_RUN_INPUT` when the body isn't a valid `RunAgentInput`
- `RunAgentInput.tools` cleared, since this slice has no browser tools

Differs from the spike:

- A Bedrock model, set by `MODEL_ID`, with `max_tokens` set explicitly
- `MCPClient` using `aws_iam_streamablehttp_client` from `mcp-proxy-for-aws`, set by
  `GATEWAY_URL`, so a new tool needs no agent change
- No session manager and no thread ownership check, because there is no Memory and
  only one IAM caller. `replay_history_into_strands` stays at its default, so the
  browser's messages supply history
- `RUN_ERROR` messages hold a fixed short reason, with the detail in logs

The system prompt says to answer only from tool results, report a failed tool as a
failure, say the data is synthetic, and say which things it can't do yet.

Versions are pinned exactly in the lockfile, starting from the spike's:
`ag-ui-strands` 1.0.2, `ag-ui-protocol` 1.0.0, `strands-agents` 1.63.0 and
`bedrock-agentcore` 1.25.2. `scripts/build_agent.sh` builds an ARM64 zip, as in the
POC spec.

## Tool (`agentcore-poc/lambda/`)

As in the POC spec: one Python Lambda, `handler.py`, with a `TOOLS` routing table and
schemas in `tools.json`. Success and failure results and error codes are unchanged.
A later tool adds a Python function, a table entry and a schema.

The team's JavaScript tool code is a reference for later ports. It isn't called from
this agent.

## Frontend (`mmrf-data-commons`)

Add `@assistant-ui/react-ag-ui` and `@ag-ui/client`, with exact versions.

| File | Change |
| --- | --- |
| `ChatRuntimeProvider.tsx` | Replace `useLocalRuntime` and the adapter with `useAgUiRuntime` and an `HttpAgent` pointed at the dev route. Remove the cohort lookup for this slice |
| `src/pages/api/agent/agui.ts` | New dev route |
| `agentAdapter.ts`, `agentResponse.ts` and their tests | Remove on this branch |
| `ChatThread.tsx` | Keep `Fallback` for tool rows. Remove the `correlation_plot` display on this branch |
| `suggestedPrompts.ts` | Suggest the health question only |

Before writing Next code, read the relevant guide in `node_modules/next/dist/docs/`,
as `AGENTS.md` requires.

### Dev route

- Returns 404 unless `NODE_ENV` is `development`.
- Reads `AGENTCORE_RUNTIME_ARN` and the AWS profile from `.env.development.local`,
  which is git-ignored. Neither uses a `NEXT_PUBLIC_` name.
- Calls `InvokeAgentRuntime` with the body unchanged. `runtimeSessionId` is the
  SHA-256 hex of `threadId`, so one thread stays on one session and the ID is long
  enough.
- Writes each chunk to the response as it arrives, with no buffering, and stops the
  upstream call when the browser disconnects.
- Never returns AWS error text to the browser. It logs the detail and returns 502.

## Error handling

| Situation | Result in Chat |
| --- | --- |
| Tool failure, such as `auth_failed` or `unreachable` | The agent reports the failure in its answer |
| Agent or Bedrock failure during a run | `RUN_ERROR` shown as a failure |
| Invalid request body | `RUN_ERROR` with `INVALID_RUN_INPUT` |
| `SESSION_BUSY` or a run already active on the thread | Shown as a failure; the user can resend. No automatic retry in this slice |
| Expired AWS credentials or missing ARN | Route returns 502, and its log says what to fix |
| Browser disconnects | Upstream call stops and `aclose()` runs |

## Testing

**Unit:**

- Lambda: as in the POC spec.
- Agent: an invalid body gives `RUN_ERROR`; client tools are cleared; `aclose()` runs
  after a disconnect. These use a fake adapter.
- Dev route, in Jest: 404 outside development; a stable session ID per thread; chunks
  pass through unchanged; no error detail reaches the response.
- Terraform: `fmt -check`, `validate` and a mock-provider test asserting `AGUI`,
  `AWS_IAM` and tool names matching `tools.json`. A real `plan` must show only new
  resources.

**Live, one layer at a time, so a failure identifies its layer:**

1. Lambda directly: `ok: true` and `cases: 1000`.
2. Gateway `tools/list` and `tools/call` with SigV4: the tool is listed and returns the
   same result. Record the real tool name.
3. `scripts/invoke.py` sends a `RunAgentInput` to Runtime and prints each event with
   its arrival time. Save this as a sample stream.
4. The official `@ag-ui/client` reads the same stream from a script, without custom
   parsing.
5. Chat in a browser against the dev route: success criteria 1 to 5, including a
   check of the browser's network traffic for criterion 6.
6. Teardown: criterion 7.

## Risks to prove first

None of these has been run against deployed resources.

| Risk | Known so far | If it fails |
| --- | --- | --- |
| The workshop role can create these resources | IAM simulation allowed the main actions | Report it, and try the smallest resource that fails |
| `AGUI` with a zip deployment on Runtime | Provider accepts `AGUI`; no zip example found | Package as a container, or use `HTTP` and lose `RUN_ERROR` for platform errors |
| The Haiku model can be invoked | Listed, not invoked | Change `MODEL_ID` |
| `ag-ui-strands` works with the SigV4 MCP client | Spike used an unsigned local MCP server | Open the MCP client per run, as the POC spec does |
| Client replay of history with the adapter | Spike ran with replay off | Attach a session manager, or add Memory |
| `@assistant-ui/react-ag-ui` 0.1.1 works with `@assistant-ui/react` 0.15.32, Next 16 and React 19 | Only `@ag-ui/client` was tested | Stop and report. AG-UI is required, so this needs a decision rather than a quiet fallback |
| Text arrives incrementally through Runtime and the route | Passed locally, without Runtime | Find the buffering layer using live checks 3 to 5 |
| `/sandbox/status` returns the expected fields with a login | Read from source; only the 401 seen live | Adjust the tool |

## Operations

- These resources bill until destroyed. Cost hasn't been calculated, and it counts
  against the $500 cap. Destroy them when they're no longer needed.
- The login comes from `access.json`, passed explicitly to `set_access_secret.py`. The
  file is currently at `~/.Trash/mmrf-virtual-lab-sandbox/generated/aws/access.json`,
  next to the live stack's Terraform state. Both must survive until teardown.
- Workshop credentials are temporary, so a long session may need them refreshed.
- All data is synthetic.

## Team impact

This replaces the Node agent assumed by the team's `infra-1` and `infra-2` plans, and
AG-UI makes streaming a goal where `infra-1` lists it as a non-goal. The team should
agree this before those plans start. Until then, the work stays on its own branches
and changes nothing they depend on.

## Next tool

`correlation_plot` is the likely next tool, ported to Python. It reintroduces three
problems this slice avoids, and each needs its own design:

1. **Chart data:** one result is about 153 KB with a case ID on every row, and through
   Gateway the whole result reaches the model. The proposal is for the tool to return
   a summary and the chart's request, and for the frontend to re-run that request.
2. **Two data sources:** the summary would come from CloudFront and the chart from the
   local stack. Their counts may differ: 334 and 666 in an earlier live call, 339 and
   661 in the team's current docs.
3. **Cohort filter:** it must reach the tool without the model being able to change it.
   Sending it in `RunAgentInput.context` and adding it in an agent hook is the proposal.
   Whether Gateway accepts an argument missing from the tool's schema is unconfirmed.

## Evidence

| Claim | Source |
| --- | --- |
| Provider accepts `AGUI`; no port or path argument | Provider docs at v6.69.1. The POC spec pins `~> 6.71`, so `validate` must confirm it |
| `AWS_IAM` needs no authorizer block; `gateway_iam_role {}` on Lambda targets | Provider docs at v6.69.1 |
| IAM inbound auth and `bedrock-agentcore:InvokeGateway` | AWS guide, Gateway inbound authorization |
| Default port and path for `AGUI` | AWS guide, Runtime serving port and invocation path |
| 6 MB tool payload limit | AWS guide, AgentCore quotas |
| `useAgUiRuntime` with `HttpAgent` | `@assistant-ui/react-ag-ui` 0.1.1 README |
| Local AG-UI compatibility, 19 of 19 checks, scripted model and local MCP server | AG-UI spike, 2026-11-03 |
| No AgentCore resources or agent ECR repository in `us-west-2` | Read-only AWS calls, 2026-11-03 |
