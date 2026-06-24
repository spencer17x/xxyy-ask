import { END, START, StateGraph } from '@langchain/langgraph';

import type { AgentRoute, ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import {
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  LlmConfigurationError,
  parseTransactionReference,
  type AnalyzeTransactionOutput,
  VectorStoreConfigurationError,
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
  type FinalPlannerRoute,
} from './langgraph-state.js';
import {
  PlannerConfigurationError,
  PlannerModelParseError,
  PlannerModelRequestError,
  type PlannerModel,
  type PlannerToolDescriptor,
} from './planner-model.js';
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

type CustomerRuntimeNode = 'answer_composer' | 'planner' | 'tool_executor';

type LangGraphAgentState = Omit<
  AgentState,
  'finalResponse' | 'plan' | 'policyDecision' | 'route'
> & {
  finalResponse: ChatResponse | undefined;
  plan: AgentPlan | undefined;
  policyDecision: AgentPolicyDecision | undefined;
  route: AgentRoute | undefined;
};

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
    .addNode('planner', (state) => plannerNode(state, options))
    .addNode('tool_executor', (state) => toolExecutorNode(state, options.registry))
    .addNode('answer_composer', answerComposerNode)
    .addEdge(START, 'planner')
    .addConditionalEdges('planner', routeAfterPlanner)
    .addEdge('tool_executor', 'answer_composer')
    .addEdge('answer_composer', END)
    .compile();
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

  let plan: AgentPlan;
  try {
    plan = await options.planner.plan({
      request: state.request,
      stateSummary: summarizeState(state),
      tools: listPlannerTools(options.registry),
    });
  } catch (error) {
    if (error instanceof PlannerConfigurationError || error instanceof LlmConfigurationError) {
      throw error;
    }
    if (
      error instanceof PlannerModelParseError ||
      error instanceof PlannerModelRequestError ||
      error instanceof Error
    ) {
      const fallbackPlan = createTransactionReferenceFallbackPlan(
        state.request.message,
        options.registry,
      );
      if (fallbackPlan !== undefined) {
        return {
          currentStep: state.currentStep + 1,
          errors: [
            `Planner failed: ${errorMessageFrom(error)}; using transaction analysis fallback.`,
          ],
          plan: fallbackPlan,
          route: 'transaction_analysis',
        };
      }

      return {
        errors: [`Planner failed: ${errorMessageFrom(error)}`],
        finalResponse: createClarificationResponse(
          '当前自动规划暂时不可用，无法可靠选择处理路径。请补充具体功能、配置步骤或单笔公开交易哈希后重试。',
        ),
        route: 'clarify',
      };
    }
    return {
      errors: ['Planner failed with an unknown error.'],
      finalResponse: createClarificationResponse(
        '当前自动规划暂时不可用，无法可靠选择处理路径。请补充具体功能、配置步骤或单笔公开交易哈希后重试。',
      ),
      route: 'clarify',
    };
  }

  return {
    currentStep: state.currentStep + 1,
    plan,
    route: normalizeAgentRoute(plan.route),
  };
}

function createTransactionReferenceFallbackPlan(
  message: string,
  registry: ToolRegistry,
): AgentPlan | undefined {
  if (registry.get('analyze_transaction') === undefined) {
    return undefined;
  }

  const reference = parseTransactionReference(message);
  if (reference === undefined) {
    return undefined;
  }

  const shouldPreserveOriginalMessage =
    reference.unsupportedChainHint !== undefined || reference.unsupportedExplorerHost !== undefined;

  return {
    input: shouldPreserveOriginalMessage
      ? { txHash: message }
      : {
          ...(reference.chain === 'unknown' ? {} : { chain: reference.chain }),
          txHash: reference.txHash,
        },
    kind: 'tool',
    reason: 'Planner failed, but the request contains one clear public transaction reference.',
    route: 'transaction_analysis',
    toolName: 'analyze_transaction',
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

  let output: unknown;
  try {
    output = await registry.execute(
      plan.toolName,
      plan.input,
      toolContextFromRequest(state.request),
    );
  } catch (error) {
    if (isProductConfigurationError(error)) {
      throw error;
    }
    return {
      errors: [`Tool ${plan.toolName} failed: ${errorMessageFrom(error)}`],
      finalResponse: toolFailureResponse(plan.toolName),
      route: 'clarify',
    };
  }
  const evidence = evidenceFromToolOutput(plan.toolName, output);

  return {
    evidence: [evidence],
    route: routeForToolName(plan.toolName),
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
      finalResponse: responseFromEvidence(evidence),
    };
  }

  if (state.plan?.kind === 'final') {
    if (!isFinalPlannerRoute(state.plan.route)) {
      return {
        errors: [`Invalid final planner route: ${String(state.plan.route)}`],
        finalResponse: createClarificationResponse(
          '当前自动规划返回了不安全的最终路线，无法可靠回答。请补充具体功能、配置步骤或单笔公开交易哈希后重试。',
        ),
        route: 'clarify',
      };
    }

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

function responseFromEvidence(evidence: AgentEvidence): ChatResponse {
  if (evidence.kind === 'chat_response') {
    return withAgentRoute(evidence.response, routeForToolName(evidence.toolName));
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

function routeForToolName(toolName: string): AgentRoute {
  if (toolName === 'analyze_transaction') {
    return 'transaction_analysis';
  }
  if (toolName === 'boundary_reply') {
    return 'boundary';
  }
  if (toolName === 'clarify_request') {
    return 'clarify';
  }
  return 'product_answer';
}

function toolFailureResponse(toolName: string): ChatResponse {
  if (toolName === 'analyze_transaction') {
    return withAgentRoute(
      createTxAnalysisUnavailableAnswer('provider_unavailable'),
      'transaction_analysis',
    );
  }

  return createClarificationResponse(
    '当前工具暂时不可用，无法可靠处理这个请求。请补充具体功能、配置步骤或单笔公开交易哈希后重试。',
  );
}

function isFinalPlannerRoute(route: unknown): route is FinalPlannerRoute {
  return route === 'boundary' || route === 'clarify' || route === 'unsupported';
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

function errorMessageFrom(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isProductConfigurationError(error: unknown): boolean {
  if (error instanceof LlmConfigurationError || error instanceof VectorStoreConfigurationError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.constructor.name === 'EmbeddingConfigurationError' ||
    error.message.includes('required for embedding generation')
  );
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
