# AgentCore AG-UI Chat, Health Check Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream an answer into Chat on local `next dev` from a Python agent on AgentCore Runtime over AG-UI, using one Python tool behind AgentCore Gateway.

**Architecture:** assistant-ui's AG-UI runtime posts to a dev-only Next API route, which signs with the local AWS profile and passes the SSE stream through from Runtime. A Strands agent wrapped by `ag-ui-strands` calls Gateway over SigV4 MCP, and Gateway invokes a Python Lambda that reads `/sandbox/status` through CloudFront.

**Tech Stack:** Python 3.13, `ag-ui-strands`, `strands-agents`, `bedrock-agentcore`, `mcp-proxy-for-aws`, uv, Terraform with `hashicorp/aws ~> 6.71`, Next 16 Pages Router, React 19, `@assistant-ui/react` 0.15.32, `@assistant-ui/react-ag-ui` 0.1.1, `@ag-ui/client`, `@aws-sdk/client-bedrock-agentcore`.

**Spec:** `docs/superpowers/specs/2026-11-03-agentcore-agui-chat-design.md`, which extends `docs/superpowers/specs/2026-11-03-agentcore-poc-design.md`. Read both. The newer spec wins where they differ.

## Global Constraints

- Account `<account-id>`, region `us-west-2`, AWS profile `workshop`.
- Sandbox work: worktree `theMMRF/mmrf-virtual-lab-sandbox-agentcore-poc`, branch `feature/agentcore-poc`, folder `agentcore-poc/`.
- Frontend work: new branch `feature/agui-chat` from `chat-core-tool`, in a new worktree `theMMRF/mmrf-data-commons-agui`. Don't change `chat-core-tool`.
- Run `nvm use` in the frontend first: it requires Node 24.18.1, and the shell default is 25.8.2.
- Pin new packages exactly. Don't touch `agent/`, root `terraform/`, or the live Virtual Lab.
- All tools are Python.
- No Cognito, Memory, VPC, CloudFront route, cohort filter or charts in this slice.
- Never print, log or return the Virtual Lab password or AWS error text to the browser.
- Don't `git add` the frontend's untracked `AGENTS.md` and `CLAUDE.md`. Commit locally only; nothing is pushed.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **`terraform apply`, `terraform destroy` and writing the secret need the user's go-ahead at that step.** They create or remove billed resources.
- **If `@assistant-ui/react-ag-ui` can't work with this stack, stop and report.** AG-UI is required, so don't fall back quietly.

## Review Focus

1. **Another machine reaches the dev route.** `next dev` can listen beyond loopback, and anyone on the event network could spend the developer's AWS credentials. Expect 403 for a non-loopback caller. Pinned in Task 2.
2. **Runtime fails after streaming has begun.** Status 502 is no longer possible, so Chat would hang or stop silently. Expect a final `RUN_ERROR` SSE event, then the response ends. Pinned in Task 2.
3. **The browser disconnects mid-answer.** Expect the upstream call to be aborted and the adapter stream closed, not left running. Pinned in Tasks 2 and 4.
4. **The secret was never filled.** `terraform apply` creates it empty, so running the deploy steps out of order is likely. Expect `config_error`, not a crash. Pinned in Task 3.
5. **A malformed body reaches the route.** Without a usable `threadId` no stable session can be derived. Expect 400 with no AWS call. Pinned in Task 2.

---

### Task 1: AG-UI runtime in Chat (compatibility gate)

This runs first because it's the risk that can stop the whole design, and it needs no AWS.

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `src/features/chat/ChatRuntimeProvider.tsx`, `src/features/chat/ChatThread.tsx`, `src/features/chat/suggestedPrompts.ts`, `src/features/chat/tools/ToolCallRow.tsx`
- Delete: `src/features/chat/agentAdapter.ts`, `agentAdapter.unit.test.ts`, `agentResponse.ts`, `agentResponse.unit.test.ts`, `tools/CorrelationPlotTool.tsx`, `tools/survivalPlotData.ts`, `tools/survivalPlotData.unit.test.ts`
- Keep unchanged and unused: `src/features/chat/selectedCohortFilter.ts` and its test, for the next tool
- Test: `src/features/chat/ChatRuntimeProvider.unit.test.tsx`, `src/features/chat/tools/ToolCallRow.unit.test.tsx`

