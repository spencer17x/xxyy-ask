import { END, START, StateGraph } from '@langchain/langgraph';

import type { AgentRoute, ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  LlmConfigurationError,
  type AnalyzeTransactionOutput,
  VectorStoreConfigurationError,
} from '@xxyy/rag-core';

import {
  isBusinessActionClassification,
  isPrivateCredentialClassification,
  isUnsafeUnsupportedClassification,
} from './answer-planner.js';
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
  if (!isBoundaryClassification(classification)) {
    return {
      policyDecision: { action: 'continue' },
    };
  }

  const response = withAgentRoute(createRuntimeBoundaryAnswer(classification), 'boundary');
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

  let plan: AgentPlan;
  try {
    plan = await options.planner.plan({
      request: state.request,
      stateSummary: summarizeState(state),
      tools: listPlannerTools(options.registry),
    });
  } catch (error) {
    if (error instanceof PlannerConfigurationError) {
      throw error;
    }
    if (
      error instanceof PlannerModelParseError ||
      error instanceof PlannerModelRequestError ||
      error instanceof Error
    ) {
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

function isBoundaryClassification(classification: ReturnType<typeof classifyQuestion>): boolean {
  return (
    BOUNDARY_INTENTS.has(classification.intent) ||
    isBusinessActionClassification(classification) ||
    isPrivateCredentialClassification(classification) ||
    isUnsafeUnsupportedClassification(classification)
  );
}

function createRuntimeBoundaryAnswer(
  classification: ReturnType<typeof classifyQuestion>,
): ChatResponse {
  if (isPrivateCredentialClassification(classification)) {
    return {
      answer:
        '不要发送私钥、助记词或 seed phrase。XXYY 客服 Agent 不需要这些信息，也不能帮你保管或恢复凭证；如果你已经泄露了凭证，请立即停止使用相关钱包并在自己的钱包工具里转移资产或更换钱包。',
      citations: [],
      confidence: Math.min(classification.confidence, 0.7),
      intent: classification.intent,
    };
  }

  if (isUnsafeUnsupportedClassification(classification)) {
    return {
      answer:
        '我不能帮助攻击、盗号、破解或钓鱼，也不会提供绕过安全保护的步骤。可以继续问我 XXYY 产品功能、配置步骤、权益说明，或发送单笔公开交易哈希做夹子检测。',
      citations: [],
      confidence: Math.min(classification.confidence, 0.7),
      intent: classification.intent,
    };
  }

  return createBoundaryAnswer(classification);
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
