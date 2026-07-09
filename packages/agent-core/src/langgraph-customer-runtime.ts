import { END, START, StateGraph } from '@langchain/langgraph';

import type {
  AgentRoute,
  ChatAttachment,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  Classification,
} from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  LlmConfigurationError,
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
  type PlannerModel,
  type PlannerToolDescriptor,
} from './planner-model.js';
import type { ToolContext, ToolRegistry } from './tool-registry.js';

const KNOWLEDGE_ONLY_CLARIFICATION =
  '当前只支持基于 XXYY 知识库回答产品功能、配置步骤、权益说明和官方更新相关问题。请补充一个具体的 XXYY 产品问题。';

export interface CustomerAgentRuntime {
  ask(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface CreateLangGraphCustomerRuntimeOptions {
  maxSteps?: number;
  planner: PlannerModel;
  registry: ToolRegistry;
}

type CustomerRuntimeNode = 'answer_composer' | 'observe' | 'planner' | 'tool_executor';

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
    const guardedResponse = deterministicPreGuard(request);
    if (guardedResponse !== undefined) {
      return guardedResponse;
    }

    const finalState = (await graph.invoke(
      createInitialAgentState(request, { maxSteps }),
    )) as LangGraphAgentState;

    return finalState.finalResponse ?? createClarificationResponse('无法生成可靠回答。');
  }

  return {
    ask,

    async *stream(request) {
      const guardedResponse = deterministicPreGuard(request);
      if (guardedResponse !== undefined) {
        yield* streamChatResponse(guardedResponse);
        return;
      }

      yield* streamRuntimeRequest(request, options, maxSteps);
    },
  };
}

async function* streamRuntimeRequest(
  request: ChatRequest,
  options: CreateLangGraphCustomerRuntimeOptions,
  maxSteps: number,
): AsyncIterable<ChatStreamEvent> {
  const initialState = createInitialAgentState(request, { maxSteps }) as LangGraphAgentState;
  const plannerPatch = await plannerNode(initialState, options);

  if (plannerPatch.finalResponse !== undefined) {
    yield* streamChatResponse(plannerPatch.finalResponse);
    return;
  }

  const plan = plannerPatch.plan;
  if (plan === undefined) {
    yield* streamChatResponse(createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION));
    return;
  }

  if (plan.kind === 'final') {
    if (!isFinalPlannerRoute(plan.route)) {
      yield* streamChatResponse(createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION));
      return;
    }

    yield* streamChatResponse(withAgentRoute(plan.response, normalizeAgentRoute(plan.route)));
    return;
  }

  if (!isAllowedAgentToolName(plan.toolName)) {
    yield* streamChatResponse(createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION));
    return;
  }

  const toolInput = inputForToolExecution(plan, request);
  const context = toolContextFromRequest(request);
  try {
    const toolStream = options.registry.stream(plan.toolName, toolInput, context);
    if (toolStream !== undefined) {
      for await (const event of toolStream) {
        yield withStreamAgentRoute(event as ChatStreamEvent, routeForToolName(plan.toolName));
      }
      return;
    }

    const output = await options.registry.execute(plan.toolName, toolInput, context);
    yield* streamChatResponse(responseFromEvidence(evidenceFromToolOutput(plan.toolName, output)));
  } catch (error) {
    if (isProductConfigurationError(error)) {
      throw error;
    }
    yield* streamChatResponse(withAgentRoute(toolFailureResponse(plan.toolName), 'clarify'));
  }
}

function deterministicPreGuard(request: ChatRequest): ChatResponse | undefined {
  const classification = classifyQuestion(request.message);
  if (!shouldReturnDeterministicBoundary(classification)) {
    return undefined;
  }

  return withAgentRoute(createBoundaryAnswer(classification), 'boundary');
}

function shouldReturnDeterministicBoundary(classification: Classification): boolean {
  if (
    classification.intent === 'realtime_account_query' ||
    classification.intent === 'investment_advice'
  ) {
    return true;
  }

  return classification.intent === 'unknown' && isBoundaryUnknownReason(classification.reason);
}

function isBoundaryUnknownReason(reason: string): boolean {
  return (
    reason === 'unsafe or unsupported operation request' ||
    reason === 'business action execution request' ||
    reason === 'private credential or seed phrase disclosure'
  );
}

