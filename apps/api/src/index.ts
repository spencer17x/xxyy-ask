import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createOpenAiEmbeddingProvider, EmbeddingConfigurationError } from '@xxyy/knowledge';
import {
  createChatService,
  createLazyRetriever,
  createPgFeedbackStore,
  createPgPool,
  createPgVectorStore,
  LlmConfigurationError,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from '@xxyy/rag-core';
import type { ChatRequest, ChatChannel, ChatResponse, ChatStreamEvent, Intent } from '@xxyy/shared';
import { supportedChannels, supportedIntents } from '@xxyy/shared';
import type {
  ChatService,
  FeedbackStats,
  KnowledgeStats,
  PgFeedbackStore,
  RagEnv,
} from '@xxyy/rag-core';
import type { RecordFeedbackInput } from '@xxyy/rag-core';
import { renderChatPage, renderOpsPage } from '@xxyy/web';

type ApiEnv = RagEnv &
  Partial<
    Record<
      | 'API_CORS_ORIGIN'
      | 'API_MAX_BODY_BYTES'
      | 'API_OPS_TOKEN'
      | 'API_RATE_LIMIT_MAX'
      | 'API_RATE_LIMIT_WINDOW_MS'
      | 'PORT',
      string
    >
  >;

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
  getOpsSummary?: () => Promise<OpsSummary>;
  logger?: ApiLogger;
  now?: () => number;
  recordFeedback?: (input: RecordFeedbackInput) => Promise<void>;
  renderHtml?: () => string;
  renderOpsHtml?: () => string;
  staticAssetsDir?: string;
}

export interface StartServerOptions extends CreateRequestHandlerOptions {
  port?: number;
}

