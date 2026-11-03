# Proposal

## Why

Hackathon Workstream 2 (Agent Orchestration) adds a chat interface to the Virtual Lab. User Journey 1 is "Using the Correlation Plot tool, perform Kaplan-Meier survival analysis to overlay outcomes of CGS high-risk versus CGS standard-risk patients." The merged agent scaffold (`agent/`) has a Strands agent with a `correlation_plot` tool, but its executor is a mock or an unconfigured URL, so no real plot is computed. This change supplies the first real executor, for survival, and makes the agent reachable from the frontend.

## What Changes

- Add a survival executor for the existing `correlation_plot` tool. When one variable is overall survival and the other is a supported grouping field, it computes Kaplan-Meier curves through the existing Gen3 survival endpoint (`POST /analysis/v0/survival/`) and returns `{summary, plot}` per the scaffold's tool contract.
- Return the plot in the shape the frontend's native `SurvivalPlot` component already renders, plus labels, counts and settings to open the same comparison in the Correlation tool.
- Add a variable catalog (`variables.mjs`) that maps the user's variable names to dataset fields, and rejects unknown or ambiguous names with the allowed options. It is separate from the scaffold's app/tool registry (`tool-catalog.mjs`), which is unchanged.
- Narrow the scaffold system prompt's mock rule, so real results computed on synthetic data are not described as mocks.
- Make the executor usable in the agent process (default) or served at `CORRELATION_TOOL_URL`, so it can back a teammate's correlation service without duplication.
- Run the agent as a Compose service and route `/agent/*` through the identity gateway, so the frontend calls it same-origin.
- Keep the scaffold's non-streaming `POST /v1/prompts` contract. The assistant-ui chat panel (built concurrently) consumes it through a custom adapter and renders `toolCalls[].result.plot`.

Phase 1 is local Docker Compose only, in this repository. Deferred: response streaming, multi-turn history, Helm and AWS deployment, and catalog drift checks.

Out of scope: building the chat UI, non-survival correlation pairs (they return "not supported yet"), progression-free survival, and changes to the synthetic data.

## Capabilities

### New Capabilities
- `agent-chat-service`: the prompt endpoint contract as consumed by the frontend, gateway routing, and the Compose service.
- `survival-analysis-tool`: survival requests through `correlation_plot`, the variable catalog, and the survival plot result.

### Modified Capabilities

None. `openspec/specs/` is empty.

## Impact

- Changed: `agent/src/` (new `executors/` and `variables.mjs`; default executor and system prompt in `strands-runner.mjs`), `agent/test/`, `agent/.env.example`, `agent/README.md`.
- New: `agent/Dockerfile`, an `agent` service in `compose.yaml`.
- Changed: `identity/server.mjs` (route `/agent/*`), `tests/` (gateway route test), `docs/`.
- Dependencies: none beyond the scaffold's `@strands-agents/sdk`; Bedrock access for non-mock runs.
- Integration: the chat UI renders `plot` with `SurvivalPlot` (`src/features/charts/SurvivalPlot` in `mmrf-data-commons`).
- Read-only. Existing services and data are unchanged.