function createCustomerGraph(options: CreateLangGraphCustomerRuntimeOptions) {
  return new StateGraph(AgentStateAnnotation)
    .addNode('planner', (state) => plannerNode(state, options))
    .addNode('tool_executor', (state) => toolExecutorNode(state, options.registry))
    .addNode('observe', observeNode)
    .addNode('answer_composer', answerComposerNode)
    .addEdge(START, 'planner')
    .addConditionalEdges('planner', routeAfterPlanner)
    .addEdge('tool_executor', 'observe')
    .addConditionalEdges('observe', routeAfterObserve)
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
  const plannerInput = {
    request: state.request,
    stateSummary: summarizeState(state),
    tools: listPlannerTools(options.registry),
  };
  const planningErrors: string[] = [];
  try {
    plan = await options.planner.plan(plannerInput);
  } catch (error) {
    if (error instanceof PlannerConfigurationError || error instanceof LlmConfigurationError) {
      throw error;
    }

    planningErrors.push(`Planner failed: ${errorMessageFrom(error)}`);
    try {
      plan = await options.planner.plan(plannerInput);
    } catch (retryError) {
      if (
        retryError instanceof PlannerConfigurationError ||
        retryError instanceof LlmConfigurationError
      ) {
        throw retryError;
      }

      const fallbackPlan = fallbackProductAnswerPlan(state.request, options.registry);
      if (fallbackPlan !== undefined) {
        return {
          currentStep: state.currentStep + 1,
          errors: [...planningErrors, `Planner retry failed: ${errorMessageFrom(retryError)}`],
          plan: fallbackPlan,
          route: 'product_answer',
        };
      }

      return {
        errors: [...planningErrors, `Planner retry failed: ${errorMessageFrom(retryError)}`],
        finalResponse: createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
        route: 'clarify',
      };
    }
  }

  const productFallbackPlan = fallbackProductAnswerPlan(state.request, options.registry);
  if (
    productFallbackPlan !== undefined &&
    shouldOverridePlannerFinalWithProductTool(plan, state.request)
  ) {
    return {
      currentStep: state.currentStep + 1,
      ...(planningErrors.length > 0 ? { errors: planningErrors } : {}),
      plan: productFallbackPlan,
      route: 'product_answer',
    };
  }

  if (plan.kind === 'tool' && isRepeatedToolInput(plan, state)) {
    return {
      currentStep: state.currentStep + 1,
      errors: [...planningErrors, `Repeated tool input: ${plan.toolName}`],
      finalResponse: createClarificationResponse(
        '已停止重复检索同一组工具输入。请补充更具体的产品功能、模块或时间范围。',
      ),
      route: 'clarify',
    };
  }

  return {
    currentStep: state.currentStep + 1,
    ...(planningErrors.length > 0 ? { errors: planningErrors } : {}),
    plan,
    route: normalizeAgentRoute(plan.route),
  };
}

function shouldOverridePlannerFinalWithProductTool(plan: AgentPlan, request: ChatRequest): boolean {
  if (plan.kind !== 'final') {
    return false;
  }

  const classification = classifyQuestion(request.message);
  if (classification.intent !== 'product_qa' && classification.intent !== 'how_to') {
    return false;
  }

  return (
    plan.response.citations.length === 0 ||
    plan.response.intent === 'unknown' ||
    normalizeAgentRoute(plan.route) === 'clarify'
  );
}

function fallbackProductAnswerPlan(
  request: ChatRequest,
  registry: ToolRegistry,
): Extract<AgentPlan, { kind: 'tool' }> | undefined {
  const classification = classifyQuestion(request.message);
  if (classification.intent !== 'product_qa' && classification.intent !== 'how_to') {
    return undefined;
  }

  const hasProductAnswerTool = registry
    .list()
    .some((tool) => tool.name === 'answer_product_question');
  if (!hasProductAnswerTool) {
    return undefined;
  }

  return {
    input: { question: request.message },
    kind: 'tool',
    reason: 'deterministic product classification fallback after planner failure',
    route: 'product_answer',
    toolName: 'answer_product_question',
  };
}

function routeAfterPlanner(state: LangGraphAgentState): CustomerRuntimeNode {
  if (state.finalResponse !== undefined) {
    return 'answer_composer';
  }

  return state.plan?.kind === 'tool' ? 'tool_executor' : 'answer_composer';
}

