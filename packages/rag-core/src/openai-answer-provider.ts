import type { ChatAttachment, ChatResponse, ChatStreamEvent } from '@xxyy/shared';

import {
  createAttachmentsFromChunks,
  createBoundaryAnswer,
  createCitationsFromChunks,
  createGroundedAnswer,
} from './answer.js';
import type { AnswerProvider, AnswerProviderInput } from './answer-provider.js';

export interface OpenAiAnswerProviderOptions {
  apiKey: string | undefined;
  model: string | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  requestTimeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface ChatCompletionStreamResponse {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

const GROUNDED_INTENTS = new Set(['product_qa', 'how_to']);
const MAX_CONTEXT_CHARS = 4000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

export class LlmConfigurationError extends Error {}

class LlmRequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms.`);
  }
}

class LlmRetryableRequestError extends Error {
  constructor(public readonly status: number) {
    super(`LLM request failed with retryable status ${status}.`);
  }
}

class LlmRequestStatusError extends Error {
  constructor(public readonly status: number) {
    super(`LLM request failed with status ${status}.`);
  }
}

export function createOpenAiAnswerProvider(options: OpenAiAnswerProviderOptions): AnswerProvider {
  if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
    throw new LlmConfigurationError('OPENAI_API_KEY is required for LLM answer generation.');
  }
  if (options.model === undefined || options.model.trim().length === 0) {
    throw new LlmConfigurationError('OPENAI_MODEL is required for LLM answer generation.');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey;
  const model = options.model;
  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
  const requestTimeoutMs = normalizePositiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const maxRetries = normalizeNonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES);

  return {
    async answer(input: AnswerProviderInput): Promise<ChatResponse> {
      if (!GROUNDED_INTENTS.has(input.classification.intent)) {
        return createBoundaryAnswer(input.classification);
      }

      if (input.retrievedChunks.length === 0) {
        return {
          answer: `当前知识库没有找到与「${input.question}」直接相关的资料。为了避免误导，我不能编造产品细节。`,
          citations: [],
          confidence: 0.25,
          intent: input.classification.intent,
        };
      }

      const citations = createCitationsFromChunks(input.retrievedChunks);
      const attachments = createAttachmentsFromChunks(input.retrievedChunks);
      let response: Response;
      try {
        response = await fetchChatCompletion(fetchImpl, endpoint, {
          apiKey,
          body: createChatCompletionBody(input, citations.length, model, false),
          maxRetries,
          requestTimeoutMs,
        });
      } catch (error) {
        if (
          error instanceof LlmRequestTimeoutError ||
          error instanceof LlmRetryableRequestError ||
          error instanceof LlmRequestStatusError
        ) {
          return createGroundedAnswer(input.question, input.classification, input.retrievedChunks);
        }
        throw error;
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const answer = payload.choices?.[0]?.message?.content?.trim();
      if (answer === undefined || isUnusableModelAnswer(answer)) {
        return createGroundedAnswer(input.question, input.classification, input.retrievedChunks);
      }

      return withOptionalAttachments(
        {
          answer,
          citations,
          confidence: calculateLlmConfidence(input.classification.confidence),
          intent: input.classification.intent,
        },
        attachments,
      );
    },

    async *stream(input: AnswerProviderInput): AsyncIterable<ChatStreamEvent> {
      if (!GROUNDED_INTENTS.has(input.classification.intent)) {
        yield* streamStaticAnswer(createBoundaryAnswer(input.classification));
        return;
      }

      if (input.retrievedChunks.length === 0) {
        yield* streamStaticAnswer({
          answer: `当前知识库没有找到与「${input.question}」直接相关的资料。为了避免误导，我不能编造产品细节。`,
          citations: [],
          confidence: 0.25,
          intent: input.classification.intent,
        });
        return;
      }

      const citations = createCitationsFromChunks(input.retrievedChunks);
      const attachments = createAttachmentsFromChunks(input.retrievedChunks);
      let response: Response;
      try {
        response = await fetchChatCompletion(fetchImpl, endpoint, {
          apiKey,
          body: createChatCompletionBody(input, citations.length, model, true),
          maxRetries,
          requestTimeoutMs,
        });
      } catch (error) {
        if (
          error instanceof LlmRequestTimeoutError ||
          error instanceof LlmRetryableRequestError ||
          error instanceof LlmRequestStatusError
        ) {
          yield* streamStaticAnswer(
            createGroundedAnswer(input.question, input.classification, input.retrievedChunks),
          );
          return;
        }
        throw error;
      }

      if (response.body === null) {
        throw new Error('LLM streaming response did not include a body.');
      }

      const deltas: string[] = [];
      for await (const delta of parseChatCompletionStream(response.body)) {
        deltas.push(delta);
      }

      const streamedAnswer = deltas.join('');
      if (isUnusableModelAnswer(streamedAnswer)) {
        yield* streamStaticAnswer(
          createGroundedAnswer(input.question, input.classification, input.retrievedChunks),
        );
        return;
      }

      for (const delta of deltas) {
        yield { type: 'answer_delta', delta };
      }

      yield withOptionalMetadataAttachments(
        {
          type: 'metadata',
          citations,
          confidence: calculateLlmConfidence(input.classification.confidence),
          intent: input.classification.intent,
        },
        attachments,
      );
    },
  };
}

async function fetchChatCompletion(
  fetchImpl: typeof fetch,
  endpoint: string,
  options: {
    apiKey: string;
    body: Record<string, unknown>;
    maxRetries: number;
    requestTimeoutMs: number;
  },
): Promise<Response> {
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    const response = await fetchWithTimeout(
      fetchImpl,
      endpoint,
      {
        body: JSON.stringify(options.body),
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      options.requestTimeoutMs,
    ).catch((error: unknown) => {
      if (error instanceof LlmRequestTimeoutError && attempt < options.maxRetries) {
        return undefined;
      }
      throw error;
    });

    if (response === undefined) {
      continue;
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status)) {
        if (attempt < options.maxRetries) {
          continue;
        }
        throw new LlmRetryableRequestError(response.status);
      }
      throw new LlmRequestStatusError(response.status);
    }

    return response;
  }

  throw new LlmRequestTimeoutError(options.requestTimeoutMs);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(endpoint, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new LlmRequestTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createChatCompletionBody(
  input: AnswerProviderInput,
  citationCount: number,
  model: string,
  stream: boolean,
): Record<string, unknown> {
  return {
    messages: [
      {
        content: systemPrompt(),
        role: 'system',
      },
      {
        content: userPrompt(input, citationCount),
        role: 'user',
      },
    ],
    model,
    ...(stream ? { stream: true } : {}),
    temperature: 0,
  };
}

function isUnusableModelAnswer(answer: string): boolean {
  const normalized = answer.replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 || /^user safety:\s*[a-z_-]+$/iu.test(normalized);
}

function withOptionalAttachments(
  response: ChatResponse,
  attachments: ChatAttachment[],
): ChatResponse {
  if (attachments.length === 0) {
    return response;
  }

  return { ...response, attachments };
}

function withOptionalMetadataAttachments(
  event: Extract<ChatStreamEvent, { type: 'metadata' }>,
  attachments: ChatAttachment[],
): Extract<ChatStreamEvent, { type: 'metadata' }> {
  if (attachments.length === 0) {
    return event;
  }

  return { ...event, attachments };
}

function streamStaticAnswer(response: ChatResponse): AsyncIterable<ChatStreamEvent> {
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

async function* parseChatCompletionStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        yield* parseStreamPart(part);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      yield* parseStreamPart(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

function* parseStreamPart(part: string): Iterable<string> {
  const data = part
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');

  if (data.length === 0 || data === '[DONE]') {
    return;
  }

  const payload = JSON.parse(data) as ChatCompletionStreamResponse;
  const delta = payload.choices?.[0]?.delta?.content;
  if (delta !== undefined && delta.length > 0) {
    yield delta;
  }
}

function systemPrompt(): string {
  return [
    '你是 XXYY 产品客服智能问答助手。',
    '只能基于提供的知识库片段回答，不要编造产品能力、实时账户数据、链上结论或投资建议。',
    '如果资料不足，直接说明当前知识库没有明确说明。',
    '如果知识库片段提供“标准客服回答”，优先使用该标准回答，不要混入其他来源扩展步骤。',
    '回答前检查知识库中与用户问题直接相关的配置项、限制、数量、条件或步骤；不要遗漏与用户问题直接相关的配置项、限制、数量、条件或步骤。',
    '回答使用简洁中文。操作类问题优先给步骤。',
    '不要在正文中伪造来源编号；来源由系统单独返回。',
  ].join('\n');
}

function userPrompt(input: AnswerProviderInput, citationCount: number): string {
  return [
    `用户问题：${input.question}`,
    `分类：${input.classification.intent}`,
    `可用来源数量：${citationCount}`,
    '',
    '知识库片段：',
    createContext(input),
  ].join('\n');
}

function createContext(input: AnswerProviderInput): string {
  const chunks = input.retrievedChunks.map((chunk, index) =>
    [
      `[${index + 1}] ${chunk.metadata.title}`,
      `文件：${chunk.metadata.file}`,
      chunk.metadata.sourceUrl === undefined ? undefined : `URL：${chunk.metadata.sourceUrl}`,
      `内容：${chunk.text}`,
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  );

  return truncateContext(chunks.join('\n\n'));
}

function truncateContext(context: string): string {
  if (context.length <= MAX_CONTEXT_CHARS) {
    return context;
  }

  return `${context.slice(0, MAX_CONTEXT_CHARS)}\n[内容已截断]`;
}

function calculateLlmConfidence(classificationConfidence: number): number {
  return Number(Math.min(0.92, Math.max(0.55, classificationConfidence)).toFixed(2));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
