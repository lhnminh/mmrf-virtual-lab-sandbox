import { createHttpCorrelationExecutor } from './correlation-tool.mjs';
import { parsePromptRequest } from './contract.mjs';
import { toolCatalog } from './tool-catalog.mjs';
import { createRoutingExecutor } from './executors/index.mjs';
import { KNOWLEDGE_GRAPH_PROMPT } from './knowledge-graph.mjs';
import { createSurvivalHandler } from './executors/survival.mjs';
import { createExecutors, registeredTools } from './tools/index.mjs';
import { createVirtualLabFetch } from './virtual-lab-fetch.mjs';
import { createGatewayClient } from './gateway-client.mjs';

// A teammate's correlation service takes over when CORRELATION_TOOL_URL is set.
export function defaultExecutor() {
  if (process.env.CORRELATION_TOOL_URL) return createHttpCorrelationExecutor();
  const origin = process.env.VIRTUAL_LAB_ORIGIN || 'http://127.0.0.1:3080';
  return createRoutingExecutor({
    survival: createSurvivalHandler({ origin, fetchImpl: createVirtualLabFetch({ origin }) }),
  });
}

const SYSTEM_PROMPT = `You help users operate the MMRF Virtual Lab tools on synthetic demonstration data.
You can also answer general questions about the application and research concepts, concisely.
Choose the registered tool that matches the user's requested analysis.
Act only on the latest user message. Earlier conversation turns are context, not pending requests; do not rerun their tool calls unless the latest message explicitly asks you to.
For survival or Kaplan-Meier comparisons, pass "overall survival" as one variable and the grouping variable (for example "CGS risk category") as the other.
Quote numbers such as group sizes and p-values exactly as the tool summary gives them; do not compute or estimate others.
If either variable is missing or ambiguous, ask a short clarifying question instead of guessing.
The cohort filter is supplied by the website; never invent, modify, or describe a filter you have not seen.
Use only tool results to describe computed findings. Do not make clinical claims.
Only a tool summary that begins with "Mock tool" comes from the development stand-in; then say no real plot was generated.
Any other successful result is a real computation shown to the user as a plot; note that the data is synthetic, not that the result is a mock.
If the summary says it is limited to the selected cohort, say so.
All data in this sandbox are synthetic; do not suggest real patient data is required.
If a tool fails, explain the failure plainly.`;

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

export function createStrandsRunner({ execute,
  executors,
  catalog = toolCatalog,
  loadSdk = () => import('@strands-agents/sdk'),
  loadBedrock = () => import('@strands-agents/sdk/models/bedrock'),
  modelId = process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
  chatOnly = process.env.AGENT_CHAT_ONLY === '1',
  knowledgeGraph = Boolean(process.env.KG_GATEWAY_URL) } = {}) {
  const origin = process.env.VIRTUAL_LAB_ORIGIN || 'http://127.0.0.1:3080';
  const localExecutors = executors || createExecutors({
    origin, fetchImpl: createVirtualLabFetch({ origin }),
  });
  if (execute) localExecutors.correlation_plot = execute;
  const gateway = !executors && !execute && process.env.AGENTCORE_GATEWAY_URL
    ? createGatewayClient() : null;
  const selectedExecutors = gateway
    ? Object.fromEntries(Object.keys(localExecutors).map(name => [name, (input, context) => gateway(name, input, context)]))
    : localExecutors;
  return async (rawRequest) => {
    const { prompt, history, context } = parsePromptRequest(rawRequest);
    const [{ Agent, tool }, { BedrockModel }] = await Promise.all([loadSdk(), loadBedrock()]);
    const toolCalls = [];
    // A fresh agent per request prevents one user's prompt history reaching another.
    const agent = new Agent({
      // Knowledge graph answers cite evidence and run to several tool calls.
      model: new BedrockModel({ modelId, maxTokens: knowledgeGraph && !chatOnly ? 4096 : 1024 }),
      systemPrompt: chatOnly ? CHAT_SYSTEM_PROMPT : [SYSTEM_PROMPT,
        ...registeredTools.map(item => item.promptGuidance),
        ...(knowledgeGraph ? [KNOWLEDGE_GRAPH_PROMPT] : [])].join('\n'),
      messages: history.map(turn => ({ role: turn.role, content: [{ text: turn.content }] })),
      tools: chatOnly ? [] : await catalog.createTools({
        toolFactory: tool,
        executors: selectedExecutors,
        context,
        calls: toolCalls,
      }),
    });
    const result = await agent.invoke(prompt);
    return {
      message: messageText(result.lastMessage),
      toolCalls,
    };
  };
}
