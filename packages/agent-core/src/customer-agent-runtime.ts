import type { ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  createTxAnalysisAnswer,
  createTxAnalysisUnavailableAnswer,
  type AnalyzeTransactionOutput,
} from '@xxyy/rag-core';

import { createNoopAuditSink, type ToolAuditEvent, type ToolAuditSink } from './audit.js';
import type { ToolRegistry } from './tool-registry.js';

export interface CustomerAgentRuntime {
  ask(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface CreateCustomerAgentRuntimeOptions {
  registry: ToolRegistry;
  audit?: ToolAuditSink;
}

export function createCustomerAgentRuntime(
  options: CreateCustomerAgentRuntimeOptions,
): CustomerAgentRuntime {
  const audit = options.audit ?? createNoopAuditSink();
  const ask: CustomerAgentRuntime['ask'] = async (request) => {
    const classification = classifyQuestion(request.message);

    if (classification.intent === 'tx_sandwich_detection') {
      const startedAt = Date.now();
      let output: AnalyzeTransactionOutput;
      try {
        output = (await options.registry.execute('analyze_transaction', {
          txHash: request.message,
        })) as AnalyzeTransactionOutput;
      } catch (error) {
        recordToolFailure(audit, request, {
          error,
          intent: classification.intent,
          startedAt,
          toolName: 'analyze_transaction',
        });
        throw error;
      }
      const response =
        output.status === 'success'
          ? createTxAnalysisAnswer(output.result)
          : createTxAnalysisUnavailableAnswer(output.failure.reason, {
              ...(output.failure.metadata === undefined
                ? {}
                : { metadata: output.failure.metadata }),
              ...(output.failure.reportUrl === undefined
                ? {}
                : { reportUrl: output.failure.reportUrl }),
            });

      audit.record({
        channel: request.channel,
        intent: classification.intent,
        latencyMs: Date.now() - startedAt,
        sessionIdPresent: request.sessionId !== undefined,
        status: 'success',
        toolName: 'analyze_transaction',
        userIdPresent: request.userId !== undefined,
      });

      return response;
    }

    if (!shouldUseProductTool(classification.intent)) {
      return createBoundaryAnswer(classification);
    }

    const startedAt = Date.now();
    let response: ChatResponse;
    try {
      response = (await options.registry.execute('answer_product_question', {
        channel: request.channel,
        question: request.message,
      })) as ChatResponse;
    } catch (error) {
      recordToolFailure(audit, request, {
        error,
        intent: classification.intent,
        startedAt,
        toolName: 'answer_product_question',
      });
      throw error;
    }

    audit.record({
      channel: request.channel,
      citationCount: response.citations.length,
      intent: classification.intent,
      latencyMs: Date.now() - startedAt,
      sessionIdPresent: request.sessionId !== undefined,
      status: 'success',
      toolName: 'answer_product_question',
      userIdPresent: request.userId !== undefined,
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

function shouldUseProductTool(intent: ChatResponse['intent']): boolean {
  return intent === 'product_qa' || intent === 'how_to';
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