**Interfaces:**
- Produces: the browser posts AG-UI `RunAgentInput` to `AGENT_ROUTE = '/api/agent/agui'`, exported from `src/features/chat/ChatRuntimeProvider.tsx`, and expects an SSE response.
- Produces: `displayToolName(toolName: string): string` in `tools/ToolCallRow.tsx`.

- [ ] **Step 1: Create the branch and worktree, then install**

Use superpowers:using-git-worktrees. From `theMMRF/mmrf-data-commons`: `git worktree add ../mmrf-data-commons-agui -b feature/agui-chat chat-core-tool`. Then `nvm use && npm install`, and add `@assistant-ui/react-ag-ui@0.1.1` and `@ag-ui/client@1.0.3` with `--save-exact`.

Expected: install completes. Report any peer conflict with `@assistant-ui/react` 0.15.32 before forcing anything.

- [ ] **Step 2: Write the failing tests**

`ChatRuntimeProvider.unit.test.tsx` renders the provider around `ChatThread`, mocks `fetch` to return a streamed SSE body, sends a message, and asserts:

```ts
expect(fetchMock.mock.calls[0][0]).toBe('/api/agent/agui');
expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages.at(-1).role).toBe('user');
await screen.findByText(/1000 synthetic cases/);          // text deltas joined
expect(screen.getByText('check_virtual_lab_health')).toBeTruthy(); // tool row, prefix removed
```

The SSE body is `RUN_STARTED`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT` twice, `TEXT_MESSAGE_END`, `TOOL_CALL_START` with `toolCallName: 'virtual-lab___check_virtual_lab_health'`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`, `RUN_FINISHED`. Add a second test where the stream carries `RUN_ERROR`: a failure is visible and the composer can send again.

`ToolCallRow.unit.test.tsx`:

```ts
expect(displayToolName('virtual-lab___check_virtual_lab_health')).toBe('check_virtual_lab_health');
expect(displayToolName('plain_name')).toBe('plain_name');
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/chat/ChatRuntimeProvider.unit.test.tsx src/features/chat/tools/ToolCallRow.unit.test.tsx`
Expected: FAIL because `displayToolName` and the new route don't exist.

- [ ] **Step 4: Implement**

- `ChatRuntimeProvider`: `useAgUiRuntime({ agent })` with `useMemo(() => new HttpAgent({ url: AGENT_ROUTE }), [])`. Remove the cohort selector.
- `ChatThread`: set `TOOL_DISPLAYS` to `{ Fallback: ToolCallFallback }`. Use this copy, because the old text promises cohort comparisons:
    - Empty state: `Check whether the Virtual Lab is healthy. This early version of Chat can't run analyses yet.`
    - Input placeholder and `aria-label`: `Ask about the Virtual Lab`
    - Remove the "Comparisons use the cohort selected above." line.
- `suggestedPrompts`: `['Is the Virtual Lab healthy?']`.
- `ToolCallFallback`: show `displayToolName(toolName)` as the title. The function removes everything up to and including the first `___`.
- Surface `RUN_ERROR` visibly, using the runtime's error state. If the runtime gives no way to do that, record it for the user.
- Delete the listed files.

- [ ] **Step 5: Run the tests and verify they pass**

Run the Step 3 command, then `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/chat`.
Expected: PASS. **If the AG-UI runtime can't pass these tests, stop and report (Global Constraints).**

- [ ] **Step 6: Prove it builds on Next 16**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm run build`
Expected: no errors from Chat files. Report unrelated existing failures rather than fixing them.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/features/chat
git commit -m "feat(chat): connect Chat through the AG-UI runtime"
```

