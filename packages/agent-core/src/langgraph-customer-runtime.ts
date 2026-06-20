import { END, START, StateGraph } from '@langchain/langgraph';

import type { AgentRoute, ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  type AnalyzeTransactionOutput,
} from '@xxyy/rag-core';

import {
  AGENT_MAX_STEPS_DEFAULT,
  AgentStateAnnotation,
  createInitialAgentState,
  isAllowedAgentToolName,
  normalizeAgentRoute,
  type AgentEvidence,
  type AgentPlan,
  type AgentPolicyDecision,
  type AgentState,
} from './langgraph-state.js';
import type { PlannerModel, PlannerToolDescriptor } from './planner-model.js';
import type { ToolContext, ToolRegistry } from './tool-registry.js';

export interface CustomerAgentRuntime {
  ask(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface CreateLangGraphCustomerRuntimeOptions {
  maxSteps?: number;
  planner: PlannerModel;
  registry: ToolRegistry;
}

type CustomerRuntimeNode = 'answer_composer' | 'planner' | 'policy_guard' | 'tool_executor';

type LangGraphAgentState = Omit<
  AgentState,
  'finalResponse' | 'plan' | 'policyDecision' | 'route'
> & {
  finalResponse: ChatResponse | undefined;
  plan: AgentPlan | undefined;
  policyDecision: AgentPolicyDecision | undefined;
  route: AgentRoute | undefined;
};

const BOUNDARY_INTENTS = new Set([
  'investment_advice',
  'mev_or_chain_forensics',
  'realtime_account_query',
]);

export function createLangGraphCustomerRuntime(
  options: CreateLangGraphCustomerRuntimeOptions,
): CustomerAgentRuntime {
  const maxSteps = options.maxSteps ?? AGENT_MAX_STEPS_DEFAULT;
  const graph = createCustomerGraph(options);

  async function ask(request: ChatRequest): Promise<ChatResponse> {
    const finalState = (await graph.invoke(
      createInitialAgentState(request, { maxSteps }),
    )) as LangGraphAgentState;

    return finalState.finalResponse ?? createClarificationResponse('无法生成可靠回答。');
  }

  return {
    ask,

    async *stream(request) {
      yield* streamChatResponse(await ask(request));
    },
  };
}

function createCustomerGraph(options: CreateLangGraphCustomerRuntimeOptions) {
  return new StateGraph(AgentStateAnnotation)
    .addNode('policy_guard', policyGuardNode)
    .addNode('planner', (state) => plannerNode(state, options))
    .addNode('tool_executor', (state) => toolExecutorNode(state, options.registry))
    .addNode('answer_composer', answerComposerNode)
    .addEdge(START, 'policy_guard')
    .addConditionalEdges('policy_guard', routeAfterPolicyGuard)
    .addConditionalEdges('planner', routeAfterPlanner)
    .addEdge('tool_executor', 'answer_composer')
    .addEdge('answer_composer', END)
    .compile();
}

function policyGuardNode(state: LangGraphAgentState): Partial<AgentState> {
  const classification = classifyQuestion(state.request.message);
  if (!BOUNDARY_INTENTS.has(classification.intent)) {
    return {
      policyDecision: { action: 'continue' },
    };
  }

  const response = withAgentRoute(createBoundaryAnswer(classification), 'boundary');
  return {
    finalResponse: response,
    policyDecision: {
      action: 'final',
      response,
    },
    route: 'boundary',
  };
}

function routeAfterPolicyGuard(state: LangGraphAgentState): CustomerRuntimeNode {
  return state.finalResponse === undefined ? 'planner' : 'answer_composer';
}

async function plannerNode(
  state: LangGraphAgentState,
  options: CreateLangGraphCustomerRuntimeOptions,
): Promise<Partial<AgentState>> {
  if (state.currentStep >= state.maxSteps) {
    return {
      finalResponse: createClarificationResponse(
        '当前问题需要更多步骤才能可靠处理，请补充更具体的问题。',
      ),
      route: 'clarify',
    };
  }

  const plan = await options.planner.plan({
    request: state.request,
    stateSummary: summarizeState(state),
    tools: listPlannerTools(options.registry),
  });

  return {
    currentStep: state.currentStep + 1,
    plan,
    route: normalizeAgentRoute(plan.route),
  };
}

function routeAfterPlanner(state: LangGraphAgentState): CustomerRuntimeNode {
  if (state.finalResponse !== undefined) {
    return 'answer_composer';
  }

  return state.plan?.kind === 'tool' ? 'tool_executor' : 'answer_composer';
}

async function toolExecutorNode(
  state: LangGraphAgentState,
  registry: ToolRegistry,
): Promise<Partial<AgentState>> {
  const plan = state.plan;
  if (plan?.kind !== 'tool') {
    return {};
  }

  if (!isAllowedAgentToolName(plan.toolName)) {
    return {
      errors: [`Unauthorized tool requested: ${String(plan.toolName)}`],
      finalResponse: createClarificationResponse(
        '当前请求无法用已授权工具可靠处理，请补充 XXYY 产品功能、配置步骤或单笔公开交易哈希。',
      ),
      route: 'clarify',
    };
  }

  const output = await registry.execute(
    plan.toolName,
    plan.input,
    toolContextFromRequest(state.request),
  );
  const evidence = evidenceFromToolOutput(plan.toolName, output);

  return {
    evidence: [evidence],
    toolCalls: [
      {
        input: plan.input,
        step: state.currentStep,
        toolName: plan.toolName,
      },
    ],
    toolResults: [
      {
        output,
        step: state.currentStep,
        toolName: plan.toolName,
      },
    ],
  };
}

function answerComposerNode(state: LangGraphAgentState): Partial<AgentState> {
  if (state.finalResponse !== undefined) {
    return {};
  }

  const evidence = state.evidence.at(-1);
  if (evidence !== undefined) {
    return {
      finalResponse: responseFromEvidence(evidence, state.route),
    };
  }

  if (state.plan?.kind === 'final') {
    return {
      finalResponse: withAgentRoute(state.plan.response, normalizeAgentRoute(state.plan.route)),
    };
  }

  return {
    finalResponse: createClarificationResponse(
      '当前没有足够证据生成可靠回答。请补充具体功能、配置步骤或单笔公开交易哈希。',
    ),
  };
}

function listPlannerTools(registry: ToolRegistry): PlannerToolDescriptor[] {
  return registry
    .list()
    .filter((tool) => isAllowedAgentToolName(tool.name))
    .map((tool) => ({
      description: tool.description,
      name: tool.name,
    }));
}

function summarizeState(state: LangGraphAgentState): string {
  return JSON.stringify({
    currentStep: state.currentStep,
    evidenceCount: state.evidence.length,
    route: state.route,
    toolCallCount: state.toolCalls.length,
  });
}

function evidenceFromToolOutput(toolName: string, output: unknown): AgentEvidence {
  if (toolName === 'analyze_transaction') {
    return {
      kind: 'tx_analysis',
      output,
      toolName,
    };
  }

  return {
    kind: 'chat_response',
    response: output as ChatResponse,
    toolName,
  };
}

function responseFromEvidence(
  evidence: AgentEvidence,
  route: AgentRoute | undefined,
): ChatResponse {
  if (evidence.kind === 'chat_response') {
    return withAgentRoute(evidence.response, route ?? routeForChatResponseTool(evidence.toolName));
  }

  const output = evidence.output as AnalyzeTransactionOutput;
  const response =
    output.status === 'success'
      ? createTxAnalysisAnswer(output.result)
      : createTxAnalysisUnavailableAnswer(output.failure.reason, {
          ...(output.failure.metadata === undefined ? {} : { metadata: output.failure.metadata }),
          ...(output.failure.reportUrl === undefined
            ? {}
            : { reportUrl: output.failure.reportUrl }),
        });

  return withAgentRoute(response, 'transaction_analysis');
}

function routeForChatResponseTool(toolName: string): AgentRoute {
  if (toolName === 'boundary_reply') {
    return 'boundary';
  }
  if (toolName === 'clarify_request') {
    return 'clarify';
  }
  return 'product_answer';
}

function toolContextFromRequest(request: ChatRequest): ToolContext {
  return {
    channel: request.channel,
    sessionId: request.sessionId,
    userIdPresent: request.userId !== undefined,
  };
}

function createClarificationResponse(answer: string): ChatResponse {
  return {
    agentRoute: 'clarify',
    answer,
    citations: [],
    confidence: 0.35,
    intent: 'unknown',
  };
}

function withAgentRoute(response: ChatResponse, agentRoute: AgentRoute): ChatResponse {
  return {
    ...response,
    agentRoute,
  };
}

function streamChatResponse(response: ChatResponse): AsyncIterable<ChatStreamEvent> {
  return toAsyncIterable([
    ...(response.answer.length > 0
      ? [{ type: 'answer_delta' as const, delta: response.answer }]
      : []),
    {
      type: 'metadata',
      ...(response.agentRoute === undefined ? {} : { agentRoute: response.agentRoute }),
      ...(response.attachments === undefined ? {} : { attachments: response.attachments }),
      citations: response.citations,
      confidence: response.confidence,
      intent: response.intent,
      ...(response.tokenUsage === undefined ? {} : { tokenUsage: response.tokenUsage }),
    },
  ]);
}

async function* toAsyncIterable<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}
