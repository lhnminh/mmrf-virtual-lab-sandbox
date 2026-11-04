// Runs the agent over AG-UI, the protocol the Chat page speaks. Turns one request
// into wire events. The cohort stays out of the model: tools get it from here.
import { randomUUID } from 'node:crypto';
import { createVirtualLabFetch } from './virtual-lab-fetch.mjs';
import { registeredTools } from './tools/index.mjs';
import {
  createKnowledgeGraphClient, KNOWLEDGE_GRAPH_PROMPT, KNOWLEDGE_GRAPH_TOOL_SPECS, modelView,
} from './knowledge-graph.mjs';

const TOOL_PREFIX = 'virtual-lab___';
const KG_PREFIX = 'kg-graph___';
const UPDATE_TOOL = 'update_cohort';
const REPLACED_TOOLS = new Set(['correlation_plot', 'top_mutated_genes']); // show_survival and show_oncomatrix.
const FAILURE_MESSAGE = 'The agent could not finish this run.';
const HIDDEN_LABEL = 'Selected cases';
const LABEL_LIMIT = 200;
const MAX_TOKENS = 4096;

export const SYSTEM_PROMPT = `You help researchers explore the MMRF Virtual Lab, which holds synthetic demonstration data.

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

Follow-up buttons appear under some charts, so don't repeat them in your answer. Keep answers short.`;

export function cohortFromState(state) {
  const cohort = state?.cohort;
  return cohort && typeof cohort === 'object' && !Array.isArray(cohort) && 'filter' in cohort ? { ...cohort } : null;
}

const revisionOf = cohort => (Number.isInteger(cohort?.revision) ? cohort.revision : 0);
const hasCaseIds = text => text.toUpperCase().includes('SYNTH-');

function withoutFilters(value) {
  if (Array.isArray(value)) return value.map(withoutFilters);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'filter')
    .map(([key, item]) => [key, withoutFilters(item)]));
}

/** The result without a filter at any depth, with the cohort's revision. */
export function cleanResult(result, revision) {
  const clean = withoutFilters(result);
  if (clean.cohort && typeof clean.cohort === 'object') {
    clean.cohort = { ...clean.cohort, revision };
    if (typeof clean.cohort.label === 'string' && hasCaseIds(clean.cohort.label)) clean.cohort.label = HIDDEN_LABEL;
  }
  return clean;
}

function safeLabel(cohort) {
  const { label } = cohort;
  if (typeof label !== 'string' || hasCaseIds(label)) return null;
  return label.split(/\s+/).filter(Boolean).join(' ').slice(0, LABEL_LIMIT) || null;
}

/** The researcher's message plus what the model may know about the cohort. */
export function promptWithCohort(message, cohort) {
  if (!cohort) return message;
  const label = safeLabel(cohort);
  const facts = [label ? `Selected cohort: ${label}.` : 'Selected cohort: no name available.'];
  if (Number.isInteger(cohort.caseCount)) facts.push(`Cases: ${cohort.caseCount}.`);
  if (cohort.changedOutsideChat === true) {
    facts.push('The researcher changed the cohort outside chat, so start your answer to this message with "Now using: " then this cohort\'s name and case count.');
  }
  return `${message}\n\n[${facts.join(' ')}]`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}

/** The latest user message, and the text turns before it, alternating from a user turn. */
export function conversationFrom(messages) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter(item => ['user', 'assistant'].includes(item?.role))
    .map(item => ({ role: item.role, text: textOf(item.content).trim() }))
    .filter(item => item.text);
  const last = turns.pop();
  if (last?.role !== 'user') throw new TypeError('The run needs a user message');
  const history = [];
  for (const turn of turns) {
    const previous = history.at(-1);
    if (previous?.role === turn.role) previous.text += `\n${turn.text}`;
    else if (history.length || turn.role === 'user') history.push({ ...turn });
  }
  if (history.at(-1)?.role === 'user') history.pop();
  return { prompt: last.text, history: history.map(turn => ({ role: turn.role, content: [{ text: turn.text }] })) };
}

export function defaultTools({ env = process.env } = {}) {
  const origin = env.VIRTUAL_LAB_ORIGIN || 'http://127.0.0.1:3080';
  const fetchImpl = createVirtualLabFetch({ origin });
  const tools = registeredTools.filter(item => !REPLACED_TOOLS.has(item.spec.name)).map(item => ({
    spec: item.spec, wireName: TOOL_PREFIX + item.spec.name, execute: item.createExecutor({ origin, fetchImpl }),
  }));
  if (!env.KG_GATEWAY_URL) return tools;
  const callTool = createKnowledgeGraphClient();
  return [...tools, ...KNOWLEDGE_GRAPH_TOOL_SPECS.map(spec => ({
    spec, wireName: KG_PREFIX + spec.name, forModel: modelView,
    execute: async input => ({ status: 'ok', ...await callTool(spec.name, input) }),
  }))];
}