---

### Task 2: Dev-only agent route

**Files:**
- Create: `src/lib/agentRuntime/proxy.ts`, tested beside it. Test files can't sit under `src/pages`, because Next would treat them as routes.
- Create: `src/lib/agentRuntime/proxy.unit.test.ts`, with `@jest-environment node`
- Create: `src/pages/api/agent/agui.ts`
- Modify: `package.json`, `package-lock.json`, adding `@aws-sdk/client-bedrock-agentcore` at the exact latest version (3.1161.0 when checked)

**Interfaces:**
- Consumes: `AGENT_ROUTE` from Task 1, and env `AGENTCORE_RUNTIME_ARN` and `AWS_PROFILE` from `.env.development.local`.
- Produces in `proxy.ts`:

```ts
export function runtimeSessionId(threadId: string): string; // SHA-256 hex
export function regionFromRuntimeArn(arn: string): string;  // fourth ARN field
export interface InvokeArgs { agentRuntimeArn: string; runtimeSessionId: string; payload: string; abortSignal: AbortSignal }
export interface ProxyDeps {
  nodeEnv: string | undefined;
  runtimeArn: string | undefined;
  invoke(args: InvokeArgs): Promise<AsyncIterable<Uint8Array>>;
  log(message: string, error?: unknown): void;
}
export function createAgentProxyHandler(deps: ProxyDeps): NextApiHandler;
```

- [ ] **Step 1: Read the Next guide**

Read `node_modules/next/dist/docs/02-pages/03-building-your-application/01-routing/07-api-routes.md` and copy the pattern `src/pages/api/protein-paint/[...path].ts` uses: `export const config = { api: { bodyParser: false, responseLimit: false } }`.

- [ ] **Step 2: Write the failing tests in `proxy.unit.test.ts`**

| Test | Assertion |
| --- | --- |
| `returns 404 outside development` | `nodeEnv: 'production'` gives 404, `invoke` not called |
| `rejects a non-loopback caller` | `socket.remoteAddress = '192.168.1.20'` gives 403, `invoke` not called |
| `accepts each loopback form` | `127.0.0.1`, `::1` and `::ffff:127.0.0.1` all invoke |
| `rejects other methods and media types` | GET gives 405; `text/plain` gives 415, which blocks simple cross-site POSTs |
| `rejects a body with no usable threadId` | invalid JSON, a missing `threadId` and a non-string `threadId` each give 400 with no `invoke` |
| `explains a missing ARN` | 502, `invoke` not called, `log` mentions `AGENTCORE_RUNTIME_ARN` |
| `keeps one session per thread` | `runtimeSessionId('t')` is the same on repeat, differs for `'u'`, and matches `/^[0-9a-f]{64}$/` |
| `passes the body and chunks through unchanged` | `invoke` gets the exact body string; response bytes equal the chunks, in order |
| `flushes each chunk` | `res.flush` is called once per chunk when present |
| `sets streaming headers` | `content-type: text/event-stream` and `cache-control: no-cache, no-transform` |
| `hides errors before the stream starts` | a rejected `invoke` with `'secret detail'` gives 502, the body lacks it, `log` receives it |
| `reports a failure after the stream starts` | a chunk, then a throw: the output ends with `data: {"type":"RUN_ERROR","code":"STREAM_INTERRUPTED","message":"The agent stream was interrupted."}\n\n`, the response ends, and the detail is absent |
| `aborts upstream on disconnect` | emitting `close` on `res` aborts the signal, and no later write happens |

- [ ] **Step 3: Run the tests and verify they fail**

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/lib/agentRuntime/proxy.unit.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 4: Implement `proxy.ts` and the route**

