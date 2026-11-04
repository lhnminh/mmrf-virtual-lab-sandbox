# AgentCore proof of concept: design

Date: 2026-11-03
Branch: `feature/agentcore-poc` in `rvantaylor/mmrf-virtual-lab-sandbox`, from `main` at `2e47ab8`

## Goal

Prove that a question sent to an agent on Amazon Bedrock AgentCore Runtime can
reach a service running in the sandbox EKS cluster, through AgentCore Gateway
(MCP) and a Lambda tool. Leave a simple place to add real tools once they are
defined.

Success means all of these are true:

1. Asking the deployed agent "Is the Virtual Lab healthy?" returns an answer
   based on a real tool call.
2. That answer reports the live values from `GET /sandbox/status`, including
   `cases: 1000`.
3. Runtime and Lambda logs each show an entry for that invocation, at matching
   times. Log entries aren't linked by a shared ID.
4. Adding a tool needs changes to the Lambda and its tool list only, not to
   the agent code.
5. `terraform destroy` removes everything the POC created and leaves the live
   Virtual Lab running.

## Out of scope

- Chat and `identity` changes. The agent is invoked by a script.
- The team's Node agent in `agent/` and the team's `infra-1` and `infra-2` plans.
- Survival or other data tools.
- AgentCore Memory, Cognito and VPC networking.

## Architecture

```
scripts/invoke.py
  │  SigV4, InvokeAgentRuntime
  ▼
Agent (AgentCore Runtime, Python, Strands) ──► Bedrock (Haiku inference profile)
  │  MCP over HTTPS, SigV4 (AWS_IAM inbound auth)
  ▼
AgentCore Gateway
  │  lambda:InvokeFunction, Gateway service role
  ▼
Lambda (Python, outside the VPC) ──► Secrets Manager (team login)
  │  HTTPS, Basic auth
  ▼
CloudFront <distribution-id> ──► internal ALB ──► access pod ──► identity pod
                                                              GET /sandbox/status
```

The Lambda uses the same public route as a browser. This was chosen over a
Lambda inside the VPC because it needs no change to the live stack.

## File layout

```
agentcore-poc/
├── README.md             # deploy, verify, add a tool, destroy
├── .gitignore            # build/, *.zip
├── agent/
│   ├── main.py           # Runtime entry point
│   └── requirements.txt
├── lambda/
│   ├── handler.py        # routing table and tool functions
│   └── tools.json        # tool schemas, read by Terraform
├── scripts/
│   ├── build_agent.sh    # builds build/agent.zip with arm64 dependencies
│   ├── set_access_secret.py
│   └── invoke.py
├── terraform/            # its own root and its own local state
│   ├── versions.tf
│   ├── variables.tf
│   ├── agent.tf          # S3 code bucket and object, Runtime, its role
│   ├── gateway.tf        # Gateway, target, its role
│   ├── tool.tf           # Lambda, its role, secret, log group
│   ├── outputs.tf
│   ├── .terraform.lock.hcl
│   └── tests/poc.tftest.hcl
└── tests/
    └── test_handler.py
```

## Components

### Agent (`agent/main.py`)

- Python 3.13 using `bedrock-agentcore` (`BedrockAgentCoreApp`), `strands-agents`
  and `mcp-proxy-for-aws`.
- Deployed as a zip from S3 through `code_configuration`, entry point `main.py`,
  runtime `PYTHON_3_13`. There is no Docker image or ECR repository.
- Reads `GATEWAY_URL` and `MODEL_ID` from its environment.
- On each invocation, it opens an MCP client to the Gateway with
  `aws_iam_streamablehttp_client(endpoint=GATEWAY_URL, aws_region=..., aws_service="bedrock-agentcore")`,
  lists the tools, runs the agent with the prompt and closes the client.
- Request: `{"prompt": "..."}`. Response: `{"message": "...", "tool_calls": ["<tool name>", ...]}`.
- The system prompt tells the agent to answer only from tool results, to report
  a failed tool as a failure, and to say the data is synthetic.
- If the Gateway can't be reached or the model call fails, it returns
  `{"error": "<short reason>"}` and logs the detail.

