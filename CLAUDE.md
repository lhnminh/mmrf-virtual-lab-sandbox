# Team context: ORION Workstream 2

Read this first. It is the shared brief for every developer and every Claude
session on this repo.

## Goal

ORION hackathon, Workstream 2 (Agent Orchestration): a chat agent inside MMRF
Virtual Lab that operates the platform's existing tools from plain-language
questions and shows their visualizations in the conversation. The brief
requires the agent to run on **Amazon Bedrock AgentCore**. Journeys and
success criteria: [docs/journeys.md](docs/journeys.md).

**Current focus: architecture and boilerplate, not new tools.** Get the existing
`correlation_plot` tool (journey 1, survival) working end to end on AWS through
AgentCore Runtime and AgentCore Gateway. New tools (journeys 2 and 3) wait
until that path works.

## Architecture in one line

Chat (browser) → Virtual Lab gateway `identity` (EKS) → **Agent** (AgentCore
Runtime) → **Tools** (AgentCore Gateway, MCP) → **Tool code** (Lambda) → Virtual
Lab data (EKS, through the public sandbox URL).

Full description, hop by hop: [docs/agent-architecture.md](docs/agent-architecture.md).
Locally, Docker Compose runs the agent and tool code in one `agent` container,
and everything keeps working without AWS AgentCore.

## Who does what

No new repositories. The work goes into the two existing repos; the AgentCore
pieces are AWS resources whose code and setup live in the sandbox repo.

| Chunk | Owner | Sandbox repo (`lhnminh/mmrf-virtual-lab-sandbox`) | Frontend fork (`lhnminh/mmrf-data-commons`) | AWS resources it creates | Plan |
| --- | --- | --- | --- | --- | --- |
| **infra-3: Foundation, then chat plumbing** | Dev 3 (TBD) | Shared skeleton (deploy hooks, tool folders), agent on EKS as a fallback, end-to-end check, team docs | Chat sends the selected cohort and shows tool calls | Agent on EKS (fallback) | [docs/plans/infra-3-foundation.md](docs/plans/infra-3-foundation.md) |
| **infra-1: Agent on Runtime** | Dev 1 (TBD) | Runtime endpoints in the agent, Runtime deploy step, gateway forwards Chat to the Runtime | None | AgentCore Runtime | [docs/plans/infra-1-agentcore-runtime.md](docs/plans/infra-1-agentcore-runtime.md) |
| **infra-2: Tools on Gateway** | Dev 2 (TBD) | Lambda handler, Gateway client in the agent, Gateway deploy step | None | AgentCore Gateway and the Lambda | [docs/plans/infra-2-gateway-tools.md](docs/plans/infra-2-gateway-tools.md) |

- Upstream `theMMRF/guppy` and `theMMRF/gen3-analysis` stay unchanged. The frontend
  fork is built at the commit pinned in `sources.json` (local clone `../mmrf-data-commons`).
- Order: **infra-3's first milestone (the skeleton) merges first**, then infra-1
  and infra-2 run in parallel. Branches are named after the chunk.
- Each plan has a ready-to-paste starting prompt, its milestones (stopping
  points), the exact files it touches, and checkboxes that show its status. Stay
  in your plan's files; edit others only by agreement.
- Team milestone (the demo): the journey 1 question asked in Chat on the AWS
  sandbox URL is answered through Runtime → Gateway → Lambda, and Chat draws the
  survival chart.

## Contracts (do not change without telling the team)

1. **Tool code**: `execute(input, context) → {summary, plot}`. `context` is
   `{cohortFilter}` (the website's selection; the model never sets it). The
   model sees only `summary`; `plot` goes to the UI.
2. **Tool spec**: name, description and JSON input schema, registered in
   `agent/src/tool-catalog.mjs` under its website app. Gateway's schemas are
   exported from these specs.
3. **Agent API**: `POST /v1/prompts` with `{prompt, history?, context?: {cohortFilter}}`
   returns `{message, toolCalls: [{name, input, status, result: {summary, plot}, error?}]}`.
   Runtime's `/invocations` takes and returns the same JSON.
4. **Chat UI**: one component per tool name in the fork's
   `src/features/chat/tools/`, chosen by `toolName`; it reads `result.plot`
   (`plot.type` says what to draw).
5. **Runtime ↔ Gateway**: infra-2's Terraform outputs `agentcore_gateway_url`;
   infra-1's Runtime reads it as the agent's `AGENTCORE_GATEWAY_URL`. With it
   unset, the agent runs tools in-process (local mode).

## Commands

```sh
docker compose up -d --wait --wait-timeout 300   # start existing images, no rebuild
docker compose ps                                # all services healthy?
cd agent && npm test                             # unit tests, no AWS needed
cd agent && LIVE=1 npm test                      # plus checks against the stack on :3080
cd agent && npm run prompt -- "Compare overall survival for CGS high risk vs standard risk patients"
python3 scripts/aws_sandbox.py doctor            # AWS prerequisites
python3 scripts/aws_sandbox.py deploy            # full AWS deploy
```

Bedrock settings for local runs go in the git-ignored `agent/.env`
(see `agent/.env.example`). Expected journey 1 result: High risk 339 cases,
Standard risk 661, log-rank p = 7.1e-60.

## Rules

- Never add AI attribution (Co-Authored-By, "Generated with") to commits or PRs.
- Never commit `.claude/`, `agent/.env` or anything in `generated/`.
- Fetch and rebase on `origin/main` before starting work and before a PR;
  teammates merge often. Keep PRs small.
- Disk space is tight on developer machines. Ask before rebuilding images, build
  the frontend with the rest of the stack stopped, and run
  `docker builder prune -af` after builds.
- Data is synthetic. Results have no clinical meaning; say so in answers.
- When something can't be verified (an AWS API name, a limit), say so and add it
  to the plan's open questions rather than guessing.
