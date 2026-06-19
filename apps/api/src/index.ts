import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  createCustomerAgentChatService,
  createInMemoryQualitySignalSink,
  createInMemorySessionContextStore,
  createPgSessionContextStore,
  sanitizeSessionText,
  type QualitySignalSink,
  type SessionContextStore,
} from '@xxyy/agent-core';
import { createOpenAiEmbeddingProvider, EmbeddingConfigurationError } from '@xxyy/knowledge';
import {
  KnowledgeCandidateNotFoundError,
  captureAnswerQualitySignals,
  createPgKnowledgeOpsStore,
  mineAnswerFeedback,
  type KnowledgeCandidate,
  type KnowledgeCandidateRun,
  type KnowledgeCandidateStore,
  type KnowledgeCandidateSource,
  type KnowledgeCandidateStatus,
  type KnowledgeCandidateType,
  type KnowledgeRiskLevel,
  type ReviewKnowledgeCandidateInput,
} from '@xxyy/knowledge-ops';
import {
  createConfiguredTxAnalysisProvider,
  createOpenAiAnswerProvider,
  createTxAnalysisUnavailableAnswer,
  createLazyRetriever,
  createPgTxAnalysisReportStore,
  createPgFeedbackStore,
  createPgPool,
  createPgVectorStore,
  findFileTxAnalysisReports,
  getFileTxAnalysisReportDocument,
  LlmConfigurationError,
  loadRagConfig,
  loadWorkspaceEnv,
  parseOptionalTxAnalysisChainInput,
  parseRequiredTxAnalysisChainInput,
  parseTransactionReference,
  resolveWorkspaceCwd,
  summarizeFileTxAnalysisReports,
  toTxAnalysisReferenceInput,
  TX_ANALYSIS_CHAIN_ERROR,
  updateFileTxAnalysisReportReview,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from '@xxyy/rag-core';
import type {
  ChatRequest,
  ChatChannel,
  ChatResponse,
  ChatStreamEvent,
  Intent,
  TxAnalysisChain,
} from '@xxyy/shared';
import { supportedChannels, supportedIntents } from '@xxyy/shared';
import type {
  AnswerProvider,
  ChatService,
  FeedbackStats,
  FindTxAnalysisReportsOptions,
  KnowledgeStats,
  PgFeedbackStore,
  RagEnv,
  SummarizeTxAnalysisReportsOptions,
  TxAnalysisReportIndexEntry,
  TxAnalysisReportReview,
  TxAnalysisReportReviewStatus,
  TxAnalysisReportSummary,
  TxAnalysisStoredReportDocument,
  TxAnalysisUnavailableReason,
  UpdateTxAnalysisReportReviewInput,
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
  getKnowledgeCandidateStore?: () => Promise<KnowledgeCandidateStore>;
  getOpsSummary?: () => Promise<OpsSummary>;
  getTxAnalysisReportStore?: () => Promise<TxAnalysisReportReader>;
  logger?: ApiLogger;
  now?: () => number;
  recordFeedback?: (input: RecordFeedbackInput) => Promise<void>;
  recordFeedbackCandidate?: (input: RecordFeedbackInput) => Promise<void>;
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

interface TxAnalysisPayload {
  txHash: string;
  chain?: TxAnalysisChain;
  channel?: ChatChannel;
  sessionId?: string;
  unsupportedChainText?: string;
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

interface ParsedTxAnalysisPayloadChain {
  chain?: TxAnalysisChain;
  unsupportedChainText?: string;
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
  agentRoute?: ChatResponse['agentRoute'];
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
  knowledgeCandidateQueues: KnowledgeCandidateQueueSummary;
  txAnalysis: TxAnalysisReportSummary;
  txAnalysisRuntime?: TxAnalysisRuntimeSummary;
}

interface KnowledgeCandidateQueueSummary {
  approvedEvalCaseCount: number;
  evalFailedCount: number;
  evalFailureReasonCounts: Record<string, number>;
  needsReviewCount: number;
  qualitySignalAgentRouteCounts: Record<string, number>;
  qualitySignalClusters: QualitySignalClusterSummary[];
  qualitySignalNeedsReviewCount: number;
  qualitySignalReasonCounts: Record<string, number>;
  recentEvalFailures: RecentKnowledgeEvalFailureSummary[];
  recentQualitySignals: RecentQualitySignalCandidateSummary[];
}

interface RecentKnowledgeEvalFailureSummary {
  candidateId: string;
  evaluatedAt?: string;
  failureReasons: string[];
  question: string;
  runId?: string;
}

interface RecentQualitySignalCandidateSummary {
  agentRoute: string;
  candidateId: string;
  createdAt: string;
  question: string;
  riskLevel: KnowledgeRiskLevel;
  targetCategory: KnowledgeCandidate['targetCategory'];
  type: KnowledgeCandidateType;
}

interface QualitySignalClusterSummary {
  agentRoute: string;
  candidateIds: string[];
  clusterKey: string;
  count: number;
  latestCreatedAt: string;
  reason: string;
  sampleQuestions: string[];
  targetCategory: KnowledgeCandidate['targetCategory'];
  type: KnowledgeCandidateType;
}

interface TxAnalysisRuntimeSummary {
  browser: {
    chromeExecutablePathConfigured: boolean;
    discoverUrl?: string;
    headless: boolean;
    maxConcurrency: number;
    maxRetries: number;
    screenshotBaseUrl: string;
    screenshotDirConfigured: boolean;
    timeoutMs: number;
    userDataDirConfigured: boolean;
  };
  provider: string;
  reportStore: string;
  reviewer: string;
}

interface TxAnalysisReportReader {
  findReports(options: FindTxAnalysisReportsOptions): Promise<TxAnalysisReportIndexEntry[]>;
  getReportDocument?(id: string): Promise<TxAnalysisStoredReportDocument | undefined>;
  summarizeReports(options?: SummarizeTxAnalysisReportsOptions): Promise<TxAnalysisReportSummary>;
  updateReportReview?(
    input: UpdateTxAnalysisReportReviewInput,
  ): Promise<TxAnalysisReportReview | undefined>;
}

const MAX_FEEDBACK_QUESTION_CHARS = 2000;
const MAX_FEEDBACK_ANSWER_CHARS = 4000;
const MAX_FEEDBACK_COMMENT_CHARS = 1000;
const MAX_FEEDBACK_SESSION_CHARS = 200;
const MAX_TX_ANALYSIS_REVIEW_ASSIGNEE_CHARS = 200;
const MAX_TX_ANALYSIS_REVIEW_NOTE_CHARS = 2000;
const MAX_TX_ANALYSIS_REVIEW_UPDATED_BY_CHARS = 200;
const MAX_KNOWLEDGE_REVIEW_NOTES_CHARS = 2000;
const MAX_KNOWLEDGE_REVIEW_REVIEWER_CHARS = 200;
const MAX_QUALITY_SIGNAL_CLUSTER_KEY_CHARS = 300;
const supportedTxAnalysisReportStatuses = ['failure', 'success'] as const;
const supportedTxAnalysisReportReviewStatuses = ['closed', 'in_review', 'open'] as const;
const supportedTxAnalysisReportReviewActions = ['claim', 'close', 'reopen'] as const;
type TxAnalysisReportReviewAction = (typeof supportedTxAnalysisReportReviewActions)[number];
const supportedKnowledgeCandidateStatuses = [
  'draft',
  'needs_review',
  'approved',
  'rejected',
  'published',
  'ingested',
  'eval_passed',
  'eval_failed',
] as const;
const supportedKnowledgeCandidateTypes = [
  'faq',
  'doc_patch',
  'boundary_example',
  'eval_case',
] as const;
const supportedKnowledgeCandidateRiskLevels = ['low', 'medium', 'high'] as const;
const supportedKnowledgeCandidateSources = [
  'telegram',
  'answer_feedback',
  'answer_quality_signal',
] as const;
const supportedKnowledgeCandidateReviewActions = [
  'approve',
  'reject',
  'request_changes',
  'merge_duplicate',
] as const;
const supportedTxAnalysisReportFailureReasons = [
  'not_configured',
  'provider_unavailable',
  'invalid_reference',
  'unsupported_chain',
  'browser_verification_required',
  'tx_not_found',
  'tx_failed',
  'tx_pending',
  'pool_not_found',
  'target_trade_not_found',
  'screenshot_unavailable',
  'timeout',
] as const;

export function createRequestHandler(options: CreateRequestHandlerOptions = {}): ApiRequestHandler {
  const env = options.env ?? createDefaultApiEnv(options);
  const config = loadRagConfig(env);
  const apiConfig = loadApiRuntimeConfig(env);
  const renderHtml = options.renderHtml ?? renderChatPage;
  const renderOpsHtml = options.renderOpsHtml ?? renderOpsPage;
  const getChatService = options.getChatService ?? createCachedChatServiceLoader(config);
  const getHealthStatus = options.getHealthStatus ?? (() => createDeepHealthStatus(config));
  const getKnowledgeCandidateStore =
    options.getKnowledgeCandidateStore ?? createCachedKnowledgeCandidateStoreLoader(config);
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const staticAssetsDir = options.staticAssetsDir ?? createDefaultStaticAssetsDir(options, env);
  const getTxAnalysisReportStore =
    options.getTxAnalysisReportStore ??
    createCachedTxAnalysisReportStoreLoader(config, staticAssetsDir);
  const getOpsSummary =
    options.getOpsSummary ??
    (() => createOpsSummary(config, getHealthStatus, now, getTxAnalysisReportStore));
  const txAnalysisRuntime = createTxAnalysisRuntimeSummary(config);
  const recordFeedback = options.recordFeedback ?? createCachedFeedbackRecorder(config);
  const recordFeedbackCandidate =
    options.recordFeedbackCandidate ?? createCachedFeedbackCandidateRecorder(config);
  const rateLimiter = createRateLimiter(apiConfig, Date.now);

  return async function handleRequest(request, response): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const corsResult = applyCors(request, response, requestUrl, apiConfig);
    if (corsResult === 'handled') {
      return;
    }

    if (isRateLimitedPostApiRoute(requestUrl.pathname) && request.method === 'POST') {
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
          txAnalysisRuntime,
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

      if (request.method === 'GET' && requestUrl.pathname === '/api/tx-analysis/reports/summary') {
        await handleTxAnalysisReportSummaryRequest({
          getTxAnalysisReportStore,
          response,
        });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/knowledge/candidates') {
        await handleKnowledgeCandidatesRequest({
          getKnowledgeCandidateStore,
          ...(apiConfig.opsToken === undefined ? {} : { opsToken: apiConfig.opsToken }),
          request,
          requestUrl,
          response,
        });
        return;
      }

      if (
        request.method === 'PATCH' &&
        requestUrl.pathname.startsWith('/api/knowledge/candidates/') &&
        requestUrl.pathname.endsWith('/review')
      ) {
        await handleKnowledgeCandidateReviewRequest({
          candidateId: decodeURIComponent(extractKnowledgeCandidateReviewId(requestUrl.pathname)),
          getKnowledgeCandidateStore,
          maxBodyBytes: apiConfig.maxBodyBytes,
          ...(apiConfig.opsToken === undefined ? {} : { opsToken: apiConfig.opsToken }),
          request,
          response,
        });
        return;
      }

      if (request.method === 'PATCH' && requestUrl.pathname === '/api/tx-analysis/reports/review') {
        await handleTxAnalysisReportBatchReviewRequest({
          getTxAnalysisReportStore,
          maxBodyBytes: apiConfig.maxBodyBytes,
          ...(apiConfig.opsToken === undefined ? {} : { opsToken: apiConfig.opsToken }),
          request,
          response,
        });
        return;
      }

      if (
        request.method === 'PATCH' &&
        requestUrl.pathname.startsWith('/api/tx-analysis/reports/') &&
        requestUrl.pathname.endsWith('/review')
      ) {
        await handleTxAnalysisReportReviewRequest({
          getTxAnalysisReportStore,
          maxBodyBytes: apiConfig.maxBodyBytes,
          ...(apiConfig.opsToken === undefined ? {} : { opsToken: apiConfig.opsToken }),
          reportId: decodeURIComponent(extractTxAnalysisReportReviewId(requestUrl.pathname)),
          request,
          response,
        });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/tx-analysis/reports/')) {
        await handleTxAnalysisReportDocumentRequest({
          getTxAnalysisReportStore,
          reportId: decodeURIComponent(
            requestUrl.pathname.slice('/api/tx-analysis/reports/'.length),
          ),
          response,
        });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/tx-analysis/reports') {
        await handleTxAnalysisReportsRequest({
          getTxAnalysisReportStore,
          requestUrl,
          response,
        });
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

      if (request.method === 'POST' && requestUrl.pathname === '/api/tx-analysis') {
        await handleTxAnalysisRequest({
          getChatService,
          maxBodyBytes: apiConfig.maxBodyBytes,
          request,
          response,
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/feedback') {
        await handleFeedbackRequest({
          maxBodyBytes: apiConfig.maxBodyBytes,
          recordFeedback,
          recordFeedbackCandidate,
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
  recordFeedbackCandidate: (input: RecordFeedbackInput) => Promise<void>;
  request: ApiRequestLike;
  response: ApiResponseLike;
}

interface HandleOpsSummaryRequestOptions {
  getOpsSummary: () => Promise<OpsSummary>;
  opsToken?: string;
  request: ApiRequestLike;
  response: ApiResponseLike;
  txAnalysisRuntime: TxAnalysisRuntimeSummary;
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

  sendJson(options.response, 200, {
    ...(await options.getOpsSummary()),
    txAnalysisRuntime: options.txAnalysisRuntime,
  });
}

interface HandleTxAnalysisReportsRequestOptions {
  getTxAnalysisReportStore: () => Promise<TxAnalysisReportReader>;
  requestUrl: URL;
  response: ApiResponseLike;
}

async function handleTxAnalysisReportsRequest(
  options: HandleTxAnalysisReportsRequestOptions,
): Promise<void> {
  const chain = parseOptionalTxAnalysisReportChain(options.requestUrl.searchParams.get('chain'));
  const reason = parseOptionalTxAnalysisReportFailureReason(
    options.requestUrl.searchParams.get('reason'),
  );
  const status = parseOptionalTxAnalysisReportStatus(options.requestUrl.searchParams.get('status'));
  const reviewStatus = parseOptionalTxAnalysisReportReviewStatus(
    options.requestUrl.searchParams.get('reviewStatus'),
  );
  const reviewAssignee = parseOptionalQueryString(options.requestUrl.searchParams.get('assignee'));
  const limit = parseOptionalPositiveQueryInteger(options.requestUrl.searchParams.get('limit'));
  const txHash = parseOptionalQueryString(options.requestUrl.searchParams.get('txHash'));
  validateTxAnalysisReportQueryReference({ chain, txHash });

  const reportStore = await options.getTxAnalysisReportStore();
  const reports = await reportStore.findReports({
    ...(chain === undefined ? {} : { chain }),
    ...(limit === undefined ? {} : { limit }),
    ...(reason === undefined ? {} : { reason }),
    ...(reviewAssignee === undefined ? {} : { reviewAssignee }),
    ...(reviewStatus === undefined ? {} : { reviewStatus }),
    ...(status === undefined ? {} : { status }),
    ...(txHash === undefined ? {} : { txHash }),
  });

  sendJson(options.response, 200, { reports });
}

async function handleKnowledgeCandidatesRequest(options: {
  getKnowledgeCandidateStore: () => Promise<KnowledgeCandidateStore>;
  opsToken?: string;
  request: ApiRequestLike;
  requestUrl: URL;
  response: ApiResponseLike;
}): Promise<void> {
  if (!authorizeOpsApiRequest(options)) {
    return;
  }

  const status = parseOptionalKnowledgeCandidateStatus(
    options.requestUrl.searchParams.get('status'),
  );
  const type = parseOptionalKnowledgeCandidateType(options.requestUrl.searchParams.get('type'));
  const riskLevel = parseOptionalKnowledgeRiskLevel(
    options.requestUrl.searchParams.get('riskLevel'),
  );
  const source = parseOptionalKnowledgeCandidateSource(
    options.requestUrl.searchParams.get('source'),
  );
  const qualitySignalClusterKey = parseOptionalQualitySignalClusterKey(
    options.requestUrl.searchParams.get('qualitySignalClusterKey'),
  );
  const limit = parseOptionalPositiveQueryInteger(options.requestUrl.searchParams.get('limit'));
  const store = await options.getKnowledgeCandidateStore();
  const candidates = await store.listCandidates({
    ...(limit === undefined ? {} : { limit }),
    ...(qualitySignalClusterKey === undefined ? {} : { qualitySignalClusterKey }),
    ...(riskLevel === undefined ? {} : { riskLevel }),
    ...(source === undefined ? {} : { source }),
    ...(status === undefined ? {} : { status }),
    ...(type === undefined ? {} : { type }),
  });

  sendJson(options.response, 200, { candidates });
}

async function handleKnowledgeCandidateReviewRequest(options: {
  candidateId: string;
  getKnowledgeCandidateStore: () => Promise<KnowledgeCandidateStore>;
  maxBodyBytes: number;
  opsToken?: string;
  request: ApiRequestLike;
  response: ApiResponseLike;
}): Promise<void> {
  if (!authorizeOpsApiRequest(options)) {
    return;
  }

  const candidateId = parseKnowledgeCandidateId(options.candidateId);
  const payload = parseKnowledgeCandidateReviewPayload(
    await readJsonBody(options.request, options.maxBodyBytes),
  );
  const store = await options.getKnowledgeCandidateStore();
  const candidate = await store.reviewCandidate(candidateId, payload);
  sendJson(options.response, 200, { candidate });
}

function authorizeOpsApiRequest(options: {
  opsToken?: string;
  request: ApiRequestLike;
  response: ApiResponseLike;
}): boolean {
  if (options.opsToken === undefined) {
    sendJson(options.response, 404, {
      error: 'ops_disabled',
      message: 'Ops summary API is disabled.',
    });
    return false;
  }

  if (!isOpsRequestAuthorized(options.request, options.opsToken)) {
    sendJson(options.response, 401, {
      error: 'ops_unauthorized',
      message: 'A valid ops token is required.',
    });
    return false;
  }

  return true;
}

function validateTxAnalysisReportQueryReference(input: {
  chain: TxAnalysisChain | undefined;
  txHash: string | undefined;
}): void {
  if (input.chain === undefined || input.chain === 'unknown' || input.txHash === undefined) {
    return;
  }

  const reference = parseTransactionReference(input.txHash);
  if (
    reference !== undefined &&
    reference.unsupportedExplorerHost === undefined &&
    reference.unsupportedChainHint === undefined &&
    reference.chain !== 'unknown' &&
    reference.chain !== input.chain
  ) {
    throw new BadRequestError('chain does not match the transaction explorer link.');
  }
}

function extractTxAnalysisReportReviewId(pathname: string): string {
  const prefix = '/api/tx-analysis/reports/';
  const suffix = '/review';
  return pathname.slice(prefix.length, -suffix.length);
}

function extractKnowledgeCandidateReviewId(pathname: string): string {
  const prefix = '/api/knowledge/candidates/';
  const suffix = '/review';
  return pathname.slice(prefix.length, -suffix.length);
}

async function handleTxAnalysisReportSummaryRequest(options: {
  getTxAnalysisReportStore: () => Promise<TxAnalysisReportReader>;
  response: ApiResponseLike;
}): Promise<void> {
  const reportStore = await options.getTxAnalysisReportStore();
  sendJson(options.response, 200, await reportStore.summarizeReports({}));
}

async function handleTxAnalysisReportDocumentRequest(options: {
  getTxAnalysisReportStore: () => Promise<TxAnalysisReportReader>;
  reportId: string;
  response: ApiResponseLike;
}): Promise<void> {
  const reportId = parseTxAnalysisReportId(options.reportId);

  const reportStore = await options.getTxAnalysisReportStore();
  const document = await reportStore.getReportDocument?.(reportId);
  if (document === undefined) {
    sendJson(options.response, 404, {
      error: 'tx_analysis_report_not_found',
      message: 'Transaction analysis report was not found.',
    });
    return;
  }

  sendJson(options.response, 200, document);
}

async function handleTxAnalysisReportBatchReviewRequest(options: {
  getTxAnalysisReportStore: () => Promise<TxAnalysisReportReader>;
  maxBodyBytes: number;
  opsToken?: string;
  request: ApiRequestLike;
  response: ApiResponseLike;
}): Promise<void> {
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

  const payload = parseTxAnalysisReportBatchReviewPayload(
    await readJsonBody(options.request, options.maxBodyBytes),
  );
  const reportStore = await options.getTxAnalysisReportStore();
  if (reportStore.updateReportReview === undefined) {
    sendJson(options.response, 501, {
      error: 'tx_analysis_report_review_unsupported',
      message: 'Transaction analysis report review updates are not supported by this store.',
    });
    return;
  }

  const reviews: Array<{ id: string; review: TxAnalysisReportReview }> = [];
  const notFound: string[] = [];
  for (const id of payload.ids) {
    const review = await reportStore.updateReportReview({
      id,
      ...payload.review,
    });
    if (review === undefined) {
      notFound.push(id);
    } else {
      reviews.push({ id, review });
    }
  }

  sendJson(options.response, 200, {
    notFound,
    notFoundCount: notFound.length,
    reviews,
    updatedCount: reviews.length,
  });
}

function parseTxAnalysisReportId(reportId: string): string {
  const normalized = reportId.trim();
  if (normalized.length === 0 || normalized.includes('/')) {
    throw new BadRequestError('Invalid transaction analysis report id.');
  }

  return normalized;
}

function parseKnowledgeCandidateId(candidateId: string): string {
  const normalized = candidateId.trim();
  if (normalized.length === 0 || normalized.includes('/')) {
    throw new BadRequestError('Invalid knowledge candidate id.');
  }

  return normalized;
}

async function handleTxAnalysisReportReviewRequest(options: {
  getTxAnalysisReportStore: () => Promise<TxAnalysisReportReader>;
  maxBodyBytes: number;
  opsToken?: string;
  reportId: string;
  request: ApiRequestLike;
  response: ApiResponseLike;
}): Promise<void> {
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

  const reportId = parseTxAnalysisReportId(options.reportId);
  const payload = parseTxAnalysisReportReviewPayload(
    await readJsonBody(options.request, options.maxBodyBytes),
  );
  const reportStore = await options.getTxAnalysisReportStore();
  if (reportStore.updateReportReview === undefined) {
    sendJson(options.response, 501, {
      error: 'tx_analysis_report_review_unsupported',
      message: 'Transaction analysis report review updates are not supported by this store.',
    });
    return;
  }

  const review = await reportStore.updateReportReview({
    id: reportId,
    ...payload,
  });
  if (review === undefined) {
    sendJson(options.response, 404, {
      error: 'tx_analysis_report_not_found',
      message: 'Transaction analysis report was not found.',
    });
    return;
  }

  sendJson(options.response, 200, { review });
}

async function handleTxAnalysisRequest(options: {
  getChatService: () => Promise<ChatService>;
  maxBodyBytes: number;
  request: ApiRequestLike;
  response: ApiResponseLike;
}): Promise<void> {
  const payload = parseTxAnalysisPayload(await readJsonBody(options.request, options.maxBodyBytes));
  if (payload.unsupportedChainText !== undefined) {
    sendJson(
      options.response,
      200,
      createTxAnalysisUnavailableAnswer('unsupported_chain', {
        metadata: { unsupportedChainHint: payload.unsupportedChainText },
      }),
    );
    return;
  }

  const service = await options.getChatService();
  sendJson(options.response, 200, await service.ask(toTxAnalysisChatRequest(payload)));
}

async function handleFeedbackRequest(options: HandleFeedbackRequestOptions): Promise<void> {
  const payload = parseFeedbackPayload(await readJsonBody(options.request, options.maxBodyBytes));
  const feedback = toRecordFeedbackInput(payload);
  await options.recordFeedback(feedback);
  if (feedback.rating === 'negative') {
    await options.recordFeedbackCandidate(feedback).catch(() => undefined);
  }
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

function createTxAnalysisRuntimeSummary(
  config: ReturnType<typeof loadRagConfig>,
): TxAnalysisRuntimeSummary {
  return {
    browser: {
      chromeExecutablePathConfigured:
        config.txAnalysisChromeExecutablePath !== undefined &&
        config.txAnalysisChromeExecutablePath.trim().length > 0,
      ...(config.txAnalysisDiscoverUrl === undefined
        ? {}
        : { discoverUrl: config.txAnalysisDiscoverUrl }),
      headless: config.txAnalysisBrowserHeadless,
      maxConcurrency: config.txAnalysisBrowserMaxConcurrency,
      maxRetries: config.txAnalysisBrowserMaxRetries,
      screenshotBaseUrl: config.txAnalysisScreenshotBaseUrl,
      screenshotDirConfigured:
        config.txAnalysisScreenshotDir !== undefined &&
        config.txAnalysisScreenshotDir.trim().length > 0,
      timeoutMs: config.txAnalysisBrowserTimeoutMs,
      userDataDirConfigured:
        config.txAnalysisBrowserUserDataDir !== undefined &&
        config.txAnalysisBrowserUserDataDir.trim().length > 0,
    },
    provider: config.txAnalysisProvider,
    reportStore: config.txAnalysisReportStore,
    reviewer: config.txAnalysisReviewer,
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

function parseOptionalTxAnalysisReportChain(value: string | null): TxAnalysisChain | undefined {
  const chain = parseOptionalQueryString(value);
  return chain === undefined ? undefined : parseTxAnalysisChainValue(chain);
}

function parseOptionalTxAnalysisReportStatus(
  value: string | null,
): 'failure' | 'success' | undefined {
  const status = parseOptionalQueryString(value);
  return status === undefined ? undefined : parseTxAnalysisReportStatusValue(status);
}

function parseOptionalTxAnalysisReportReviewStatus(
  value: string | null,
): TxAnalysisReportReviewStatus | undefined {
  const status = parseOptionalQueryString(value);
  return status === undefined ? undefined : parseTxAnalysisReportReviewStatus(status);
}

function parseOptionalTxAnalysisReportFailureReason(
  value: string | null,
): TxAnalysisUnavailableReason | undefined {
  const reason = parseOptionalQueryString(value);
  return reason === undefined ? undefined : parseTxAnalysisReportFailureReasonValue(reason);
}

function parseOptionalKnowledgeCandidateStatus(
  value: string | null,
): KnowledgeCandidateStatus | undefined {
  const status = parseOptionalQueryString(value);
  return status === undefined ? undefined : parseKnowledgeCandidateStatus(status);
}

function parseOptionalKnowledgeCandidateType(
  value: string | null,
): KnowledgeCandidateType | undefined {
  const type = parseOptionalQueryString(value);
  return type === undefined ? undefined : parseKnowledgeCandidateType(type);
}

function parseOptionalKnowledgeRiskLevel(value: string | null): KnowledgeRiskLevel | undefined {
  const riskLevel = parseOptionalQueryString(value);
  return riskLevel === undefined ? undefined : parseKnowledgeRiskLevel(riskLevel);
}

function parseOptionalKnowledgeCandidateSource(
  value: string | null,
): KnowledgeCandidateSource | undefined {
  const source = parseOptionalQueryString(value);
  return source === undefined ? undefined : parseKnowledgeCandidateSource(source);
}

function parseOptionalQualitySignalClusterKey(value: string | null): string | undefined {
  const clusterKey = parseOptionalQueryString(value);
  if (clusterKey === undefined) {
    return undefined;
  }
  if (clusterKey.length > MAX_QUALITY_SIGNAL_CLUSTER_KEY_CHARS) {
    throw new BadRequestError('qualitySignalClusterKey is too long.');
  }
  if (!/^[a-z_]+:[a-z_]+:[a-z_]+:[a-z_]+$/u.test(clusterKey)) {
    throw new BadRequestError('qualitySignalClusterKey must be a valid quality cluster key.');
  }

  return clusterKey;
}

function parseOptionalPositiveQueryInteger(value: string | null): number | undefined {
  const normalized = parseOptionalQueryString(value);
  if (normalized === undefined) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestError('limit must be a positive integer.');
  }

  return Math.min(parsed, 100);
}

function parseTxAnalysisChainValue(chain: string): TxAnalysisChain {
  try {
    const parsed = parseRequiredTxAnalysisChainInput(chain);
    if (parsed.chain === undefined) {
      throw new BadRequestError(TX_ANALYSIS_CHAIN_ERROR);
    }
    return parsed.chain;
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : TX_ANALYSIS_CHAIN_ERROR);
  }
}

function parseTxAnalysisReportStatusValue(status: string): 'failure' | 'success' {
  if (!supportedTxAnalysisReportStatuses.includes(status as 'failure' | 'success')) {
    throw new BadRequestError('status must be one of: failure, success.');
  }

  return status as 'failure' | 'success';
}

function parseTxAnalysisReportFailureReasonValue(reason: string): TxAnalysisUnavailableReason {
  if (!supportedTxAnalysisReportFailureReasons.includes(reason as TxAnalysisUnavailableReason)) {
    throw new BadRequestError(
      'reason must be one of: not_configured, provider_unavailable, invalid_reference, unsupported_chain, browser_verification_required, tx_not_found, tx_failed, tx_pending, pool_not_found, target_trade_not_found, screenshot_unavailable, timeout.',
    );
  }

  return reason as TxAnalysisUnavailableReason;
}

function parseKnowledgeCandidateStatus(status: string): KnowledgeCandidateStatus {
  if (!supportedKnowledgeCandidateStatuses.includes(status as KnowledgeCandidateStatus)) {
    throw new BadRequestError(
      'status must be one of: draft, needs_review, approved, rejected, published, ingested, eval_passed, eval_failed.',
    );
  }

  return status as KnowledgeCandidateStatus;
}

function parseKnowledgeCandidateType(type: string): KnowledgeCandidateType {
  if (!supportedKnowledgeCandidateTypes.includes(type as KnowledgeCandidateType)) {
    throw new BadRequestError('type must be one of: faq, doc_patch, boundary_example, eval_case.');
  }

  return type as KnowledgeCandidateType;
}

function parseKnowledgeRiskLevel(riskLevel: string): KnowledgeRiskLevel {
  if (!supportedKnowledgeCandidateRiskLevels.includes(riskLevel as KnowledgeRiskLevel)) {
    throw new BadRequestError('riskLevel must be one of: low, medium, high.');
  }

  return riskLevel as KnowledgeRiskLevel;
}

function parseKnowledgeCandidateSource(source: string): KnowledgeCandidateSource {
  if (!supportedKnowledgeCandidateSources.includes(source as KnowledgeCandidateSource)) {
    throw new BadRequestError(
      'source must be one of: telegram, answer_feedback, answer_quality_signal.',
    );
  }

  return source as KnowledgeCandidateSource;
}

function parseOptionalQueryString(value: string | null): string | undefined {
  if (value === null) {
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
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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

function isRateLimitedPostApiRoute(pathname: string): boolean {
  return (
    pathname === '/api/chat' || pathname === '/api/chat/stream' || pathname === '/api/tx-analysis'
  );
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
    ...(input.response.agentRoute === undefined ? {} : { agentRoute: input.response.agentRoute }),
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
    ...(input.summary.agentRoute === undefined ? {} : { agentRoute: input.summary.agentRoute }),
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
  const normalized = sanitizeSessionText(message).replace(/\s+/gu, ' ').trim();
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
  getTxAnalysisReportStore: () => Promise<TxAnalysisReportReader>,
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
    const candidateStore = createPgKnowledgeOpsStore({ client: pool });
    const [health, knowledge, feedback, knowledgeCandidateQueues, txAnalysis] = await Promise.all([
      getHealthStatus(),
      knowledgeStore.getStats(),
      feedbackStore.getFeedbackStats({ limit: 10 }),
      summarizeKnowledgeCandidateQueues(candidateStore),
      getTxAnalysisReportStore().then((reportStore) => reportStore.summarizeReports({})),
    ]);

    return {
      feedback,
      generatedAt: new Date(now()).toISOString(),
      health,
      knowledge,
      knowledgeCandidateQueues,
      txAnalysis,
    };
  } finally {
    await pool.end();
  }
}

const OPS_CANDIDATE_QUEUE_LIMIT = 200;
const OPS_RECENT_EVAL_FAILURE_LIMIT = 5;
const OPS_RECENT_QUALITY_SIGNAL_LIMIT = 5;
const OPS_QUALITY_SIGNAL_CLUSTER_SAMPLE_LIMIT = 5;

async function summarizeKnowledgeCandidateQueues(
  store: KnowledgeCandidateStore,
): Promise<KnowledgeCandidateQueueSummary> {
  const [needsReview, qualitySignalNeedsReview, approvedEvalCases, evalFailed] = await Promise.all([
    store.listCandidates({ limit: OPS_CANDIDATE_QUEUE_LIMIT, status: 'needs_review' }),
    store.listCandidates({
      limit: OPS_CANDIDATE_QUEUE_LIMIT,
      source: 'answer_quality_signal',
      status: 'needs_review',
    }),
    store.listCandidates({
      limit: OPS_CANDIDATE_QUEUE_LIMIT,
      status: 'approved',
      type: 'eval_case',
    }),
    store.listCandidates({
      limit: OPS_CANDIDATE_QUEUE_LIMIT,
      status: 'eval_failed',
      type: 'eval_case',
    }),
  ]);

  const evalFailureSummaries = await summarizeRecentEvalFailures(store, evalFailed);

  return {
    approvedEvalCaseCount: approvedEvalCases.length,
    evalFailedCount: evalFailed.length,
    evalFailureReasonCounts: summarizeEvalFailureReasonCounts(evalFailureSummaries),
    needsReviewCount: needsReview.length,
    qualitySignalAgentRouteCounts: summarizeQualitySignalAgentRouteCounts(qualitySignalNeedsReview),
    qualitySignalClusters: summarizeQualitySignalClusters(qualitySignalNeedsReview),
    qualitySignalNeedsReviewCount: qualitySignalNeedsReview.length,
    qualitySignalReasonCounts: summarizeQualitySignalReasonCounts(qualitySignalNeedsReview),
    recentEvalFailures: evalFailureSummaries.slice(0, OPS_RECENT_EVAL_FAILURE_LIMIT),
    recentQualitySignals: summarizeRecentQualitySignals(
      qualitySignalNeedsReview.slice(0, OPS_RECENT_QUALITY_SIGNAL_LIMIT),
    ),
  };
}

function summarizeEvalFailureReasonCounts(
  failures: RecentKnowledgeEvalFailureSummary[],
): Record<string, number> {
  const counts = new Map<string, number>();

  for (const failure of failures) {
    for (const reason of failure.failureReasons) {
      const normalized = reason.trim();
      if (normalized.length === 0) {
        continue;
      }
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarizeQualitySignalReasonCounts(
  candidates: KnowledgeCandidate[],
): Record<string, number> {
  const counts = new Map<string, number>();

  for (const candidate of candidates) {
    const reason = extractQualitySignalReason(candidate);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarizeQualitySignalAgentRouteCounts(
  candidates: KnowledgeCandidate[],
): Record<string, number> {
  const counts = new Map<string, number>();

  for (const candidate of candidates) {
    const agentRoute = extractQualitySignalAgentRoute(candidate);
    counts.set(agentRoute, (counts.get(agentRoute) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function summarizeQualitySignalClusters(
  candidates: KnowledgeCandidate[],
): QualitySignalClusterSummary[] {
  const clusters = new Map<
    string,
    { candidates: KnowledgeCandidate[]; summary: QualitySignalClusterSummary }
  >();

  for (const candidate of candidates) {
    const agentRoute = extractQualitySignalAgentRoute(candidate);
    const reason = extractQualitySignalReason(candidate);
    const key = [agentRoute, reason, candidate.targetCategory, candidate.type].join('\0');
    const existing = clusters.get(key);
    if (existing === undefined) {
      clusters.set(key, {
        candidates: [candidate],
        summary: {
          agentRoute,
          candidateIds: [],
          clusterKey: createQualitySignalClusterKey({
            agentRoute,
            reason,
            targetCategory: candidate.targetCategory,
            type: candidate.type,
          }),
          count: 0,
          latestCreatedAt: candidate.createdAt,
          reason,
          sampleQuestions: [],
          targetCategory: candidate.targetCategory,
          type: candidate.type,
        },
      });
      continue;
    }

    existing.candidates.push(candidate);
    if (candidate.createdAt.localeCompare(existing.summary.latestCreatedAt) > 0) {
      existing.summary.latestCreatedAt = candidate.createdAt;
    }
  }

  return [...clusters.values()]
    .map(({ candidates: clusterCandidates, summary }) => {
      const sortedCandidates = [...clusterCandidates].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
      const sampleQuestions = uniqueNonEmptyStrings(
        sortedCandidates.map((candidate) => candidate.question),
      ).slice(0, OPS_QUALITY_SIGNAL_CLUSTER_SAMPLE_LIMIT);

      return {
        ...summary,
        candidateIds: sortedCandidates
          .map((candidate) => candidate.id)
          .slice(0, OPS_QUALITY_SIGNAL_CLUSTER_SAMPLE_LIMIT),
        count: clusterCandidates.length,
        sampleQuestions,
      };
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.latestCreatedAt.localeCompare(left.latestCreatedAt) ||
        left.agentRoute.localeCompare(right.agentRoute) ||
        left.reason.localeCompare(right.reason) ||
        left.targetCategory.localeCompare(right.targetCategory) ||
        left.type.localeCompare(right.type),
    );
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length > 0) {
      unique.add(normalized);
    }
  }

  return [...unique];
}

function createQualitySignalClusterKey(input: {
  agentRoute: string;
  reason: string;
  targetCategory: KnowledgeCandidate['targetCategory'];
  type: KnowledgeCandidateType;
}): string {
  return [input.agentRoute, input.reason, input.targetCategory, input.type].join(':');
}

function extractQualitySignalReason(candidate: KnowledgeCandidate): string {
  const sourceRef = candidate.sourceRefs.find((ref) => ref.source === 'answer_quality_signal');
  const reason = sourceRef?.qualitySignalReason?.trim();
  return reason === undefined || reason.length === 0 ? 'unknown' : reason;
}

function extractQualitySignalAgentRoute(candidate: KnowledgeCandidate): string {
  const sourceRef = candidate.sourceRefs.find((ref) => ref.source === 'answer_quality_signal');
  const agentRoute = sourceRef?.qualitySignalAgentRoute?.trim();
  return agentRoute === undefined || agentRoute.length === 0 ? 'unknown' : agentRoute;
}

function summarizeRecentQualitySignals(
  candidates: KnowledgeCandidate[],
): RecentQualitySignalCandidateSummary[] {
  return candidates.map((candidate) => ({
    agentRoute: extractQualitySignalAgentRoute(candidate),
    candidateId: candidate.id,
    createdAt: candidate.createdAt,
    question: candidate.question,
    riskLevel: candidate.riskLevel,
    targetCategory: candidate.targetCategory,
    type: candidate.type,
  }));
}

async function summarizeRecentEvalFailures(
  store: KnowledgeCandidateStore,
  candidates: KnowledgeCandidate[],
): Promise<RecentKnowledgeEvalFailureSummary[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      const runs = await store.listCandidateRuns(candidate.id);
      const latestFailedEvalRun = [...runs]
        .filter((run) => run.runType === 'eval' && run.status === 'failed')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

      return {
        candidateId: candidate.id,
        ...(latestFailedEvalRun === undefined
          ? {}
          : {
              evaluatedAt: latestFailedEvalRun.createdAt,
              runId: latestFailedEvalRun.runId,
            }),
        failureReasons:
          latestFailedEvalRun === undefined ? [] : extractEvalFailureReasons(latestFailedEvalRun),
        question: candidate.question,
      };
    }),
  );
}

function extractEvalFailureReasons(run: KnowledgeCandidateRun): string[] {
  const failures = Array.isArray(run.metadata.failures) ? run.metadata.failures : [];
  const reasons = failures.flatMap((failure) => {
    if (!isRecord(failure)) {
      return [];
    }

    const rawReasons = failure.reasons ?? failure.failureReasons;
    if (!Array.isArray(rawReasons)) {
      return [];
    }

    return rawReasons
      .filter((reason): reason is string => typeof reason === 'string')
      .map((reason) => reason.trim())
      .filter((reason) => reason.length > 0);
  });

  return [...new Set(reasons)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  if (config.txAnalysisReportStore !== 'file' && config.txAnalysisReportStore !== 'postgres') {
    return {
      message: `Unsupported TX_ANALYSIS_REPORT_STORE: ${config.txAnalysisReportStore}`,
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
    cachedService = createCustomerAgentChatService({
      answerProvider: createLazyAnswerProvider(config),
      config,
      qualitySignals: createApiQualitySignalSink(config),
      retriever,
      sessionContext: createApiSessionContextStore(config),
      txAnalysisProvider: createConfiguredTxAnalysisProvider(config),
    });
    return Promise.resolve(cachedService);
  };
}

function createApiSessionContextStore(
  config: ReturnType<typeof loadRagConfig>,
): SessionContextStore {
  const fallback = createInMemorySessionContextStore();

  try {
    const primary = createPgSessionContextStore({ client: createPgPool(config.databaseUrl) });
    return {
      async appendTurn(sessionId, turn) {
        try {
          await primary.appendTurn(sessionId, turn);
        } catch {
          await fallback.appendTurn(sessionId, turn);
        }
      },

      async getRecentTurns(sessionId, limit) {
        try {
          return await primary.getRecentTurns(sessionId, limit);
        } catch {
          return fallback.getRecentTurns(sessionId, limit);
        }
      },
    };
  } catch {
    return fallback;
  }
}

function createApiQualitySignalSink(config: ReturnType<typeof loadRagConfig>): QualitySignalSink {
  const memory = createInMemoryQualitySignalSink();
  let candidateStore: KnowledgeCandidateStore | undefined;

  function getCandidateStore(): KnowledgeCandidateStore {
    candidateStore ??= createPgKnowledgeOpsStore({ client: createPgPool(config.databaseUrl) });
    return candidateStore;
  }

  return {
    record(signal) {
      memory.record(signal);
      try {
        void captureAnswerQualitySignals({
          getStore: getCandidateStore,
          signals: [signal],
        }).catch(() => undefined);
      } catch {
        // Quality-gap capture is best-effort and must never block customer answers.
      }
    },
  };
}

function createLazyAnswerProvider(config: ReturnType<typeof loadRagConfig>): AnswerProvider {
  let cachedProvider: AnswerProvider | undefined;

  function getProvider(): AnswerProvider {
    cachedProvider ??= createOpenAiAnswerProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    return cachedProvider;
  }

  return {
    answer(input) {
      return getProvider().answer(input);
    },
  };
}

function createCachedTxAnalysisReportStoreLoader(
  config: ReturnType<typeof loadRagConfig>,
  reportDir: string,
): () => Promise<TxAnalysisReportReader> {
  let cachedStore: TxAnalysisReportReader | undefined;

  return () => {
    if (cachedStore !== undefined) {
      return Promise.resolve(cachedStore);
    }

    if (config.txAnalysisReportStore === 'postgres') {
      cachedStore = createPgTxAnalysisReportStore({ client: createPgPool(config.databaseUrl) });
      return Promise.resolve(cachedStore);
    }
    if (config.txAnalysisReportStore === 'file') {
      cachedStore = createFileTxAnalysisReportReader(reportDir);
      return Promise.resolve(cachedStore);
    }

    throw new Error(`Unsupported TX_ANALYSIS_REPORT_STORE: ${config.txAnalysisReportStore}`);
  };
}

function createCachedKnowledgeCandidateStoreLoader(
  config: ReturnType<typeof loadRagConfig>,
): () => Promise<KnowledgeCandidateStore> {
  let cachedStore: KnowledgeCandidateStore | undefined;

  return () => {
    if (cachedStore !== undefined) {
      return Promise.resolve(cachedStore);
    }

    cachedStore = createPgKnowledgeOpsStore({ client: createPgPool(config.databaseUrl) });
    return Promise.resolve(cachedStore);
  };
}

function createFileTxAnalysisReportReader(reportDir: string): TxAnalysisReportReader {
  return {
    async findReports(options: FindTxAnalysisReportsOptions) {
      return findFileTxAnalysisReports({
        ...options,
        reportDir,
      });
    },
    async getReportDocument(id: string) {
      return getFileTxAnalysisReportDocument({
        id,
        reportDir,
      });
    },
    async summarizeReports(options: SummarizeTxAnalysisReportsOptions = {}) {
      return summarizeFileTxAnalysisReports({
        ...options,
        reportDir,
      });
    },
    async updateReportReview(input: UpdateTxAnalysisReportReviewInput) {
      return updateFileTxAnalysisReportReview({
        ...input,
        reportDir,
      });
    },
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

function createCachedFeedbackCandidateRecorder(
  config: ReturnType<typeof loadRagConfig>,
): (input: RecordFeedbackInput) => Promise<void> {
  let cachedStore: KnowledgeCandidateStore | undefined;

  function getCandidateStore(): KnowledgeCandidateStore {
    cachedStore ??= createPgKnowledgeOpsStore({ client: createPgPool(config.databaseUrl) });
    return cachedStore;
  }

  return async (input) => {
    const mined = mineAnswerFeedback({
      feedback: [
        {
          answer: input.answer,
          channel: input.channel,
          citationCount: input.citationCount,
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          intent: input.intent,
          question: input.question,
          rating: input.rating,
          sessionIdPresent: input.sessionId !== undefined,
        },
      ],
    });

    if (mined.candidates.length === 0) {
      return;
    }

    try {
      await getCandidateStore().addCandidates(mined.candidates);
    } catch {
      // Feedback-derived candidates are best-effort and must never block feedback capture.
    }
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

function parseTxAnalysisPayload(value: unknown): TxAnalysisPayload {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = value as Record<string, unknown>;
  if (typeof record.txHash !== 'string' || record.txHash.trim().length === 0) {
    throw new BadRequestError('txHash must be a non-empty string.');
  }

  const txHash = record.txHash.trim();
  const parsedChain = parseOptionalTxAnalysisPayloadChain(record.chain);
  const chain = parsedChain.chain;
  const reference = parseTransactionReference(txHash);
  if (parsedChain.unsupportedChainText !== undefined) {
    const channel = parseOptionalChannel(record.channel);
    const sessionId = parseOptionalString(record.sessionId, 'sessionId');
    const userId = parseOptionalString(record.userId, 'userId');
    const combinedReferenceInput = `${parsedChain.unsupportedChainText} ${txHash}`;
    const combinedReference = parseTransactionReference(combinedReferenceInput);

    return {
      txHash: combinedReference === undefined ? combinedReferenceInput : txHash,
      ...(combinedReference === undefined
        ? {}
        : { unsupportedChainText: parsedChain.unsupportedChainText }),
      ...(channel === undefined ? {} : { channel }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(userId === undefined ? {} : { userId }),
    };
  }

  if (chain !== undefined && chain !== 'unknown' && reference !== undefined) {
    if (reference.chain !== 'unknown' && reference.chain !== chain) {
      throw new BadRequestError(
        isTransactionExplorerLink(txHash)
          ? 'chain does not match the transaction explorer link.'
          : 'chain does not match the transaction hash.',
      );
    }

    if (parseTransactionReference(`${chain} ${txHash}`) === undefined) {
      throw new BadRequestError('chain does not match the transaction hash.');
    }
  }
  const channel = parseOptionalChannel(record.channel);
  const sessionId = parseOptionalString(record.sessionId, 'sessionId');
  const userId = parseOptionalString(record.userId, 'userId');
  const preservesUnsupportedReference =
    reference?.unsupportedChainHint !== undefined ||
    (reference?.unsupportedExplorerHost !== undefined && reference.chain === 'unknown');
  const normalizedReference =
    reference === undefined ||
    reference.unsupportedExplorerHost !== undefined ||
    reference.unsupportedChainHint !== undefined
      ? undefined
      : reference;

  return {
    txHash: normalizedReference?.txHash ?? txHash,
    ...(preservesUnsupportedReference || chain === undefined || chain === 'unknown'
      ? normalizedReference?.chain === undefined || normalizedReference.chain === 'unknown'
        ? {}
        : { chain: normalizedReference.chain }
      : { chain }),
    ...(channel === undefined ? {} : { channel }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(userId === undefined ? {} : { userId }),
  };
}

function isTransactionExplorerLink(value: string): boolean {
  return /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?=[/:?#\s]|$)/iu.test(value);
}

function parseTxAnalysisReportReviewPayload(
  value: unknown,
): Omit<UpdateTxAnalysisReportReviewInput, 'id'> {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = value as Record<string, unknown>;
  const assignee = parseOptionalText(
    record.assignee,
    'assignee',
    MAX_TX_ANALYSIS_REVIEW_ASSIGNEE_CHARS,
  );
  const note = parseOptionalText(record.note, 'note', MAX_TX_ANALYSIS_REVIEW_NOTE_CHARS);
  const updatedBy = parseOptionalText(
    record.updatedBy,
    'updatedBy',
    MAX_TX_ANALYSIS_REVIEW_UPDATED_BY_CHARS,
  );
  const action = parseOptionalTxAnalysisReportReviewAction(record.action);
  const status =
    record.status === undefined ? undefined : parseTxAnalysisReportReviewStatus(record.status);

  if (action === 'claim') {
    if (status !== undefined && status !== 'in_review') {
      throw new BadRequestError('claim action must use status in_review.');
    }
    if (assignee === undefined) {
      throw new BadRequestError('assignee is required when claiming a report.');
    }

    return {
      assignee,
      ...(note === undefined ? {} : { note }),
      status: 'in_review',
      ...(updatedBy === undefined ? {} : { updatedBy }),
    };
  }
  if (action === 'close') {
    if (status !== undefined && status !== 'closed') {
      throw new BadRequestError('close action must use status closed.');
    }
    if (note === undefined) {
      throw new BadRequestError('note is required when closing a report.');
    }

    return {
      ...(assignee === undefined ? {} : { assignee }),
      note,
      status: 'closed',
      ...(updatedBy === undefined ? {} : { updatedBy }),
    };
  }
  if (action === 'reopen') {
    if (status !== undefined && status !== 'open') {
      throw new BadRequestError('reopen action must use status open.');
    }

    return {
      ...(note === undefined ? {} : { note }),
      status: 'open',
      ...(updatedBy === undefined ? {} : { updatedBy }),
    };
  }

  return {
    ...(assignee === undefined ? {} : { assignee }),
    ...(note === undefined ? {} : { note }),
    status: status ?? parseTxAnalysisReportReviewStatus(record.status),
    ...(updatedBy === undefined ? {} : { updatedBy }),
  };
}

function parseTxAnalysisReportBatchReviewPayload(value: unknown): {
  ids: string[];
  review: Omit<UpdateTxAnalysisReportReviewInput, 'id'>;
} {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = value as Record<string, unknown>;
  const ids = parseTxAnalysisReportReviewIds(record.ids);
  return {
    ids,
    review: parseTxAnalysisReportReviewPayload(value),
  };
}

function parseKnowledgeCandidateReviewPayload(value: unknown): ReviewKnowledgeCandidateInput {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = value as Record<string, unknown>;
  const action = parseKnowledgeCandidateReviewAction(record.action);
  const reviewedAt = parseOptionalKnowledgeReviewedAt(record.reviewedAt);
  const mergedIntoCandidateId = parseKnowledgeCandidateMergeTarget(
    action,
    record.mergedIntoCandidateId,
  );
  const notes = parseOptionalText(record.notes, 'notes', MAX_KNOWLEDGE_REVIEW_NOTES_CHARS);

  return {
    action,
    ...(mergedIntoCandidateId === undefined ? {} : { mergedIntoCandidateId }),
    ...(notes === undefined ? {} : { notes }),
    ...(reviewedAt === undefined ? {} : { reviewedAt }),
    reviewer: parseRequiredText(record.reviewer, 'reviewer', MAX_KNOWLEDGE_REVIEW_REVIEWER_CHARS),
  };
}

function parseKnowledgeCandidateMergeTarget(
  action: ReviewKnowledgeCandidateInput['action'],
  value: unknown,
): string | undefined {
  const mergedIntoCandidateId = parseOptionalText(value, 'mergedIntoCandidateId', 200);
  if (action === 'merge_duplicate' && mergedIntoCandidateId === undefined) {
    throw new BadRequestError('mergedIntoCandidateId is required for merge_duplicate.');
  }

  return mergedIntoCandidateId;
}

function parseKnowledgeCandidateReviewAction(
  value: unknown,
): ReviewKnowledgeCandidateInput['action'] {
  if (
    typeof value !== 'string' ||
    !supportedKnowledgeCandidateReviewActions.includes(
      value as ReviewKnowledgeCandidateInput['action'],
    )
  ) {
    throw new BadRequestError(
      'action must be one of: approve, reject, request_changes, merge_duplicate.',
    );
  }

  return value as ReviewKnowledgeCandidateInput['action'];
}

function parseOptionalKnowledgeReviewedAt(value: unknown): string | undefined {
  const reviewedAt = parseOptionalText(value, 'reviewedAt', 100);
  if (reviewedAt === undefined) {
    return undefined;
  }

  if (Number.isNaN(Date.parse(reviewedAt))) {
    throw new BadRequestError('reviewedAt must be a valid date-time string.');
  }

  return reviewedAt;
}

function parseTxAnalysisReportReviewIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError('ids must be a non-empty array.');
  }

  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new BadRequestError(`ids item ${index + 1} must be a string.`);
    }

    return parseTxAnalysisReportId(item);
  });
}

function parseOptionalTxAnalysisReportReviewAction(
  value: unknown,
): TxAnalysisReportReviewAction | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !supportedTxAnalysisReportReviewActions.includes(value as TxAnalysisReportReviewAction)
  ) {
    throw new BadRequestError('action must be one of: claim, close, reopen.');
  }

  return value as TxAnalysisReportReviewAction;
}

function parseTxAnalysisReportReviewStatus(value: unknown): TxAnalysisReportReviewStatus {
  if (
    typeof value !== 'string' ||
    !supportedTxAnalysisReportReviewStatuses.includes(value as TxAnalysisReportReviewStatus)
  ) {
    throw new BadRequestError('status must be one of: open, in_review, closed.');
  }

  return value as TxAnalysisReportReviewStatus;
}

function parseOptionalTxAnalysisPayloadChain(value: unknown): ParsedTxAnalysisPayloadChain {
  try {
    return parseOptionalTxAnalysisChainInput(value);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : TX_ANALYSIS_CHAIN_ERROR);
  }
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

function toTxAnalysisChatRequest(payload: TxAnalysisPayload): ChatRequest {
  return {
    channel: payload.channel ?? 'web',
    message: toTxAnalysisReferenceInput({
      ...(payload.chain === undefined ? {} : { chain: payload.chain }),
      txHash: payload.txHash,
    }),
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    ...(payload.userId === undefined ? {} : { userId: payload.userId }),
  };
}

function toRecordFeedbackInput(payload: FeedbackPayload): RecordFeedbackInput {
  return {
    answer: sanitizeSessionText(payload.answer),
    channel: payload.channel ?? 'web',
    citationCount: payload.citationCount,
    intent: payload.intent,
    question: sanitizeSessionText(payload.question),
    rating: payload.rating,
    ...(payload.comment === undefined ? {} : { comment: sanitizeSessionText(payload.comment) }),
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
  if (
    env.TX_ANALYSIS_SCREENSHOT_DIR !== undefined &&
    env.TX_ANALYSIS_SCREENSHOT_DIR.trim().length > 0
  ) {
    return path.resolve(env.TX_ANALYSIS_SCREENSHOT_DIR);
  }

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
  if (lower.endsWith('.json')) {
    return 'application/json; charset=utf-8';
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
  agentRoute?: ChatResponse['agentRoute'];
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
      ...(metadata?.agentRoute === undefined ? {} : { agentRoute: metadata.agentRoute }),
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

  if (error instanceof KnowledgeCandidateNotFoundError) {
    return {
      body: {
        error: 'knowledge_candidate_not_found',
        message: 'Knowledge candidate was not found.',
      },
      statusCode: 404,
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