function promptFor(tools) {
  const knowledgeGraph = tools.some(tool => tool.wireName.startsWith(KG_PREFIX));
  const expression = tools.some(tool => tool.spec.name === 'differential_expression');
  return [SYSTEM_PROMPT,
    ...(expression ? ['For differential gene expression between two groups, call differential_expression.'] : []),
    ...(knowledgeGraph ? [KNOWLEDGE_GRAPH_PROMPT] : [])].join('\n\n');
}

export function createAgUiRunner({ tools = null,
  loadSdk = () => import('@strands-agents/sdk'),
  loadBedrock = () => import('@strands-agents/sdk/models/bedrock'),
  modelId = process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
  log = console.error, newId = randomUUID } = {}) {
  return async function* run(input) {
    const threadId = typeof input?.threadId === 'string' ? input.threadId : newId();
    const runId = typeof input?.runId === 'string' ? input.runId : newId();
    let cohort = cohortFromState(input?.state);
    yield { type: 'RUN_STARTED', threadId, runId, protocolVersion: '1.0' };
    yield { type: 'STATE_SNAPSHOT', snapshot: cohort ? { cohort } : {} };
    const queued = [];
    const started = []; // Tools run one at a time, in the order the model asked for them.
    let textId = null;
    let toolId = null;
    try {
      const { prompt, history } = conversationFrom(input?.messages);
      const available = tools ?? defaultTools();
      const byName = new Map(available.map(tool => [tool.spec.name, tool]));
      const [{ Agent, tool: toolFactory }, { BedrockModel }] = await Promise.all([loadSdk(), loadBedrock()]);
      const finish = (value, forModel) => {
        const toolCallId = started.shift();
        queued.push({ type: 'TOOL_CALL_RESULT', messageId: newId(), toolCallId, role: 'tool', content: JSON.stringify(value) });
        return forModel;
      };
      const agent = new Agent({
        model: new BedrockModel({ modelId, maxTokens: MAX_TOKENS }),
        systemPrompt: promptFor(available),
        messages: history,
        toolExecutor: 'sequential',
        printer: false,
        tools: available.map(({ spec, execute, forModel }) => toolFactory({
          ...spec,
          callback: async rawInput => {
            let result;
            try {
              result = await execute(rawInput, { cohortFilter: cohort?.filter ?? null });
            } catch (error) {
              log(`Tool ${spec.name} failed:`, error);
              result = { status: 'error', summary: 'The tool could not finish.' };
            }
            const changed = spec.name === UPDATE_TOOL && result?.status === 'ok' && 'filter' in result;
            const revision = revisionOf(cohort) + (changed ? 1 : 0);
            const clean = cleanResult(result, revision);
            const reply = finish(clean, forModel ? forModel(clean) : clean);
            if (changed) {
              cohort = { filter: result.filter, label: clean.cohort.label, caseCount: clean.cohort.caseCount,
                revision, changes: result.changes };
              queued.push({ type: 'STATE_SNAPSHOT', snapshot: { cohort } });
            }
            return reply;
          },
        })),
      });
      for await (const event of agent.stream(promptWithCohort(prompt, cohort))) {
        if (event?.type === 'modelStreamUpdateEvent') {
          const part = event.event;
          if (part.type === 'modelContentBlockStartEvent' && part.start?.type === 'toolUseStart') {
            if (textId) { yield { type: 'TEXT_MESSAGE_END', messageId: textId }; textId = null; }
            toolId = part.start.toolUseId;
            started.push(toolId);
            const known = byName.get(part.start.name);
            yield { type: 'TOOL_CALL_START', toolCallId: toolId, toolCallName: known?.wireName ?? part.start.name };
          } else if (part.type === 'modelContentBlockDeltaEvent' && part.delta?.type === 'textDelta' && part.delta.text) {
            if (!textId) {
              textId = newId();
              yield { type: 'TEXT_MESSAGE_START', messageId: textId, role: 'assistant' };
            }
            yield { type: 'TEXT_MESSAGE_CONTENT', messageId: textId, delta: part.delta.text };
          } else if (part.type === 'modelContentBlockDeltaEvent' && part.delta?.type === 'toolUseInputDelta' && toolId) {
            yield { type: 'TOOL_CALL_ARGS', toolCallId: toolId, delta: part.delta.input };
          } else if (part.type === 'modelContentBlockStopEvent' && toolId) {
            yield { type: 'TOOL_CALL_END', toolCallId: toolId };
            toolId = null;
          }
        }
        while (queued.length) yield queued.shift();
      }
      while (queued.length) yield queued.shift();
      if (textId) yield { type: 'TEXT_MESSAGE_END', messageId: textId };
      yield { type: 'STATE_SNAPSHOT', snapshot: cohort ? { cohort } : {} };
      yield { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'success' } };
    } catch (error) {
      log('Agent run failed:', error);
      if (textId) yield { type: 'TEXT_MESSAGE_END', messageId: textId };
      yield { type: 'RUN_ERROR', code: 'AGENT_ERROR', message: FAILURE_MESSAGE };
    }
  };
}
