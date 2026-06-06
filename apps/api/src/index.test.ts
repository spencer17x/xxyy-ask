import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import { LlmConfigurationError, VectorStoreUnavailableError } from '@xxyy/rag-core';

import { createDefaultApiEnv, createRequestHandler, type ApiRequestHandler } from './index.js';
import type { ApiLogEntry } from './index.js';

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  rawBody: Buffer;
}

async function callHandler(
  handler: ApiRequestHandler,
  input: {
    method: string;
    url: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<CapturedResponse> {
  const chunks = input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body), 'utf8')];
  const request = {
    method: input.method,
    url: input.url,
    headers: input.headers ?? {},
    [Symbol.asyncIterator]() {
      return Readable.from(chunks)[Symbol.asyncIterator]();
    },
  };
  const response: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    rawBody: Buffer.alloc(0),
  };
  const bodyChunks: Buffer[] = [];

  await handler(request, {
    get statusCode() {
      return response.statusCode;
    },
    set statusCode(statusCode: number) {
      response.statusCode = statusCode;
    },
    setHeader(name: string, value: string) {
      response.headers[name] = value;
    },
    write(body: string) {
      bodyChunks.push(Buffer.from(body, 'utf8'));
      response.body += body;
      return true;
    },
    end(body?: string | Uint8Array) {
      if (body === undefined) {
        return;
      }
      const chunk = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
      bodyChunks.push(chunk);
      response.body += typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
    },
  });

  response.rawBody = Buffer.concat(bodyChunks);
  return response;
}

