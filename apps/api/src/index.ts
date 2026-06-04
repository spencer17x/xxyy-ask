import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createOpenAiEmbeddingProvider, EmbeddingConfigurationError } from '@xxyy/knowledge';
import {
  createChatService,
  createLazyRetriever,
  createPgPool,
  createPgVectorStore,
  LlmConfigurationError,
  loadRagConfig,
  loadWorkspaceEnv,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from '@xxyy/rag-core';
import type { ChatRequest, ChatChannel, ChatStreamEvent } from '@xxyy/shared';
import { supportedChannels } from '@xxyy/shared';
import type { ChatService, RagEnv } from '@xxyy/rag-core';
import { renderChatPage } from '@xxyy/web';

type ApiEnv = RagEnv & Partial<Record<'PORT', string>>;

export interface ApiRequestLike {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}

export interface ApiResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  write(body: string): void;
  end(body?: string): void;
}

export type ApiRequestHandler = (
  request: ApiRequestLike,
  response: ApiResponseLike,
) => Promise<void>;

export interface CreateRequestHandlerOptions {
  cwd?: string;
  env?: ApiEnv;
  getChatService?: () => Promise<ChatService>;
  renderHtml?: () => string;
}

export interface StartServerOptions extends CreateRequestHandlerOptions {
  port?: number;
}

interface ChatPayload {
  message: string;
  channel?: ChatChannel;
  sessionId?: string;
  userId?: string;
}

export function createRequestHandler(options: CreateRequestHandlerOptions = {}): ApiRequestHandler {
  const env = options.env ?? createDefaultApiEnv(options);
  const config = loadRagConfig(env);
  const renderHtml = options.renderHtml ?? renderChatPage;
  const getChatService = options.getChatService ?? createCachedChatServiceLoader(config);

  return async function handleRequest(request, response): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');

    try {
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/') {
        sendHtml(response, 200, renderHtml());
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/chat') {
        const payload = parseChatPayload(await readJsonBody(request));
        const service = await getChatService();
        const chatRequest = toChatRequest(payload);
        const chatResponse = await service.ask(chatRequest);
        sendJson(response, 200, chatResponse);
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/chat/stream') {
        const payload = parseChatPayload(await readJsonBody(request));
        const service = await getChatService();
        const chatRequest = toChatRequest(payload);
        await sendChatStream(response, service.stream(chatRequest));
        return;
      }

      sendJson(response, 404, { error: 'not_found', message: 'Route not found.' });
    } catch (error) {
      if (error instanceof BadRequestError) {
        sendJson(response, 400, { error: 'bad_request', message: error.message });
        return;
      }

      if (error instanceof LlmConfigurationError) {
        sendJson(response, 503, {
          error: 'llm_configuration_missing',
          message: error.message,
        });
        return;
      }

      if (error instanceof EmbeddingConfigurationError) {
        sendJson(response, 503, {
          error: 'embedding_configuration_missing',
          message: error.message,
        });
        return;
      }

      if (error instanceof VectorStoreConfigurationError) {
        sendJson(response, 503, {
          error: 'vector_store_configuration_missing',
          message: error.message,
        });
        return;
      }

      if (error instanceof VectorStoreUnavailableError) {
        sendJson(response, 503, {
          error: 'vector_store_unavailable',
          message: error.message,
        });
        return;
      }

      sendJson(response, 500, {
        error: 'internal_error',
        message: 'Unable to process request.',
      });
    }
  };
}

export function createDefaultApiEnv(
  options: Pick<CreateRequestHandlerOptions, 'cwd' | 'env'> = {},
): ApiEnv {
  return loadWorkspaceEnv({
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  });
}

export function startServer(options: StartServerOptions = {}): ReturnType<typeof createServer> {
  const env = options.env ?? createDefaultApiEnv(options);
  const port = Number(options.port ?? env.PORT ?? 3000);
  const handler = createRequestHandler({ ...options, env });
  const server = createServer((request, response) => {
    void handler(request as ApiRequestLike, response);
  });

  server.listen(port, () => {
    process.stdout.write(`XXYY RAG API listening on http://localhost:${port}\n`);
  });

  return server;
}

