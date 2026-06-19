import type { ChatRequest, ChatResponse, ChatStreamEvent, Classification } from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  LlmConfigurationError,
  parseTransactionReference,
  type AnalyzeTransactionOutput,
  VectorStoreConfigurationError,
} from '@xxyy/rag-core';

import {
  isPrivateCredentialClassification,
  isUnsafeUnsupportedClassification,
  planAnswer,
} from './answer-planner.js';
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
      const response = createTxAnalysisUnavailableAnswer('provider_unavailable');
      recordQualitySignal(qualitySignals, request, {
        answer: response.answer,
        errorCode: errorCodeFrom(error),
        intent,
        reason: 'tool_failure',
        redactedQuestion: messageForTool,
      });
      return response;
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
        answer: response.answer,
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
      const response = createProductKnowledgeUnavailableAnswer(intent);
      recordQualitySignal(qualitySignals, request, {
        answer: response.answer,
        errorCode: errorCodeFrom(error),
        intent,
        reason: 'tool_failure',
        redactedQuestion: messageForTool,
      });
      return response;
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

    const hasMissingCitations = response.citations.length === 0;
    const hasLowConfidence = response.confidence < qualityConfidenceThreshold;
    const guardedResponse =
      hasLowConfidence || hasMissingCitations
        ? createProductKnowledgeInsufficientAnswer(response.intent)
        : undefined;

    if (hasLowConfidence && hasMissingCitations) {
      recordQualitySignal(qualitySignals, request, {
        answer: guardedResponse?.answer ?? response.answer,
        citationCount: 0,
        confidence: response.confidence,
        intent: response.intent,
        reason: 'low_confidence_missing_citations',
        redactedQuestion: messageForTool,
      });
    } else if (hasLowConfidence) {
      recordQualitySignal(qualitySignals, request, {
        answer: guardedResponse?.answer ?? response.answer,
        citationCount: response.citations.length,
        confidence: response.confidence,
        intent: response.intent,
        reason: 'low_confidence',
        redactedQuestion: messageForTool,
      });
    } else if (hasMissingCitations) {
      recordQualitySignal(qualitySignals, request, {
        answer: guardedResponse?.answer ?? response.answer,
        citationCount: 0,
        confidence: response.confidence,
        intent: response.intent,
        reason: 'missing_citations',
        redactedQuestion: messageForTool,
      });
    }

    return guardedResponse ?? response;
  }

  const ask: CustomerAgentRuntime['ask'] = async (request) => {
    const missingSessionDependency =
      options.sessionContext === undefined
        ? missingSessionDependencyForRequest(request)
        : undefined;
    if (missingSessionDependency !== undefined) {
      const response = createSessionUnavailableClarification(
        request.message,
        missingSessionDependency,
      );
      recordQualitySignal(qualitySignals, request, {
        answer: response.answer,
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
        intent: intentForFollowUpDependency(followUp.dependency, request.message),
      };
      recordQualitySignal(qualitySignals, request, {
        answer: response.answer,
        confidence: response.confidence,
        intent: response.intent,
        reason:
          followUp.clarificationReason === 'missing_context'
            ? 'missing_followup_context'
            : 'ambiguous_followup',
        redactedQuestion: request.message,
      });
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
      const response = createRuntimeBoundaryAnswer(plan.classification);
      recordBoundaryQualitySignal(
        qualitySignals,
        request,
        response,
        followUp.resolvedMessage,
        plan.classification,
      );
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

function intentForFollowUpDependency(
  dependency: FollowUpDependency,
  message: string,
): ChatResponse['intent'] {
  if (dependency === 'transaction_reference') {
    return 'tx_sandwich_detection';
  }

  const classification = classifyQuestion(message);
  return classification.intent === 'how_to' ? 'how_to' : 'product_qa';
}

function missingSessionDependencyForRequest(request: ChatRequest): FollowUpDependency | undefined {
  const dependency = detectFollowUpDependency(request.message);
  if (dependency === undefined) {
    return undefined;
  }

  if (request.sessionId !== undefined) {
    return dependency;
  }

  return dependency;
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

function createProductKnowledgeInsufficientAnswer(intent: ChatResponse['intent']): ChatResponse {
  return {
    answer:
      '当前知识库没有足够资料确认这个问题。为了避免误导，我不会编造产品细节；请补充更具体的功能、权益或配置步骤，或稍后在知识库更新后再问。',
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

function createRuntimeBoundaryAnswer(classification: Classification): ChatResponse {
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

function recordBoundaryQualitySignal(
  qualitySignals: QualitySignalSink,
  request: ChatRequest,
  response: ChatResponse,
  redactedQuestion: string,
  classification: Classification,
): void {
  const reason: QualitySignalReason = isPrivateCredentialClassification(classification)
    ? 'boundary_private_credentials'
    : isUnsafeUnsupportedClassification(classification)
      ? 'boundary_unsafe_request'
      : response.intent === 'investment_advice'
        ? 'boundary_investment_advice'
        : response.intent === 'realtime_account_query'
          ? 'boundary_private_data'
          : response.intent === 'mev_or_chain_forensics'
            ? 'boundary_chain_forensics'
            : 'unknown_intent';
  recordQualitySignal(qualitySignals, request, {
    answer: response.answer,
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
  const userTransactionMetadata =
    response.intent === 'tx_sandwich_detection'
      ? transactionMetadataFromText(options.userContent)
      : undefined;
  await sessionContext.appendTurn(request.sessionId, {
    content: options.userContent,
    createdAt: now,
    metadata: {
      intent: response.intent,
      ...(userTransactionMetadata === undefined ? {} : userTransactionMetadata),
    },
    role: 'user',
  });
  await sessionContext.appendTurn(request.sessionId, {
    content: response.answer,
    createdAt: now,
    metadata: metadataFromResponse(response, userTransactionMetadata),
    role: 'assistant',
  });
}

function metadataFromResponse(
  response: ChatResponse,
  fallbackTransactionMetadata: Pick<SessionTurnMetadata, 'chain' | 'txHash'> | undefined,
): SessionTurnMetadata {
  const relatedUserTransaction =
    response.intent === 'tx_sandwich_detection'
      ? (transactionMetadataFromText(response.answer) ?? fallbackTransactionMetadata)
      : undefined;
  return {
    citationCount: response.citations.length,
    confidence: response.confidence,
    intent: response.intent,
    ...(relatedUserTransaction === undefined ? {} : relatedUserTransaction),
  };
}

function transactionMetadataFromText(
  text: string,
): Pick<SessionTurnMetadata, 'chain' | 'txHash'> | undefined {
  const reference = parseTransactionReference(text);
  if (reference === undefined) {
    return undefined;
  }

  return {
    chain: reference.chain,
    txHash: reference.txHash,
  };
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