interface ApiRuntimeConfig {
  corsOrigins: string[];
  maxBodyBytes: number;
  opsToken?: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

interface ChatPayload {
  message: string;
  channel?: ChatChannel;
  sessionId?: string;
  userId?: string;
}

interface FeedbackPayload {
  answer: string;
  channel?: ChatChannel;
  citationCount: number;
  comment?: string;
  intent: Intent;
  question: string;
  rating: 'positive' | 'negative';
  sessionId?: string;
}

export interface ApiLogEntry {
  event: 'chat_request';
  route: '/api/chat' | '/api/chat/stream';
  channel: ChatChannel;
  durationMs: number;
  messageLength: number;
  messagePreview: string;
  outcome: 'success' | 'error';
  sessionIdPresent: boolean;
  statusCode: number;
  userIdPresent: boolean;
  attachmentCount?: number;
  citationCount?: number;
  confidence?: number;
  error?: string;
  intent?: ChatResponse['intent'];
}

export type ApiLogger = (entry: ApiLogEntry) => void;

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

interface OpsSummary {
  feedback: FeedbackStats;
  generatedAt: string;
  health: DeepHealthStatus;
  knowledge: KnowledgeStats;
}

const MAX_FEEDBACK_QUESTION_CHARS = 2000;
const MAX_FEEDBACK_ANSWER_CHARS = 4000;
const MAX_FEEDBACK_COMMENT_CHARS = 1000;
const MAX_FEEDBACK_SESSION_CHARS = 200;

export function createRequestHandler(options: CreateRequestHandlerOptions = {}): ApiRequestHandler {
  const env = options.env ?? createDefaultApiEnv(options);
  const config = loadRagConfig(env);
  const apiConfig = loadApiRuntimeConfig(env);
  const renderHtml = options.renderHtml ?? renderChatPage;
  const renderOpsHtml = options.renderOpsHtml ?? renderOpsPage;
  const getChatService = options.getChatService ?? createCachedChatServiceLoader(config);
  const getHealthStatus = options.getHealthStatus ?? (() => createDeepHealthStatus(config));
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const getOpsSummary =
    options.getOpsSummary ?? (() => createOpsSummary(config, getHealthStatus, now));
  const recordFeedback = options.recordFeedback ?? createCachedFeedbackRecorder(config);
  const rateLimiter = createRateLimiter(apiConfig, Date.now);
  const staticAssetsDir = options.staticAssetsDir ?? createDefaultStaticAssetsDir(options, env);

  return async function handleRequest(request, response): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const corsResult = applyCors(request, response, requestUrl, apiConfig);
    if (corsResult === 'handled') {
      return;
    }

    if (isChatApiRoute(requestUrl.pathname) && request.method === 'POST') {
      const rateLimitResult = rateLimiter.check(clientAddress(request));
      if (!rateLimitResult.allowed) {
        response.setHeader('Retry-After', String(Math.ceil(rateLimitResult.retryAfterMs / 1000)));
        sendJson(response, 429, {
          error: 'rate_limited',
          message: 'Too many requests. Please try again later.',
        });
        return;
      }
    }

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

      if (request.method === 'GET' && requestUrl.pathname === '/api/ops/summary') {
        await handleOpsSummaryRequest({
          getOpsSummary,
          request,
          response,
          ...(apiConfig.opsToken === undefined ? {} : { opsToken: apiConfig.opsToken }),
        });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/') {
        sendHtml(response, 200, renderHtml());
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/ops') {
        sendHtml(response, 200, renderOpsHtml());
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/assets/')) {
        await sendStaticAsset(response, staticAssetsDir, requestUrl.pathname);
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/chat') {
        await handleChatRequest({
          getChatService,
          logger,
          maxBodyBytes: apiConfig.maxBodyBytes,
          now,
          request,
          response,
          route: '/api/chat',
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/chat/stream') {
        await handleChatRequest({
          getChatService,
          logger,
          maxBodyBytes: apiConfig.maxBodyBytes,
          now,
          request,
          response,
          route: '/api/chat/stream',
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/feedback') {
        await handleFeedbackRequest({
          maxBodyBytes: apiConfig.maxBodyBytes,
          recordFeedback,
          request,
          response,
        });
        return;
      }

      sendJson(response, 404, { error: 'not_found', message: 'Route not found.' });
    } catch (error) {
      const apiError = createApiErrorResponse(error);
      sendJson(response, apiError.statusCode, apiError.body);
    }
  };
}

interface HandleChatRequestOptions {
  getChatService: () => Promise<ChatService>;
  logger: ApiLogger;
  maxBodyBytes: number;
  now: () => number;
  request: ApiRequestLike;
  response: ApiResponseLike;
  route: ApiLogEntry['route'];
}

async function handleChatRequest(options: HandleChatRequestOptions): Promise<void> {
  const payload = parseChatPayload(await readJsonBody(options.request, options.maxBodyBytes));
  const startedAt = options.now();
  const chatRequest = toChatRequest(payload);

  try {
    const service = await options.getChatService();

    if (options.route === '/api/chat') {
      const chatResponse = await service.ask(chatRequest);
      sendJson(options.response, 200, chatResponse);
      options.logger(
        createChatSuccessLogEntry({
          durationMs: options.now() - startedAt,
          payload,
          response: chatResponse,
          route: options.route,
          statusCode: 200,
        }),
      );
      return;
    }

    const summary = await sendChatStream(options.response, service.stream(chatRequest));
    options.logger(
      createChatStreamLogEntry({
        durationMs: options.now() - startedAt,
        payload,
        route: options.route,
        summary,
      }),
    );
  } catch (error) {
    const apiError = createApiErrorResponse(error);
    options.logger(
      createChatErrorLogEntry({
        durationMs: options.now() - startedAt,
        error: apiError.body.error,
        payload,
        route: options.route,
        statusCode: apiError.statusCode,
      }),
    );
    throw error;
  }
}

interface HandleFeedbackRequestOptions {
  maxBodyBytes: number;
  recordFeedback: (input: RecordFeedbackInput) => Promise<void>;
  request: ApiRequestLike;
  response: ApiResponseLike;
}

interface HandleOpsSummaryRequestOptions {
  getOpsSummary: () => Promise<OpsSummary>;
  opsToken?: string;
  request: ApiRequestLike;
  response: ApiResponseLike;
}

async function handleOpsSummaryRequest(options: HandleOpsSummaryRequestOptions): Promise<void> {
  if (options.opsToken === undefined) {
    sendJson(options.response, 404, {
      error: 'ops_disabled',
      message: 'Ops summary API is disabled.',
    });
    return;
  }

  if (!isOpsRequestAuthorized(options.request, options.opsToken)) {
    sendJson(options.response, 401, {
      error: 'ops_unauthorized',
      message: 'A valid ops token is required.',
    });
    return;
  }

  sendJson(options.response, 200, await options.getOpsSummary());
}

async function handleFeedbackRequest(options: HandleFeedbackRequestOptions): Promise<void> {
  const payload = parseFeedbackPayload(await readJsonBody(options.request, options.maxBodyBytes));
  await options.recordFeedback(toRecordFeedbackInput(payload));
  sendJson(options.response, 201, { status: 'recorded' });
}

function loadApiRuntimeConfig(env: ApiEnv): ApiRuntimeConfig {
  const opsToken = parseOptionalEnvText(env.API_OPS_TOKEN);
  return {
    corsOrigins: parseCsv(env.API_CORS_ORIGIN),
    maxBodyBytes: parsePositiveInteger(env.API_MAX_BODY_BYTES, 64 * 1024),
    ...(opsToken === undefined ? {} : { opsToken }),
    rateLimitMax: parsePositiveInteger(env.API_RATE_LIMIT_MAX, 60),
    rateLimitWindowMs: parsePositiveInteger(env.API_RATE_LIMIT_WINDOW_MS, 60_000),
  };
}

function parseCsv(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalEnvText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

type CorsResult = 'continue' | 'handled';

function applyCors(
  request: ApiRequestLike,
  response: ApiResponseLike,
  requestUrl: URL,
  config: ApiRuntimeConfig,
): CorsResult {
  if (!isApiRoute(requestUrl.pathname)) {
    return 'continue';
  }

  const origin = headerValue(request.headers.origin);
  if (origin !== undefined && isCorsOriginAllowed(origin, config.corsOrigins)) {
    const allowedOrigin = config.corsOrigins.includes('*') ? '*' : origin;
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader(
      'Access-Control-Allow-Headers',
      headerValue(request.headers['access-control-request-headers']) ?? 'Content-Type',
    );
    response.setHeader('Access-Control-Max-Age', '600');
    if (allowedOrigin !== '*') {
      response.setHeader('Vary', 'Origin');
    }
  }

  if (request.method === 'OPTIONS') {
    if (origin !== undefined && !isCorsOriginAllowed(origin, config.corsOrigins)) {
      sendJson(response, 403, {
        error: 'cors_origin_forbidden',
        message: 'CORS origin is not allowed.',
      });
      return 'handled';
    }
    response.statusCode = 204;
    response.end();
    return 'handled';
  }

  return 'continue';
}

function isCorsOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

function isChatApiRoute(pathname: string): boolean {
  return pathname === '/api/chat' || pathname === '/api/chat/stream';
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

function createRateLimiter(
  config: Pick<ApiRuntimeConfig, 'rateLimitMax' | 'rateLimitWindowMs'>,
  now: () => number,
): { check(key: string): RateLimitResult } {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key) {
      const currentTime = now();
      const currentBucket = buckets.get(key);
      if (currentBucket === undefined || currentBucket.resetAt <= currentTime) {
        buckets.set(key, {
          count: 1,
          resetAt: currentTime + config.rateLimitWindowMs,
        });
        return { allowed: true, retryAfterMs: 0 };
      }

      if (currentBucket.count >= config.rateLimitMax) {
        return {
          allowed: false,
          retryAfterMs: Math.max(1, currentBucket.resetAt - currentTime),
        };
      }

      currentBucket.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

function clientAddress(request: ApiRequestLike): string {
  const forwardedFor = headerValue(request.headers['x-forwarded-for']);
  if (forwardedFor !== undefined && forwardedFor.trim().length > 0) {
    return forwardedFor.split(',')[0]?.trim() ?? 'unknown';
  }

  const realIp = headerValue(request.headers['x-real-ip']);
  if (realIp !== undefined && realIp.trim().length > 0) {
    return realIp.trim();
  }

  return 'unknown';
}

function isOpsRequestAuthorized(request: ApiRequestLike, opsToken: string): boolean {
  const directToken = requestHeaderValue(request.headers, 'x-ops-token');
  if (directToken !== undefined && directToken.trim() === opsToken) {
    return true;
  }

  const authorization = requestHeaderValue(request.headers, 'authorization');
  const bearerPrefix = 'Bearer ';
  if (authorization !== undefined && authorization.startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length).trim() === opsToken;
  }

  return false;
}

function requestHeaderValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const direct = headerValue(headers[name]);
  if (direct !== undefined) {
    return direct;
  }

  const lowerName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === lowerName) {
      return headerValue(value);
    }
  }

  return undefined;
}

function createChatSuccessLogEntry(input: {
  durationMs: number;
  payload: ChatPayload;
  response: ChatResponse;
  route: ApiLogEntry['route'];
  statusCode: number;
}): ApiLogEntry {
  return {
    ...createChatLogBase(input.payload, input.route, input.durationMs, input.statusCode),
    attachmentCount: input.response.attachments?.length ?? 0,
    citationCount: input.response.citations.length,
    confidence: input.response.confidence,
    intent: input.response.intent,
    outcome: 'success',
  };
}

function createChatStreamLogEntry(input: {
  durationMs: number;
  payload: ChatPayload;
  route: ApiLogEntry['route'];
  summary: ChatStreamSummary;
}): ApiLogEntry {
  const base = createChatLogBase(
    input.payload,
    input.route,
    input.durationMs,
    input.summary.statusCode,
  );

  if (input.summary.outcome === 'error') {
    return {
      ...base,
      error: input.summary.error ?? 'internal_error',
      outcome: 'error',
    };
  }

  return {
    ...base,
    attachmentCount: input.summary.attachmentCount ?? 0,
    citationCount: input.summary.citationCount ?? 0,
    ...(input.summary.confidence === undefined ? {} : { confidence: input.summary.confidence }),
    ...(input.summary.intent === undefined ? {} : { intent: input.summary.intent }),
    outcome: 'success',
  };
}

function createChatErrorLogEntry(input: {
  durationMs: number;
  error: string;
  payload: ChatPayload;
  route: ApiLogEntry['route'];
  statusCode: number;
}): ApiLogEntry {
  return {
    ...createChatLogBase(input.payload, input.route, input.durationMs, input.statusCode),
    error: input.error,
    outcome: 'error',
  };
}

function createChatLogBase(
  payload: ChatPayload,
  route: ApiLogEntry['route'],
  durationMs: number,
  statusCode: number,
): Omit<ApiLogEntry, 'outcome'> {
  return {
    channel: payload.channel ?? 'web',
    durationMs,
    event: 'chat_request',
    messageLength: payload.message.length,
    messagePreview: createMessagePreview(payload.message),
    route,
    sessionIdPresent: payload.sessionId !== undefined,
    statusCode,
    userIdPresent: payload.userId !== undefined,
  };
}

function createMessagePreview(message: string): string {
  const normalized = message.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= 160) {
    return normalized;
  }
  return `${normalized.slice(0, 159)}…`;
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

async function createOpsSummary(
  config: ReturnType<typeof loadRagConfig>,
  getHealthStatus: () => Promise<DeepHealthStatus>,
  now: () => number,
): Promise<OpsSummary> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const knowledgeStore = createPgVectorStore({
      client: pool,
      embeddingProvider: {
        embedTexts: () => Promise.reject(new Error('ops summary does not generate embeddings.')),
      },
    });
    const feedbackStore = createPgFeedbackStore({ client: pool });
    const [health, knowledge, feedback] = await Promise.all([
      getHealthStatus(),
      knowledgeStore.getStats(),
      feedbackStore.getFeedbackStats({ limit: 10 }),
    ]);

    return {
      feedback,
      generatedAt: new Date(now()).toISOString(),
      health,
      knowledge,
    };
  } finally {
    await pool.end();
  }
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
  if (
    config.txAnalysisProvider !== 'none' &&
    config.txAnalysisProvider !== 'mock' &&
    config.txAnalysisProvider !== 'browser'
  ) {
    return {
      message: `Unsupported TX_ANALYSIS_PROVIDER: ${config.txAnalysisProvider}`,
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
  const handler = createRequestHandler({
    ...options,
    env,
    logger: options.logger ?? createConsoleApiLogger(),
  });
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

function createCachedFeedbackRecorder(
  config: ReturnType<typeof loadRagConfig>,
): (input: RecordFeedbackInput) => Promise<void> {
  let cachedStore: PgFeedbackStore | undefined;

  return async (input) => {
    if (cachedStore === undefined) {
      cachedStore = createPgFeedbackStore({ client: createPgPool(config.databaseUrl) });
    }

    await cachedStore.recordFeedback(input);
  };
}

async function readJsonBody(request: ApiRequestLike, maxBodyBytes: number): Promise<unknown> {
  let body = '';
  let byteLength = 0;
  for await (const chunk of request) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    byteLength += Buffer.byteLength(text, 'utf8');
    if (byteLength > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
    body += text;
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

function parseFeedbackPayload(value: unknown): FeedbackPayload {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = value as Record<string, unknown>;
  const channel = parseOptionalChannel(record.channel);
  const comment = parseOptionalText(record.comment, 'comment', MAX_FEEDBACK_COMMENT_CHARS);
  const sessionId = parseOptionalText(record.sessionId, 'sessionId', MAX_FEEDBACK_SESSION_CHARS);

  return {
    answer: parseRequiredText(record.answer, 'answer', MAX_FEEDBACK_ANSWER_CHARS),
    citationCount: parseNonNegativeInteger(record.citationCount, 'citationCount'),
    intent: parseIntent(record.intent),
    question: parseRequiredText(record.question, 'question', MAX_FEEDBACK_QUESTION_CHARS),
    rating: parseFeedbackRating(record.rating),
    ...(channel === undefined ? {} : { channel }),
    ...(comment === undefined ? {} : { comment }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
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

function parseFeedbackRating(value: unknown): 'positive' | 'negative' {
  if (value !== 'positive' && value !== 'negative') {
    throw new BadRequestError('rating must be one of: positive, negative.');
  }

  return value;
}

function parseIntent(value: unknown): Intent {
  if (typeof value !== 'string' || !supportedIntents.includes(value as Intent)) {
    throw new BadRequestError(`intent must be one of: ${supportedIntents.join(', ')}.`);
  }

  return value as Intent;
}

function parseRequiredText(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${fieldName} must be a non-empty string.`);
  }

  return truncateText(value.trim(), maxLength);
}

function parseOptionalText(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new BadRequestError(`${fieldName} must be a string.`);
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : truncateText(normalized, maxLength);
}

function parseNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestError(`${fieldName} must be a non-negative integer.`);
  }

  return value;
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

function toRecordFeedbackInput(payload: FeedbackPayload): RecordFeedbackInput {
  return {
    answer: payload.answer,
    channel: payload.channel ?? 'web',
    citationCount: payload.citationCount,
    intent: payload.intent,
    question: payload.question,
    rating: payload.rating,
    ...(payload.comment === undefined ? {} : { comment: payload.comment }),
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
  };
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
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
  const lower = assetName.toLowerCase();
  if (lower.endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.svg')) {
    return 'image/svg+xml';
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

interface ChatStreamSummary {
  outcome: 'success' | 'error';
  statusCode: number;
  attachmentCount?: number;
  citationCount?: number;
  confidence?: number;
  error?: string;
  intent?: ChatResponse['intent'];
}

async function sendChatStream(
  response: ApiResponseLike,
  events: AsyncIterable<ChatStreamEvent>,
): Promise<ChatStreamSummary> {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');

  let metadata: Extract<ChatStreamEvent, { type: 'metadata' }> | undefined;

  try {
    for await (const event of events) {
      writeSseEvent(response, event.type, event);
      if (event.type === 'metadata') {
        metadata = event;
      }
    }
    return {
      attachmentCount: metadata?.attachments?.length ?? 0,
      citationCount: metadata?.citations.length ?? 0,
      ...(metadata?.confidence === undefined ? {} : { confidence: metadata.confidence }),
      ...(metadata?.intent === undefined ? {} : { intent: metadata.intent }),
      outcome: 'success',
      statusCode: 200,
    };
  } catch (error) {
    const payload = createApiErrorResponse(error).body;
    writeSseEvent(response, 'error', payload);
    return {
      error: payload.error,
      outcome: 'error',
      statusCode: 200,
    };
  } finally {
    response.end();
  }
}

function writeSseEvent(response: ApiResponseLike, eventName: string, payload: unknown): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createApiErrorResponse(error: unknown): {
  body: { error: string; message: string };
  statusCode: number;
} {
  if (error instanceof BadRequestError) {
    return {
      body: { error: 'bad_request', message: error.message },
      statusCode: 400,
    };
  }

  if (error instanceof PayloadTooLargeError) {
    return {
      body: {
        error: 'payload_too_large',
        message: 'Request body exceeds the configured size limit.',
      },
      statusCode: 413,
    };
  }

  if (error instanceof LlmConfigurationError) {
    return {
      body: { error: 'llm_configuration_missing', message: error.message },
      statusCode: 503,
    };
  }

  if (error instanceof EmbeddingConfigurationError) {
    return {
      body: { error: 'embedding_configuration_missing', message: error.message },
      statusCode: 503,
    };
  }

  if (error instanceof VectorStoreConfigurationError) {
    return {
      body: { error: 'vector_store_configuration_missing', message: error.message },
      statusCode: 503,
    };
  }

  if (error instanceof VectorStoreUnavailableError) {
    return {
      body: { error: 'vector_store_unavailable', message: error.message },
      statusCode: 503,
    };
  }

  return {
    body: { error: 'internal_error', message: 'Unable to process request.' },
    statusCode: 500,
  };
}

function noopLogger(_entry: ApiLogEntry): void {}

function createConsoleApiLogger(): ApiLogger {
  return (entry) => {
    process.stdout.write(`${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`);
  };
}

function sendHtml(response: ApiResponseLike, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
}

class BadRequestError extends Error {}

class PayloadTooLargeError extends Error {}

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