`agui.ts` exports the config above and `createAgentProxyHandler` with real deps. `invoke` sends `InvokeAgentRuntimeCommand` with `contentType: 'application/json'` and `accept: 'text/event-stream'`, passing `abortSignal` to `client.send`, and returns `result.response`. Build `BedrockAgentCoreClient` with `regionFromRuntimeArn`; credentials come from the default chain, which reads `AWS_PROFILE`.

- [ ] **Step 5: Run the tests and verify they pass**

Run the Step 3 command.
Expected: PASS.

- [ ] **Step 6: Check the missing-ARN failure on a running server**

Run `npm run dev -- -H 127.0.0.1` with no ARN set, then `curl -si -X POST localhost:3000/api/agent/agui -H 'content-type: application/json' -d '{"threadId":"t"}'`.
Expected: 502 with a generic body, and a log line naming `AGENTCORE_RUNTIME_ARN`. If `src/middleware-impl.ts` intercepts the route, allow this path in development only.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lib/agentRuntime src/pages/api/agent
git commit -m "feat(chat): add dev-only route to the deployed agent"
```

---

### Task 3: Python health tool

Before this task's commit, also `git add` the two approved docs: the design spec and this plan.

**Files:**
- Create: `agentcore-poc/lambda/handler.py`, `agentcore-poc/lambda/tools.json`
- Test: `agentcore-poc/tests/test_handler.py`

**Interfaces:**
- Produces: `handler(event: dict, context) -> dict`; `TOOLS: dict[str, Callable]`; `check_virtual_lab_health(args: dict, *, fetch_status=..., read_login=...) -> dict`.
- Produces: `tools.json`, a JSON array of `{"name", "description", "properties": []}`, consumed by Task 5. Each property is `{"name", "type", "description", "required"}`.
- Result shapes and error codes are exactly those in the POC spec's "First tool" and "Error handling" sections.
- Environment: `SANDBOX_ORIGIN`, `ACCESS_SECRET_ARN`.

- [ ] **Step 1: Write the failing tests** using `unittest`, importing through `sys.path` because `lambda` is a reserved word:

| Test | Assertion |
| --- | --- |
| `test_routes_after_removing_prefix` | client context tool `virtual-lab___check_virtual_lab_health` runs that function |
| `test_unknown_tool` | `{"ok": False, "error": "unknown_tool", ...}` |
| `test_healthy` | `ok`, `status == "OK"`, `synthetic`, `cases == 1000`, an integer `latency_ms`, `summary == "Virtual Lab is healthy: 1000 synthetic cases."` |
| `test_401_is_auth_failed` | `error == "auth_failed"` |
| `test_5xx_timeout_and_connection_are_unreachable` | each gives `error == "unreachable"` |
| `test_bad_body_is_unhealthy` | non-JSON, `status != "OK"`, `synthetic` not true and non-integer `cases` each give `error == "unhealthy"` |
| `test_unfilled_secret_is_config_error` | Secrets Manager's no-value error gives `config_error`, without raising |
| `test_invalid_secret_is_config_error` | non-JSON and a missing `password` each give `config_error` |
| `test_password_never_appears` | across all of the above, the password is absent from `json.dumps(result)` and from captured logs |

- [ ] **Step 2: Run the tests and verify they fail**

Run: `python3 -m unittest discover -s agentcore-poc/tests -p 'test_handler.py'`
Expected: FAIL with import error.

- [ ] **Step 3: Implement `handler.py` and `tools.json`**

Standard library plus the runtime's `boto3`, imported lazily so tests don't need it. HTTP timeout 10 seconds. Call `{SANDBOX_ORIGIN}/sandbox/status`, not `/_status`. Cache the login per instance. The secret value is JSON with `username` and `password`. One tool, with no properties.

- [ ] **Step 4: Run the tests and verify they pass**

Run the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers agentcore-poc/lambda agentcore-poc/tests/test_handler.py
git commit -m "feat(agentcore): add the health check tool"
```

---

### Task 4: AG-UI agent

