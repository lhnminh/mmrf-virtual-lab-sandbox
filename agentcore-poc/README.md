# AgentCore AG-UI proof of concept

A Python Strands agent on AgentCore Runtime that speaks AG-UI, with one Python tool behind AgentCore Gateway. The local Chat page on `next dev` streams its answers.

Design: [`docs/superpowers/specs/2026-11-03-agentcore-agui-chat-design.md`](../docs/superpowers/specs/2026-11-03-agentcore-agui-chat-design.md) and the [architecture diagram](../docs/superpowers/specs/2026-11-03-agentcore-agui-chat-architecture.drawio.png).

This has its own Terraform root and local state. It creates nothing inside the live Virtual Lab, and these resources bill until destroyed.

## Deploy

Needs `uv`, Terraform and the `workshop` AWS profile. Create `terraform/poc.auto.tfvars`, which git ignores:

```hcl
sandbox_account_id = "<account-id>"
sandbox_origin     = "https://<distribution-id>.cloudfront.net"
```

Then:

```sh
scripts/build_agent.sh
(cd terraform && terraform init && AWS_PROFILE=workshop terraform apply)
cd agent
uv run python ../scripts/set_access_secret.py --access-file PATH/TO/generated/aws/access.json
uv run python ../scripts/invoke.py "Is the Virtual Lab healthy?"
```

To send a cohort as a browser would, add `--cohort-file PATH`. The file is JSON with `filter`, `label`, `caseCount`, `revision` and `changedOutsideChat`, and goes in `state.cohort`.

Until the secret is filled, the tool returns `config_error`. The login is cached per Lambda instance, so after changing it, force a new instance by updating the function's configuration.

## Connect Chat

Charts and tool answers read the same deployed Virtual Lab, so no local stack is needed. In the `mmrf-data-commons` `feature/chat-cohort-tools` branch, add these to `.env.development.local`, which git ignores:

```sh
AGENTCORE_RUNTIME_ARN=<terraform output agent_runtime_arn>
AWS_PROFILE=workshop
NEXT_PUBLIC_GEN3_API_TARGET=http://127.0.0.1:3090
PROTEINPAINT_API=http://127.0.0.1:3091
```

Start the forwarders, then the dev server:

```sh
SANDBOX_ACCESS_FILE=PATH/TO/access.json node scripts/dev-forward.mjs
npm run dev -- -H 127.0.0.1
```

`scripts/dev-forward.mjs` listens on `127.0.0.1` only. Port 3090 forwards to the deployed origin and 3091 to its `/protein-paint`, each adding the Basic login. `SANDBOX_ACCESS_FILE` is JSON with `origin`, `username` and `password`. Keep it outside the repositories.

Open `http://localhost:3000/?app=Chat`. It must be port 3000, because `.env.development` points the app there.

`next dev` has no sandbox session, so it redirects to Login. Open `http://localhost:3090/sandbox/session` and set its `access_token` as a `credentials_token` cookie for `localhost`. It lasts 30 minutes and only works in development.

The dev route answers only in development and only to this machine, because it signs with your AWS credentials. Restart the server after refreshing credentials or changing these values.

## Add a tool

Tools are Python.

1. Add a function in its own `lambda/tool_<name>.py`, and register it in `lambda/handler.py`. Use `CLIENT_TOOLS` if it calls the Virtual Lab with the cohort, or `TOOLS` if it doesn't.
2. Add its schema to `lambda/tools.json`. Nested input properties are supported, because Gateway reads the schema from S3. Don't offer a cohort parameter, because the agent's hook adds the filter and the model never sees it.
3. Run `terraform apply`.

The agent finds new tools through Gateway, so its code doesn't change. Show a tool's result in Chat by adding a renderer to `src/features/chat/toolkit.tsx` in `mmrf-data-commons`.

`terraform plan` doesn't notice Lambda code swapped outside Terraform, so it can report no changes while different code is running. Deploy code only through `terraform apply`.

## Test

```sh
python3 -m unittest discover -s tests -p 'test_handler.py'
(cd agent && uv run python -m unittest test_runs test_main)
(cd agent && uv run python -m unittest discover -s ../tests -p 'test_scripts.py')
(cd terraform && terraform fmt -check && terraform validate && terraform test)
```

