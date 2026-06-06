import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { readFile } from 'node:fs/promises';
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
  resolveWorkspaceCwd,
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
  end(body?: string | Uint8Array): void;
}

export type ApiRequestHandler = (
  request: ApiRequestLike,
  response: ApiResponseLike,
) => Promise<void>;

export interface CreateRequestHandlerOptions {
  cwd?: string;
  env?: ApiEnv;
  getChatService?: () => Promise<ChatService>;
  getHealthStatus?: () => Promise<DeepHealthStatus>;
  renderHtml?: () => string;
  staticAssetsDir?: string;
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

interface HealthCheck {
  status: 'ok' | 'error';
  message?: string;
  missing?: string[];
  model?: string;
  dimension?: number;
  chunkCount?: number;
  vectorExtension?: boolean;
}

interface DeepHealthStatus {
  status: 'ok' | 'degraded';
  checks: {
    config: HealthCheck;
    embedding: HealthCheck;
    llm: HealthCheck;
    vectorStore: HealthCheck;
  };
}

export function createRequestHandler(options: CreateRequestHandlerOptions = {}): ApiRequestHandler {
  const env = options.env ?? createDefaultApiEnv(options);
  const config = loadRagConfig(env);
  const renderHtml = options.renderHtml ?? renderChatPage;
  const getChatService = options.getChatService ?? createCachedChatServiceLoader(config);
  const getHealthStatus = options.getHealthStatus ?? (() => createDeepHealthStatus(config));
  const staticAssetsDir = options.staticAssetsDir ?? createDefaultStaticAssetsDir(options, env);

  return async function handleRequest(request, response): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');

    try {
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/health/deep') {
        const healthStatus = await getHealthStatus();
        sendJson(response, healthStatus.status === 'ok' ? 200 : 503, healthStatus);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/') {
        sendHtml(response, 200, renderHtml());
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/assets/')) {
        await sendStaticAsset(response, staticAssetsDir, requestUrl.pathname);
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

async function createDeepHealthStatus(
  config: ReturnType<typeof loadRagConfig>,
): Promise<DeepHealthStatus> {
  const checks: DeepHealthStatus['checks'] = {
    config: checkRequiredConfig(config),
    embedding: await checkEmbedding(config),
    llm: await checkLlm(config),
    vectorStore: await checkVectorStore(config),
  };

  return {
    checks,
    status: Object.values(checks).every((check) => check.status === 'ok') ? 'ok' : 'degraded',
  };
}

function checkRequiredConfig(config: ReturnType<typeof loadRagConfig>): HealthCheck {
  const missing: string[] = [];

  if (config.databaseUrl === undefined || config.databaseUrl.trim().length === 0) {
    missing.push('DATABASE_URL');
  }
  if (config.openAiApiKey === undefined || config.openAiApiKey.trim().length === 0) {
    missing.push('OPENAI_API_KEY');
  }
  if (config.openAiModel === undefined || config.openAiModel.trim().length === 0) {
    missing.push('OPENAI_MODEL');
  }

  if (config.answerProvider !== 'openai') {
    return {
      message: `Unsupported RAG_ANSWER_PROVIDER: ${config.answerProvider}`,
      missing,
      status: 'error',
    };
  }

  if (missing.length > 0) {
    return { missing, status: 'error' };
  }

  return { status: 'ok' };
}

async function checkVectorStore(config: ReturnType<typeof loadRagConfig>): Promise<HealthCheck> {
  if (config.databaseUrl === undefined || config.databaseUrl.trim().length === 0) {
    return {
      message: 'DATABASE_URL is required for pgvector retrieval.',
      status: 'error',
    };
  }

  const pool = createPgPool(config.databaseUrl);
  try {
    const result = await pool.query<{
      chunk_count: number;
      vector_extension: boolean;
    }>(`
      select
        exists(select 1 from pg_extension where extname = 'vector') as vector_extension,
        (select count(*)::integer from knowledge_chunks) as chunk_count
    `);
    const row = result.rows[0];
    if (row === undefined) {
      return { message: 'Vector store health query returned no rows.', status: 'error' };
    }
    return {
      chunkCount: row.chunk_count,
      status: row.vector_extension ? 'ok' : 'error',
      vectorExtension: row.vector_extension,
      ...(row.vector_extension ? {} : { message: 'pgvector extension is not enabled.' }),
    };
  } catch (error) {
    return { message: healthErrorMessage(error), status: 'error' };
  } finally {
    await pool.end();
  }
}

async function checkEmbedding(config: ReturnType<typeof loadRagConfig>): Promise<HealthCheck> {
  try {
    const provider = createOpenAiEmbeddingProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiEmbeddingModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    const [embedding] = await provider.embedTexts(['XXYY health check']);
    if (embedding === undefined) {
      return { message: 'Embedding response did not include an embedding.', status: 'error' };
    }
    return {
      dimension: embedding.length,
      model: config.openAiEmbeddingModel,
      status: 'ok',
    };
  } catch (error) {
    return { message: healthErrorMessage(error), status: 'error' };
  }
}

async function checkLlm(config: ReturnType<typeof loadRagConfig>): Promise<HealthCheck> {
  const apiKey = config.openAiApiKey;
  const model = config.openAiModel;
  const missingApiKey = apiKey === undefined || apiKey.trim().length === 0;
  const missingModel = model === undefined || model.trim().length === 0;

  if (missingApiKey && missingModel) {
    return {
      message: 'OPENAI_API_KEY and OPENAI_MODEL are required for LLM answer generation.',
      status: 'error',
    };
  }
  if (missingApiKey) {
    return {
      message: 'OPENAI_API_KEY is required for LLM answer generation.',
      status: 'error',
    };
  }
  if (missingModel) {
    return {
      message: 'OPENAI_MODEL is required for LLM answer generation.',
      status: 'error',
    };
  }

  const resolvedApiKey = apiKey;
  const resolvedModel = model;

  try {
    const response = await fetchWithHealthTimeout(
      `${config.openAiBaseUrl.replace(/\/+$/u, '')}/chat/completions`,
      {
        body: JSON.stringify({
          messages: [
            { content: 'Reply with OK only.', role: 'system' },
            { content: 'health check', role: 'user' },
          ],
          model: resolvedModel,
          temperature: 0,
        }),
        headers: {
          Authorization: `Bearer ${resolvedApiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      config.openAiRequestTimeoutMs,
    );

    if (!response.ok) {
      return {
        message: `LLM health request failed with status ${response.status}${await readHealthErrorDetail(response)}`,
        model: resolvedModel,
        status: 'error',
      };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return {
        message: 'LLM health response did not include message content.',
        model: resolvedModel,
        status: 'error',
      };
    }

    return { model: resolvedModel, status: 'ok' };
  } catch (error) {
    return {
      message: healthErrorMessage(error),
      model: resolvedModel,
      status: 'error',
    };
  }
}

async function fetchWithHealthTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readHealthErrorDetail(response: Response): Promise<string> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return '';
  }

  try {
    const payload = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = payload.error?.message ?? payload.message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return `: ${message.trim()}`;
    }
  } catch {
    return `: ${truncateHealthError(text)}`;
  }

  return `: ${truncateHealthError(text)}`;
}

function truncateHealthError(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 300);
}

function healthErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
          maxRetries: config.openAiMaxRetries,
          model: config.openAiEmbeddingModel,
          requestTimeoutMs: config.openAiRequestTimeoutMs,
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

function createDefaultStaticAssetsDir(
  options: Pick<CreateRequestHandlerOptions, 'cwd'>,
  env: ApiEnv,
): string {
  const workspaceCwd = resolveWorkspaceCwd(options.cwd ?? process.cwd(), env);
  return path.join(workspaceCwd, 'docs', 'product-features', 'assets');
}

async function sendStaticAsset(
  response: ApiResponseLike,
  assetsDir: string,
  pathname: string,
): Promise<void> {
  const assetName = decodeURIComponent(pathname.replace(/^\/assets\//u, ''));
  if (!/^[A-Za-z0-9._-]+$/u.test(assetName)) {
    sendJson(response, 404, { error: 'not_found', message: 'Asset not found.' });
    return;
  }

  try {
    const body = await readFile(path.join(assetsDir, assetName));
    response.statusCode = 200;
    response.setHeader('Content-Type', contentTypeForAsset(assetName));
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.end(body);
  } catch (error) {
    if (isMissingFileError(error)) {
      sendJson(response, 404, { error: 'not_found', message: 'Asset not found.' });
      return;
    }
    throw error;
  }
}

function contentTypeForAsset(assetName: string): string {
  if (assetName.toLowerCase().endsWith('.mp4')) {
    return 'video/mp4';
  }

  return 'application/octet-stream';
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
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