**Files:**
- Create: `agentcore-poc/agent/runs.py`, `agentcore-poc/agent/main.py`, `agentcore-poc/agent/pyproject.toml`, `agentcore-poc/agent/uv.lock`
- Create: `agentcore-poc/scripts/build_agent.sh`, `agentcore-poc/.gitignore` (`build/`, `*.zip`, `.venv/`)
- Test: `agentcore-poc/agent/test_runs.py`

**Interfaces:**
- Produces in `runs.py`: `async def handle_run(payload: dict, adapter, log=logger) -> AsyncIterator[dict]`, plus the constant `FAILURE_MESSAGE = "The agent could not finish this run."`.
- Produces in `main.py`: `app = BedrockAgentCoreApp()` and an entry point delegating to `handle_run`. Environment: `GATEWAY_URL`, `MODEL_ID`, `AGENT_REGION`.
- Produces: `agentcore-poc/build/agent.zip`, consumed by Task 5.

- [ ] **Step 1: Pin dependencies**

`pyproject.toml`: `requires-python = ">=3.13,<3.14"`, with exact `ag-ui-strands==1.0.2`, `ag-ui-protocol==1.0.0`, `strands-agents==1.63.0`, `bedrock-agentcore==1.25.2`, and the current `mcp-proxy-for-aws`. Run `uv lock`.
Expected: resolves. If `mcp-proxy-for-aws` conflicts with the spike's `mcp` version, report the versions that resolve.

- [ ] **Step 2: Write the failing tests in `test_runs.py`**, with a fake adapter whose `run()` is an async generator that records `aclose`:

| Test | Assertion |
| --- | --- |
| `test_invalid_body` | `{}` yields exactly one event: `type == "RUN_ERROR"`, `code == "INVALID_RUN_INPUT"`; the adapter isn't called |
| `test_client_tools_are_cleared` | a payload with a client tool reaches the adapter with `tools == []` |
| `test_events_use_wire_names` | a `TextMessageContentEvent` is dumped with `messageId` and without any `None` field |
| `test_closes_on_disconnect` | closing the generator mid-stream triggers the adapter stream's `aclose` |
| `test_closes_on_finish` | `aclose` also runs on normal completion |
| `test_adapter_error_is_sanitized` | an adapter `RunErrorEvent(code="STRANDS_ERROR", message="arn:secret")` keeps its code, has `message == FAILURE_MESSAGE`, and the detail is logged |
| `test_raised_error_becomes_run_error` | an adapter raising `RuntimeError("arn:secret")` ends with `code == "AGENT_ERROR"`, `message == FAILURE_MESSAGE` |

- [ ] **Step 3: Run the tests and verify they fail**

Run: `cd agentcore-poc/agent && uv run python -m unittest test_runs`
Expected: FAIL with import error.

- [ ] **Step 4: Implement `runs.py`, then `main.py`**

`runs.py` follows `invocations` in the spike (`~/.Trash/worstream-2-agent-orchestration/spikes/agui-compat/agent.py`) without its thread ownership and session manager.

`main.py` builds one adapter at module level:

```python
template = Agent(
    model=BedrockModel(model_id=os.environ["MODEL_ID"], region_name=REGION, max_tokens=1024),
    system_prompt=SYSTEM_PROMPT,
    tools=[MCPClient(lambda: aws_iam_streamablehttp_client(
        endpoint=os.environ["GATEWAY_URL"], aws_region=REGION, aws_service="bedrock-agentcore"))],
)
ADAPTER = StrandsAgent(agent=template, name="virtual-lab", description="Virtual Lab assistant")
```

`SYSTEM_PROMPT` says to answer only from tool results, report a failed tool as a failure, say the data is synthetic, and say it can only check Virtual Lab health for now and can't run analyses.

- [ ] **Step 5: Run the tests and verify they pass**

Run the Step 3 command, then `GATEWAY_URL=https://example.invalid MODEL_ID=x AGENT_REGION=us-west-2 uv run python -c "import main"`.
Expected: PASS, and the import succeeds without any network call. If building the adapter connects eagerly, report it, because the fallback in the spec's risk table applies.

