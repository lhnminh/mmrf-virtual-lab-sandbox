# Design

## Context

See `proposal.md` for motivation. Current state:

- **Agent scaffold (`agent/`, merged in a9aa210 and extended in PR #2):** Node 22 with the Strands TypeScript SDK 1.23.
  - `strands-runner.mjs` creates a fresh `Agent` per request with a Bedrock model. Tools come from the registry in `tool-catalog.mjs` (`catalog.createTools({toolFactory, executors, context, calls})`), which currently registers one tool, `correlation_plot` (spec `CORRELATION_TOOL_SPEC` in `correlation-tool.mjs`). `GET /v1/tools` lists the website apps and their registered tools.
  - The tool calls an injected `execute(input, context)`, where `input` is `{primaryVariable, secondaryVariable}` and `context` is `{cohortFilter}`. It expects `{summary, plot?}` back (`contract.mjs`).
  - The model sees only `summary`. The runner returns `{message, toolCalls}`, and each call carries the full `result`.
  - Default `execute` posts to `CORRELATION_TOOL_URL` or fails when it is unset. `mockCorrelationExecutor` exists for tests.
  - `http.mjs` serves `POST /v1/prompts`, `GET /v1/tools` and `GET /health` on `127.0.0.1:8787`. The service is not in Compose or the gateway.
- **Data:** `POST /analysis/v0/survival/` through the gateway takes `{filters: [...]}`, one per curve, and returns `{results: [{meta, donors}], overallStats: {pValue, degreesFreedom}}`. Verified with CGS filters: 339 and 661 cases, p = 7.1e-60. Time is in days.
- **Frontend (`mmrf-data-commons@27cf09a`):** `SurvivalPlot` renders `{survivalData, overallStats}` with `names`. Limits: `MINIMUM_CASES = 10`, `MAXIMUM_CURVES = 5`.

## Goals / Non-Goals

**Goals:**
- Journey 1 works end to end through the existing `correlation_plot` tool with real data.
- Minimal changes to the scaffold's structure and contracts.
- An executor pattern later pairs (expression, mutation, age) extend.

**Non-Goals:**
- Streaming, multi-turn history, the chat UI, Helm/AWS (phase 2).

## Decisions

**1. Implement survival as an executor for `correlation_plot`, not a new tool.**
The journey names the Correlation Plot tool, and the scaffold already defines its tool contract and system prompt. A routing executor (`src/executors/index.mjs`) resolves both variables through the catalog and dispatches by pair type. Survival is the first handler (`src/executors/survival.mjs`); other pairs fail with "not supported yet". *Alternative:* a separate `plot_survival` tool (clearer schema, but it duplicates the correlation entry point and the prompt).

**2. Executor wiring.**
`createStrandsRunner` already accepts `execute` and passes it to the registry as `executors.correlation_plot`. Its default is now `defaultExecutor()`: the in-process routing executor when `CORRELATION_TOOL_URL` is unset, and the HTTP executor when it is set. The registry and tool spec are unchanged. A small `POST /v1/correlation` route on the same server exposes the routing executor with the scaffold's HTTP contract, so a teammate's service or the agent itself can use it over HTTP. The mock executor stays for tests and `smoke:bedrock`.

**3. Variable catalog.**
`src/variables.mjs` (named to avoid confusion with the app/tool registry in `tool-catalog.mjs`) holds entries `{key, label, synonyms, gen3Field, values, ppTerm}`. The initial entries are overall survival (outcome), CGS risk category (`cgs_risk_key_criteria.cgs_risk_category`, `cgs_risk_category`), gender and race. Matching normalizes case and punctuation and checks the label and synonyms. More than one match is ambiguous. Adding a field is one entry.

**4. Gen3 survival, through the gateway.**
The handler builds `filters = values.map(v => cohort ? {and: [cohort, {in: {[gen3Field]: [v]}}]} : {in: {[gen3Field]: [v]}})` and posts them to `${VIRTUAL_LAB_ORIGIN}/analysis/v0/survival/`. In Compose the origin is `http://identity:8080`; locally it defaults to `http://127.0.0.1:3080`. The gateway adds the synthetic token. The handler checks the group limits and then returns:
- `plot`: `{type: "survival", field, outcome: "overall_survival", unit: "days", labels, counts, survivalData: results, overallStats, correlation: {term1: "overall_survival", term2: ppTerm, filter0: cohort}}`
- `summary`: "Overall survival by CGS risk category: High risk n=339, Standard risk n=661; log-rank p=7.1e-60. Synthetic data with no clinical meaning." With a cohort, it adds "Limited to the selected cohort."

The p-value is formatted to two significant figures. *Alternative:* ProteinPaint `termdb/survival` (exact Correlation-tool parity, but needs a new renderer and returns `"0"` as the p-value).

**5. Response size.**
`createHttpCorrelationExecutor` rejects responses over 1 MiB. A 1,000-case survival plot is about 150 KB (about 300 KB as a full `/v1/prompts` response), so this is fine now. Dropping `submitter_id` and `project_id` from each donor would cut it by about a third without changing the chart. It is noted here because larger cohorts or more curves will approach it.

**6. System prompt.**
Added to the scaffold prompt: survival comparisons pass "overall survival" and the grouping variable to `correlation_plot`; numbers in the reply come only from the tool summary; mention when the summary says it is limited to the selected cohort.

Changed during testing: the scaffold's rule "if a tool says it is a mock … say no real plot was generated" made the model describe real results as a mock, because the summary mentions synthetic data. The rule now applies only to summaries that begin with "Mock tool"; any other successful result is real and is described as computed on synthetic data. Verified with Bedrock: the real executor's replies no longer claim a mock, and `smoke:bedrock` still reports one.

**7. Same-origin access.**
Add an `agent` service to `compose.yaml`, built from `agent/Dockerfile` (Node 22, `npm ci --omit=dev`). It listens on `0.0.0.0:8787` inside the network with no host port, and Bedrock settings come from `agent/.env` when present. The gateway forwards `/agent/*` to `http://agent:8787/*` after stripping the prefix, and `agent` is added to its origin allowlist. The chat UI calls `/agent/v1/prompts`.

**8. Chat UI contract (non-streaming).**
assistant-ui's `LocalRuntime` with a custom `ChatModelAdapter` calls `/agent/v1/prompts` with the latest user message and the selected cohort, then maps the response:
- `message` becomes text.
- Each successful `toolCalls[i]` becomes a tool-call part named `correlation_plot` with `result.plot`.

A tool UI registered for `correlation_plot` renders `SurvivalPlot` when `plot.type === "survival"`. Streaming and history can be added later without changing executors.

## Risks / Trade-offs

- [Single-turn requests: follow-ups like "now only for women" lose context] → Acceptable for the demo. The UI can resend the prior prompt. History is phase 2.
- [Variable matching misses user wording] → Synonyms in the catalog, plus the scaffold prompt already asks the model to clarify ambiguous variables. Errors list the options so the model can retry.
- [The model misreports numbers] → It sees only the summary, which already has the numbers, and the chart is drawn from data.
- [Teammate builds a different correlation service] → The executor is reachable over the same HTTP contract, so either side can call the other.
- [Survival chart differs from the Correlation tool's (days and Gen3 styling)] → Same cohorts and counts. The `correlation` settings support an exact-parity link.

## Migration Plan

Additive. Rollback is reverting the executor wiring (the default falls back to `CORRELATION_TOOL_URL`) and removing the Compose service and gateway route.

## Open Questions

- Bedrock model id for the hackathon account (configuration only; the scaffold defaults to `global.anthropic.claude-sonnet-4-6`).