Browser checks use the Chrome DevTools MCP against the deployed agent, after a deploy or when a UI change needs seeing. The steps are in [Acceptance checks in a browser](#acceptance-checks-in-a-browser). There's no automated browser suite.

## Destroy

```sh
(cd terraform && AWS_PROFILE=workshop terraform destroy)
```

Keep `terraform/terraform.tfstate` until this succeeds. The live Virtual Lab isn't affected.

## Live checks

Run on 2026-11-03 against the deployed agent, with the real login loaded.

| Check | Result |
| --- | --- |
| Apply | 15 resources created, including `AGUI` on a zip deployment |
| Lambda directly | `ok: true`, `cases: 1000` |
| Lambda with an unfilled secret | `config_error` |
| Lambda with a wrong password | `auth_failed` |
| Gateway `tools/list` and `tools/call` with SigV4 | Lists `virtual-lab___check_virtual_lab_health` and returns the Lambda's result |
| Runtime stream, warm tool path | `RUN_STARTED` 5.7s, tool start 6.7s, result 6.9s, text 7.7s to 8.0s. See `tests/fixtures/agui-sample-stream.sse` |
| Official `@ag-ui/client` on that stream | Parses without custom code; tool calls have a start, end and result |
| Chat in a browser | "1,000 synthetic cases"; tool row at 9.3s, before the text, which grew in steps from 10.5s to 10.7s |
| Follow-up in the same thread | Used the earlier answer without calling the tool again |
| Wrong password in Chat | The agent reports the login was refused and doesn't present the earlier result as current |
| No agent reachable from Chat | Shows `HTTP 502: {"error":"The agent is unavailable"}`; the composer still works |
| Browser traffic | Same origin only; no AWS keys, signatures, ARNs or Basic credentials |

### Cohort and Lollipop tools

Run on 2026-11-03 against the deployed agent. Streams are in `tests/fixtures/`. Gene names and counts are synthetic.

| Check | Result |
| --- | --- |
| Apply | 2 added, 4 changed in place, 1 replaced (`aws_s3_object.agent_code`). Runtime and Gateway kept |
| Gateway `tools/list` | 4 tools, with `changes` nested in the S3 schema. None offers a cohort |
| `cohortFilter` on a tool that declares properties | Delivered: KRAS goes from 480 samples of 1,000 cases to 148 of 334 with a race filter |
| `cohortFilter: null` | All cases, the same as leaving it out. The tool treats both alike, so this doesn't show whether Gateway delivers or drops it |
| Gateway validation errors with a marker in `cohortFilter` | Name only the declared field. The marker isn't in the text |
| Journey: "What's mutated in Black patients?" | `update_cohort`, `show_oncomatrix`, `RUN_FINISHED`, and a `STATE_SNAPSHOT` at revision 2 |
| Filter in the stream | No filter, `cohortFilter` or case ID outside `STATE_SNAPSHOT`, including `TOOL_CALL_*`, `MESSAGES_SNAPSHOT`, `TEXT_MESSAGE_*`, `RAW` and `REASONING_*` |
| Runtime and Lambda logs after the apply | None of those strings. Bedrock model invocation logging isn't configured |
| Case ID cohort of 200 | Same absence, with the IDs only in `STATE_SNAPSHOT`. Label "Selected cases" and 200 cases. Not saved as a fixture |
| `changedOutsideChat` | The answer starts "Now using: Selected cases (200 cases)" |
| Lollipop follow-up in the same thread | Uses the new cohort without changing it |
| `ambiguous`, `unknown_field`, `no_data_for_gene` | Each reported as a result. The cohort stays unchanged |
| Tool failure | Reported as a failure, with no guessed result. Recorded by sending a malformed `state.cohort` filter, so `tool-failure.sse` holds that filter in its `STATE_SNAPSHOT` |
| `check_numbers` | No unsupported numbers in any saved stream. It counts the state's case count as a source and ignores list markers at a line start. The first run flagged the `ambiguous` answer for both |
| `none-in-cohort.sse`, `journey-oncomatrix.sse` | Re-recorded from the deployed agent after the fixes below |

**Found broken and fixed:** `none_in_cohort` failed live, because ProteinPaint omits `sampleTotalNumber` when no sample in the cohort has a mutation in the gene. The tool now treats that reply as 0 samples, and any other malformed track stays an error. `show_oncomatrix`'s summary now gives gene counts in samples, and the system prompt says to keep that unit. Follow-up buttons in tool output threw "Composer is not available" after sending, so they no longer clear the composer.

### Acceptance checks in a browser

Run on 2026-11-03 through the Chrome DevTools MCP: local Chat, deployed agent. Numbers are compared with the chart and cohort bar on the same page.

| Check | What the page showed |
| --- | --- |
| "What's mutated in Black patients?" | Cohort bar 1,000 to 334. Answer and OncoMatrix agree: KRAS 148, NRAS 113, DIS3 98, BRAF 76, MYC 62, TP53 38 |
| "Top 3 genes" | The same 3 genes and counts in the answer and matrix. The chart header counted 251 samples and the answer 287, because the summary counted all ranked genes. Fixed in code to count the genes shown, pending deploy |
| Lollipop for KRAS | Answer and chart agree: 148 samples, 14 variants, p.Q61H 38. The sample list wasn't opened |
| Named and open-ended wording | "Show a Lollipop plot for KRAS" and "Where do KRAS mutations fall on the protein?" reach the same result |
| Change the cohort, then ask | The answer opens with "Now using" and uses the new cohort. The request's `changedOutsideChat` is true once, then false |
| Undo | Cohort restored, and older charts keep their labels |
| "Only women", then "white patients", then "black patients instead" | Adds Sex (500 cases), adds Race (167), then replaces Race and keeps Sex |
| "Only smokers" | `unknown_field`. Cohort unchanged |
| "Only Hispanic patients" | `ambiguous` and asks, in 6 of 6 new threads and a new browser thread. Clicking an option sets the cohort (502 cases). In one long thread about race, the model tried Race first and got `unknown_value`, with the cohort unchanged |
| Filters matching nobody | `would_be_empty`. Cohort unchanged |
| BRCA1 | `no_data_for_gene`, listing the genes covered |
| DIS3 in a cohort of 6 | `none_in_cohort`: "0 of 6 cases", stated as a result |
| Wrong login in the secret | Health and OncoMatrix steps show Failed. No numbers from them, and the cohort is unchanged. Login restored afterwards |
| Tool schemas | No tool offers a cohort parameter |
| More turns in one thread | Earlier turns and charts stay on screen. Chart requests in the server log didn't rise over turns that drew no chart |

The standalone OncoMatrix page wasn't opened for comparison. Chat draws the same component with the same filter.

**Pending deploy:** these fixes from the final review pass unit tests but haven't run on the deployed agent: the Top N sample count, transport failures showing as Failed, whole-word value matching ("I" means Stage I), `unsupported_field` for number-range fields such as age, and "Now using" only on the turn after a change. `journey-oncomatrix.sse` holds the earlier summary wording until it's re-recorded.

**Local dev:** after refreshing AWS credentials, restart `next dev`. Until then Chat shows `HTTP 502`, and the log shows a `SyntaxError` for what is a 403 from AWS.
`terraform destroy` hasn't been run.