- [ ] **Step 6: Write and run `build_agent.sh`**

Run `uv export --frozen --no-dev` to a build requirements file, then `uv pip install --target build/agent --python-platform aarch64-manylinux2014 --python-version 3.13 --only-binary=:all: -r` that file. Copy `main.py` and `runs.py` in, set 644 and 755 permissions, and write `build/agent.zip`.

Run: `bash agentcore-poc/scripts/build_agent.sh && du -m agentcore-poc/build/agent.zip && unzip -l agentcore-poc/build/agent.zip | grep -E ' (main|runs)\.py$'`
Expected: under 250 MB, with both files at the zip root.

- [ ] **Step 7: Commit**

```bash
git add agentcore-poc/agent agentcore-poc/scripts/build_agent.sh agentcore-poc/.gitignore
git commit -m "feat(agentcore): add the AG-UI agent"
```

---

### Task 5: Terraform

**Files:**
- Create in `agentcore-poc/terraform/`: `versions.tf`, `variables.tf`, `agent.tf`, `gateway.tf`, `tool.tf`, `outputs.tf`, `.terraform.lock.hcl`, `tests/poc.tftest.hcl`, `tests/fixtures/agent.zip` (a small placeholder)

**Interfaces:**
- Consumes: `../build/agent.zip` from Task 4, `../lambda/handler.py` and `../lambda/tools.json` from Task 3.
- Produces outputs: `agent_runtime_arn`, `gateway_url`, `lambda_function_name`, `access_secret_arn`.
- Gateway target name is `virtual-lab`, so tools appear as `virtual-lab___<tool>`.

- [ ] **Step 1: Write the failing test `tests/poc.tftest.hcl`**, using `mock_provider "aws"`, overriding `agent_zip_path` with the fixture, and asserting:

```hcl
assert { condition = aws_bedrockagentcore_gateway.tools.authorizer_type == "AWS_IAM"
         error_message = "Gateway must use IAM" }
assert { condition = aws_bedrockagentcore_agent_runtime.agent.protocol_configuration[0].server_protocol == "AGUI"
         error_message = "Runtime must use AG-UI" }
assert { condition = length(aws_bedrockagentcore_agent_runtime.agent.authorizer_configuration) == 0
         error_message = "Runtime callers use IAM" }
assert { condition = aws_bedrockagentcore_agent_runtime.agent.environment_variables["AGENT_REGION"] == var.region
         error_message = "Agent needs its region" }
```

Also assert that the target's inline tool name equals `jsondecode(file("../lambda/tools.json"))[0].name`, and that a second run with a changed `agent_zip_path` changes the S3 key.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd agentcore-poc/terraform && terraform init -backend=false && terraform test`
Expected: FAIL because the resources aren't declared.

- [ ] **Step 3: Implement**

Follow the POC spec's "Terraform", "IAM" and variable tables exactly, with these additions:

- `agent_zip_path` variable, default `"../build/agent.zip"`.
- The S3 key contains `filemd5(var.agent_zip_path)`, so a new zip updates the Runtime.
- `code_configuration` uses entry point `main.py` and runtime `PYTHON_3_13`.
- Runtime env: `GATEWAY_URL`, `MODEL_ID`, `AGENT_REGION = var.region`.
- `protocol_configuration { server_protocol = "AGUI" }`; no `authorizer_configuration`.
- The Lambda package comes from `archive_file` over `../lambda`.
- `dynamic` blocks build the schema from `tools.json`.

- [ ] **Step 4: Run the checks and verify they pass**

Run: `terraform fmt -check && terraform validate && terraform test`
Expected: all pass. If `validate` rejects `AGUI` or an argument name, check the provider docs for the locked version before changing the design.

- [ ] **Step 5: Plan against the account, without applying**

