# Tasks

## 1. Catalog and survival executor

- [x] 1.1 Add `agent/src/variables.mjs` (overall survival, CGS risk category, gender, race, with synonyms, Gen3 field, values, ProteinPaint term) and a resolver; verify `npm test` covers synonyms, case-insensitivity, unknown names and ambiguous names with listed options.
- [x] 1.2 Add `agent/src/executors/survival.mjs`: build one filter per value with the request cohort, POST to `${VIRTUAL_LAB_ORIGIN}/analysis/v0/survival/`, enforce 10-case and 5-curve limits, and return `{summary, plot}`; verify tests with a recorded Gen3 response check labels, counts, p-value formatting, cohort combination and limit errors.
- [x] 1.3 Add `agent/src/executors/index.mjs` routing executor: resolve both variables, accept either order, dispatch survival pairs, and fail clearly on unsupported pairs and PFS; verify tests cover both orders and the non-survival error.
- [x] 1.4 Record the live CGS response as `agent/test/fixtures/survival-cgs.json` and add an opt-in live test (`LIVE=1`); verify it returns 339 and 661 cases with p < 0.001 against the running stack.

## 2. Agent wiring

- [x] 2.1 Default `createStrandsRunner`'s `execute` to the routing executor when `CORRELATION_TOOL_URL` is unset; verify a fake-agent test shows a CGS prompt's tool call returns a survival `plot`, and existing scaffold tests still pass.
- [ ] 2.2 Add `POST /v1/correlation` to `http.mjs`, serving the routing executor with the scaffold's HTTP contract; verify a test shows `createHttpCorrelationExecutor` pointed at it returns the same result as the in-process call.
- [x] 2.3 Extend the system prompt with survival guidance and the quote-only-summary rule; verify `npm run prompt -- "Compare survival for CGS high risk vs standard risk"` (real executor; `smoke:bedrock` always uses the mock tool) with the stack running completes a `correlation_plot` call with `plot.type === "survival"`.
- [ ] 2.4 Update `agent/README.md`: survival support, catalog, `VIRTUAL_LAB_ORIGIN`, `/v1/correlation`, and the `plot` schema for the UI; verify the README's curl examples run as written.

## 3. Local stack

- [ ] 3.1 Add `agent/Dockerfile` and an `agent` service to `compose.yaml` (no host port, `AGENT_HOST=0.0.0.0`, `VIRTUAL_LAB_ORIGIN=http://identity:8080`, optional `agent/.env`, health check on `/health`); verify `docker compose up -d --wait` reports it healthy without Bedrock credentials.
- [ ] 3.2 Route `/agent/*` in `identity/server.mjs` to `http://agent:8787` with the prefix stripped, and add `agent` to the origin allowlist; verify a new test in `tests/` shows `/agent/v1/prompts` reaches a stub upstream at `/v1/prompts`.
- [ ] 3.3 Document the chat UI contract in `docs/agent-api.md`: request, response, mapping to assistant-ui `LocalRuntime` tool-call parts, and rendering `plot` with `SurvivalPlot`; verify a UI teammate has reviewed it.

## 4. End-to-end check

- [ ] 4.1 With Bedrock access, post the CGS prompt to `http://localhost:3080/agent/v1/prompts`; verify the response has a survival plot with 339 and 661 cases and a message quoting the same numbers.
- [ ] 4.2 Repeat with `context.cohortFilter` for female cases; verify the counts sum to the female case count.

## Workflow follow-up

- Phase 2 (separate change): streaming responses, multi-turn history, Helm and AWS deployment with an IAM role for Bedrock, and a catalog drift check.