function routeAfterObserve(state: LangGraphAgentState): CustomerRuntimeNode {
  if (state.finalResponse !== undefined) {
    return 'answer_composer';
  }

  return 'planner';
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
      finalResponse: createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
      route: 'clarify',
    };
  }

  let output: unknown;
  const toolInput = inputForToolExecution(plan, state.request);
  try {
    output = await registry.execute(
      plan.toolName,
      toolInput,
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
        input: toolInput,
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

function observeNode(state: LangGraphAgentState): Partial<AgentState> {
  const evidence = state.evidence.at(-1);
  if (evidence === undefined) {
    return {};
  }

  if (evidence.kind === 'chat_response') {
    return {
      finalResponse: responseFromEvidence(evidence),
    };
  }

  if (evidence.output.citations.length > 0 && hasSufficientSearchEvidence(state)) {
    return {
      finalResponse: withAgentRoute(
        responseFromSearchEvidenceList(searchEvidenceList(state.evidence)),
        'product_answer',
      ),
    };
  }

  if (consecutiveEmptySearchEvidenceCount(state.evidence) >= 2) {
    return {
      finalResponse: createClarificationResponse(
        '连续检索后没有找到新的知识库证据。请补充更具体的产品功能、模块、时间范围或官方更新线索。',
      ),
      route: 'clarify',
    };
  }

  return {};
}

function inputForToolExecution(plan: Extract<AgentPlan, { kind: 'tool' }>, request: ChatRequest) {
  if (plan.toolName === 'answer_product_question') {
    return { question: request.message };
  }

  if (plan.toolName === 'search_product_docs') {
    return inputForSearchProductDocs(plan.input, request.message);
  }

  return plan.input;
}

function inputForSearchProductDocs(input: unknown, fallbackQuery: string) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { query: fallbackQuery };
  }

  const record = input as Record<string, unknown>;
  const query = nonEmptyString(record.query) ?? nonEmptyString(record.question) ?? fallbackQuery;

  return {
    question: fallbackQuery,
    query,
    ...(typeof record.topK === 'number' ? { topK: record.topK } : {}),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.trim().length === 0 ? undefined : value;
}

function answerComposerNode(state: LangGraphAgentState): Partial<AgentState> {
  if (state.finalResponse !== undefined) {
    return {};
  }

  if (state.plan?.kind === 'final') {
    if (!isFinalPlannerRoute(state.plan.route)) {
      return {
        errors: [`Invalid final planner route: ${String(state.plan.route)}`],
        finalResponse: createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
        route: 'clarify',
      };
    }

    return {
      finalResponse: withAgentRoute(state.plan.response, normalizeAgentRoute(state.plan.route)),
    };
  }

  const evidence = state.evidence.at(-1);
  if (evidence !== undefined) {
    const searchEvidence = searchEvidenceList(state.evidence);
    if (searchEvidence.length > 0) {
      return {
        finalResponse: withAgentRoute(
          responseFromSearchEvidenceList(searchEvidence),
          'product_answer',
        ),
      };
    }

    return {
      finalResponse: responseFromEvidence(evidence),
    };
  }

  return {
    finalResponse: createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
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
  const searchEvidence = searchEvidenceList(state.evidence);
  return JSON.stringify({
    currentStep: state.currentStep,
    evidenceCount: state.evidence.length,
    searchCitationSourceCount: distinctSearchCitationKeys(searchEvidence).size,
    searchEvidenceSufficient: hasSufficientSearchEvidence(state),
    route: state.route,
    toolCallCount: state.toolCalls.length,
  });
}

function evidenceFromToolOutput(toolName: string, output: unknown): AgentEvidence {
  if (toolName === 'search_product_docs') {
    return {
      kind: 'search_results',
      output: output as AgentEvidenceForSearch,
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
  if (evidence.kind === 'search_results') {
    return withAgentRoute(
      responseFromSearchEvidence(evidence.output),
      routeForToolName(evidence.toolName),
    );
  }

  return withAgentRoute(evidence.response, routeForToolName(evidence.toolName));
}

function withStreamAgentRoute(event: ChatStreamEvent, route: AgentRoute): ChatStreamEvent {
  if (event.type !== 'metadata') {
    return event;
  }

  return {
    ...event,
    agentRoute: route,
  };
}

function routeForToolName(_toolName: string): AgentRoute {
  return 'product_answer';
}

type AgentEvidenceForSearch = Extract<AgentEvidence, { kind: 'search_results' }>['output'];

function responseFromSearchEvidence(output: AgentEvidenceForSearch): ChatResponse {
  return responseFromSearchEvidenceList([
    { kind: 'search_results', output, toolName: 'search_product_docs' },
  ]);
}

function responseFromSearchEvidenceList(evidenceList: AgentEvidence[]): ChatResponse {
  const outputs = evidenceList
    .filter((evidence): evidence is Extract<AgentEvidence, { kind: 'search_results' }> => {
      return evidence.kind === 'search_results';
    })
    .map((evidence) => evidence.output);
  const citations = uniqueCitations(outputs.flatMap((output) => output.citations));
  const attachments = uniqueAttachments(outputs.flatMap((output) => output.attachments ?? []));
  const excerpts = citations.map((citation) => citation.excerpt);
  const confidence = outputs.reduce((max, output) => Math.max(max, output.confidence), 0);

  return {
    answer:
      excerpts.length === 0
        ? '当前知识库没有找到直接相关的产品资料。'
        : `根据知识库，${excerpts.join(' ')}`,
    citations,
    confidence: Number(Math.min(0.9, Math.max(0.55, confidence / 10)).toFixed(2)),
    intent: 'product_qa',
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

function hasSufficientSearchEvidence(state: LangGraphAgentState): boolean {
  const searchEvidence = searchEvidenceList(state.evidence);
  if (!hasSearchCitations(searchEvidence)) {
    return false;
  }

  if (!requiresMultiSourceEvidence(state.request.message)) {
    return true;
  }

  if (distinctSearchCitationKeys(searchEvidence).size >= 2) {
    return true;
  }

  return state.currentStep >= state.maxSteps;
}

function searchEvidenceList(evidenceList: AgentEvidence[]): AgentEvidence[] {
  return evidenceList.filter((evidence) => evidence.kind === 'search_results');
}

function hasSearchCitations(evidenceList: AgentEvidence[]): boolean {
  return evidenceList.some((evidence) => {
    return evidence.kind === 'search_results' && evidence.output.citations.length > 0;
  });
}

function requiresMultiSourceEvidence(question: string): boolean {
  return (
    /比较|对比|区别|分别|同时|以及|与|\bcompare\b|\bversus\b|\bvs\b/iu.test(question) ||
    /(?:权益|功能|设置|上限|限制|管理).+和.+(?:权益|功能|设置|上限|限制|管理)/u.test(question)
  );
}

function distinctSearchCitationKeys(evidenceList: AgentEvidence[]): Set<string> {
  return new Set(
    evidenceList.flatMap((evidence) => {
      if (evidence.kind !== 'search_results') {
        return [];
      }
      return evidence.output.citations.map((citation) => citationKey(citation));
    }),
  );
}

function uniqueCitations(
  citations: AgentEvidenceForSearch['citations'],
): AgentEvidenceForSearch['citations'] {
  const byKey = new Map<string, AgentEvidenceForSearch['citations'][number]>();
  for (const citation of citations) {
    byKey.set(citationKey(citation), citation);
  }
  return [...byKey.values()];
}

function uniqueAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  const byKey = new Map<string, ChatAttachment>();
  for (const attachment of attachments) {
    byKey.set(
      [attachment.kind, attachment.mediaType, attachment.url, attachment.title].join('\0'),
      attachment,
    );
  }
  return [...byKey.values()];
}

function citationKey(citation: AgentEvidenceForSearch['citations'][number]): string {
  return [citation.file, citation.title, citation.sourceUrl ?? '', citation.excerpt].join('\0');
}

function consecutiveEmptySearchEvidenceCount(evidenceList: AgentEvidence[]): number {
  let count = 0;
  for (let index = evidenceList.length - 1; index >= 0; index -= 1) {
    const evidence = evidenceList[index];
    if (evidence === undefined || evidence.kind !== 'search_results') {
      break;
    }
    if (evidence.output.chunks.length > 0 || evidence.output.citations.length > 0) {
      break;
    }
    count += 1;
  }
  return count;
}

function isRepeatedToolInput(plan: AgentPlan, state: LangGraphAgentState): boolean {
  if (plan.kind !== 'tool') {
    return false;
  }

  const nextInput = inputForToolExecution(plan, state.request);
  const nextInputKey = stableJson(nextInput);
  return state.toolCalls.some(
    (toolCall) =>
      toolCall.toolName === plan.toolName && stableJson(toolCall.input) === nextInputKey,
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJsonValue(entryValue)]),
    );
  }

  return value;
}

function toolFailureResponse(toolName: string): ChatResponse {
  return createClarificationResponse(
    `当前知识库检索或 AI 服务暂时不可用，${toolName} 无法可靠处理这个请求。请稍后重试，或检查 AI/embedding 服务和向量库健康状态。`,
  );
}

function isFinalPlannerRoute(route: unknown): route is FinalPlannerRoute {
  return route === 'boundary' || route === 'clarify' || route === 'unsupported';
}

function toolContextFromRequest(request: ChatRequest): ToolContext {
  return {
    channel: request.channel,
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
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