Write `poc.auto.tfvars` (git-ignored) with `sandbox_account_id = "<account-id>"` and `sandbox_origin = "https://<distribution-id>.cloudfront.net"`. Then run `AWS_PROFILE=workshop terraform plan`.
Expected: only additions and nothing destroyed or changed. Report refused permissions.

- [ ] **Step 6: Commit**

```bash
git add agentcore-poc/terraform
git commit -m "feat(agentcore): add Terraform for the agent, Gateway and tool"
```

---

### Task 6: Operator scripts and README

**Files:**
- Create: `agentcore-poc/scripts/set_access_secret.py`, `agentcore-poc/scripts/invoke.py`, `agentcore-poc/README.md`
- Test: `agentcore-poc/tests/test_scripts.py`

**Interfaces:**
- Consumes: Terraform outputs from Task 5.
- Produces in `invoke.py`: `build_run_input(prompt: str, thread_id: str, history: list[dict]) -> dict`; `parse_sse_line(line: str) -> dict | None`; `session_id(thread_id: str) -> str`, which must match the frontend's `runtimeSessionId` (SHA-256 hex).
- Produces in `set_access_secret.py`: `load_login(path: str) -> dict`.
- CLI: `invoke.py PROMPT [--thread ID] [--save PATH]` prints `+<ms>ms <type>` per event, then the joined text.

- [ ] **Step 1: Write the failing tests**

| Test | Assertion |
| --- | --- |
| `test_run_input_is_valid` | `RunAgentInput.model_validate(build_run_input("q", "t", []))` succeeds; the last message is the user's |
| `test_history_comes_before_prompt` | history messages precede the new prompt, in order |
| `test_parse_sse_line` | `data: {"type":"RUN_STARTED"}` parses; blank lines and `: comment` give `None` |
| `test_session_id_matches_frontend` | `session_id("t") == hashlib.sha256(b"t").hexdigest()` |
| `test_load_login_requires_both_fields` | a missing `password` raises `ValueError` whose message doesn't include file contents |

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd agentcore-poc/agent && uv run python -m unittest discover -s ../tests -p 'test_scripts.py'`
Expected: FAIL with import error.

- [ ] **Step 3: Implement the scripts and README**

`set_access_secret.py --access-file PATH` writes `username` and `password` to the secret from Terraform's output and prints neither. The README covers deploy order, frontend setup (`AGENTCORE_RUNTIME_ARN`, `AWS_PROFILE=workshop`, `npm run dev -- -H 127.0.0.1`), the live checks, adding a tool in Python, and destroy.

- [ ] **Step 4: Run the tests and verify they pass**

Run the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agentcore-poc/scripts agentcore-poc/README.md agentcore-poc/tests/test_scripts.py
git commit -m "feat(agentcore): add deploy and invoke scripts"
```

---

### Task 7: Deploy and prove each backend layer

No new product code unless a check fails. Record each result in the README's verification section, as the POC spec requires.

**Files:**
- Modify: `agentcore-poc/README.md`
- Create: `agentcore-poc/tests/fixtures/agui-sample-stream.sse`, copied to `src/features/chat/__fixtures__/agui-sample-stream.sse` in the frontend worktree
- Test: `src/features/chat/sampleStream.unit.test.ts`

- [ ] **Step 1: Confirm the state files exist and credentials are fresh**

Run: `ls ~/.Trash/mmrf-virtual-lab-sandbox/generated/aws/access.json`, or use the new path if the user moved the folder, and check `sts get-caller-identity` for account `<account-id>`.
Expected: both succeed.

- [ ] **Step 2: Get the user's go-ahead, then apply**

Ask first. Then run `terraform apply` and `scripts/set_access_secret.py --access-file PATH`.
Expected: outputs are printed. If a permission is refused, report the action and narrow the fix.

- [ ] **Step 3: Live check 1, Lambda directly**

Invoke with client context `{"custom":{"bedrockAgentCoreToolName":"virtual-lab___check_virtual_lab_health"}}`.
Expected: `ok: true`, `cases: 1000`.