`scripts/build_agent.sh` installs dependencies with
`uv pip install --target build/agent --python-platform aarch64-manylinux2014 --python-version 3.13 --only-binary=:all:`,
copies `main.py` in, sets 644 and 755 permissions, and writes `build/agent.zip`.
Runtime accepts arm64 only, with a limit of 250 MB zipped.

### Gateway

- `authorizer_type = "AWS_IAM"`, `protocol_type = "MCP"`.
- One Lambda target using `credential_provider_configuration { gateway_iam_role {} }`.
- Tool schemas are built from `lambda/tools.json` with `dynamic` blocks over
  `inline_payload` and `property`. Only flat input properties are supported.
  Nested input would need the Terraform blocks extended.

### Lambda (`lambda/handler.py`)

- Python 3.13, arm64, standard library plus the `boto3` in the Lambda runtime,
  so there is nothing to package. Lambda timeout 15 seconds, HTTP timeout 10.
- Reads the tool name from
  `context.client_context.custom["bedrockAgentCoreToolName"]`, which has the form
  `<target>___<tool>`, and removes the prefix up to and including `___`. The
  tool's arguments are the `event` object.
- Routes through a table:

  ```python
  TOOLS = {"check_virtual_lab_health": check_virtual_lab_health}
  ```

- Environment: `SANDBOX_ORIGIN` and `ACCESS_SECRET_ARN`. The login is read from
  Secrets Manager once per Lambda instance and cached. Rotating it needs a new
  Lambda instance.

**First tool, `check_virtual_lab_health`:** takes no input and calls
`GET {SANDBOX_ORIGIN}/sandbox/status` with Basic auth. It deliberately does not
use `/_status`: the `access` pod answers that path itself, without a login, so
it wouldn't prove the route to `identity` or the login later tools need.

Success result:

```json
{"ok": true, "status": "OK", "synthetic": true, "cases": 1000, "latency_ms": 120,
 "summary": "Virtual Lab is healthy: 1000 synthetic cases."}
```

### Adding a tool later

1. Add a function to `lambda/handler.py` and an entry to `TOOLS`.
2. Add its schema to `lambda/tools.json`.
3. Run `terraform apply`.

The agent finds the new tool through `tools/list`, so its code doesn't change.

## Error handling

The Lambda always returns a structured result instead of raising, so the agent
can report what failed. Failures have this shape:

```json
{"ok": false, "error": "<code>", "summary": "<one sentence>"}
```

| Case | `error` |
| --- | --- |
| HTTP 401 from the sandbox | `auth_failed` |
| HTTP 5xx, other unexpected status, timeout or connection failure | `unreachable` |
| HTTP 200 where `status` isn't `OK` or the body isn't valid | `unhealthy` |
| Secret missing, or its value isn't valid | `config_error` |
| Tool name not in `TOOLS` | `unknown_tool` |

The password never appears in results, log lines or exception text.

## IAM

Each role is limited to its next step.

| Role | Trusted by | Allows |
| --- | --- | --- |
| Runtime | `bedrock-agentcore.amazonaws.com`, limited by `aws:SourceAccount` and `aws:SourceArn` | Invoke the configured inference profile and its foundation models; `bedrock-agentcore:InvokeGateway` on this Gateway; write logs; read the code object |
| Gateway | `bedrock-agentcore.amazonaws.com`, limited the same way | `lambda:InvokeFunction` on this Lambda |
| Lambda | `lambda.amazonaws.com` | `secretsmanager:GetSecretValue` on this secret; write to its log group |

## Terraform

- Own root in `agentcore-poc/terraform`, with local gitignored state. It has no
  remote-state link to the live stack and creates no resource inside it.
- Provider `hashicorp/aws ~> 6.71`, the latest release checked on 2026-11-03.
  Terraform `>= 1.9, < 2.0`, matching the main root.
- `allowed_account_ids = [var.sandbox_account_id]`, plus the same `default_tags`
  style as the main root, with `Component = "agentcore-poc"`.

Variables:

