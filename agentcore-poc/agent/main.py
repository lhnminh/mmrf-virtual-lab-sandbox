"""AgentCore Runtime entry point for the Virtual Lab agent, speaking AG-UI."""
import os

from ag_ui_strands import StrandsAgent
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient

from runs import LazyAdapter, handle_run

REGION = os.environ["AGENT_REGION"]
MAX_TOKENS = 1024

SYSTEM_PROMPT = """You help researchers check the MMRF Virtual Lab, which holds synthetic demonstration data.
For now you can only check Virtual Lab health. You can't run analyses, build cohorts or draw charts; say so if asked.
Answer only from tool results. Quote numbers exactly as the tool gives them, and never estimate others.
If a tool reports a failure, report it as a failure and don't guess a result.
Say that the data is synthetic and has no clinical meaning. Keep answers short."""


# The adapter keeps the template's tools but not the template. If the template were
# collected, Agent.__del__ would stop the MCP client those tools need.
_templates = []


def build_adapter() -> StrandsAgent:
    template = Agent(
        model=BedrockModel(model_id=os.environ["MODEL_ID"], region_name=REGION, max_tokens=MAX_TOKENS),
        system_prompt=SYSTEM_PROMPT,
        tools=[
            MCPClient(
                lambda: aws_iam_streamablehttp_client(
                    endpoint=os.environ["GATEWAY_URL"],
                    aws_region=REGION,
                    aws_service="bedrock-agentcore",
                )
            )
        ],
    )
    _templates.append(template)
    return StrandsAgent(agent=template, name="virtual-lab", description="Virtual Lab assistant")


# One adapter per process: its guard against overlapping runs works per instance.
ADAPTER = LazyAdapter(build_adapter)

app = BedrockAgentCoreApp()


@app.entrypoint
async def invocations(payload, context):
    async for event in handle_run(payload, ADAPTER):
        yield event


if __name__ == "__main__":
    app.run()
