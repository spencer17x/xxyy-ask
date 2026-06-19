import type { ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  LlmConfigurationError,
  type AnalyzeTransactionOutput,
  VectorStoreConfigurationError,
} from '@xxyy/rag-core';

import { planAnswer } from './answer-planner.js';
import { createNoopAuditSink, type ToolAuditEvent, type ToolAuditSink } from './audit.js';
import {
  detectFollowUpDependency,
  resolveFollowUp,
  type FollowUpDependency,
} from './follow-up-resolver.js';
import {
  createNoopQualitySignalSink,
  type QualitySignalReason,
  type QualitySignalSink,
} from './quality-signals.js';
import {
  sanitizeSessionText,
  type SessionContextStore,
  type SessionTurnMetadata,
} from './session-context.js';
import type { ToolRegistry } from './tool-registry.js';

export interface CustomerAgentRuntime {
  ask(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface CreateCustomerAgentRuntimeOptions {
  registry: ToolRegistry;
  audit?: ToolAuditSink;
  qualityConfidenceThreshold?: number;
  qualitySignals?: QualitySignalSink;
  sessionContext?: SessionContextStore;
}

export function createCustomerAgentRuntime(
  options: CreateCustomerAgentRuntimeOptions,
): CustomerAgentRuntime {
  const audit = options.audit ?? createNoopAuditSink();
  const qualitySignals = options.qualitySignals ?? createNoopQualitySignalSink();
  const qualityConfidenceThreshold = options.qualityConfidenceThreshold ?? 0.45;

  async function answerTransaction(
    request: ChatRequest,
    messageForTool: string,
    intent: ChatResponse['intent'],
  ): Promise<ChatResponse> {
    const startedAt = Date.now();
    let output: AnalyzeTransactionOutput;
    try {
      output = (await options.registry.execute('analyze_transaction', {
        txHash: messageForTool,
      })) as AnalyzeTransactionOutput;
    } catch (error) {
      recordToolFailure(audit, request, {
        error,
        intent,
        startedAt,
        toolName: 'analyze_transaction',
      });
      recordQualitySignal(qualitySignals, request, {
        errorCode: errorCodeFrom(error),
        intent,
        reason: 'tool_failure',
        redactedQuestion: messageForTool,
      });
      return createTxAnalysisUnavailableAnswer('provider_unavailable');
    }

    const response =
      output.status === 'success'
        ? createTxAnalysisAnswer(output.result)
        : createTxAnalysisUnavailableAnswer(output.failure.reason, {
            ...(output.failure.metadata === undefined ? {} : { metadata: output.failure.metadata }),
            ...(output.failure.reportUrl === undefined
              ? {}
              : { reportUrl: output.failure.reportUrl }),
          });

    if (output.status === 'failure') {
      recordQualitySignal(qualitySignals, request, {
        confidence: response.confidence,
        intent,
        reason: 'tx_analysis_failure',
        redactedQuestion: messageForTool,
      });
    }

    audit.record({
      channel: request.channel,
      intent,
      latencyMs: Date.now() - startedAt,
      sessionIdPresent: request.sessionId !== undefined,
      status: 'success',
      toolName: 'analyze_transaction',
      userIdPresent: request.userId !== undefined,
    });

    return response;
  }

  async function answerProduct(
    request: ChatRequest,
    messageForTool: string,
    intent: ChatResponse['intent'],
  ): Promise<ChatResponse> {
    const startedAt = Date.now();
    let response: ChatResponse;
    try {
      response = (await options.registry.execute('answer_product_question', {
        channel: request.channel,
        question: messageForTool,
      })) as ChatResponse;
    } catch (error) {
      recordToolFailure(audit, request, {
        error,
        intent,
        startedAt,
        toolName: 'answer_product_question',
      });
      if (isProductConfigurationError(error)) {
        throw error;
      }
      recordQualitySignal(qualitySignals, request, {
        errorCode: errorCodeFrom(error),
        intent,
        reason: 'tool_failure',
        redactedQuestion: messageForTool,
      });
      return createProductKnowledgeUnavailableAnswer(intent);
    }

    audit.record({
      channel: request.channel,
      citationCount: response.citations.length,
      intent,
      latencyMs: Date.now() - startedAt,
      sessionIdPresent: request.sessionId !== undefined,
      status: 'success',
      toolName: 'answer_product_question',
      userIdPresent: request.userId !== undefined,
    });

    if (response.confidence < qualityConfidenceThreshold) {
      recordQualitySignal(qualitySignals, request, {
        answer: response.answer,
        citationCount: response.citations.length,
        confidence: response.confidence,
        intent: response.intent,
        reason: 'low_confidence',
        redactedQuestion: messageForTool,
      });
    }
    if (response.citations.length === 0) {
      recordQualitySignal(qualitySignals, request, {
        answer: response.answer,
        citationCount: 0,
        confidence: response.confidence,
        intent: response.intent,
        reason: 'missing_citations',
        redactedQuestion: messageForTool,
      });
    }

    return response;
  }

  const ask: CustomerAgentRuntime['ask'] = async (request) => {
    const missingSessionDependency =
      request.sessionId === undefined || options.sessionContext !== undefined
        ? undefined
        : detectFollowUpDependency(request.message);
    if (missingSessionDependency !== undefined) {
      const response = createSessionUnavailableClarification(
        request.message,
        missingSessionDependency,
      );
      recordQualitySignal(qualitySignals, request, {
        confidence: response.confidence,
        intent: response.intent,
        reason: 'session_unavailable',
        redactedQuestion: request.message,
      });
      return response;
    }

    const recentTurns =
      request.sessionId === undefined || options.sessionContext === undefined
        ? []
        : await options.sessionContext.getRecentTurns(request.sessionId);
    const followUp = resolveFollowUp({ message: request.message, recentTurns });

    if (followUp.resolution === 'needs_clarification') {
      const response: ChatResponse = {
        answer: followUp.clarificationQuestion,
        citations: [],
        confidence: 0.55,
        intent: 'tx_sandwich_detection',
      };
      await appendSessionTurns(options.sessionContext, request, response, {
        userContent: request.message,
      });
      return response;
    }

    const classification = classifyQuestion(followUp.resolvedMessage);
    const plan = planAnswer({
      classification,
      resolvedMessage: followUp.resolvedMessage,
    });

    if (plan.route === 'clarify') {
      const response: ChatResponse = {
        answer: plan.clarificationQuestion,
        citations: [],
        confidence: 0.45,
        intent: plan.classification.intent,
      };
      recordQualitySignal(qualitySignals, request, {
        answer: response.answer,
        confidence: response.confidence,
        intent: response.intent,
        reason: 'unknown_intent',
        redactedQuestion: followUp.resolvedMessage,
      });
      await appendSessionTurns(options.sessionContext, request, response, {
        userContent: followUp.resolvedMessage,
      });
      return response;
    }

    if (plan.route === 'boundary') {
      const response = createBoundaryAnswer(plan.classification);
      recordBoundaryQualitySignal(qualitySignals, request, response, followUp.resolvedMessage);
      await appendSessionTurns(options.sessionContext, request, response, {
        userContent: followUp.resolvedMessage,
      });
      return response;
    }

    if (plan.route === 'transaction_analysis') {
      const response = await answerTransaction(
        request,
        plan.messageForTool,
        plan.classification.intent,
      );
      await appendSessionTurns(options.sessionContext, request, response, {
        userContent: followUp.resolvedMessage,
      });
      return response;
    }

    const response = await answerProduct(request, plan.messageForTool, plan.classification.intent);
    await appendSessionTurns(options.sessionContext, request, response, {
      userContent: followUp.resolvedMessage,
    });
    return response;
  };

  return {
    ask,

    async *stream(request) {
      yield* streamChatResponse(await ask(request));
    },
  };
}

function recordToolFailure(
  audit: ToolAuditSink,
  request: ChatRequest,
  event: {
    error: unknown;
    intent: ChatResponse['intent'];
    startedAt: number;
    toolName: ToolAuditEvent['toolName'];
  },
): void {
  audit.record({
    channel: request.channel,
    errorCode: errorCodeFrom(event.error),
    intent: event.intent,
    latencyMs: Date.now() - event.startedAt,
    sessionIdPresent: request.sessionId !== undefined,
    status: 'failure',
    toolName: event.toolName,
    userIdPresent: request.userId !== undefined,
  });
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

function createProductKnowledgeUnavailableAnswer(intent: ChatResponse['intent']): ChatResponse {
  return {
    answer:
      '当前产品知识库暂时不可用，无法基于 XXYY 文档确认这个问题。为了避免误导，我不会编造产品细节；请稍后重试，或换成更具体的功能、权益或配置步骤提问。',
    citations: [],
    confidence: 0.25,
    intent,
  };
}

function createSessionUnavailableClarification(
  message: string,
  dependency: FollowUpDependency,
): ChatResponse {
  if (dependency === 'transaction_reference') {
    return {
      answer:
        '我缺少这次会话的上一轮上下文，不能确定“这笔”指哪一笔交易。请发送单笔完整交易哈希或对应主网浏览器链接，我会自动继续分析。',
      citations: [],
      confidence: 0.45,
      intent: 'tx_sandwich_detection',
    };
  }

  const classification = classifyQuestion(message);
  return {
    answer:
      '我缺少这次会话的上一轮上下文，不能确定你想继续咨询哪个具体功能。请补充具体功能、权益或配置步骤，例如“XXYY Pro 怎么升级？”。',
    citations: [],
    confidence: 0.45,
    intent: classification.intent === 'how_to' ? 'how_to' : 'product_qa',
  };
}

function recordBoundaryQualitySignal(
  qualitySignals: QualitySignalSink,
  request: ChatRequest,
  response: ChatResponse,
  redactedQuestion: string,
): void {
  const reason: QualitySignalReason =
    response.intent === 'investment_advice'
      ? 'boundary_investment_advice'
      : response.intent === 'realtime_account_query'
        ? 'boundary_private_data'
        : 'unknown_intent';
  recordQualitySignal(qualitySignals, request, {
    confidence: response.confidence,
    intent: response.intent,
    reason,
    redactedQuestion,
  });
}

function recordQualitySignal(
  qualitySignals: QualitySignalSink,
  request: ChatRequest,
  signal: {
    answer?: string;
    citationCount?: number;
    confidence?: number;
    errorCode?: string;
    intent: ChatResponse['intent'];
    reason: QualitySignalReason;
    redactedQuestion: string;
  },
): void {
  qualitySignals.record({
    ...(signal.answer === undefined ? {} : { answer: sanitizeSessionText(signal.answer) }),
    channel: request.channel,
    ...(signal.citationCount === undefined ? {} : { citationCount: signal.citationCount }),
    ...(signal.confidence === undefined ? {} : { confidence: signal.confidence }),
    ...(signal.errorCode === undefined ? {} : { errorCode: signal.errorCode }),
    intent: signal.intent,
    reason: signal.reason,
    redactedQuestion: sanitizeSessionText(signal.redactedQuestion),
    sessionIdPresent: request.sessionId !== undefined,
    userIdPresent: request.userId !== undefined,
  });
}

async function appendSessionTurns(
  sessionContext: SessionContextStore | undefined,
  request: ChatRequest,
  response: ChatResponse,
  options: { userContent: string },
): Promise<void> {
  if (sessionContext === undefined || request.sessionId === undefined) {
    return;
  }
  const now = new Date().toISOString();
  await sessionContext.appendTurn(request.sessionId, {
    content: options.userContent,
    createdAt: now,
    metadata: { intent: response.intent },
    role: 'user',
  });
  await sessionContext.appendTurn(request.sessionId, {
    content: response.answer,
    createdAt: now,
    metadata: metadataFromResponse(response),
    role: 'assistant',
  });
}

function metadataFromResponse(response: ChatResponse): SessionTurnMetadata {
  const relatedUserTransaction =
    response.intent === 'tx_sandwich_detection'
      ? extractUserTransactionFromAnswer(response)
      : undefined;
  return {
    citationCount: response.citations.length,
    confidence: response.confidence,
    intent: response.intent,
    ...(relatedUserTransaction === undefined ? {} : relatedUserTransaction),
  };
}

function extractUserTransactionFromAnswer(
  response: ChatResponse,
): Pick<SessionTurnMetadata, 'txHash'> | undefined {
  const hashMatch = response.answer.match(/\b0x[a-fA-F0-9]{64}\b/u);
  if (hashMatch === null) {
    return undefined;
  }
  return { txHash: hashMatch[0] };
}

function errorCodeFrom(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) {
    return error.name;
  }

  return 'unknown_error';
}

function streamChatResponse(response: ChatResponse): AsyncIterable<ChatStreamEvent> {
  return toAsyncIterable([
    ...(response.answer.length > 0
      ? [{ type: 'answer_delta' as const, delta: response.answer }]
      : []),
    {
      type: 'metadata',
      ...(response.attachments === undefined ? {} : { attachments: response.attachments }),
      citations: response.citations,
      confidence: response.confidence,
      intent: response.intent,
    },
  ]);
}

async function* toAsyncIterable<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}
