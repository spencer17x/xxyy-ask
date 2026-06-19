import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { CreateCustomerAgentChatServiceOptions } from '@xxyy/agent-core';
import type { ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import type { KnowledgeCandidate, KnowledgeCandidateStore } from '@xxyy/knowledge-ops';
import { KnowledgeCandidateNotFoundError } from '@xxyy/knowledge-ops';
import {
  createChatService,
  LlmConfigurationError,
  VectorStoreUnavailableError,
} from '@xxyy/rag-core';

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

function createRuntimeConfigForTest(): Record<string, unknown> {
  return {
    answerProvider: 'openai',
    databaseUrl: 'postgres://xxyy:secret@example.test/xxyy_ask',
    openAiApiKey: 'test-key',
    openAiApiKeyPresent: true,
    openAiBaseUrl: 'https://api.openai.test/v1',
    openAiEmbeddingModel: 'text-embedding-3-small',
    openAiMaxRetries: 1,
    openAiModel: 'test-model',
    openAiRequestTimeoutMs: 30000,
    topK: 6,
    txAnalysisBrowserHeadless: true,
    txAnalysisBrowserMaxConcurrency: 1,
    txAnalysisBrowserMaxRetries: 1,
    txAnalysisBrowserTimeoutMs: 60000,
    txAnalysisProvider: 'none',
    txAnalysisReportStore: 'file',
    txAnalysisReviewer: 'none',
    txAnalysisScreenshotBaseUrl: '/assets',
  };
}

function knowledgeCandidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    confidence: 0.8,
    createdAt: '2026-06-17T02:00:00.000Z',
    existingKnowledgeMatches: [],
    generatedEvalCases: [
      {
        expectedAnswer: '在钱包监控里配置 Telegram Bot。',
        question: 'Telegram 通知怎么设置？',
      },
    ],
    id: 'kc_telegram_setup',
    proposedAnswer: '在钱包监控里配置 Telegram Bot。',
    question: 'Telegram 通知怎么设置？',
    redactionReport: {
      entities: [],
      riskFlags: [],
      riskLevel: 'low',
    },
    riskLevel: 'low',
    sourceRefs: [{ source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '10' }],
    status: 'needs_review',
    targetCategory: 'product_faq',
    type: 'faq',
    updatedAt: '2026-06-17T02:00:00.000Z',
    ...overrides,
  };
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

  it('reports unsupported transaction analysis provider configuration', async () => {
    const handler = createRequestHandler({ env: { TX_ANALYSIS_PROVIDER: 'future-provider' } });

    const response = await callHandler(handler, { method: 'GET', url: '/health/deep' });
    const payload = JSON.parse(response.body) as {
      checks: {
        config: { message: string; status: string };
      };
    };

    expect(response.statusCode).toBe(503);
    expect(payload.checks.config).toMatchObject({
      message: 'Unsupported TX_ANALYSIS_PROVIDER: future-provider',
      status: 'error',
    });
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
      knowledgeCandidateQueues: {
        approvedEvalCaseCount: 0,
        evalFailedCount: 0,
        needsReviewCount: 0,
        qualitySignalNeedsReviewCount: 0,
        qualitySignalReasonCounts: {},
        recentEvalFailures: [],
        recentQualitySignals: [],
      },
      txAnalysis: {
        byChain: {
          base: 2,
          ethereum: 1,
        },
        byRuleVersion: {
          'sandwich-window-rules-v1': 2,
        },
        failureCount: 1,
        failureReasons: {
          pool_not_found: 1,
        },
        latestReports: [],
        successCount: 2,
        totalCount: 3,
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
    expect(JSON.parse(response.body)).toEqual({
      ...summary,
      txAnalysisRuntime: {
        browser: {
          chromeExecutablePathConfigured: false,
          headless: false,
          maxConcurrency: 1,
          maxRetries: 1,
          screenshotBaseUrl: '/assets',
          screenshotDirConfigured: false,
          timeoutMs: 60000,
          userDataDirConfigured: false,
        },
        provider: 'none',
        reportStore: 'file',
        reviewer: 'none',
      },
    });
  });

  it('adds transaction analysis runtime settings to ops summary responses', async () => {
    const summary = {
      feedback: {
        latest: [],
        negativeCount: 0,
        positiveCount: 0,
        totalCount: 0,
      },
      generatedAt: '2026-06-06T02:04:05.000Z',
      health: {
        checks: {
          config: { status: 'ok' as const },
          embedding: { status: 'ok' as const },
          llm: { status: 'ok' as const },
          vectorStore: { status: 'ok' as const },
        },
        status: 'ok' as const,
      },
      knowledge: {
        chunkCount: 0,
        documentCount: 0,
        sourceStats: [],
        sourceUrlCount: 0,
      },
      knowledgeCandidateQueues: {
        approvedEvalCaseCount: 0,
        evalFailedCount: 0,
        needsReviewCount: 0,
        qualitySignalNeedsReviewCount: 0,
        qualitySignalReasonCounts: {},
        recentEvalFailures: [],
        recentQualitySignals: [],
      },
      txAnalysis: {
        byChain: {},
        byRuleVersion: {},
        failureCount: 0,
        failureReasons: {},
        latestReports: [],
        successCount: 0,
        totalCount: 0,
      },
    };
    const handler = createRequestHandler({
      env: {
        API_OPS_TOKEN: 'secret-token',
        TX_ANALYSIS_BROWSER_HEADLESS: 'true',
        TX_ANALYSIS_BROWSER_MAX_CONCURRENCY: '2',
        TX_ANALYSIS_BROWSER_MAX_RETRIES: '3',
        TX_ANALYSIS_BROWSER_TIMEOUT_MS: '45000',
        TX_ANALYSIS_DISCOVER_URL: 'https://staging.xxyy.io/discover',
        TX_ANALYSIS_PROVIDER: 'browser',
        TX_ANALYSIS_REPORT_STORE: 'postgres',
        TX_ANALYSIS_REVIEWER: 'openai',
        TX_ANALYSIS_SCREENSHOT_BASE_URL: '/tx-assets',
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
    expect(JSON.parse(response.body)).toMatchObject({
      txAnalysisRuntime: {
        browser: {
          discoverUrl: 'https://staging.xxyy.io/discover',
          headless: true,
          maxConcurrency: 2,
          maxRetries: 3,
          screenshotBaseUrl: '/tx-assets',
          timeoutMs: 45000,
        },
        provider: 'browser',
        reportStore: 'postgres',
        reviewer: 'openai',
      },
    });
  });

  it('adds knowledge candidate queue counts to default ops summary responses', async () => {
    vi.resetModules();

    const listFilters: unknown[] = [];
    const pgClient = {
      end: vi.fn(),
      query: vi.fn(() => Promise.resolve({ rows: [] })),
    };
    const createPgPool = vi.fn(() => pgClient);
    const createPgVectorStore = vi.fn(() => ({
      getStats: vi.fn(() =>
        Promise.resolve({
          chunkCount: 64,
          documentCount: 12,
          sourceStats: [],
          sourceUrlCount: 8,
        }),
      ),
    }));
    const createPgFeedbackStore = vi.fn(() => ({
      getFeedbackStats: vi.fn(() =>
        Promise.resolve({
          latest: [],
          negativeCount: 1,
          positiveCount: 2,
          totalCount: 3,
        }),
      ),
    }));
    const listCandidates = vi.fn((filter: Record<string, unknown>) => {
      listFilters.push(filter);
      if (filter.status === 'needs_review') {
        if (filter.source === 'answer_quality_signal') {
          const qualitySourceRef = (
            reason: string,
          ): KnowledgeCandidate['sourceRefs'][number] & { qualitySignalReason: string } => ({
            chatIdHash: 'session_present',
            messageId: `aqs_${reason}`,
            qualitySignalReason: reason,
            source: 'answer_quality_signal',
          });

          return Promise.resolve([
            knowledgeCandidate({
              createdAt: '2026-06-19T07:30:00.000Z',
              id: 'kc_quality_gap_1',
              question: 'XXYY Pro 价格是多少？',
              riskLevel: 'medium',
              sourceRefs: [qualitySourceRef('missing_citations')],
              status: 'needs_review',
              targetCategory: 'eval_case',
              type: 'eval_case',
            }),
            knowledgeCandidate({
              createdAt: '2026-06-19T07:20:00.000Z',
              id: 'kc_quality_gap_2',
              question: '怎么升级？',
              riskLevel: 'low',
              sourceRefs: [qualitySourceRef('missing_followup_context')],
              status: 'needs_review',
              targetCategory: 'eval_case',
              type: 'eval_case',
            }),
            knowledgeCandidate({
              createdAt: '2026-06-19T07:10:00.000Z',
              id: 'kc_quality_gap_3',
              question: 'XXYY 文档打不开怎么办？',
              riskLevel: 'low',
              sourceRefs: [qualitySourceRef('missing_citations')],
              status: 'needs_review',
              targetCategory: 'eval_case',
              type: 'eval_case',
            }),
          ]);
        }
        return Promise.resolve([
          knowledgeCandidate({ id: 'kc_needs_review_1', status: 'needs_review' }),
          knowledgeCandidate({ id: 'kc_needs_review_2', status: 'needs_review' }),
        ]);
      }
      if (filter.status === 'approved' && filter.type === 'eval_case') {
        return Promise.resolve([
          knowledgeCandidate({
            id: 'kc_eval_approved',
            status: 'approved',
            targetCategory: 'eval_case',
            type: 'eval_case',
          }),
        ]);
      }
      if (filter.status === 'eval_failed' && filter.type === 'eval_case') {
        return Promise.resolve([
          knowledgeCandidate({
            id: 'kc_eval_failed_1',
            status: 'eval_failed',
            targetCategory: 'eval_case',
            type: 'eval_case',
          }),
          knowledgeCandidate({
            id: 'kc_eval_failed_2',
            status: 'eval_failed',
            targetCategory: 'eval_case',
            type: 'eval_case',
          }),
          knowledgeCandidate({
            id: 'kc_eval_failed_3',
            status: 'eval_failed',
            targetCategory: 'eval_case',
            type: 'eval_case',
          }),
        ]);
      }

      return Promise.resolve([]);
    });
    const listCandidateRuns = vi.fn((candidateId: string) => {
      if (candidateId === 'kc_eval_failed_1') {
        return Promise.resolve([
          {
            candidateId,
            createdAt: '2026-06-19T07:00:00.000Z',
            metadata: {
              failures: [
                {
                  failureReasons: ['missing expected answer text'],
                  name: 'knowledge candidate kc_eval_failed_1 / [evm_tx_hash]',
                },
              ],
              passed: 0,
              total: 1,
            },
            runId: 'eval_20260619T070000Z_failed1',
            runType: 'eval',
            status: 'failed',
          },
          {
            candidateId,
            createdAt: '2026-06-19T06:00:00.000Z',
            metadata: { failures: [], passed: 1, total: 1 },
            runId: 'eval_20260619T060000Z_passed1',
            runType: 'eval',
            status: 'passed',
          },
        ]);
      }
      if (candidateId === 'kc_eval_failed_2') {
        return Promise.resolve([
          {
            candidateId,
            createdAt: '2026-06-19T07:05:00.000Z',
            metadata: {
              failures: [
                {
                  failureReasons: ['expected tx_sandwich_detection, got unknown'],
                  name: 'knowledge candidate kc_eval_failed_2 / Base hash',
                },
              ],
              passed: 0,
              total: 1,
            },
            runId: 'eval_20260619T070500Z_failed2',
            runType: 'eval',
            status: 'failed',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgFeedbackStore,
        createPgPool,
        createPgVectorStore,
        loadRagConfig: vi.fn(() => createRuntimeConfigForTest()),
      };
    });
    vi.doMock('@xxyy/knowledge-ops', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgKnowledgeOpsStore: vi.fn(() => ({
          listCandidateRuns,
          listCandidates,
        })),
      };
    });

    try {
      const { createRequestHandler: createRequestHandlerWithMocks } = await import('./index.js');
      const handler = createRequestHandlerWithMocks({
        env: { API_OPS_TOKEN: 'secret-token' },
        getHealthStatus: () =>
          Promise.resolve({
            checks: {
              config: { status: 'ok' },
              embedding: { status: 'ok' },
              llm: { status: 'ok' },
              vectorStore: { status: 'ok' },
            },
            status: 'ok',
          }),
        getTxAnalysisReportStore: () =>
          Promise.resolve({
            findReports: () => Promise.resolve([]),
            getReportDocument: () => Promise.resolve(undefined),
            summarizeReports: () =>
              Promise.resolve({
                byChain: {},
                byRuleVersion: {},
                failureCount: 0,
                failureReasons: {},
                latestReports: [],
                successCount: 0,
                totalCount: 0,
              }),
            updateReportReview: () => Promise.reject(new Error('not used')),
          }),
        now: () => Date.parse('2026-06-19T08:00:00.000Z'),
      });

      const response = await callHandler(handler, {
        headers: {
          Authorization: 'Bearer secret-token',
        },
        method: 'GET',
        url: '/api/ops/summary',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        generatedAt: '2026-06-19T08:00:00.000Z',
        knowledgeCandidateQueues: {
          approvedEvalCaseCount: 1,
          evalFailedCount: 3,
          recentEvalFailures: [
            {
              candidateId: 'kc_eval_failed_1',
              evaluatedAt: '2026-06-19T07:00:00.000Z',
              failureReasons: ['missing expected answer text'],
              question: 'Telegram 通知怎么设置？',
              runId: 'eval_20260619T070000Z_failed1',
            },
            {
              candidateId: 'kc_eval_failed_2',
              evaluatedAt: '2026-06-19T07:05:00.000Z',
              failureReasons: ['expected tx_sandwich_detection, got unknown'],
              question: 'Telegram 通知怎么设置？',
              runId: 'eval_20260619T070500Z_failed2',
            },
            {
              candidateId: 'kc_eval_failed_3',
              failureReasons: [],
              question: 'Telegram 通知怎么设置？',
            },
          ],
          needsReviewCount: 2,
          qualitySignalNeedsReviewCount: 3,
          qualitySignalReasonCounts: {
            missing_citations: 2,
            missing_followup_context: 1,
          },
          recentQualitySignals: [
            {
              candidateId: 'kc_quality_gap_1',
              createdAt: '2026-06-19T07:30:00.000Z',
              question: 'XXYY Pro 价格是多少？',
              riskLevel: 'medium',
              targetCategory: 'eval_case',
              type: 'eval_case',
            },
            {
              candidateId: 'kc_quality_gap_2',
              createdAt: '2026-06-19T07:20:00.000Z',
              question: '怎么升级？',
              riskLevel: 'low',
              targetCategory: 'eval_case',
              type: 'eval_case',
            },
            {
              candidateId: 'kc_quality_gap_3',
              createdAt: '2026-06-19T07:10:00.000Z',
              question: 'XXYY 文档打不开怎么办？',
              riskLevel: 'low',
              targetCategory: 'eval_case',
              type: 'eval_case',
            },
          ],
        },
      });
      expect(listFilters).toEqual([
        { limit: 200, status: 'needs_review' },
        {
          limit: 200,
          source: 'answer_quality_signal',
          status: 'needs_review',
        },
        { limit: 200, status: 'approved', type: 'eval_case' },
        { limit: 200, status: 'eval_failed', type: 'eval_case' },
      ]);
      expect(listCandidateRuns).toHaveBeenCalledTimes(3);
      expect(listCandidateRuns).toHaveBeenCalledWith('kc_eval_failed_1');
      expect(listCandidateRuns).toHaveBeenCalledWith('kc_eval_failed_2');
      expect(listCandidateRuns).toHaveBeenCalledWith('kc_eval_failed_3');
      expect(pgClient.end).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('@xxyy/rag-core');
      vi.doUnmock('@xxyy/knowledge-ops');
    }
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
    expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, POST, PATCH, OPTIONS');
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

  it('handles direct transaction analysis requests with the chat response contract', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: '交易哈希分析完成：未发现明确被夹迹象。',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              confidence: 0.82,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: {
        chain: 'base',
        txHash,
      },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      answer: '交易哈希分析完成：未发现明确被夹迹象。',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/png',
          title: '交易分析截图',
          url: '/assets/tx-analysis-base-window.png',
        },
      ],
      citations: [],
      confidence: 0.82,
      intent: 'tx_sandwich_detection',
    });
    expect(calls).toEqual([
      {
        channel: 'web',
        message: `base ${txHash} 是否被夹？`,
      },
    ]);
  });

  it('normalizes direct transaction analysis chain aliases before routing to chat', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: '交易分析完成。',
              citations: [],
              confidence: 0.8,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    for (const chain of [
      'Base',
      'Base Mainnet',
      'ETH',
      'Ethereum Mainnet',
      '以太链',
      'BNB Smart Chain',
      'BNB Smart Chain Mainnet',
      'BNB SmartChain',
      'BNB SmartChain Mainnet',
      'BNBChain',
      'BNBSmartChain',
      'Binance SmartChain',
      'BinanceSmartChain',
      '币安',
    ]) {
      const response = await callHandler(handler, {
        body: { chain, txHash },
        method: 'POST',
        url: '/api/tx-analysis',
      });

      expect(response.statusCode).toBe(200);
    }

    expect(calls).toEqual([
      {
        channel: 'web',
        message: `base ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `base ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `ethereum ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `ethereum ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `ethereum ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `bsc ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `bsc ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `bsc ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `bsc ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `bsc ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `bsc ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `bsc ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `bsc ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `bsc ${txHash} 是否被夹？`,
      },
    ]);
  });

  it('normalizes direct Solana transaction analysis chain aliases before routing to chat', async () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: 'Solana 交易分析完成。',
              citations: [],
              confidence: 0.8,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    for (const chain of ['SOL', 'SOL chain', 'SOL mainnet']) {
      const response = await callHandler(handler, {
        body: { chain, txHash },
        method: 'POST',
        url: '/api/tx-analysis',
      });

      expect(response.statusCode).toBe(200);
    }

    expect(calls).toEqual([
      {
        channel: 'web',
        message: `solana ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `solana ${txHash} 是否被夹？`,
      },
      {
        channel: 'web',
        message: `solana ${txHash} 是否被夹？`,
      },
    ]);
  });

  it('normalizes supported explorer links before routing direct transaction analysis to chat', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: '交易分析完成。',
              citations: [],
              confidence: 0.8,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { txHash: `https://basescan.org/tx/${txHash.toUpperCase()}` },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        channel: 'web',
        message: `base ${txHash.toUpperCase()} 是否被夹？`,
      },
    ]);
  });

  it('uses explorer links to infer the chain when direct transaction analysis chain is unknown', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: '交易分析完成。',
              citations: [],
              confidence: 0.8,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { chain: 'unknown', txHash: `https://basescan.org/tx/${txHash}` },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        channel: 'web',
        message: `base ${txHash} 是否被夹？`,
      },
    ]);
  });

  it('rejects direct transaction analysis requests without a transaction hash', async () => {
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask() {
            throw new Error('ask should not be called when txHash is missing');
          },
          stream() {
            throw new Error('stream should not be called when txHash is missing');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { chain: 'base' },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'bad_request',
      message: 'txHash must be a non-empty string.',
    });
  });

  it('keeps direct transaction analysis from treating Solana devnet explorer links as mainnet', async () => {
    const chatService = createChatService({
      config: { txAnalysisProvider: 'mock' },
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });
    const handler = createRequestHandler({
      getChatService: () => Promise.resolve(chatService),
    });

    const txUrl =
      'https://explorer.solana.com/tx/5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH?cluster=devnet';
    const response = await callHandler(handler, {
      body: { chain: 'solana', txHash: txUrl },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    const responseBody = JSON.parse(response.body) as ChatResponse;

    expect(response.statusCode).toBe(200);
    expect(responseBody.intent).toBe('tx_sandwich_detection');
    expect(responseBody.answer).toContain('其他链暂不支持');
    expect(responseBody.answer).toContain('devnet');
    expect(responseBody.answer).not.toContain('演示数据');
  });

  it('preserves unsupported explorer links when routing direct transaction analysis to chat', async () => {
    const txUrl =
      'https://explorer.solana.com/tx/5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH?cluster=devnet';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: '其他链暂不支持。',
              citations: [],
              confidence: 0,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { chain: 'solana', txHash: txUrl },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        channel: 'web',
        message: `${txUrl} 是否被夹？`,
      },
    ]);
  });

  it('preserves unsupported EVM explorer links when a supported direct chain is also provided', async () => {
    const txUrl =
      'https://polygonscan.com/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: '其他链暂不支持。',
              citations: [],
              confidence: 0,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { chain: 'base', txHash: txUrl },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        channel: 'web',
        message: `${txUrl} 是否被夹？`,
      },
    ]);
  });

  it('preserves unsupported chain text when routing direct transaction analysis to chat', async () => {
    const txHash = 'Polygon 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: '其他链暂不支持。',
              citations: [],
              confidence: 0,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { txHash },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        channel: 'web',
        message: `${txHash} 是否被夹？`,
      },
    ]);
  });

  it('preserves unsupported chain text when a supported direct chain is also provided', async () => {
    const txHash = 'Polygon 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: '其他链暂不支持。',
              citations: [],
              confidence: 0,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { chain: 'base', txHash },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        channel: 'web',
        message: `${txHash} 是否被夹？`,
      },
    ]);
  });

  it('returns unsupported_chain for direct transaction analysis chain fields that are not yet supported', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const chatService = createChatService({
      config: { txAnalysisProvider: 'mock' },
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });
    const handler = createRequestHandler({
      getChatService: () => Promise.resolve(chatService),
    });

    for (const chain of [
      'Arbitrum One',
      'Avalanche C-Chain',
      'AVAX C-Chain',
      'Base Sepolia',
      'BSC Testnet',
      'ETH Goerli',
      'Ethereum Sepolia',
      'Optimistic Ethereum',
      'Gnosis Chain',
      'Fantom Opera',
      'Polygon PoS',
      'Polygon zkEVM',
      'Sonic',
      'Sonic Mainnet',
      'Berachain',
      'Berachain Mainnet',
      'Abstract',
      'Abstract Mainnet',
      'Moonriver',
      'Moonriver Mainnet',
      'Mode',
      'Mode Network',
      'Taiko',
      'Taiko Mainnet',
      'World Chain',
      'World Chain Mainnet',
      'Zora',
      'Zora Network',
      'Manta',
      'Manta Pacific',
      'X-Layer',
      'X Layer Mainnet',
      'Plasma',
      'Plasma Mainnet',
      'Mantle',
      'Mantle Mainnet',
      'zkSync Era',
      'ZK-Sync Era',
      'zkSync Era Mainnet',
    ]) {
      const response = await callHandler(handler, {
        body: { chain, txHash },
        method: 'POST',
        url: '/api/tx-analysis',
      });
      const responseBody = JSON.parse(response.body) as ChatResponse;

      expect(response.statusCode).toBe(200);
      expect(responseBody.intent).toBe('tx_sandwich_detection');
      expect(responseBody.answer).toContain('其他链暂不支持');
      expect(responseBody.answer).not.toContain('演示数据');
    }
  });

  it('returns unsupported_chain for direct transaction analysis chain fields that are known but not supported', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: 'should not be called',
              citations: [],
              confidence: 0,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { chain: 'Polygon', txHash },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(200);
    const responseBody = JSON.parse(response.body) as ChatResponse;
    expect(responseBody.answer).toContain('暂不支持');
    expect(calls).toEqual([]);
  });

  it('routes unsupported direct transaction analysis chain fields with invalid hashes to chat', async () => {
    const calls: unknown[] = [];
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            calls.push(request);
            return Promise.resolve({
              answer: 'stubbed invalid reference response',
              citations: [],
              confidence: 0,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { chain: 'Polygon', txHash: 'not-a-transaction' },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(200);
    const responseBody = JSON.parse(response.body) as ChatResponse;
    expect(responseBody.answer).toBe('stubbed invalid reference response');
    expect(calls).toEqual([
      {
        channel: 'web',
        message: 'Polygon not-a-transaction 是否被夹？',
      },
    ]);
  });

  it('rejects direct transaction analysis when the requested chain conflicts with the explorer link', async () => {
    const handler = createRequestHandler({
      getChatService: () => {
        throw new Error('chat service should not be called for conflicting chain input');
      },
    });
    const txUrl =
      'https://etherscan.io/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const response = await callHandler(handler, {
      body: { chain: 'base', txHash: txUrl },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'bad_request',
      message: 'chain does not match the transaction explorer link.',
    });
  });

  it('rejects direct transaction analysis when Solana is requested for an EVM hash', async () => {
    const handler = createRequestHandler({
      getChatService: () => {
        throw new Error('chat service should not be called for conflicting hash shape input');
      },
    });
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const response = await callHandler(handler, {
      body: { chain: 'solana', txHash },
      method: 'POST',
      url: '/api/tx-analysis',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'bad_request',
      message: 'chain does not match the transaction hash.',
    });
  });

  it('rate limits direct transaction analysis requests by client address', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
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
              answer: '交易分析完成。',
              citations: [],
              confidence: 0.8,
              intent: 'tx_sandwich_detection',
            });
          },
          stream() {
            throw new Error('stream should not be used for direct transaction analysis');
          },
        }),
    });

    const first = await callHandler(handler, {
      body: { txHash },
      headers: { 'x-forwarded-for': '203.0.113.2' },
      method: 'POST',
      url: '/api/tx-analysis',
    });
    const second = await callHandler(handler, {
      body: { txHash },
      headers: { 'x-forwarded-for': '203.0.113.2' },
      method: 'POST',
      url: '/api/tx-analysis',
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
    const feedbackCandidates: unknown[] = [];
    const handler = createRequestHandler({
      recordFeedbackCandidate(input: unknown) {
        feedbackCandidates.push(input);
        return Promise.resolve();
      },
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
    const expectedFeedback = {
      answer: '根据知识库，XXYY Pro 提供更多权益。',
      channel: 'web',
      citationCount: 2,
      comment: '没有讲清楚监控数量上限',
      intent: 'product_qa',
      question: 'XXYY Pro 有哪些权益？',
      rating: 'negative',
      sessionId: 'session-1',
    };
    expect(feedback).toEqual([expectedFeedback]);
    expect(feedbackCandidates).toEqual([expectedFeedback]);
  });

  it('redacts pasted secrets before storing or mining answer feedback', async () => {
    const feedback: unknown[] = [];
    const feedbackCandidates: unknown[] = [];
    const handler = createRequestHandler({
      recordFeedbackCandidate(input: unknown) {
        feedbackCandidates.push(input);
        return Promise.resolve();
      },
      recordFeedback(input: unknown) {
        feedback.push(input);
        return Promise.resolve();
      },
    });

    const response = await callHandler(handler, {
      body: {
        answer: '不要发送私钥、助记词或 seed phrase。api key: sk-answer-123',
        channel: 'web',
        citationCount: 0,
        comment: '我的密码是 hunter2',
        intent: 'unknown',
        question: '我的密码是 hunter2 api key: sk-test-123456',
        rating: 'negative',
        sessionId: 'session-secret-feedback',
      },
      method: 'POST',
      url: '/api/feedback',
    });

    expect(response.statusCode).toBe(201);
    const expectedFeedback = {
      answer: '不要发送私钥、助记词或 seed phrase。api key: [sensitive_credential]',
      channel: 'web',
      citationCount: 0,
      comment: '我的密码是 [sensitive_credential]',
      intent: 'unknown',
      question: '我的密码是 [sensitive_credential] api key: [sensitive_credential]',
      rating: 'negative',
      sessionId: 'session-secret-feedback',
    };
    expect(feedback).toEqual([expectedFeedback]);
    expect(feedbackCandidates).toEqual([expectedFeedback]);
    expect(JSON.stringify(feedback)).not.toContain('hunter2');
    expect(JSON.stringify(feedback)).not.toContain('sk-test-123456');
    expect(JSON.stringify(feedback)).not.toContain('sk-answer-123');
  });

  it('does not mine positive answer feedback into knowledge candidates', async () => {
    const feedbackCandidates: unknown[] = [];
    const handler = createRequestHandler({
      recordFeedback: () => Promise.resolve(),
      recordFeedbackCandidate(input: unknown) {
        feedbackCandidates.push(input);
        return Promise.resolve();
      },
    });

    const response = await callHandler(handler, {
      body: {
        answer: '根据知识库，XXYY Pro 提供更多权益。',
        channel: 'web',
        citationCount: 2,
        intent: 'product_qa',
        question: 'XXYY Pro 有哪些权益？',
        rating: 'positive',
        sessionId: 'session-1',
      },
      method: 'POST',
      url: '/api/feedback',
    });

    expect(response.statusCode).toBe(201);
    expect(feedbackCandidates).toEqual([]);
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
    await writeFile(path.join(assetsDir, 'tx-analysis-fixture.svg'), Buffer.from('<svg />'));
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-solana.json'),
      Buffer.from('{"version":1}'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const videoResponse = await callHandler(handler, {
      method: 'GET',
      url: '/assets/xxyy-add-to-home.mp4',
    });

    expect(videoResponse.statusCode).toBe(200);
    expect(videoResponse.headers['Content-Type']).toBe('video/mp4');
    expect(videoResponse.rawBody).toEqual(Buffer.from('video-bytes'));

    const imageResponse = await callHandler(handler, {
      method: 'GET',
      url: '/assets/tx-analysis-fixture.svg',
    });

    expect(imageResponse.statusCode).toBe(200);
    expect(imageResponse.headers['Content-Type']).toBe('image/svg+xml');
    expect(imageResponse.rawBody).toEqual(Buffer.from('<svg />'));

    const reportResponse = await callHandler(handler, {
      method: 'GET',
      url: '/assets/tx-analysis-report-solana.json',
    });

    expect(reportResponse.statusCode).toBe(200);
    expect(reportResponse.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(reportResponse.rawBody).toEqual(Buffer.from('{"version":1}'));
  });

  it('serves transaction analysis assets from the configured screenshot directory', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-tx-assets-'));
    const screenshotDir = path.join(workspaceRoot, 'tx-assets');
    await mkdir(screenshotDir, { recursive: true });
    await writeFile(
      path.join(screenshotDir, 'tx-analysis-report-solana.json'),
      Buffer.from('{"status":"success"}'),
    );

    const handler = createRequestHandler({
      cwd: workspaceRoot,
      env: {
        TX_ANALYSIS_SCREENSHOT_DIR: screenshotDir,
      },
    });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/assets/tx-analysis-report-solana.json',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(response.rawBody).toEqual(Buffer.from('{"status":"success"}'));
  });

  it('looks up transaction analysis reports by chain and transaction hash', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-report-index-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'solana',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-solana-a.json',
          status: 'success',
          txHash,
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-base-a.json',
          status: 'success',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: `/api/tx-analysis/reports?chain=solana&txHash=${encodeURIComponent(txHash)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reports: [
        {
          chain: 'solana',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-solana-a.json',
          status: 'success',
          txHash,
        },
      ],
    });
  });

  it('looks up transaction analysis reports when txHash is an explorer link', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-report-link-index-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      JSON.stringify({
        chain: 'solana',
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportUrl: '/assets/tx-analysis-report-solana-a.json',
        status: 'success',
        txHash,
      }),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: `/api/tx-analysis/reports?txHash=${encodeURIComponent(`https://solscan.io/tx/${txHash}`)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reports: [
        {
          chain: 'solana',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-solana-a.json',
          status: 'success',
          txHash,
        },
      ],
    });
  });

  it('rejects report lookups when the chain filter conflicts with the explorer link', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-report-chain-conflict-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      JSON.stringify({
        chain: 'base',
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportUrl: '/assets/tx-analysis-report-base-a.json',
        status: 'success',
        txHash,
      }),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: `/api/tx-analysis/reports?chain=base&txHash=${encodeURIComponent(
        `https://etherscan.io/tx/${txHash}`,
      )}`,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      error: 'bad_request',
      message: 'chain does not match the transaction explorer link.',
    });
  });

  it('looks up transaction analysis reports by transaction hash without a chain filter', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-cross-chain-reports-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-base-a.json',
          status: 'success',
          txHash,
        }),
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reportUrl: '/assets/tx-analysis-report-ethereum-a.json',
          status: 'success',
          txHash,
        }),
        JSON.stringify({
          chain: 'bsc',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reportUrl: '/assets/tx-analysis-report-bsc-other.json',
          status: 'success',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: `/api/tx-analysis/reports?txHash=${encodeURIComponent(txHash)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reports: [
        {
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reportUrl: '/assets/tx-analysis-report-ethereum-a.json',
          status: 'success',
          txHash,
        },
        {
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-base-a.json',
          status: 'success',
          txHash,
        },
      ],
    });
  });

  it('looks up recent transaction analysis reports by chain without requiring another filter', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-chain-reports-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-base-old.json',
          status: 'success',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reportUrl: '/assets/tx-analysis-report-ethereum.json',
          status: 'success',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reportUrl: '/assets/tx-analysis-report-base-new.json',
          status: 'failure',
          reason: 'timeout',
          txHash: '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?chain=base&limit=1',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reports: [
        {
          chain: 'base',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reason: 'timeout',
          reportUrl: '/assets/tx-analysis-report-base-new.json',
          status: 'failure',
          txHash: '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      ],
    });
  });

  it('accepts tx_failed as a transaction analysis report failure reason filter', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-tx-failed-reports-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reason: 'tx_failed',
          reportUrl: '/assets/tx-analysis-failure-base-failed.json',
          status: 'failure',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reason: 'timeout',
          reportUrl: '/assets/tx-analysis-failure-base-timeout.json',
          status: 'failure',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?reason=tx_failed',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reports: [
        {
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reason: 'tx_failed',
          reportUrl: '/assets/tx-analysis-failure-base-failed.json',
          status: 'failure',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      ],
    });
  });

  it('accepts tx_pending as a transaction analysis report failure reason filter', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-tx-pending-reports-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reason: 'tx_pending',
          reportUrl: '/assets/tx-analysis-failure-base-pending.json',
          status: 'failure',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reason: 'tx_failed',
          reportUrl: '/assets/tx-analysis-failure-base-failed.json',
          status: 'failure',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?reason=tx_pending',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reports: [
        {
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reason: 'tx_pending',
          reportUrl: '/assets/tx-analysis-failure-base-pending.json',
          status: 'failure',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      ],
    });
  });

  it('normalizes transaction analysis report chain aliases in query filters', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-report-chain-aliases-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    const solanaTxHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'solana',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-solana.json',
          status: 'success',
          txHash: solanaTxHash,
        }),
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reportUrl: '/assets/tx-analysis-report-ethereum.json',
          status: 'success',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'bsc',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reportUrl: '/assets/tx-analysis-report-bsc.json',
          status: 'success',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const ethereumResponse = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?chain=ETH',
    });
    const bscResponse = await callHandler(handler, {
      method: 'GET',
      url: `/api/tx-analysis/reports?chain=${encodeURIComponent('BNB Smart Chain')}`,
    });
    const bnbChainResponse = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?chain=BNBChain',
    });
    const solanaResponse = await callHandler(handler, {
      method: 'GET',
      url: `/api/tx-analysis/reports?chain=${encodeURIComponent('SOL chain')}`,
    });

    expect(ethereumResponse.statusCode).toBe(200);
    expect(JSON.parse(ethereumResponse.body)).toEqual({
      reports: [
        {
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reportUrl: '/assets/tx-analysis-report-ethereum.json',
          status: 'success',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      ],
    });
    expect(bscResponse.statusCode).toBe(200);
    expect(JSON.parse(bscResponse.body)).toEqual({
      reports: [
        {
          chain: 'bsc',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reportUrl: '/assets/tx-analysis-report-bsc.json',
          status: 'success',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      ],
    });
    expect(bnbChainResponse.statusCode).toBe(200);
    expect(JSON.parse(bnbChainResponse.body)).toEqual({
      reports: [
        {
          chain: 'bsc',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reportUrl: '/assets/tx-analysis-report-bsc.json',
          status: 'success',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      ],
    });
    expect(solanaResponse.statusCode).toBe(200);
    expect(JSON.parse(solanaResponse.body)).toEqual({
      reports: [
        {
          chain: 'solana',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-solana.json',
          status: 'success',
          txHash: solanaTxHash,
        },
      ],
    });
  });

  it('looks up recent transaction analysis reports without filters', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-recent-reports-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-base.json',
          status: 'success',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reportUrl: '/assets/tx-analysis-report-ethereum.json',
          status: 'success',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?limit=1',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reports: [
        {
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reportUrl: '/assets/tx-analysis-report-ethereum.json',
          status: 'success',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      ],
    });
  });

  it('looks up transaction analysis failure reports by reason', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-reason-reports-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-base-a.json',
          status: 'success',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          message: 'XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: '/assets/tx-analysis-failure-ethereum-a.json',
          status: 'failure',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:02:00.000Z',
          message: 'Browser timeout',
          reason: 'timeout',
          reportUrl: '/assets/tx-analysis-failure-base-a.json',
          status: 'failure',
          txHash: '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'bsc',
          generatedAt: '2026-06-11T00:03:00.000Z',
          message: 'Another XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: '/assets/tx-analysis-failure-bsc-a.json',
          status: 'failure',
          txHash: '0x4234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?reason=pool_not_found',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reports: [
        {
          chain: 'bsc',
          generatedAt: '2026-06-11T00:03:00.000Z',
          message: 'Another XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: '/assets/tx-analysis-failure-bsc-a.json',
          status: 'failure',
          txHash: '0x4234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
        {
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          message: 'XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: '/assets/tx-analysis-failure-ethereum-a.json',
          status: 'failure',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      ],
    });
  });

  it('looks up recent transaction analysis reports by status and limit', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-status-reports-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:00:00.000Z',
          message: 'XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: '/assets/tx-analysis-failure-ethereum-a.json',
          status: 'failure',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:01:00.000Z',
          message: 'Browser timeout',
          reason: 'timeout',
          reportUrl: '/assets/tx-analysis-failure-base-a.json',
          status: 'failure',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'bsc',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reportUrl: '/assets/tx-analysis-report-bsc-a.json',
          status: 'success',
          txHash: '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?status=failure&limit=1',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      reports: [
        {
          chain: 'base',
          generatedAt: '2026-06-11T00:01:00.000Z',
          message: 'Browser timeout',
          reason: 'timeout',
          reportUrl: '/assets/tx-analysis-failure-base-a.json',
          status: 'failure',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        },
      ],
    });
  });

  it('returns transaction analysis report summary for ops review', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-report-summary-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          analysisRuleVersion: 'sandwich-window-rules-v1',
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/assets/tx-analysis-report-base-a.json',
          status: 'success',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          message: 'XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: '/assets/tx-analysis-failure-ethereum-a.json',
          status: 'failure',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:02:00.000Z',
          message: 'Browser timeout',
          reason: 'timeout',
          reportUrl: '/assets/tx-analysis-failure-base-a.json',
          status: 'failure',
          txHash: '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports/summary',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      byChain: {
        base: 2,
        ethereum: 1,
      },
      byRuleVersion: {
        'sandwich-window-rules-v1': 1,
      },
      failureCount: 2,
      failureReasons: {
        pool_not_found: 1,
        timeout: 1,
      },
      successCount: 1,
      totalCount: 3,
    });
  });

  it('can read transaction analysis reports from a configured report store', async () => {
    let findInput: unknown;
    let summaryInput: unknown;
    let documentId: string | undefined;
    const handler = createRequestHandler({
      getTxAnalysisReportStore: () =>
        Promise.resolve({
          findReports: (input: unknown) => {
            findInput = input;
            return Promise.resolve([
              {
                chain: 'base',
                confidence: 0.8,
                generatedAt: '2026-06-11T00:00:00.000Z',
                reportUrl: '/api/tx-analysis/reports/txr_base_success',
                status: 'success',
                txHash: '0xabc',
                verdict: 'not_sandwiched',
              },
            ]);
          },
          getReportDocument: (id: string) => {
            documentId = id;
            return Promise.resolve({
              generatedAt: '2026-06-11T00:00:00.000Z',
              reference: { chain: 'base', txHash: '0xabc' },
              result: {
                analyzedAt: '2026-06-11T00:00:00.000Z',
                chain: 'base',
                confidence: 0.8,
                dataSource: 'browser',
                evidence: [],
                relatedTransactions: [],
                summary: 'not sandwiched',
                txHash: '0xabc',
                verdict: 'not_sandwiched',
              },
              status: 'success',
              version: 1,
            });
          },
          summarizeReports: (input: unknown) => {
            summaryInput = input;
            return Promise.resolve({
              byChain: { base: 1 },
              byRuleVersion: { 'sandwich-window-rules-v1': 1 },
              failureCount: 0,
              failureReasons: {},
              latestReports: [],
              successCount: 1,
              totalCount: 1,
            });
          },
        }),
    });

    const reportsResponse = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?chain=base&status=success&reviewStatus=in_review&assignee=alice&txHash=0xabc&limit=5',
    });
    const summaryResponse = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports/summary',
    });
    const documentResponse = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports/txr_base_success',
    });

    expect(reportsResponse.statusCode).toBe(200);
    const reportsPayload = JSON.parse(reportsResponse.body) as { reports: unknown[] };
    expect(reportsPayload.reports).toEqual([
      expect.objectContaining({
        reportUrl: '/api/tx-analysis/reports/txr_base_success',
        status: 'success',
      }),
    ]);
    expect(findInput).toEqual({
      chain: 'base',
      limit: 5,
      reviewAssignee: 'alice',
      reviewStatus: 'in_review',
      status: 'success',
      txHash: '0xabc',
    });
    expect(summaryResponse.statusCode).toBe(200);
    expect(JSON.parse(summaryResponse.body)).toMatchObject({ byChain: { base: 1 } });
    expect(summaryInput).toEqual({});
    expect(documentResponse.statusCode).toBe(200);
    expect(JSON.parse(documentResponse.body)).toMatchObject({
      reference: { chain: 'base', txHash: '0xabc' },
      status: 'success',
      version: 1,
    });
    expect(documentId).toBe('txr_base_success');
  });

  it('requires a valid ops token before updating a transaction analysis report review', async () => {
    const handler = createRequestHandler({
      env: {
        API_OPS_TOKEN: 'secret-token',
      },
      getTxAnalysisReportStore: () =>
        Promise.resolve({
          findReports: () => Promise.resolve([]),
          summarizeReports: () =>
            Promise.resolve({
              byChain: {},
              byRuleVersion: {},
              failureCount: 0,
              failureReasons: {},
              latestReports: [],
              successCount: 0,
              totalCount: 0,
            }),
          updateReportReview() {
            throw new Error('updateReportReview should not be called for unauthorized requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { status: 'in_review' },
      method: 'PATCH',
      url: '/api/tx-analysis/reports/txr_base_success/review',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'ops_unauthorized',
      message: 'A valid ops token is required.',
    });
  });

  it('updates file-backed transaction analysis report reviews in the default report store', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-file-review-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    const reportFileName = 'tx-analysis-report-solana-review.json';
    await writeFile(
      path.join(assetsDir, reportFileName),
      `${JSON.stringify(
        {
          generatedAt: '2026-06-11T00:00:00.000Z',
          reference: { chain: 'solana', txHash: 'solana-review-tx' },
          result: {
            analyzedAt: '2026-06-11T00:00:00.000Z',
            chain: 'solana',
            confidence: 0.58,
            dataSource: 'browser',
            evidence: [],
            relatedTransactions: [],
            summary: 'not sandwiched',
            txHash: 'solana-review-tx',
            verdict: 'not_sandwiched',
          },
          status: 'success',
          version: 1,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      `${JSON.stringify({
        chain: 'solana',
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportUrl: `/assets/${reportFileName}`,
        status: 'success',
        txHash: 'solana-review-tx',
      })}\n`,
    );
    const handler = createRequestHandler({
      cwd: workspaceRoot,
      env: { API_OPS_TOKEN: 'secret-token' },
      staticAssetsDir: assetsDir,
    });

    const updateResponse = await callHandler(handler, {
      body: {
        assignee: ' alice ',
        note: ' 已回复用户并附上截图。 ',
        status: 'in_review',
        updatedBy: ' ops-user ',
      },
      headers: {
        Authorization: 'Bearer secret-token',
      },
      method: 'PATCH',
      url: `/api/tx-analysis/reports/${reportFileName}/review`,
    });
    const reportsResponse = await callHandler(handler, {
      method: 'GET',
      url: '/api/tx-analysis/reports?reviewStatus=in_review&assignee=alice',
    });
    const documentResponse = await callHandler(handler, {
      method: 'GET',
      url: `/api/tx-analysis/reports/${reportFileName}`,
    });

    expect(updateResponse.statusCode).toBe(200);
    const updatePayload = JSON.parse(updateResponse.body) as {
      review: {
        assignee?: string;
        note?: string;
        status: string;
        updatedAt: string;
        updatedBy?: string;
      };
    };
    expect(typeof updatePayload.review.updatedAt).toBe('string');
    expect(updatePayload).toEqual({
      review: {
        assignee: 'alice',
        note: '已回复用户并附上截图。',
        status: 'in_review',
        updatedAt: updatePayload.review.updatedAt,
        updatedBy: 'ops-user',
      },
    });
    expect(reportsResponse.statusCode).toBe(200);
    const reportsPayload = JSON.parse(reportsResponse.body) as {
      reports: Array<{
        reportUrl: string;
        review?: {
          assignee?: string;
          status: string;
        };
      }>;
    };
    expect(reportsPayload.reports).toHaveLength(1);
    expect(reportsPayload.reports[0]).toMatchObject({
      reportUrl: `/assets/${reportFileName}`,
      review: {
        assignee: 'alice',
        status: 'in_review',
      },
    });
    expect(documentResponse.statusCode).toBe(200);
    expect(JSON.parse(documentResponse.body)).toMatchObject({
      review: {
        assignee: 'alice',
        note: '已回复用户并附上截图。',
        status: 'in_review',
        updatedBy: 'ops-user',
      },
    });
  });

  it('updates transaction analysis report review metadata through a protected API route', async () => {
    let updateInput: unknown;
    const handler = createRequestHandler({
      env: {
        API_OPS_TOKEN: 'secret-token',
      },
      getTxAnalysisReportStore: () =>
        Promise.resolve({
          findReports: () => Promise.resolve([]),
          summarizeReports: () =>
            Promise.resolve({
              byChain: {},
              byRuleVersion: {},
              failureCount: 0,
              failureReasons: {},
              latestReports: [],
              successCount: 0,
              totalCount: 0,
            }),
          updateReportReview(input: unknown) {
            updateInput = input;
            return Promise.resolve({
              assignee: 'alice',
              note: '已回复用户并附上 XXYY 原页面截图。',
              status: 'closed' as const,
              updatedAt: '2026-06-11T00:05:00.000Z',
              updatedBy: 'ops-user',
            });
          },
        }),
    });

    const response = await callHandler(handler, {
      body: {
        assignee: 'alice',
        note: '已回复用户并附上 XXYY 原页面截图。',
        status: 'closed',
        updatedBy: 'ops-user',
      },
      headers: {
        Authorization: 'Bearer secret-token',
      },
      method: 'PATCH',
      url: '/api/tx-analysis/reports/txr_base_success/review',
    });

    expect(response.statusCode).toBe(200);
    expect(updateInput).toEqual({
      assignee: 'alice',
      id: 'txr_base_success',
      note: '已回复用户并附上 XXYY 原页面截图。',
      status: 'closed',
      updatedBy: 'ops-user',
    });
    expect(JSON.parse(response.body)).toEqual({
      review: {
        assignee: 'alice',
        note: '已回复用户并附上 XXYY 原页面截图。',
        status: 'closed',
        updatedAt: '2026-06-11T00:05:00.000Z',
        updatedBy: 'ops-user',
      },
    });
  });

  it('supports claiming a transaction analysis report through a review workflow action', async () => {
    let updateInput: unknown;
    const handler = createRequestHandler({
      env: {
        API_OPS_TOKEN: 'secret-token',
      },
      getTxAnalysisReportStore: () =>
        Promise.resolve({
          findReports: () => Promise.resolve([]),
          summarizeReports: () =>
            Promise.resolve({
              byChain: {},
              byRuleVersion: {},
              failureCount: 0,
              failureReasons: {},
              latestReports: [],
              successCount: 0,
              totalCount: 0,
            }),
          updateReportReview(input: unknown) {
            updateInput = input;
            return Promise.resolve({
              assignee: 'alice',
              status: 'in_review' as const,
              updatedAt: '2026-06-11T00:06:00.000Z',
              updatedBy: 'ops-user',
            });
          },
        }),
    });

    const response = await callHandler(handler, {
      body: {
        action: 'claim',
        assignee: 'alice',
        updatedBy: 'ops-user',
      },
      headers: {
        Authorization: 'Bearer secret-token',
      },
      method: 'PATCH',
      url: '/api/tx-analysis/reports/txr_base_success/review',
    });

    expect(response.statusCode).toBe(200);
    expect(updateInput).toEqual({
      assignee: 'alice',
      id: 'txr_base_success',
      status: 'in_review',
      updatedBy: 'ops-user',
    });
    expect(JSON.parse(response.body)).toEqual({
      review: {
        assignee: 'alice',
        status: 'in_review',
        updatedAt: '2026-06-11T00:06:00.000Z',
        updatedBy: 'ops-user',
      },
    });
  });

  it('supports closing a transaction analysis report through a review workflow action', async () => {
    let updateInput: unknown;
    const handler = createRequestHandler({
      env: {
        API_OPS_TOKEN: 'secret-token',
      },
      getTxAnalysisReportStore: () =>
        Promise.resolve({
          findReports: () => Promise.resolve([]),
          summarizeReports: () =>
            Promise.resolve({
              byChain: {},
              byRuleVersion: {},
              failureCount: 0,
              failureReasons: {},
              latestReports: [],
              successCount: 0,
              totalCount: 0,
            }),
          updateReportReview(input: unknown) {
            updateInput = input;
            return Promise.resolve({
              assignee: 'alice',
              note: '已回复用户，截图和报告链接已同步。',
              status: 'closed' as const,
              updatedAt: '2026-06-11T00:07:00.000Z',
              updatedBy: 'ops-user',
            });
          },
        }),
    });

    const response = await callHandler(handler, {
      body: {
        action: 'close',
        assignee: 'alice',
        note: '已回复用户，截图和报告链接已同步。',
        updatedBy: 'ops-user',
      },
      headers: {
        Authorization: 'Bearer secret-token',
      },
      method: 'PATCH',
      url: '/api/tx-analysis/reports/txr_base_success/review',
    });

    expect(response.statusCode).toBe(200);
    expect(updateInput).toEqual({
      assignee: 'alice',
      id: 'txr_base_success',
      note: '已回复用户，截图和报告链接已同步。',
      status: 'closed',
      updatedBy: 'ops-user',
    });
    expect(JSON.parse(response.body)).toEqual({
      review: {
        assignee: 'alice',
        note: '已回复用户，截图和报告链接已同步。',
        status: 'closed',
        updatedAt: '2026-06-11T00:07:00.000Z',
        updatedBy: 'ops-user',
      },
    });
  });

  it('supports closing multiple transaction analysis reports through a review workflow action', async () => {
    const updateInputs: unknown[] = [];
    const handler = createRequestHandler({
      env: {
        API_OPS_TOKEN: 'secret-token',
      },
      getTxAnalysisReportStore: () =>
        Promise.resolve({
          findReports: () => Promise.resolve([]),
          summarizeReports: () =>
            Promise.resolve({
              byChain: {},
              byRuleVersion: {},
              failureCount: 0,
              failureReasons: {},
              latestReports: [],
              successCount: 0,
              totalCount: 0,
            }),
          updateReportReview(input: { id: string }) {
            updateInputs.push(input);
            if (input.id === 'txr_missing') {
              return Promise.resolve(undefined);
            }

            return Promise.resolve({
              assignee: 'alice',
              note: '已批量关闭并同步给客服。',
              status: 'closed' as const,
              updatedAt: '2026-06-11T00:09:00.000Z',
              updatedBy: 'ops-user',
            });
          },
        }),
    });

    const response = await callHandler(handler, {
      body: {
        action: 'close',
        assignee: 'alice',
        ids: ['txr_base_success', 'txr_missing'],
        note: '已批量关闭并同步给客服。',
        updatedBy: 'ops-user',
      },
      headers: {
        Authorization: 'Bearer secret-token',
      },
      method: 'PATCH',
      url: '/api/tx-analysis/reports/review',
    });

    expect(response.statusCode).toBe(200);
    expect(updateInputs).toEqual([
      {
        assignee: 'alice',
        id: 'txr_base_success',
        note: '已批量关闭并同步给客服。',
        status: 'closed',
        updatedBy: 'ops-user',
      },
      {
        assignee: 'alice',
        id: 'txr_missing',
        note: '已批量关闭并同步给客服。',
        status: 'closed',
        updatedBy: 'ops-user',
      },
    ]);
    expect(JSON.parse(response.body)).toEqual({
      notFound: ['txr_missing'],
      notFoundCount: 1,
      reviews: [
        {
          id: 'txr_base_success',
          review: {
            assignee: 'alice',
            note: '已批量关闭并同步给客服。',
            status: 'closed',
            updatedAt: '2026-06-11T00:09:00.000Z',
            updatedBy: 'ops-user',
          },
        },
      ],
      updatedCount: 1,
    });
  });

  it('supports reopening a transaction analysis report through a review workflow action', async () => {
    let updateInput: unknown;
    const handler = createRequestHandler({
      env: {
        API_OPS_TOKEN: 'secret-token',
      },
      getTxAnalysisReportStore: () =>
        Promise.resolve({
          findReports: () => Promise.resolve([]),
          summarizeReports: () =>
            Promise.resolve({
              byChain: {},
              byRuleVersion: {},
              failureCount: 0,
              failureReasons: {},
              latestReports: [],
              successCount: 0,
              totalCount: 0,
            }),
          updateReportReview(input: unknown) {
            updateInput = input;
            return Promise.resolve({
              note: '用户补充了交易页面，需要重新复查。',
              status: 'open' as const,
              updatedAt: '2026-06-11T00:08:00.000Z',
              updatedBy: 'ops-user',
            });
          },
        }),
    });

    const response = await callHandler(handler, {
      body: {
        action: 'reopen',
        note: '用户补充了交易页面，需要重新复查。',
        updatedBy: 'ops-user',
      },
      headers: {
        Authorization: 'Bearer secret-token',
      },
      method: 'PATCH',
      url: '/api/tx-analysis/reports/txr_base_success/review',
    });

    expect(response.statusCode).toBe(200);
    expect(updateInput).toEqual({
      id: 'txr_base_success',
      note: '用户补充了交易页面，需要重新复查。',
      status: 'open',
      updatedBy: 'ops-user',
    });
    expect(JSON.parse(response.body)).toEqual({
      review: {
        note: '用户补充了交易页面，需要重新复查。',
        status: 'open',
        updatedAt: '2026-06-11T00:08:00.000Z',
        updatedBy: 'ops-user',
      },
    });
  });

  it('requires a valid ops token before listing knowledge candidates', async () => {
    const handler = createRequestHandler({
      env: { API_OPS_TOKEN: 'secret-token' },
      getKnowledgeCandidateStore: () =>
        Promise.resolve({
          addCandidates: () => Promise.resolve([]),
          getCandidate() {
            throw new Error('getCandidate should not be called for unauthorized requests');
          },
          listCandidates() {
            throw new Error('listCandidates should not be called for unauthorized requests');
          },
          listCandidateRuns() {
            throw new Error('listCandidateRuns should not be called for unauthorized requests');
          },
          markCandidateEvalResult() {
            throw new Error(
              'markCandidateEvalResult should not be called for unauthorized requests',
            );
          },
          markCandidateIngested() {
            throw new Error('markCandidateIngested should not be called for unauthorized requests');
          },
          markCandidatePublished() {
            throw new Error(
              'markCandidatePublished should not be called for unauthorized requests',
            );
          },
          recordCandidateRun() {
            throw new Error('recordCandidateRun should not be called for unauthorized requests');
          },
          reviewCandidate() {
            throw new Error('reviewCandidate should not be called for unauthorized requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/knowledge/candidates',
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'ops_unauthorized',
      message: 'A valid ops token is required.',
    });
  });

  it('lists knowledge candidates for the protected review queue', async () => {
    let listFilter: unknown;
    const store: KnowledgeCandidateStore = {
      addCandidates: () => Promise.resolve([]),
      getCandidate() {
        throw new Error('getCandidate should not be called for list requests');
      },
      listCandidates(filter) {
        listFilter = filter;
        return Promise.resolve([
          knowledgeCandidate({
            id: 'kc_boundary',
            proposedAnswer: '不能查询账户余额。',
            question: '帮我查钱包余额。',
            redactionReport: {
              entities: [],
              riskFlags: ['private_account_query'],
              riskLevel: 'high',
            },
            riskLevel: 'high',
            status: 'needs_review',
            targetCategory: 'policy_boundary',
            type: 'boundary_example',
          }),
        ]);
      },
      listCandidateRuns() {
        throw new Error('listCandidateRuns should not be called for list requests');
      },
      markCandidateEvalResult() {
        throw new Error('markCandidateEvalResult should not be called for list requests');
      },
      markCandidateIngested() {
        throw new Error('markCandidateIngested should not be called for list requests');
      },
      reviewCandidate() {
        throw new Error('reviewCandidate should not be called for list requests');
      },
      markCandidatePublished() {
        throw new Error('markCandidatePublished should not be called for list requests');
      },
      recordCandidateRun() {
        throw new Error('recordCandidateRun should not be called for list requests');
      },
    };
    const handler = createRequestHandler({
      env: { API_OPS_TOKEN: 'secret-token' },
      getKnowledgeCandidateStore: () => Promise.resolve(store),
    });

    const response = await callHandler(handler, {
      headers: { Authorization: 'Bearer secret-token' },
      method: 'GET',
      url: '/api/knowledge/candidates?status=needs_review&type=boundary_example&riskLevel=high&source=answer_feedback&limit=5',
    });

    expect(response.statusCode).toBe(200);
    expect(listFilter).toEqual({
      limit: 5,
      riskLevel: 'high',
      source: 'answer_feedback',
      status: 'needs_review',
      type: 'boundary_example',
    });
    expect(JSON.parse(response.body)).toEqual({
      candidates: [
        expect.objectContaining({
          id: 'kc_boundary',
          riskLevel: 'high',
          status: 'needs_review',
          type: 'boundary_example',
        }),
      ],
    });
  });

  it('rejects unsupported knowledge candidate source filters', async () => {
    const handler = createRequestHandler({
      env: { API_OPS_TOKEN: 'secret-token' },
      getKnowledgeCandidateStore: () =>
        Promise.resolve({
          addCandidates: () => Promise.resolve([]),
          getCandidate() {
            throw new Error('getCandidate should not be called for invalid source filters');
          },
          listCandidates() {
            throw new Error('listCandidates should not be called for invalid source filters');
          },
          listCandidateRuns() {
            throw new Error('listCandidateRuns should not be called for invalid source filters');
          },
          markCandidateEvalResult() {
            throw new Error(
              'markCandidateEvalResult should not be called for invalid source filters',
            );
          },
          markCandidateIngested() {
            throw new Error(
              'markCandidateIngested should not be called for invalid source filters',
            );
          },
          markCandidatePublished() {
            throw new Error(
              'markCandidatePublished should not be called for invalid source filters',
            );
          },
          recordCandidateRun() {
            throw new Error('recordCandidateRun should not be called for invalid source filters');
          },
          reviewCandidate() {
            throw new Error('reviewCandidate should not be called for invalid source filters');
          },
        }),
    });

    const response = await callHandler(handler, {
      headers: { Authorization: 'Bearer secret-token' },
      method: 'GET',
      url: '/api/knowledge/candidates?source=manual_ticket',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'bad_request',
      message: 'source must be one of: telegram, answer_feedback, answer_quality_signal.',
    });
  });

  it('reviews a knowledge candidate through a protected API route without publishing it', async () => {
    let reviewInput: unknown;
    const store: KnowledgeCandidateStore = {
      addCandidates: () => Promise.resolve([]),
      getCandidate() {
        throw new Error('getCandidate should not be called for review requests');
      },
      listCandidateRuns() {
        throw new Error('listCandidateRuns should not be called for review requests');
      },
      listCandidates: () => Promise.resolve([]),
      markCandidateEvalResult() {
        throw new Error('markCandidateEvalResult should not be called for review requests');
      },
      markCandidateIngested() {
        throw new Error('markCandidateIngested should not be called for review requests');
      },
      markCandidatePublished() {
        throw new Error('markCandidatePublished should not be called for review requests');
      },
      recordCandidateRun() {
        throw new Error('recordCandidateRun should not be called for review requests');
      },
      reviewCandidate(candidateId, input) {
        reviewInput = { candidateId, input };
        return Promise.resolve(
          knowledgeCandidate({
            reviewNotes: '内容准确，等待发布流程处理。',
            reviewer: 'ops@example.com',
            status: 'approved',
            updatedAt: '2026-06-17T03:00:00.000Z',
          }),
        );
      },
    };
    const handler = createRequestHandler({
      env: { API_OPS_TOKEN: 'secret-token' },
      getKnowledgeCandidateStore: () => Promise.resolve(store),
    });

    const response = await callHandler(handler, {
      body: {
        action: 'approve',
        notes: ' 内容准确，等待发布流程处理。 ',
        reviewedAt: '2026-06-17T03:00:00.000Z',
        reviewer: ' ops@example.com ',
      },
      headers: { Authorization: 'Bearer secret-token' },
      method: 'PATCH',
      url: '/api/knowledge/candidates/kc_telegram_setup/review',
    });

    expect(response.statusCode).toBe(200);
    expect(reviewInput).toEqual({
      candidateId: 'kc_telegram_setup',
      input: {
        action: 'approve',
        notes: '内容准确，等待发布流程处理。',
        reviewedAt: '2026-06-17T03:00:00.000Z',
        reviewer: 'ops@example.com',
      },
    });
    const payload = JSON.parse(response.body) as { candidate: Record<string, unknown> };
    expect(payload.candidate).toMatchObject({
      id: 'kc_telegram_setup',
      reviewNotes: '内容准确，等待发布流程处理。',
      reviewer: 'ops@example.com',
      status: 'approved',
    });
    expect(payload.candidate).not.toHaveProperty('publishedTarget');
  });

  it('returns 404 when reviewing a missing knowledge candidate', async () => {
    const handler = createRequestHandler({
      env: { API_OPS_TOKEN: 'secret-token' },
      getKnowledgeCandidateStore: () =>
        Promise.resolve({
          addCandidates: () => Promise.resolve([]),
          getCandidate: () => Promise.resolve(undefined),
          listCandidateRuns: () => Promise.resolve([]),
          listCandidates: () => Promise.resolve([]),
          markCandidateEvalResult: () =>
            Promise.reject(new KnowledgeCandidateNotFoundError('missing_candidate')),
          markCandidateIngested: () =>
            Promise.reject(new KnowledgeCandidateNotFoundError('missing_candidate')),
          markCandidatePublished: () =>
            Promise.reject(new KnowledgeCandidateNotFoundError('missing_candidate')),
          recordCandidateRun: () =>
            Promise.reject(new KnowledgeCandidateNotFoundError('missing_candidate')),
          reviewCandidate: () =>
            Promise.reject(new KnowledgeCandidateNotFoundError('missing_candidate')),
        }),
    });

    const response = await callHandler(handler, {
      body: {
        action: 'reject',
        reviewer: 'ops@example.com',
      },
      headers: { Authorization: 'Bearer secret-token' },
      method: 'PATCH',
      url: '/api/knowledge/candidates/missing_candidate/review',
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: 'knowledge_candidate_not_found',
      message: 'Knowledge candidate was not found.',
    });
  });

  it('passes chat requests through ChatService', async () => {
    const chatResponse: ChatResponse = {
      answer: '交易哈希分析截图如下。',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/svg+xml',
          title: '交易分析截图',
          url: '/assets/tx-analysis-fixture.svg',
        },
      ],
      confidence: 0.8,
      intent: 'tx_sandwich_detection',
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

  it('builds the default chat service from the Customer Agent Runtime factory', async () => {
    vi.resetModules();

    const agentAsk = vi.fn(() =>
      Promise.resolve({
        answer: 'agent runtime response',
        citations: [],
        confidence: 0.7,
        intent: 'product_qa' as const,
      }),
    );
    const createCustomerAgentChatService = vi.fn(
      (_options: CreateCustomerAgentChatServiceOptions) => ({
        ask: agentAsk,
        stream: vi.fn(),
      }),
    );
    const createLegacyChatService = vi.fn(() => ({
      ask: vi.fn(() =>
        Promise.resolve({
          answer: 'legacy response',
          citations: [],
          confidence: 0.1,
          intent: 'product_qa' as const,
        }),
      ),
      stream: vi.fn(),
    }));
    const candidateFromSignal = { id: 'kc_quality_signal' };
    const addCandidates = vi.fn(() => Promise.resolve([]));
    const candidateStore = { addCandidates };
    const createPgKnowledgeOpsStore = vi.fn(() => candidateStore);
    const captureAnswerQualitySignals = vi.fn(
      (input: { getStore?: () => unknown; signals: readonly unknown[]; store?: unknown }) => {
        expect(input.store).toBeUndefined();
        expect(typeof input.getStore).toBe('function');
        expect(input.getStore?.()).toBe(candidateStore);
        return Promise.resolve({
          candidates: [{ id: 'kc_quality_signal' }],
          storedCandidates: [{ id: 'kc_quality_signal' }],
          candidatesCreated: 1,
          signalsRead: 1,
          signalsSkipped: 0,
        });
      },
    );
    const mineAnswerQualitySignals = vi.fn(() => ({
      candidates: [candidateFromSignal],
      candidatesCreated: 1,
      signalsRead: 1,
      signalsSkipped: 0,
    }));
    const pgClient = {
      end: vi.fn(),
      query: vi.fn(() => Promise.resolve({ rows: [] })),
    };
    const createPgPool = vi.fn(() => pgClient);

    vi.doMock('@xxyy/agent-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createCustomerAgentChatService,
      };
    });
    vi.doMock('@xxyy/knowledge-ops', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        captureAnswerQualitySignals,
        createPgKnowledgeOpsStore,
        mineAnswerQualitySignals,
      };
    });
    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn() })),
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createChatService: createLegacyChatService,
        createLazyRetriever: vi.fn(() => ({ retrieve: vi.fn() })),
        createPgPool,
        loadRagConfig: vi.fn(() => createRuntimeConfigForTest()),
      };
    });

    try {
      const { createRequestHandler: createRequestHandlerWithMocks } = await import('./index.js');
      const handler = createRequestHandlerWithMocks({
        env: {
          DATABASE_URL: 'postgres://xxyy:secret@example.test/xxyy_ask',
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'test-model',
        },
      });

      const response = await callHandler(handler, {
        body: {
          channel: 'web',
          message: 'XXYY Pro 有哪些权益？',
        },
        method: 'POST',
        url: '/api/chat',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        answer: 'agent runtime response',
        intent: 'product_qa',
      });
      expect(createLegacyChatService).not.toHaveBeenCalled();
      expect(createCustomerAgentChatService).toHaveBeenCalledTimes(1);
      const serviceOptions = createCustomerAgentChatService.mock.calls[0]?.[0];
      expect(serviceOptions).toBeDefined();
      if (serviceOptions === undefined) {
        throw new Error('Expected Customer Agent service options to be captured.');
      }
      expect(typeof serviceOptions.qualitySignals?.record).toBe('function');
      expect(typeof serviceOptions.sessionContext?.appendTurn).toBe('function');
      expect(typeof serviceOptions.sessionContext?.getRecentTurns).toBe('function');
      await serviceOptions.sessionContext?.getRecentTurns('session-1');
      expect(createPgPool).toHaveBeenCalledWith('postgres://xxyy:secret@example.test/xxyy_ask');
      expect(pgClient.query).toHaveBeenCalledWith(
        expect.stringContaining('from customer_agent_session_turns'),
        ['session-1', 12],
      );
      const signal = {
        answer: '当前知识库没有足够信息。',
        channel: 'web',
        confidence: 0.2,
        intent: 'product_qa',
        reason: 'low_confidence',
        redactedQuestion: 'XXYY Pro 价格是多少？',
        sessionIdPresent: true,
        userIdPresent: false,
      } as const;
      serviceOptions.qualitySignals?.record(signal);
      expect(captureAnswerQualitySignals).toHaveBeenCalledTimes(1);
      const captureInput = captureAnswerQualitySignals.mock.calls[0]?.[0];
      expect(captureInput).toBeDefined();
      expect(captureInput?.signals).toEqual([signal]);
      expect(typeof captureInput?.getStore).toBe('function');
      expect(mineAnswerQualitySignals).not.toHaveBeenCalled();
      expect(createPgKnowledgeOpsStore).toHaveBeenCalledTimes(1);
      expect(addCandidates).not.toHaveBeenCalled();
      expect(agentAsk).toHaveBeenCalledWith({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      });
    } finally {
      vi.doUnmock('@xxyy/agent-core');
      vi.doUnmock('@xxyy/knowledge-ops');
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
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

  it('redacts pasted secrets from chat request log previews', async () => {
    const logs: ApiLogEntry[] = [];
    const handler = createRequestHandler({
      logger: (entry) => {
        logs.push(entry);
      },
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '不要发送私钥、助记词或 seed phrase。',
              citations: [],
              confidence: 0.35,
              intent: 'unknown',
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
        message: '我的密码是 hunter2 api key: sk-test-123456',
      },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      messagePreview: '我的密码是 [sensitive_credential] api key: [sensitive_credential]',
      outcome: 'success',
      route: '/api/chat',
    });
    expect(JSON.stringify(logs)).not.toContain('hunter2');
    expect(JSON.stringify(logs)).not.toContain('sk-test-123456');
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