function createCachedChatServiceLoader(
  config: ReturnType<typeof loadRagConfig>,
): () => Promise<ChatService> {
  let cachedService: ChatService | undefined;

  return () => {
    if (cachedService !== undefined) {
      return Promise.resolve(cachedService);
    }

    const retriever = createLazyRetriever(async () => {
      const pool = createPgPool(config.databaseUrl);

      try {
        const embeddingProvider = createOpenAiEmbeddingProvider({
          apiKey: config.openAiApiKey,
          baseUrl: config.openAiBaseUrl,
          model: config.openAiEmbeddingModel,
        });
        return createPgVectorStore({ client: pool, embeddingProvider });
      } catch (error) {
        await pool.end();
        throw error;
      }
    });
    cachedService = createChatService({ config, retriever });
    return Promise.resolve(cachedService);
  };
}

async function readJsonBody(request: ApiRequestLike): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }

  if (body.trim().length === 0) {
    throw new BadRequestError('Request body must be JSON.');
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (_error) {
    throw new BadRequestError('Request body must be valid JSON.');
  }
}

function parseChatPayload(value: unknown): ChatPayload {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message !== 'string' || record.message.trim().length === 0) {
    throw new BadRequestError('message must be a non-empty string.');
  }

  const channel = parseOptionalChannel(record.channel);

  return withOptionalFields(
    {
      message: record.message.trim(),
      ...(channel === undefined ? {} : { channel }),
    },
    record,
  );
}

function withOptionalFields(
  payload: { message: string; channel?: ChatChannel },
  record: Record<string, unknown>,
): ChatPayload {
  const sessionId = parseOptionalString(record.sessionId, 'sessionId');
  const userId = parseOptionalString(record.userId, 'userId');

  return {
    ...payload,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(userId === undefined ? {} : { userId }),
  };
}

function parseOptionalChannel(value: unknown): ChatChannel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !supportedChannels.includes(value as ChatChannel)) {
    throw new BadRequestError('channel must be one of: cli, web, telegram.');
  }

  return value as ChatChannel;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new BadRequestError(`${fieldName} must be a string.`);
  }

  return value;
}

function toChatRequest(payload: ChatPayload): ChatRequest {
  return {
    channel: payload.channel ?? 'web',
    message: payload.message,
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    ...(payload.userId === undefined ? {} : { userId: payload.userId }),
  };
}

function sendJson(response: ApiResponseLike, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload)}\n`);
}

async function sendChatStream(
  response: ApiResponseLike,
  events: AsyncIterable<ChatStreamEvent>,
): Promise<void> {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');

  try {
    for await (const event of events) {
      writeSseEvent(response, event.type, event);
    }
  } catch (error) {
    writeSseEvent(response, 'error', createStreamErrorPayload(error));
  } finally {
    response.end();
  }
}

function writeSseEvent(response: ApiResponseLike, eventName: string, payload: unknown): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createStreamErrorPayload(error: unknown): { error: string; message: string } {
  if (error instanceof LlmConfigurationError) {
    return { error: 'llm_configuration_missing', message: error.message };
  }

  if (error instanceof EmbeddingConfigurationError) {
    return { error: 'embedding_configuration_missing', message: error.message };
  }

  if (error instanceof VectorStoreConfigurationError) {
    return { error: 'vector_store_configuration_missing', message: error.message };
  }

  if (error instanceof VectorStoreUnavailableError) {
    return { error: 'vector_store_unavailable', message: error.message };
  }

  const message = error instanceof Error ? error.message : 'Unable to process request.';
  return { error: 'internal_error', message };
}

function sendHtml(response: ApiResponseLike, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
}

class BadRequestError extends Error {}

function isDirectRun(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  startServer();
}
