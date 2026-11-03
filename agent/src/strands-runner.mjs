import { createHttpCorrelationExecutor } from './correlation-tool.mjs';
import { parsePromptRequest } from './contract.mjs';
import { toolCatalog } from './tool-catalog.mjs';

const SYSTEM_PROMPT = `You help users operate the MMRF Virtual Lab Correlation Plot on synthetic demonstration data.
For a plot request, identify the primary and secondary variables and call correlation_plot.
If either variable is missing or ambiguous, ask a short clarifying question instead of guessing.
The cohort filter is supplied by the website; never invent, modify, or describe a filter you have not seen.
Use only tool results to describe computed findings. Do not make clinical claims.
If a tool says it is a mock or that no correlation was computed, say no real plot was generated.
The mock tool is a stand-in for development; do not infer that the dataset or real plot tool cannot compute correlations.
All data in this sandbox are synthetic. A future real tool can compute on that synthetic data; do not suggest real patient data is required.
If the plot tool fails, explain the failure plainly.`;

const CHAT_SYSTEM_PROMPT = `You are a helpful assistant in the MMRF Virtual Lab synthetic-data sandbox.
Answer general questions about the application and research concepts. Keep responses concise.
You cannot inspect the selected cohort, run analyses, or see patient-level data in this chat yet.
If asked for results or a plot, explain that those capabilities are not connected yet. Do not invent results.
Do not offer clinical advice. All sandbox data are synthetic demonstration data.`;

function messageText(message) {
  if (typeof message === 'string') return message;
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(block => typeof block?.text === 'string').map(block => block.text).join('');
}

export function createStrandsRunner({ execute = createHttpCorrelationExecutor(),
  catalog = toolCatalog,
  loadSdk = () => import('@strands-agents/sdk'),
  loadBedrock = () => import('@strands-agents/sdk/models/bedrock'),
  modelId = process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
  chatOnly = process.env.AGENT_CHAT_ONLY === '1' } = {}) {
  return async (rawRequest) => {
    const { prompt, history, context } = parsePromptRequest(rawRequest);
    const [{ Agent, tool }, { BedrockModel }] = await Promise.all([loadSdk(), loadBedrock()]);
    const toolCalls = [];
    // A fresh agent per request prevents one user's prompt history reaching another.
    const agent = new Agent({
      model: new BedrockModel({ modelId, maxTokens: 1024 }),
      systemPrompt: chatOnly ? CHAT_SYSTEM_PROMPT : SYSTEM_PROMPT,
      tools: chatOnly ? [] : catalog.createTools({
        toolFactory: tool,
        executors: { correlation_plot: execute },
        context,
        calls: toolCalls,
      }),
    });
    const conversation = history.length
      ? `Previous conversation (for context):\n${history.map(turn => `${turn.role}: ${turn.content}`).join('\n')}\nCurrent user message: ${prompt}`
      : prompt;
    const result = await agent.invoke(conversation);
    return {
      message: messageText(result.lastMessage),
      toolCalls,
    };
  };
}