| Name | Default | Notes |
| --- | --- | --- |
| `sandbox_account_id` | none | Must be set to `<account-id>` for this sandbox |
| `sandbox_origin` | none | Validated as `https://<id>.cloudfront.net`. The live value is `https://<distribution-id>.cloudfront.net` |
| `region` | `us-west-2` | |
| `name` | `mmrf_agentcore_poc` | Letters, digits and underscores for Runtime naming; Terraform converts it to hyphens where a resource needs them |
| `model_id` | `us.anthropic.claude-haiku-5-5` | Listed in the account; a live call is the first thing the verification proves |

Outputs: `agent_runtime_arn`, `gateway_url`, `lambda_function_name`,
`access_secret_arn`.

For clean teardown, the S3 bucket uses `force_destroy = true` and the secret uses
`recovery_window_in_days = 0`.

**Team login:** Terraform creates the empty secret only.
`scripts/set_access_secret.py --access-file PATH` reads `username` and `password`
from the launcher's `access.json`, writes them to the secret and prints neither.
This keeps the password out of Terraform state. Today that file is at
`~/.Trash/mmrf-virtual-lab-sandbox/generated/aws/access.json`, so the path is
always passed explicitly.

## Deploy order

1. `scripts/build_agent.sh`
2. `terraform apply`
3. `scripts/set_access_secret.py --access-file PATH`
4. `scripts/invoke.py "Is the Virtual Lab healthy?"`

## Testing

**Unit tests**, in `agentcore-poc/tests/test_handler.py`, using `unittest` as the
repo does, with fake HTTP and Secrets Manager clients:

- The `___` prefix is removed and the right tool is called.
- A healthy response gives the success result.
- Each row of the error table gives its `error` code.
- The password doesn't appear in any result or captured log output.

**Terraform**, matching the repo's `terraform fmt -check`, `validate` and `test`
with a mock provider. `tests/poc.tftest.hcl` asserts that the Gateway uses
`AWS_IAM` and that the target's tool names match `tools.json`. A real `plan` must
show only new resources.

**Live checks**, one layer at a time, so a failure identifies its layer:

1. Invoke the Lambda directly with a test client context: `ok: true`, `cases: 1000`.
2. Call the Gateway's `tools/list` and `tools/call` with SigV4: the tool is listed
   and returns the same result.
3. Run `scripts/invoke.py "Is the Virtual Lab healthy?"`: the answer reports 1000
   cases, `tool_calls` names the tool, and the logs show the request at Runtime
   and Lambda.
4. Set a wrong password in the secret, start a new Lambda instance and repeat
   step 1: `auth_failed`. Then restore the login.

**Teardown check:** after `terraform destroy`, no POC resources remain, and the
live site's `/_status` still returns 200.

CI isn't changed: the workflow runs only `tests/` and `terraform/` at the repo
root. The POC's tests run locally, with the commands in its README.

## Risks to confirm during implementation

These come from documentation or simulation and haven't been proven live. Each
gets recorded in the README once checked.

| Assumption | Checked by |
| --- | --- |
| `/sandbox/status` returns `{status, synthetic, cases}` with the login. Read from `identity/server.mjs` on `main`; so far only the 401 without a login has been seen live | Live check 1 |
| The workshop role can really create these resources. An IAM simulation allowed the main actions, but that may not show every limit | First `apply` |
| Runtime and its role need the exact permissions listed, including reading the code object and any extra log or trace actions | First invocation; failures are added to the role narrowly |
| The Haiku profile's foundation model ARN pattern, and that the model can be invoked | Live check 3 |
| `tools.json` works through `dynamic` blocks with a tool that has no input properties | `terraform validate` and `plan` |
| Workshop credentials expire during long operations | Refresh and rerun; Terraform resumes from state |

## Cost

All new resources are pay-per-use or have a small fixed cost, with nothing
expected to run constantly. The cost hasn't been calculated. It counts against the
sandbox's $500 cap, and the POC should be destroyed when it's no longer needed.

## Relationship to the team's work

This is deliberately separate from `lhnminh/mmrf-virtual-lab-sandbox` and its
`infra-1` and `infra-2` plans. The agent language differs (Python here, Node
there), so the agent won't merge directly. The Terraform, Gateway and Lambda
patterns, and the answers to that plan's open questions on Gateway auth and
provider support, should carry over.