describe('createRequestHandler', () => {
  it('loads workspace .env values for the default API environment', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-env-'));
    await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeFile(
      path.join(workspaceRoot, '.env'),
      [
        'POSTGRES_DB=xxyy_ask',
        'POSTGRES_HOST=localhost',
        'POSTGRES_PORT=5432',
        'POSTGRES_USER=xxyy',
        'POSTGRES_PASSWORD=from_file',
        'OPENAI_MODEL=openrouter/free',
      ].join('\n'),
    );

    const env = createDefaultApiEnv({
      cwd: workspaceRoot,
      env: {
        POSTGRES_PASSWORD: 'from_shell',
      },
    });

    expect(env.POSTGRES_DB).toBe('xxyy_ask');
    expect(env.POSTGRES_PASSWORD).toBe('from_shell');
    expect(env.OPENAI_MODEL).toBe('openrouter/free');
  });

  it('returns JSON health status', async () => {
    const handler = createRequestHandler();

    const response = await callHandler(handler, { method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('serves the ops dashboard page', async () => {
    const handler = createRequestHandler({
      renderOpsHtml: () => '<!doctype html><title>XXYY Ops</title>',
    });

    const response = await callHandler(handler, { method: 'GET', url: '/ops' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('XXYY Ops');
  });

  it('returns deep health status with dependency details', async () => {
    const handler = createRequestHandler({
      getHealthStatus: () =>
        Promise.resolve({
          checks: {
            config: { status: 'ok' },
            embedding: { model: 'text-embedding-3-small', status: 'ok' },
            llm: { model: 'gpt-test', status: 'ok' },
            vectorStore: { chunkCount: 42, status: 'ok', vectorExtension: true },
          },
          status: 'ok',
        }),
    });

    const response = await callHandler(handler, { method: 'GET', url: '/health/deep' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      checks: {
        config: { status: 'ok' },
        embedding: { model: 'text-embedding-3-small', status: 'ok' },
        llm: { model: 'gpt-test', status: 'ok' },
        vectorStore: { chunkCount: 42, status: 'ok', vectorExtension: true },
      },
      status: 'ok',
    });
  });

  it('reports missing production configuration in deep health status', async () => {
    const handler = createRequestHandler({ env: {} });

    const response = await callHandler(handler, { method: 'GET', url: '/health/deep' });
    const payload = JSON.parse(response.body) as {
      checks: {
        config: { missing: string[]; status: string };
        embedding: { message: string; status: string };
        llm: { message: string; status: string };
        vectorStore: { message: string; status: string };
      };
      status: string;
    };

    expect(response.statusCode).toBe(503);
    expect(payload.status).toBe('degraded');
    expect(payload.checks.config).toEqual({
      missing: ['DATABASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'],
      status: 'error',
    });
    expect(payload.checks.vectorStore.message).toBe(
      'DATABASE_URL is required for pgvector retrieval.',
    );
    expect(payload.checks.embedding.message).toBe(
      'OPENAI_API_KEY is required for embedding generation.',
    );
    expect(payload.checks.llm.message).toBe(
      'OPENAI_API_KEY and OPENAI_MODEL are required for LLM answer generation.',
    );
  });

  it('keeps ops summary disabled until an ops token is configured', async () => {
    const handler = createRequestHandler({
      getOpsSummary() {
        throw new Error('getOpsSummary should not be called when ops are disabled');
      },
    });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/ops/summary',
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: 'ops_disabled',
      message: 'Ops summary API is disabled.',
    });
  });

  it('requires a valid ops token before returning production summary data', async () => {
    const handler = createRequestHandler({
      env: {
        API_OPS_TOKEN: 'secret-token',
      },
      getOpsSummary() {
        throw new Error('getOpsSummary should not be called for unauthorized requests');
      },
    });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/ops/summary',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'ops_unauthorized',
      message: 'A valid ops token is required.',
    });
  });

  it('returns protected ops summary data for monitoring dashboards', async () => {
    const summary = {
      feedback: {
        latest: [
          {
            answer: '根据知识库，XXYY Pro 提供更多权益。',
            channel: 'web' as const,
            citationCount: 2,
            createdAt: '2026-06-06T02:03:04.000Z',
            intent: 'product_qa' as const,
            question: 'XXYY Pro 有哪些权益？',
            rating: 'negative' as const,
          },
        ],
        negativeCount: 1,
        positiveCount: 2,
        totalCount: 3,
      },
      generatedAt: '2026-06-06T02:04:05.000Z',
      health: {
        checks: {
          config: { status: 'ok' as const },
          embedding: { model: 'text-embedding-3-small', status: 'ok' as const },
          llm: { model: 'gpt-test', status: 'ok' as const },
          vectorStore: { chunkCount: 64, status: 'ok' as const, vectorExtension: true },
        },
        status: 'ok' as const,
      },
      knowledge: {
        chunkCount: 64,
        documentCount: 12,
        sourceStats: [],
        sourceUrlCount: 8,
      },
    };
    const handler = createRequestHandler({
      env: {
        API_OPS_TOKEN: 'secret-token',
      },
      getOpsSummary: () => Promise.resolve(summary),
    });

    const response = await callHandler(handler, {
      headers: {
        Authorization: 'Bearer secret-token',
      },
      method: 'GET',
      url: '/api/ops/summary',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(summary);
  });

  it('handles allowed CORS preflight requests for chat APIs', async () => {
    const handler = createRequestHandler({
      env: {
        API_CORS_ORIGIN: 'https://app.example',
      },
    });

    const response = await callHandler(handler, {
      headers: {
        'access-control-request-headers': 'Content-Type',
        origin: 'https://app.example',
      },
      method: 'OPTIONS',
      url: '/api/chat',
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(response.headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
    expect(response.headers['Access-Control-Allow-Headers']).toBe('Content-Type');
    expect(response.body).toBe('');
  });

  it('adds CORS headers to allowed chat responses', async () => {
    const handler = createRequestHandler({
      env: {
        API_CORS_ORIGIN: 'https://app.example',
      },
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '根据知识库，XXYY Pro 提供更多权益。',
              citations: [],
              confidence: 0.8,
              intent: 'product_qa',
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      headers: { origin: 'https://app.example' },
      method: 'POST',
      url: '/api/chat',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('https://app.example');
  });

  it('rejects oversized JSON request bodies before invoking chat service', async () => {
    const handler = createRequestHandler({
      env: {
        API_MAX_BODY_BYTES: '32',
      },
      getChatService: () =>
        Promise.resolve({
          ask() {
            throw new Error('ask should not be called for oversized bodies');
          },
          stream() {
            throw new Error('stream should not be called for oversized bodies');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { message: '这个请求体会超过三十二个字节' },
      method: 'POST',
      url: '/api/chat',
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      error: 'payload_too_large',
      message: 'Request body exceeds the configured size limit.',
    });
  });

  it('rate limits chat requests by client address', async () => {
    const handler = createRequestHandler({
      env: {
        API_RATE_LIMIT_MAX: '1',
        API_RATE_LIMIT_WINDOW_MS: '1000',
      },
      now: () => 100,
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '根据知识库，XXYY Pro 提供更多权益。',
              citations: [],
              confidence: 0.8,
              intent: 'product_qa',
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const first = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      headers: { 'x-forwarded-for': '203.0.113.1' },
      method: 'POST',
      url: '/api/chat',
    });
    const second = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      headers: { 'x-forwarded-for': '203.0.113.1' },
      method: 'POST',
      url: '/api/chat',
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers['Retry-After']).toBe('1');
    expect(JSON.parse(second.body)).toEqual({
      error: 'rate_limited',
      message: 'Too many requests. Please try again later.',
    });
  });

  it('records answer feedback for production quality loops', async () => {
    const feedback: unknown[] = [];
    const handler = createRequestHandler({
      recordFeedback(input: unknown) {
        feedback.push(input);
        return Promise.resolve();
      },
    });

    const response = await callHandler(handler, {
      body: {
        answer: '根据知识库，XXYY Pro 提供更多权益。',
        channel: 'web',
        citationCount: 2,
        comment: '没有讲清楚监控数量上限',
        intent: 'product_qa',
        question: 'XXYY Pro 有哪些权益？',
        rating: 'negative',
        sessionId: 'session-1',
        userId: 'user-1',
      },
      method: 'POST',
      url: '/api/feedback',
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({ status: 'recorded' });
    expect(feedback).toEqual([
      {
        answer: '根据知识库，XXYY Pro 提供更多权益。',
        channel: 'web',
        citationCount: 2,
        comment: '没有讲清楚监控数量上限',
        intent: 'product_qa',
        question: 'XXYY Pro 有哪些权益？',
        rating: 'negative',
        sessionId: 'session-1',
      },
    ]);
  });

  it('rejects malformed feedback payloads before writing', async () => {
    const handler = createRequestHandler({
      recordFeedback() {
        throw new Error('recordFeedback should not be called for invalid payloads');
      },
    });

    const response = await callHandler(handler, {
      body: {
        answer: '根据知识库，XXYY Pro 提供更多权益。',
        citationCount: 2,
        intent: 'product_qa',
        question: 'XXYY Pro 有哪些权益？',
        rating: 'maybe',
      },
      method: 'POST',
      url: '/api/feedback',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'bad_request',
      message: 'rating must be one of: positive, negative.',
    });
  });

  it('serves product media assets for chat attachments', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-assets-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(path.join(assetsDir, 'xxyy-add-to-home.mp4'), Buffer.from('video-bytes'));
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/assets/xxyy-add-to-home.mp4',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('video/mp4');
    expect(response.rawBody).toEqual(Buffer.from('video-bytes'));
  });

  it('passes chat requests through ChatService', async () => {
    const chatResponse: ChatResponse = {
      answer: '根据知识库，XXYY Pro 提供更多权益。',
      confidence: 0.8,
      intent: 'product_qa',
      citations: [],
    };
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            expect(request).toEqual({
              channel: 'web',
              message: 'XXYY Pro 有哪些权益？',
              sessionId: 'session-1',
              userId: 'user-1',
            });
            return Promise.resolve(chatResponse);
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 'session-1',
        userId: 'user-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(chatResponse);
  });

  it('logs completed chat requests with RAG response metrics', async () => {
    const logs: ApiLogEntry[] = [];
    const nowValues = [100, 145];
    const handler = createRequestHandler({
      logger: (entry) => {
        logs.push(entry);
      },
      now: () => nowValues.shift() ?? 145,
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '根据知识库，XXYY Pro 提供更多权益。',
              citations: [
                {
                  excerpt: 'Pro 用户可以使用更多产品权益。',
                  file: 'docs/pro.md',
                  title: 'XXYY Pro 权益',
                },
              ],
              confidence: 0.8,
              intent: 'product_qa',
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 'session-1',
        userId: 'user-1',
      },
    });

    expect(logs).toEqual([
      {
        attachmentCount: 0,
        channel: 'web',
        citationCount: 1,
        confidence: 0.8,
        durationMs: 45,
        event: 'chat_request',
        intent: 'product_qa',
        messageLength: 15,
        messagePreview: 'XXYY Pro 有哪些权益？',
        outcome: 'success',
        route: '/api/chat',
        sessionIdPresent: true,
        statusCode: 200,
        userIdPresent: true,
      },
    ]);
  });

  it('streams chat responses as server-sent events', async () => {
    const streamEvents: ChatStreamEvent[] = [
      { type: 'answer_delta', delta: 'XXYY Pro' },
      { type: 'answer_delta', delta: ' 有长期权益。' },
      {
        type: 'metadata',
        citations: [],
        confidence: 0.8,
        intent: 'product_qa',
      },
    ];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask() {
            throw new Error('ask should not be used for stream requests');
          },
          async *stream(request) {
            await Promise.resolve();
            expect(request).toEqual({
              channel: 'web',
              message: 'XXYY Pro 有哪些权益？',
            });
            yield* streamEvents;
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat/stream',
      body: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(response.body).toContain('event: answer_delta\n');
    expect(response.body).toContain('data: {"type":"answer_delta","delta":"XXYY Pro"}\n\n');
    expect(response.body).toContain('event: metadata\n');
    expect(response.body).toContain(
      'data: {"type":"metadata","citations":[],"confidence":0.8,"intent":"product_qa"}\n\n',
    );
  });

  it('logs streamed chat requests when metadata is emitted', async () => {
    const logs: ApiLogEntry[] = [];
    const nowValues = [200, 260];
    const streamEvents: ChatStreamEvent[] = [
      { type: 'answer_delta', delta: 'XXYY Pro' },
      {
        type: 'metadata',
        citations: [
          {
            excerpt: 'Pro 用户可以使用更多产品权益。',
            file: 'docs/pro.md',
            title: 'XXYY Pro 权益',
          },
        ],
        confidence: 0.8,
        intent: 'product_qa',
      },
    ];
    const handler = createRequestHandler({
      logger: (entry) => {
        logs.push(entry);
      },
      now: () => nowValues.shift() ?? 260,
      getChatService: () =>
        Promise.resolve({
          ask() {
            throw new Error('ask should not be used for stream requests');
          },
          async *stream() {
            await Promise.resolve();
            yield* streamEvents;
          },
        }),
    });

    await callHandler(handler, {
      method: 'POST',
      url: '/api/chat/stream',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(logs).toEqual([
      {
        attachmentCount: 0,
        channel: 'web',
        citationCount: 1,
        confidence: 0.8,
        durationMs: 60,
        event: 'chat_request',
        intent: 'product_qa',
        messageLength: 15,
        messagePreview: 'XXYY Pro 有哪些权益？',
        outcome: 'success',
        route: '/api/chat/stream',
        sessionIdPresent: false,
        statusCode: 200,
        userIdPresent: false,
      },
    ]);
  });

  it('returns a useful 503 when LLM configuration is missing', async () => {
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.reject(
              new LlmConfigurationError('OPENAI_API_KEY is required for LLM answer generation.'),
            );
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'llm_configuration_missing',
      message: 'OPENAI_API_KEY is required for LLM answer generation.',
    });
  });

  it('logs chat request errors with the public API error code', async () => {
    const logs: ApiLogEntry[] = [];
    const nowValues = [300, 325];
    const handler = createRequestHandler({
      logger: (entry) => {
        logs.push(entry);
      },
      now: () => nowValues.shift() ?? 325,
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.reject(
              new LlmConfigurationError('OPENAI_API_KEY is required for LLM answer generation.'),
            );
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(logs).toEqual([
      {
        channel: 'web',
        durationMs: 25,
        error: 'llm_configuration_missing',
        event: 'chat_request',
        messageLength: 15,
        messagePreview: 'XXYY Pro 有哪些权益？',
        outcome: 'error',
        route: '/api/chat',
        sessionIdPresent: false,
        statusCode: 503,
        userIdPresent: false,
      },
    ]);
  });

  it('answers boundary questions in pgvector mode before requiring vector configuration', async () => {
    const handler = createRequestHandler({ env: {} });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: '帮我查一下钱包余额' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      intent: 'realtime_account_query',
      citations: [],
    });
  });

  it('returns a useful 503 when pgvector configuration is missing', async () => {
    const handler = createRequestHandler({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_MODEL: 'test-model',
      },
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'vector_store_configuration_missing',
      message: 'DATABASE_URL is required for pgvector retrieval.',
    });
  });

  it('returns a useful 503 when embedding configuration is missing', async () => {
    const handler = createRequestHandler({
      env: {
        DATABASE_URL: 'postgres://xxyy:password@localhost:5432/xxyy_ask',
        OPENAI_MODEL: 'test-model',
      },
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'embedding_configuration_missing',
      message: 'OPENAI_API_KEY is required for embedding generation.',
    });
  });

  it('returns a useful 503 when vector store runtime is unavailable', async () => {
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.reject(new VectorStoreUnavailableError(new Error('connect refused')));
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'vector_store_unavailable',
      message: 'Vector store is unavailable. Check DATABASE_URL and database connectivity.',
    });
  });
});
