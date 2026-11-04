# AgentCore AG-UI proof of concept

A Python Strands agent on AgentCore Runtime that speaks AG-UI, with one Python tool behind AgentCore Gateway. The local Chat page on `next dev` streams its answers.

Design: [`docs/superpowers/specs/2026-11-03-agentcore-agui-chat-design.md`](../docs/superpowers/specs/2026-11-03-agentcore-agui-chat-design.md) and the [planned architecture diagram](../docs/superpowers/specs/2026-11-03-agentcore-agui-chat-architecture.drawio.png).

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

Until the secret is filled, the tool returns `config_error`. The login is cached per Lambda instance, so after changing it, force a new instance by updating the function's configuration.

## Connect Chat

In the `mmrf-data-commons` `feature/agui-chat` worktree, add these to `.env.development.local`, which git ignores:

```sh
AGENTCORE_RUNTIME_ARN=<terraform output agent_runtime_arn>
AWS_PROFILE=workshop
NEXT_PUBLIC_GEN3_API_TARGET=http://localhost:3080
```

Then run `npm run dev -- -H 127.0.0.1` and open `http://localhost:3000/?app=Chat`. It must be port 3000, because `.env.development` points the app there.

`next dev` has no sandbox session, so it redirects to Login. With the local stack running, open `http://localhost:3080/sandbox/session` and set its `access_token` as a `credentials_token` cookie for `localhost`. It lasts 30 minutes and only works in development.

The dev route answers only in development and only to this machine, because it signs with your AWS credentials. Restart the server after refreshing credentials or changing these values.

## Add a tool

Tools are Python.

1. Add a function to `lambda/handler.py` and an entry to `TOOLS`.
2. Add its schema to `lambda/tools.json`. Only flat input properties are supported.
3. Run `terraform apply`.

The agent finds new tools through Gateway, so its code doesn't change.

## Test

```sh
python3 -m unittest discover -s tests -p 'test_handler.py'
(cd agent && uv run python -m unittest test_runs test_main)
(cd agent && uv run python -m unittest discover -s ../tests -p 'test_scripts.py')
(cd terraform && terraform fmt -check && terraform validate && terraform test)
```

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

`terraform destroy` hasn't been run.