- [ ] **Step 4: Live check 2, Gateway**

Send signed `tools/list` and `tools/call` using `aws_iam_streamablehttp_client`.
Expected: the tool is listed as `virtual-lab___check_virtual_lab_health` and returns the Step 3 result. If the real name differs, update `displayToolName`'s test.

- [ ] **Step 5: Live check 3, Runtime stream**

Run: `uv run python ../scripts/invoke.py "Is the Virtual Lab healthy?" --save ../tests/fixtures/agui-sample-stream.sse` from `agentcore-poc/agent`.
Expected: `RUN_STARTED`, then text and tool events, then `RUN_FINISHED`; the answer states 1000 cases; `TEXT_MESSAGE_CONTENT` arrival times are visibly spread; Runtime and Lambda logs show entries at matching times. Save nothing containing credentials.

- [ ] **Step 6: Live check 4, the official client reads the real stream**

In the frontend, `sampleStream.unit.test.ts` feeds the saved file through `HttpAgent` with a mocked `fetch`, and asserts that it parses without custom code, every tool call has a start, end and result, and the run ends with `RUN_FINISHED`.

Run: `NODE_OPTIONS=--no-experimental-strip-types npx jest --runInBand src/features/chat/sampleStream.unit.test.ts`
Expected: PASS.

- [ ] **Step 7: Check the tool failure path**

With the user's go-ahead, set a wrong password in the secret, force a new Lambda instance by updating its description, and rerun Steps 3 and 5.
Expected: `auth_failed`, and the agent reports a failure rather than a number. Then restore the login with `set_access_secret.py` and confirm `ok: true`.

- [ ] **Step 8: Commit in each repo**

```bash
git add agentcore-poc/README.md agentcore-poc/tests/fixtures
git commit -m "docs(agentcore): record live checks and a sample AG-UI stream"
```

In the frontend worktree:

```bash
git add src/features/chat/__fixtures__ src/features/chat/sampleStream.unit.test.ts
git commit -m "test(chat): read a real AG-UI stream with the official client"
```

---

### Task 8: Chat end to end

- [ ] **Step 1: Start the frontend against the deployed agent**

Put `AGENTCORE_RUNTIME_ARN=<output>` and `AWS_PROFILE=workshop` in the worktree's `.env.development.local`, alongside `NEXT_PUBLIC_GEN3_API_TARGET=http://localhost:3080`. Make sure the local stack is healthy, then run `npm run dev -- -H 127.0.0.1`.
Expected: the Chat page loads at `localhost:3000`.

- [ ] **Step 2: Check success criteria 1 to 3 in a browser**

Click the suggested prompt.
Expected: a `check_virtual_lab_health` row appears before the answer finishes; text grows in several steps; the answer states 1000 cases. Take a screenshot. Add temporary timing to the route's log only if the growth is ambiguous, and don't commit it.

- [ ] **Step 3: Check criterion 4**

Ask: `What number of cases did you just report?`
Expected: the answer uses the earlier result. If the agent has no memory of it, apply the spec's risk-table fallback and report.

- [ ] **Step 4: Check criterion 5**

Repeat Task 7 Step 7's wrong password with the user's go-ahead, and ask again. Then stop the Runtime's access by unsetting the ARN and restarting, and ask again.
Expected: both show a failure in Chat with no raw AWS text, and the composer still works. Restore both.

- [ ] **Step 5: Check criterion 6**

Inspect the browser's network requests and the page source.
Expected: requests go only to same-origin routes, and no AWS key, ARN, signature or Basic credential appears in any request or response.

- [ ] **Step 6: Report, then get a decision on teardown**

Report criteria 1 to 6 with evidence, plus any risk-table fallback used. Ask whether to keep the agent running for further work. Only on the user's instruction, run `terraform destroy` and verify criterion 7: no POC resources remain, and the live site's `/_status` returns 200.
