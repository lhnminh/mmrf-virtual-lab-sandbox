import { createCorrelationTool, createHttpCorrelationExecutor } from './correlation-tool.mjs';
import { parsePromptRequest } from './contract.mjs';

const SYSTEM_PROMPT = `You help users operate the MMRF Virtual Lab Correlation Plot on synthetic demonstration data.
For a plot request, identify the primary and secondary variables and call correlation_plot.
If either variable is missing or ambiguous, ask a short clarifying question instead of guessing.
The cohort filter is supplied by the website; never invent, modify, or describe a filter you have not seen.
Use only tool results to describe computed findings. Do not make clinical claims.
If a tool says it is a mock or that no correlation was computed, say no real plot was generated.
The mock tool is a stand-in for development; do not infer that the dataset or real plot tool cannot compute correlations.
If the plot tool fails, explain the failure plainly.`;

function messageText(message) {
  if (typeof message === 'string') return message;
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(block => typeof block?.text === 'string').map(block => block.text).join('');
}

export function createStrandsRunner({ execute = createHttpCorrelationExecutor(),
  loadSdk = () => import('@strands-agents/sdk'),
  loadBedrock = () => import('@strands-agents/sdk/models/bedrock'),
  modelId = process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6' } = {}) {
  return async (rawRequest) => {
    const { prompt, context } = parsePromptRequest(rawRequest);
    const [{ Agent, tool }, { BedrockModel }] = await Promise.all([loadSdk(), loadBedrock()]);
    const toolCalls = [];
    // A fresh agent per request prevents one user's prompt history reaching another.
    const agent = new Agent({
      model: new BedrockModel({ modelId, maxTokens: 1024 }),
      systemPrompt: SYSTEM_PROMPT,
      tools: [createCorrelationTool({ toolFactory: tool, execute, context, calls: toolCalls })],
    });
    const result = await agent.invoke(prompt);
    return {
      message: messageText(result.lastMessage),
      toolCalls,
    };
  };
}
