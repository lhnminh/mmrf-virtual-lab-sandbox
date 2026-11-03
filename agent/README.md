# Correlation Plot agent backend

This folder hosts a single Strands agent for prompt-driven use of the existing
Correlation Plot. The UI and plot implementation can be developed separately.
The agent uses Amazon Bedrock through the Strands SDK; AWS credentials and model
access are supplied by the runtime, not stored in this repository.

## Install and run

Requires Node.js 22 or newer, Bedrock model invocation access, and access to
the selected model in the configured AWS region. You can use a Bedrock API
key, an AWS profile, or a runtime role. No credentials belong in this repository.

```sh
cd agent
npm install
npm test
```

The tests use a fake agent and need no AWS access. For a quick local key setup,
copy the template to an ignored file, edit it locally, and set
`AWS_BEARER_TOKEN_BEDROCK` to your Bedrock API key. Choose a Bedrock model ID or
inference profile ID available to the key's AWS identity and region:

```sh
cp .env.example .env
# Edit .env locally, then run:
npm run smoke:bedrock -- "Create a correlation plot for age at diagnosis and KRAS expression"
```

The `start`, `prompt`, and `smoke:bedrock` commands load `agent/.env` if it
exists. Environment variables already set in the shell take precedence. The
file is ignored by Git. Keep it out of screenshots and shared logs.

If you prefer an AWS CLI profile, put `AWS_PROFILE`, `AWS_REGION`, and
`BEDROCK_MODEL_ID` in `.env`, then verify the profile separately:

```sh
aws sso login --profile your-profile  # if your profile uses SSO
aws sts get-caller-identity --profile your-profile
npm run smoke:bedrock -- "Create a correlation plot for age at diagnosis and KRAS expression"
```

`smoke:bedrock` calls the real Bedrock model but supplies a clearly labeled
mock plot tool. It exits unsuccessfully unless the agent completes a tool
call. It verifies prompt interpretation and Strands tool invocation, not plot
calculations. The CLI prints the response and tool call as JSON. Strands uses
its default Bedrock model if `BEDROCK_MODEL_ID` is omitted, though an explicit
ID is more predictable for a test. The agent caps each model response at 1,024
output tokens.

The AWS identity needs `bedrock:InvokeModelWithResponseStream` for Strands'
streaming calls to the selected model or inference profile. Inference profiles
can also require access to destination-region foundation models. If your
profile uses AWS IAM Identity Center, run `aws sso login --profile your-profile`
before the smoke test. An AWS runtime role works without a local profile.

To run with the teammate's actual correlation tool:

```sh
export CORRELATION_TOOL_URL=http://127.0.0.1:9000/correlation
npm run prompt -- "Create a correlation plot for age at diagnosis and KRAS expression"
npm start
```

The server listens on `127.0.0.1:8787` by default; `AGENT_HOST` and
`AGENT_PORT` override those values.

```sh
curl -fsS http://127.0.0.1:8787/v1/prompts \
  -H 'content-type: application/json' \
  -d '{"prompt":"Plot age at diagnosis against KRAS expression"}'
```

The endpoint accepts an optional website cohort filter. Pass the converted
`filter0` expression used by the existing Correlation Plot wrapper, rather
than the frontend's raw cohort state:

```json
{
  "prompt": "Plot age at diagnosis against KRAS expression",
  "context": { "cohortFilter": { "in": { "demographic.gender": ["female"] } } }
}
```

The response contains `message` and `toolCalls`. Each successful tool call
includes the validated input, the tool's summary, and any plot payload. The
frontend should proxy this endpoint through its own server route or configure
an authenticated same-origin route before exposing it to users. No browser
cross-origin access or public listener is enabled by default.

## Correlation tool contract

`CORRELATION_TOOL_URL` points to the teammate's HTTP tool endpoint. The agent
POSTs JSON with `primaryVariable`, `secondaryVariable`, and `cohortFilter`.
Variable names are the user's terms; the tool should resolve them to supported
dataset terms and reject ambiguous or unknown terms. The website supplies the
cohort filter; the model cannot change it.

The tool responds with JSON containing a nonempty `summary` string and an
optional `plot` payload:

```json
{
  "summary": "Synthetic correlation plot generated for age and KRAS expression.",
  "plot": { "type": "scatter", "points": [] }
}
```

The agent passes only `summary` back to the model. The full `plot` remains in
the endpoint response for the UI. This is an initial contract to align with
the tool author before integration.

## Backend tests

```sh
cd agent
npm test
```

These tests use a fake Strands agent and HTTP adapter to verify prompt input,
tool arguments, cohort forwarding, and response shape without AWS credentials
or the UI. The mock Bedrock smoke test exercises real model access while the
teammate's tool is under development.
