"""AgentCore Runtime entry point for the Virtual Lab agent, speaking AG-UI."""
import os

from ag_ui_strands import StrandsAgent, StrandsAgentConfig, ToolBehavior
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
from strands import Agent
from strands.models import BedrockModel
from strands.tools.executors import SequentialToolExecutor
from strands.tools.mcp import MCPClient

from cohort import UPDATE_TOOL, CohortHooks, prompt_context, state_from_update
from runs import LazyAdapter, handle_run

REGION = os.environ["AGENT_REGION"]
MAX_TOKENS = 1024
GATEWAY_TIMEOUT_SECONDS = 60

# Don't enable tracing without redacting cohortFilter. Tool spans record the tool call
# after CohortHooks adds it, so they would hold filters, which can hold case IDs.

SYSTEM_PROMPT = """You help researchers explore the MMRF Virtual Lab, which holds synthetic demonstration data.

Before any tool runs, write a one-line plan. If the question changes who's in the cohort, call update_cohort first, then call the other tools.
Comparing groups doesn't change who's in the cohort. When the researcher compares groups, such as high risk vs standard risk, call show_survival with compareBy and leave the cohort as it is. When they ask about one group only, such as survival for high-risk patients, call update_cohort first, then show_survival without compareBy.
If a P-value shows 0, say what the summary says and never write p = 0.

Quote only numbers that appear in a tool result's summary, exactly as given and with the unit the summary gives it. Never estimate or calculate others. Cases and samples are different things: state cases and samples separately, and never treat one as the other.

Write the answer in these sections:
Observed: what the tool results show.
Limits: always include this. Say the data is synthetic and has no clinical meaning, and say "Numbers are for the default view and don't reflect changes made in the chart." Add anything specific to this result.
Interpretation: only if the researcher asks for it, and labelled separately from Observed.

Only when the latest researcher message says the researcher changed the cohort outside chat, start the answer to that message with "Now using: " followed by the cohort's name and case count. Otherwise never write "Now using", even if an earlier answer did. The selected cohort's case count, given in the message, is the only number you may quote from outside a summary.

If a tool's status is error, report it as a failure and don't guess a result. If an earlier cohort change in this answer succeeded, say that it still applies.
If update_cohort returns ambiguous, ask one question that offers its options, and don't run other tools until it's answered.
Other statuses, such as none_in_cohort, are results and not failures: report them as they are.

Follow-up buttons appear under some charts, so don't repeat them in your answer. Keep answers short."""


# The adapter keeps the template's tools but not the template. If the template were
# collected, Agent.__del__ would stop the MCP client those tools need.
_templates = []


def build_adapter() -> StrandsAgent:
    template = Agent(
        model=BedrockModel(model_id=os.environ["MODEL_ID"], region_name=REGION, max_tokens=MAX_TOKENS),
        system_prompt=SYSTEM_PROMPT,
        # One at a time, so a tool asked for alongside update_cohort gets the new cohort.
        tool_executor=SequentialToolExecutor(),
        tools=[
            MCPClient(
                lambda: aws_iam_streamablehttp_client(
                    endpoint=os.environ["GATEWAY_URL"],
                    aws_region=REGION,
                    aws_service="bedrock-agentcore",
                    timeout=GATEWAY_TIMEOUT_SECONDS,
                )
            )
        ],
    )
    _templates.append(template)
    return StrandsAgent(
        agent=template,
        name="virtual-lab",
        description="Virtual Lab assistant",
        hooks=[CohortHooks()],
        config=StrandsAgentConfig(
            state_context_builder=prompt_context,
            tool_behaviors={UPDATE_TOOL: ToolBehavior(state_from_result=state_from_update)},
        ),
    )


# One adapter per process: its guard against overlapping runs works per instance.
ADAPTER = LazyAdapter(build_adapter)

app = BedrockAgentCoreApp()


@app.entrypoint
async def invocations(payload, context):
    async for event in handle_run(payload, ADAPTER):
        yield event


if __name__ == "__main__":
    app.run()
