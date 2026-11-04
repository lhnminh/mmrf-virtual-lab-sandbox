# Spec Delta

## Purpose

Provides the prompt endpoint through which the Virtual Lab chat UI sends a plain-language request to the agent and receives its reply together with structured plot results.

## ADDED Requirements

### Requirement: Prompt endpoint returns message and tool calls
The service SHALL accept `POST /v1/prompts` with `{prompt, context?: {cohortFilter?}}` and respond with JSON `{message, toolCalls}`, where each tool call has its name, validated input, status, and on success a result with `summary` and optional `plot`.

#### Scenario: Successful survival prompt
- **WHEN** a client posts a prompt asking to compare survival by CGS risk
- **THEN** the response has a `message` and one successful `correlation_plot` tool call whose `result.plot` holds the survival curves

#### Scenario: Invalid request
- **WHEN** the body is not JSON, the prompt is empty, or `cohortFilter` is not an object
- **THEN** the service responds 400 with a readable error

#### Scenario: Agent failure
- **WHEN** the model or tool infrastructure fails
- **THEN** the service responds 502 with a generic error and no stack trace or credentials

### Requirement: Selected cohort comes from the website
The cohort filter SHALL come only from `context.cohortFilter` in the request, and every data call in that request MUST be limited to the cases it selects. The model MUST NOT be able to set or change it.

#### Scenario: Cohort supplied
- **WHEN** a request includes a cohort filter selecting female cases
- **THEN** survival results count only female cases

#### Scenario: No cohort supplied
- **WHEN** a request omits the cohort filter
- **THEN** tools run over all cases

### Requirement: Reachable through the gateway
In the local stack the service SHALL be reachable through the identity gateway at `/agent/*`, mapped to the service's own paths, and MUST NOT be published on a host port.

#### Scenario: Request via gateway
- **WHEN** a client posts to `http://localhost:3080/agent/v1/prompts`
- **THEN** the gateway forwards it to the agent's `/v1/prompts` and returns the agent's response

### Requirement: Health reporting
The service SHALL expose `GET /health` that reports OK without calling the model.

#### Scenario: Health check without model access
- **WHEN** Compose checks health and no Bedrock credentials are configured
- **THEN** the health endpoint still returns OK
