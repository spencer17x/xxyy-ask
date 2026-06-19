import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PreparedKnowledgeChunk } from '@xxyy/knowledge';
import type { CreateCustomerAgentChatServiceOptions } from '@xxyy/agent-core';
import type {
  EmbeddedKnowledgeChunk,
  EvaluateCasesOptions,
  EvaluationCase,
  EvaluationReport,
  EvaluationResult,
  FeedbackStats,
  KnowledgeStats,
} from '@xxyy/rag-core';
import type { SourceDocument } from '@xxyy/shared';

import {
  BUILT_IN_EVALUATION_CASES,
  createDefaultCliIo,
  formatChatResponse,
  formatEvaluationReport,
  formatEvaluationProgress,
  formatFeedbackStats,
  formatIngestSummary,
  formatKnowledgeStats,
  formatMigrationSummary,
  parseCliArgs,
  resolveWorkspaceCwd,
  runCli,
} from './index.js';

describe('parseCliArgs', () => {
  it('parses ask questions with or without a separator', () => {
    expect(parseCliArgs(['ask', '--', 'XXYY Pro 有哪些权益？'])).toEqual({
      command: 'ask',
      question: 'XXYY Pro 有哪些权益？',
    });
    expect(parseCliArgs(['ask', 'XXYY Pro', '有哪些权益？'])).toEqual({
      command: 'ask',
      question: 'XXYY Pro 有哪些权益？',
    });
  });

  it('parses commands that do not require extra arguments', () => {
    expect(parseCliArgs(['ingest'])).toEqual({ command: 'ingest' });
    expect(parseCliArgs(['gate:knowledge', '--id', 'kc_telegram_setup', '--fast'])).toEqual({
      candidateId: 'kc_telegram_setup',
      command: 'gate:knowledge',
      fast: true,
    });
    expect(parseCliArgs(['migrate'])).toEqual({ command: 'migrate' });
    expect(parseCliArgs(['publish:knowledge', '--id', 'kc_telegram_setup'])).toEqual({
      candidateId: 'kc_telegram_setup',
      command: 'publish:knowledge',
    });
    expect(
      parseCliArgs([
        'publish:knowledge',
        '--',
        '--id',
        'kc_telegram_setup',
        '--target',
        'pages/support-faq.md',
      ]),
    ).toEqual({
      candidateId: 'kc_telegram_setup',
      command: 'publish:knowledge',
      targetFile: 'pages/support-faq.md',
    });
    expect(parseCliArgs(['stats'])).toEqual({ command: 'stats' });
    expect(parseCliArgs(['sync:telegram'])).toEqual({ command: 'sync:telegram' });
    expect(parseCliArgs(['sync:x'])).toEqual({ command: 'sync:x' });
    expect(parseCliArgs(['feedback'])).toEqual({
      command: 'feedback',
      json: false,
      limit: 10,
    });
    expect(parseCliArgs(['evaluate'])).toEqual({ command: 'evaluate', fast: false });
    expect(parseCliArgs(['evaluate', '--fast'])).toEqual({ command: 'evaluate', fast: true });
    expect(parseCliArgs(['evaluate', '--', '--fast'])).toEqual({
      command: 'evaluate',
      fast: true,
    });
    expect(parseCliArgs(['publish:knowledge'])).toEqual({
      command: 'help',
      error: 'Missing value for publish:knowledge --id.',
    });
    expect(parseCliArgs(['gate:knowledge'])).toEqual({
      command: 'help',
      error: 'Missing value for gate:knowledge --id.',
    });
  });

  it('parses feedback review filters for operations automation', () => {
    expect(parseCliArgs(['feedback', '--rating', 'negative', '--limit', '25', '--json'])).toEqual({
      command: 'feedback',
      json: true,
      limit: 25,
      rating: 'negative',
    });
    expect(parseCliArgs(['feedback', '--', '--rating', 'positive'])).toEqual({
      command: 'feedback',
      json: false,
      limit: 10,
      rating: 'positive',
    });
    expect(parseCliArgs(['feedback', '--limit', '0'])).toEqual({
      command: 'help',
      error: 'Invalid feedback limit: 0',
    });
    expect(parseCliArgs(['feedback', '--rating', 'mixed'])).toEqual({
      command: 'help',
      error: 'Invalid feedback rating: mixed',
    });
  });
});

function xChunk(overrides: Partial<PreparedKnowledgeChunk> = {}): PreparedKnowledgeChunk {
  return {
    contentHash: 'hash-1',
    documentId: 'x-doc',
    id: 'x_updates:sources/usexxyyio-x-posts/1:chunk:0001',
    metadata: {
      file: 'docs/product-features/sources/usexxyyio-x-posts.jsonl',
      headingPath: ['X Post 1', 'Text'],
      module: 'X Updates',
      sourceType: 'x_updates',
      title: 'X Post 1',
    },
    searchableText: 'X Post 1\nXXYY update',
    text: 'XXYY update',
    tokens: ['xxyy', 'update'],
    ...overrides,
  };
}

describe('BUILT_IN_EVALUATION_CASES', () => {
  it('contains a product support regression suite with quality assertions', () => {
    expect(BUILT_IN_EVALUATION_CASES.length).toBeGreaterThanOrEqual(30);
    const groundedCases = BUILT_IN_EVALUATION_CASES.filter(
      (item) => item.expectedIntent === 'product_qa' || item.expectedIntent === 'how_to',
    );
    expect(groundedCases.length).toBeGreaterThan(0);

    for (const testCase of groundedCases) {
      expect(testCase.minCitations ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it('covers core product, source tracing, and boundary topics', () => {
    expect(BUILT_IN_EVALUATION_CASES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'pro benefits' }),
        expect.objectContaining({ name: 'mobile app desktop shortcut' }),
        expect.objectContaining({ name: 'copy trading support' }),
        expect.objectContaining({ name: 'wallet monitoring limit updates' }),
        expect.objectContaining({
          name: 'wallet note x source',
          requiredSourceUrls: ['https://x.com/useXXYYio/status/2030954722350575916'],
        }),
        expect.objectContaining({ name: 'investment advice boundary' }),
        expect.objectContaining({ name: 'mev detection boundary' }),
      ]),
    );
  });

  it('covers sourceable X update questions', () => {
    expect(BUILT_IN_EVALUATION_CASES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'wallet note x source',
          expectedIntent: 'product_qa',
          minCitations: 1,
        }),
        expect.objectContaining({
          name: 'wallet monitoring limit updates',
          expectedIntent: 'product_qa',
          minCitations: 1,
        }),
      ]),
    );
  });
});

describe('resolveWorkspaceCwd', () => {
  it('prefers pnpm INIT_CWD when filtered scripts run inside an app package', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-cli-root-'));
    const appCwd = path.join(workspaceRoot, 'apps', 'cli');
    await mkdir(path.join(workspaceRoot, 'docs', 'product-features'), { recursive: true });
    await mkdir(appCwd, { recursive: true });

    expect(resolveWorkspaceCwd(appCwd, { INIT_CWD: workspaceRoot })).toBe(workspaceRoot);
  });
});

describe('createDefaultCliIo', () => {
  it('loads workspace .env values without overriding shell env', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-cli-env-'));
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

    const io = createDefaultCliIo({
      cwd: workspaceRoot,
      env: {
        POSTGRES_PASSWORD: 'from_shell',
      },
      stderr: { write: () => true },
      stdout: { write: () => true },
    });

    expect(io.env.POSTGRES_DB).toBe('xxyy_ask');
    expect(io.env.POSTGRES_PASSWORD).toBe('from_shell');
    expect(io.env.OPENAI_MODEL).toBe('openrouter/free');
  });
});

describe('CLI output formatting', () => {
  it('formats chat responses with readable citations', () => {
    expect(
      formatChatResponse({
        answer: '根据知识库，XXYY Pro 提供更多权益。',
        attachments: [
          {
            kind: 'video',
            mediaType: 'video/mp4',
            title: '添加到桌面演示',
            url: '/assets/xxyy-add-to-home.mp4',
          },
        ],
        confidence: 0.82,
        intent: 'product_qa',
        citations: [
          {
            title: 'XXYY Pro 权益',
            file: 'docs/product-features/pages/pro.md',
            sourceUrl: 'https://docs.xxyy.io/pro',
            excerpt: 'Pro 用户可以使用更多产品权益。',
          },
        ],
      }),
    ).toContain(
      [
        '根据知识库，XXYY Pro 提供更多权益。',
        '',
        'Intent: product_qa (confidence 0.82)',
        '',
        'Citations:',
        '[1] XXYY Pro 权益',
        '    docs/product-features/pages/pro.md',
        '    https://docs.xxyy.io/pro',
        '    Pro 用户可以使用更多产品权益。',
        '',
        'Attachments:',
        '[1] 添加到桌面演示',
        '    /assets/xxyy-add-to-home.mp4',
      ].join('\n'),
    );
  });

  it('formats image attachments for transaction analysis responses', () => {
    expect(
      formatChatResponse({
        answer: '交易哈希分析截图如下。',
        attachments: [
          {
            kind: 'image',
            mediaType: 'image/svg+xml',
            title: '交易分析截图',
            url: '/assets/tx-analysis-fixture.svg',
          },
        ],
        citations: [],
        confidence: 0.35,
        intent: 'tx_sandwich_detection',
      }),
    ).toContain(
      [
        'Citations: none',
        '',
        'Attachments:',
        '[1] 交易分析截图',
        '    /assets/tx-analysis-fixture.svg',
      ].join('\n'),
    );
  });

  it('formats ingest and evaluation summaries', () => {
    expect(
      formatIngestSummary({
        chunkCount: 64,
        documentCount: 12,
        indexPath: '.rag/index.json',
      }),
    ).toBe('Indexed 12 documents into 64 chunks.\nSaved index: .rag/index.json');

    expect(
      formatEvaluationReport({
        passed: 1,
        total: 2,
        results: [
          {
            actualIntent: 'product_qa',
            citationCount: 2,
            expectedIntent: 'product_qa',
            failureReasons: [],
            minCitations: 1,
            name: 'pro benefits',
            passed: true,
          },
          {
            actualIntent: 'unknown',
            citationCount: 0,
            expectedIntent: 'how_to',
            failureReasons: ['intent unknown != how_to', 'citations 0/1'],
            minCitations: 1,
            name: 'telegram setup',
            passed: false,
          },
        ],
      }),
    ).toContain('Evaluation: 1/2 passed');
    expect(
      formatEvaluationReport({
        passed: 0,
        total: 1,
        results: [
          {
            actualIntent: 'product_qa',
            citationCount: 0,
            expectedIntent: 'product_qa',
            failureReasons: ['answer missing required text: 独享服务器和节点'],
            minCitations: 1,
            name: 'pro quality',
            passed: false,
          },
        ],
      }),
    ).toContain('reasons: answer missing required text: 独享服务器和节点');
    expect(
      formatEvaluationProgress(
        {
          actualIntent: 'product_qa',
          citationCount: 2,
          expectedIntent: 'product_qa',
          failureReasons: [],
          minCitations: 1,
          name: 'pro benefits',
          passed: true,
        },
        3,
        37,
      ),
    ).toBe('[3/37] PASS pro benefits: expected product_qa, got product_qa, citations 2/1');
    expect(
      formatEvaluationProgress(
        {
          actualIntent: 'unknown',
          citationCount: 0,
          expectedIntent: 'how_to',
          failureReasons: ['intent unknown != how_to'],
          minCitations: 1,
          name: 'telegram setup',
          passed: false,
        },
        4,
        37,
      ),
    ).toContain('reasons: intent unknown != how_to');
  });

  it('formats pgvector ingest summaries', () => {
    expect(
      formatIngestSummary({
        chunkCount: 491,
        documentCount: 65,
        indexPath: 'pgvector',
        runId: 'ingest_20260606T010203Z_abcd1234',
      }),
    ).toContain('Run ID: ingest_20260606T010203Z_abcd1234');
  });

  it('formats migration summaries', () => {
    expect(formatMigrationSummary()).toBe('Database migrations applied.');
  });

  it('formats knowledge stats for operations checks', () => {
    const stats: KnowledgeStats = {
      chunkCount: 64,
      documentCount: 12,
      latestChunkUpdatedAt: '2026-06-06T01:02:03.000Z',
      latestIngestionRun: {
        chunkCount: 64,
        contentHash: 'content-hash-1',
        createdAt: '2026-06-06T01:03:04.000Z',
        documentCount: 12,
        runId: 'ingest_20260606T010203Z_abcd1234',
        source: 'cli',
        sourceCounts: { official_docs: 48, x_updates: 16 },
      },
      sourceStats: [
        { chunkCount: 48, documentCount: 10, sourceType: 'official_docs' },
        { chunkCount: 16, documentCount: 2, sourceType: 'x_updates' },
      ],
      sourceUrlCount: 8,
    };

    expect(formatKnowledgeStats(stats)).toContain(
      [
        'Knowledge stats:',
        'Documents: 12',
        'Chunks: 64',
        'Source URLs: 8',
        'Latest chunk update: 2026-06-06T01:02:03.000Z',
        '',
        'Latest ingest run:',
        'Run ID: ingest_20260606T010203Z_abcd1234',
      ].join('\n'),
    );
    expect(formatKnowledgeStats(stats)).toContain('official_docs: 48 chunks, 10 documents');
    expect(formatKnowledgeStats(stats)).toContain('Content hash: content-hash-1');
  });

  it('formats feedback stats for answer quality operations', () => {
    const stats: FeedbackStats = {
      latest: [
        {
          answer: '根据知识库，XXYY Pro 提供更多权益。',
          channel: 'web',
          citationCount: 2,
          comment: '没有讲清楚监控数量上限',
          createdAt: '2026-06-06T02:03:04.000Z',
          intent: 'product_qa',
          question: 'XXYY Pro 有哪些权益？',
          rating: 'negative',
          sessionId: 'session-1',
        },
      ],
      negativeCount: 1,
      positiveCount: 2,
      totalCount: 3,
    };

    expect(formatFeedbackStats(stats)).toContain(
      ['Feedback stats:', 'Total: 3', 'Positive: 2', 'Negative: 1'].join('\n'),
    );
    expect(formatFeedbackStats(stats)).toContain('[1] negative product_qa citations 2 web');
    expect(formatFeedbackStats(stats)).toContain('Question: XXYY Pro 有哪些权益？');
    expect(formatFeedbackStats(stats)).toContain('Comment: 没有讲清楚监控数量上限');
  });
});

describe('runCli', () => {
  it('answers boundary questions in pgvector mode before requiring vector configuration', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(['ask', '帮我查一下钱包余额'], {
      cwd: process.cwd(),
      env: {},
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
      stdout: {
        write: (message: string) => {
          stdout.push(message);
          return true;
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join('')).toContain('Intent: realtime_account_query');
    expect(stderr.join('')).toBe('');
  });

  it('prints database configuration errors from pgvector mode', async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(['ask', 'XXYY Pro 有哪些权益？'], {
      cwd: process.cwd(),
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_MODEL: 'test-model',
      },
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
      stdout: { write: () => true },
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('DATABASE_URL is required for pgvector retrieval');
  });

  it('runs fast evaluation with progress output and a local answer provider', async () => {
    vi.resetModules();

    const stdout: string[] = [];
    const createCustomerAgentChatService = vi.fn(
      (_options: CreateCustomerAgentChatServiceOptions) => ({
        ask: vi.fn(),
        stream: vi.fn(),
      }),
    );
    vi.doMock('@xxyy/agent-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createCustomerAgentChatService,
      };
    });
    const createLegacyChatService = vi.fn(() => ({
      ask: vi.fn(),
      stream: vi.fn(),
    }));
    const evaluateCases = vi.fn(
      (
        _cases: EvaluationCase[],
        _service: unknown,
        options?: EvaluateCasesOptions,
      ): Promise<EvaluationReport> => {
        const result: EvaluationResult = {
          actualIntent: 'product_qa',
          citationCount: 1,
          expectedIntent: 'product_qa',
          failureReasons: [],
          minCitations: 1,
          name: 'pro benefits',
          passed: true,
        };
        options?.onResult?.(result, 1, 1);
        return Promise.resolve({
          passed: 1,
          total: 1,
          results: [result],
        });
      },
    );

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createChatService: createLegacyChatService,
        createLazyRetriever: vi.fn(() => ({ retrieve: vi.fn() })),
        createPgPool: vi.fn(() => ({ end: vi.fn() })),
        createPgVectorStore: vi.fn(() => ({ retrieve: vi.fn() })),
        evaluateCases,
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
          txAnalysisProvider: 'none',
          txAnalysisReportStore: 'file',
          txAnalysisReviewer: 'none',
        })),
      };
    });
    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn() })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(['evaluate', '--fast'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(createLegacyChatService).not.toHaveBeenCalled();
      expect(createCustomerAgentChatService).toHaveBeenCalledTimes(1);
      expect(typeof createCustomerAgentChatService.mock.calls[0]?.[0].answerProvider?.answer).toBe(
        'function',
      );
      expect(evaluateCases).toHaveBeenCalledTimes(1);
      expect(typeof evaluateCases.mock.calls[0]?.[2]?.onResult).toBe('function');
      expect(stdout.join('')).toContain('[1/1] PASS pro benefits');
      expect(stdout.join('')).toContain('Evaluation: 1/1 passed');
      expect(stdout.join('').match(/PASS pro benefits/gu)).toHaveLength(1);
    } finally {
      vi.doUnmock('@xxyy/agent-core');
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
  });

  it('migrates pgvector storage before replacing prepared chunks', async () => {
    vi.resetModules();

    const events: string[] = [];
    const documents = [
      {
        id: 'doc-1',
        title: 'Doc 1',
        module: 'Product',
        sourceType: 'official_docs',
        file: 'docs/doc-1.md',
        content: 'Doc content',
      },
    ] satisfies SourceDocument[];
    const chunks = [
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        text: 'Doc content',
        metadata: {
          title: 'Doc 1',
          module: 'Product',
          sourceType: 'official_docs',
          file: 'docs/doc-1.md',
          headingPath: [],
        },
        searchableText: 'Doc 1 Doc content',
        tokens: ['doc', 'content'],
        contentHash: 'hash-1',
      },
    ] satisfies PreparedKnowledgeChunk[];
    const embedTexts = vi.fn(() => {
      events.push('embed');
      return Promise.resolve([[0.1, 0.2, 0.3]]);
    });
    const migrate = vi.fn(() => {
      events.push('migrate');
      return Promise.resolve();
    });
    const migratePgKnowledgeOpsStore = vi.fn(() => {
      events.push('knowledge-ops:migrate');
      return Promise.resolve();
    });
    const migratePgSessionContextStore = vi.fn(() => {
      events.push('session-context:migrate');
      return Promise.resolve();
    });
    const replaceChunks = vi.fn(() => {
      events.push('replace');
      return Promise.resolve();
    });
    const recordIngestionRun = vi.fn(() => {
      events.push('record');
      return Promise.resolve();
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });

    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts })),
        loadProductDocuments: vi.fn(() => Promise.resolve(documents)),
        prepareKnowledgeChunks: vi.fn(() => chunks),
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        createPgVectorStore: vi.fn(() => ({
          getStats: vi.fn(),
          migrate,
          recordIngestionRun,
          replaceChunks,
          retrieve: vi.fn(),
          upsertChunks: vi.fn(),
        })),
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiModel: 'gpt-test',
          topK: 6,
        })),
      };
    });
    vi.doMock('@xxyy/knowledge-ops', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        migratePgKnowledgeOpsStore,
      };
    });
    vi.doMock('@xxyy/agent-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        migratePgSessionContextStore,
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(['ingest'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: { write: () => true },
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual([
        'migrate',
        'knowledge-ops:migrate',
        'session-context:migrate',
        'embed',
        'replace',
        'record',
        'pool.end',
      ]);
      expect(recordIngestionRun).toHaveBeenCalledWith(
        expect.objectContaining({
          chunkCount: 1,
          documentCount: 1,
          source: 'cli',
          sourceCounts: { official_docs: 1 },
        }),
      );
    } finally {
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
      vi.doUnmock('@xxyy/knowledge-ops');
      vi.doUnmock('@xxyy/agent-core');
    }
  });

  it('syncs only changed X update chunks without replacing the full index', async () => {
    vi.resetModules();

    const events: string[] = [];
    const documents = [
      {
        id: 'official-doc',
        title: 'Official Doc',
        module: 'Product',
        sourceType: 'official_docs',
        file: 'docs/product-features/pages/pro.md',
        content: 'Official content',
      },
      {
        id: 'x-doc',
        title: 'X Post 2',
        module: 'X Updates',
        sourceType: 'x_updates',
        file: 'docs/product-features/sources/usexxyyio-x-posts.jsonl',
        content: 'X update content',
      },
    ] satisfies SourceDocument[];
    const chunks = [
      xChunk({
        contentHash: 'hash-unchanged',
        id: 'x_updates:sources/usexxyyio-x-posts/1:chunk:0001',
        searchableText: 'unchanged searchable text',
      }),
      xChunk({
        contentHash: 'hash-changed',
        id: 'x_updates:sources/usexxyyio-x-posts/2:chunk:0001',
        searchableText: 'changed searchable text',
      }),
    ] satisfies PreparedKnowledgeChunk[];
    const prepareKnowledgeChunks = vi.fn((inputDocuments: SourceDocument[]) => {
      events.push(`prepare:${inputDocuments.map((document) => document.id).join(',')}`);
      return chunks;
    });
    const embedTexts = vi.fn((texts: string[]) => {
      events.push(`embed:${texts.join('|')}`);
      return Promise.resolve(texts.map(() => [0.9, 0.8, 0.7]));
    });
    const migrate = vi.fn(() => {
      events.push('migrate');
      return Promise.resolve();
    });
    const migratePgKnowledgeOpsStore = vi.fn(() => {
      events.push('knowledge-ops:migrate');
      return Promise.resolve();
    });
    const migratePgSessionContextStore = vi.fn(() => {
      events.push('session-context:migrate');
      return Promise.resolve();
    });
    const getChunkContentHashes = vi.fn(() => {
      events.push('hashes');
      return Promise.resolve(
        new Map([
          ['x_updates:sources/usexxyyio-x-posts/1:chunk:0001', 'hash-unchanged'],
          ['x_updates:sources/usexxyyio-x-posts/2:chunk:0001', 'old-hash'],
        ]),
      );
    });
    const replaceChunks = vi.fn(() => {
      events.push('replace');
      return Promise.resolve();
    });
    const upsertChunks = vi.fn((_chunks: EmbeddedKnowledgeChunk[]) => {
      events.push('upsert');
      return Promise.resolve();
    });
    const recordIngestionRun = vi.fn(() => {
      events.push('record');
      return Promise.resolve();
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });

    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts })),
        loadProductDocuments: vi.fn(() => Promise.resolve(documents)),
        prepareKnowledgeChunks,
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        createPgVectorStore: vi.fn(() => ({
          getChunkContentHashes,
          getStats: vi.fn(),
          migrate,
          recordIngestionRun,
          replaceChunks,
          retrieve: vi.fn(),
          upsertChunks,
        })),
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiModel: 'gpt-test',
          topK: 6,
        })),
      };
    });
    vi.doMock('@xxyy/knowledge-ops', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        migratePgKnowledgeOpsStore,
      };
    });
    vi.doMock('@xxyy/agent-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        migratePgSessionContextStore,
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');
      const stdout: string[] = [];

      const exitCode = await runCliWithMocks(['sync:x'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual([
        'prepare:x-doc',
        'migrate',
        'knowledge-ops:migrate',
        'session-context:migrate',
        'hashes',
        'embed:changed searchable text',
        'upsert',
        'record',
        'pool.end',
      ]);
      expect(getChunkContentHashes).toHaveBeenCalledWith([
        'x_updates:sources/usexxyyio-x-posts/1:chunk:0001',
        'x_updates:sources/usexxyyio-x-posts/2:chunk:0001',
      ]);
      expect(upsertChunks).toHaveBeenCalledWith([
        expect.objectContaining({
          contentHash: 'hash-changed',
          id: 'x_updates:sources/usexxyyio-x-posts/2:chunk:0001',
        }),
      ]);
      expect(replaceChunks).not.toHaveBeenCalled();
      expect(recordIngestionRun).toHaveBeenCalledWith(
        expect.objectContaining({
          chunkCount: 1,
          documentCount: 1,
          source: 'cli:x_incremental',
          sourceCounts: { x_updates: 1 },
        }),
      );
      expect(stdout.join('')).toContain('Synced 1 changed X chunks (1 skipped).');
    } finally {
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
      vi.doUnmock('@xxyy/knowledge-ops');
      vi.doUnmock('@xxyy/agent-core');
    }
  });

  it('syncs authorized Telegram support messages into review candidates without publishing', async () => {
    vi.resetModules();

    const events: string[] = [];
    const rawMessages = [
      {
        chatIdHash: 'support_chat_hash',
        contentHash: 'question_hash',
        ingestedAt: '2026-06-17T04:00:00.000Z',
        messageId: '100',
        senderRole: 'user',
        sentAt: '2026-06-17T03:59:00.000Z',
        source: 'telegram',
        text: 'Telegram 通知怎么设置？',
      },
      {
        chatIdHash: 'support_chat_hash',
        contentHash: 'answer_hash',
        ingestedAt: '2026-06-17T04:00:00.000Z',
        messageId: '101',
        replyToMessageId: '100',
        senderRole: 'support',
        sentAt: '2026-06-17T04:00:00.000Z',
        source: 'telegram',
        text: '在钱包监控里配置 Telegram Bot。',
      },
    ];
    const candidates = [
      {
        confidence: 0.8,
        createdAt: '2026-06-17T04:00:00.000Z',
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
        redactionReport: { entities: [], riskFlags: [], riskLevel: 'low' },
        riskLevel: 'low',
        sourceRefs: [{ source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '100' }],
        status: 'needs_review',
        targetCategory: 'product_faq',
        type: 'faq',
        updatedAt: '2026-06-17T04:00:00.000Z',
      },
    ];
    const getSourceCursor = vi.fn(() => {
      events.push('cursor:get');
      return Promise.resolve('124');
    });
    const setSourceCursor = vi.fn((input: { cursorValue: string }) => {
      events.push(`cursor:set:${input.cursorValue}`);
      return Promise.resolve();
    });
    const migrate = vi.fn(() => {
      events.push('knowledge-ops:migrate');
      return Promise.resolve();
    });
    const upsertRawMessages = vi.fn((messages: unknown[]) => {
      events.push(`raw:${messages.length}`);
      return Promise.resolve(messages);
    });
    const addCandidates = vi.fn((items: unknown[]) => {
      events.push(`candidates:${items.length}`);
      return Promise.resolve(items);
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
        })),
      };
    });
    vi.doMock('@xxyy/knowledge-ops', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgKnowledgeOpsStore: vi.fn(() => ({
          addCandidates,
          getSourceCursor,
          migrate,
          setSourceCursor,
          upsertRawMessages,
        })),
        fetchTelegramSupportMessages: vi.fn(
          (input: {
            allowedChatIds: readonly string[];
            botToken: string;
            limit?: number;
            offset?: number;
            supportUserIds?: readonly string[];
          }) => {
            events.push(`telegram:${input.offset}:${input.limit}`);
            expect(input.allowedChatIds).toEqual(['-1001', '-1002']);
            expect(input.botToken).toBe('bot-token');
            expect(input.supportUserIds).toEqual(['42']);
            return Promise.resolve({ messages: rawMessages, nextOffset: 125 });
          },
        ),
        mineSupportConversations: vi.fn((input: { messages: unknown[] }) => {
          events.push(`mine:${input.messages.length}`);
          return { candidates, messagesRead: 2, pairsConsidered: 1 };
        }),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');
      const stdout: string[] = [];

      const exitCode = await runCliWithMocks(['sync:telegram'], {
        cwd: process.cwd(),
        env: {
          DATABASE_URL: 'postgres://example.test/db',
          TELEGRAM_ALLOWED_CHAT_IDS: '-1001, -1002',
          TELEGRAM_BOT_TOKEN: 'bot-token',
          TELEGRAM_SUPPORT_USER_IDS: '42',
          TELEGRAM_UPDATES_LIMIT: '50',
        },
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual([
        'knowledge-ops:migrate',
        'cursor:get',
        'telegram:124:50',
        'raw:2',
        'mine:2',
        'candidates:1',
        'cursor:set:125',
        'pool.end',
      ]);
      expect(setSourceCursor).toHaveBeenCalledWith(
        expect.objectContaining({
          cursorValue: '125',
          source: 'telegram',
        }),
      );
      expect(stdout.join('')).toContain(
        'Telegram support sync: fetched 2 messages, stored 2 raw messages, generated 1 review candidates.',
      );
      expect(stdout.join('')).toContain('Next Telegram offset: 125');
      expect(stdout.join('')).toContain('No candidates were published; human review is required.');
    } finally {
      vi.doUnmock('@xxyy/rag-core');
      vi.doUnmock('@xxyy/knowledge-ops');
    }
  });

  it('publishes an approved knowledge candidate into the reviewed support source', async () => {
    vi.resetModules();

    const events: string[] = [];
    const approvedCandidate = {
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
      redactionReport: { entities: [], riskFlags: [], riskLevel: 'low' },
      reviewer: 'ops@example.com',
      riskLevel: 'low',
      sourceRefs: [{ source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '100' }],
      status: 'approved',
      targetCategory: 'product_faq',
      type: 'faq',
      updatedAt: '2026-06-17T03:00:00.000Z',
    };
    const migrate = vi.fn(() => {
      events.push('knowledge-ops:migrate');
      return Promise.resolve();
    });
    const getCandidate = vi.fn((candidateId: string) => {
      events.push(`candidate:get:${candidateId}`);
      return Promise.resolve(approvedCandidate);
    });
    const markCandidatePublished = vi.fn(
      (candidateId: string, input: { publishedTarget: string }) => {
        events.push(`candidate:mark:${candidateId}:${input.publishedTarget}`);
        return Promise.resolve({
          ...approvedCandidate,
          publishedTarget: input.publishedTarget,
          status: 'published',
          updatedAt: '2026-06-17T05:00:00.000Z',
        });
      },
    );
    type CandidateRunInputForTest = {
      candidateId: string;
      createdAt?: string;
      metadata: Record<string, unknown>;
      runId: string;
      runType: string;
      status: string;
    };
    const recordCandidateRun = vi.fn((input: CandidateRunInputForTest) => {
      events.push(`candidate:run:${input.runType}:${input.runId}`);
      return Promise.resolve({
        candidateId: 'kc_telegram_setup',
        createdAt: '2026-06-17T05:00:00.000Z',
        metadata: {},
        runId: input.runId,
        runType: input.runType,
        status: 'completed',
      });
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
        })),
      };
    });
    vi.doMock('@xxyy/knowledge-ops', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgKnowledgeOpsStore: vi.fn(() => ({
          getCandidate,
          markCandidatePublished,
          migrate,
          recordCandidateRun,
        })),
        publishKnowledgeCandidate: vi.fn(
          (input: {
            candidate: { id: string };
            productFeaturesDir: string;
            targetFile?: string;
          }) => {
            events.push(`publish:${input.candidate.id}:${input.targetFile ?? 'default'}`);
            expect(input.productFeaturesDir).toBe(
              path.join(process.cwd(), 'docs', 'product-features'),
            );
            return Promise.resolve({
              candidate: {
                ...approvedCandidate,
                publishedTarget: 'pages/support-faq.md#kc_telegram_setup',
                status: 'published',
                updatedAt: '2026-06-17T05:00:00.000Z',
              },
              publishedAt: '2026-06-17T05:00:00.000Z',
              publishedTarget: 'pages/support-faq.md#kc_telegram_setup',
              publishRunId: 'publish_20260617T050000Z_abcd1234',
            });
          },
        ),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');
      const stdout: string[] = [];

      const exitCode = await runCliWithMocks(
        ['publish:knowledge', '--id', 'kc_telegram_setup', '--target', 'pages/support-faq.md'],
        {
          cwd: process.cwd(),
          env: { DATABASE_URL: 'postgres://example.test/db' },
          stderr: { write: () => true },
          stdout: {
            write: (message: string) => {
              stdout.push(message);
              return true;
            },
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(events).toEqual([
        'knowledge-ops:migrate',
        'candidate:get:kc_telegram_setup',
        'publish:kc_telegram_setup:pages/support-faq.md',
        'candidate:mark:kc_telegram_setup:pages/support-faq.md#kc_telegram_setup',
        'candidate:run:publish:publish_20260617T050000Z_abcd1234',
        'pool.end',
      ]);
      expect(markCandidatePublished).toHaveBeenCalledWith('kc_telegram_setup', {
        publishedAt: '2026-06-17T05:00:00.000Z',
        publishedTarget: 'pages/support-faq.md#kc_telegram_setup',
      });
      expect(recordCandidateRun).toHaveBeenCalledWith({
        candidateId: 'kc_telegram_setup',
        createdAt: '2026-06-17T05:00:00.000Z',
        metadata: {
          publishedTarget: 'pages/support-faq.md#kc_telegram_setup',
        },
        runId: 'publish_20260617T050000Z_abcd1234',
        runType: 'publish',
        status: 'completed',
      });
      expect(stdout.join('')).toContain('Published knowledge candidate kc_telegram_setup.');
      expect(stdout.join('')).toContain('Published target: pages/support-faq.md#kc_telegram_setup');
      expect(stdout.join('')).toContain('Publish run: publish_20260617T050000Z_abcd1234');
      expect(stdout.join('')).toContain(
        'Next: run pnpm rag:gate:knowledge -- --id <candidate-id> --fast before production confirmation.',
      );
    } finally {
      vi.doUnmock('@xxyy/rag-core');
      vi.doUnmock('@xxyy/knowledge-ops');
    }
  });

  it('runs the knowledge gate by ingesting published knowledge and evaluating generated cases', async () => {
    vi.resetModules();

    const events: string[] = [];
    const publishedCandidate = {
      confidence: 0.8,
      createdAt: '2026-06-17T02:00:00.000Z',
      existingKnowledgeMatches: [],
      generatedEvalCases: [
        {
          expectedAnswer: '在钱包监控里配置 Telegram Bot。',
          expectedIntent: 'how_to',
          minCitations: 0,
          question: 'Telegram 通知怎么设置？',
          requireExpectedAnswerText: false,
        },
      ],
      id: 'kc_telegram_setup',
      proposedAnswer: '在钱包监控里配置 Telegram Bot。',
      publishedTarget: 'pages/support-faq.md#kc_telegram_setup',
      question: 'Telegram 通知怎么设置？',
      redactionReport: { entities: [], riskFlags: [], riskLevel: 'low' },
      reviewer: 'ops@example.com',
      riskLevel: 'low',
      sourceRefs: [{ source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '100' }],
      status: 'published',
      targetCategory: 'product_faq',
      type: 'faq',
      updatedAt: '2026-06-17T05:00:00.000Z',
    };
    const documents = [
      {
        content: 'Telegram 通知怎么设置？\n在钱包监控里配置 Telegram Bot。',
        file: 'docs/product-features/pages/support-faq.md',
        id: 'reviewed-support',
        module: 'Support',
        sourceType: 'official_docs',
        title: 'Reviewed Support Knowledge',
      },
    ] satisfies SourceDocument[];
    const chunks = [
      {
        contentHash: 'hash-reviewed-support',
        documentId: 'reviewed-support',
        id: 'official_docs:reviewed-support:chunk:0001',
        metadata: {
          file: 'docs/product-features/pages/support-faq.md',
          headingPath: ['Telegram 通知怎么设置？'],
          module: 'Support',
          sourceType: 'official_docs',
          title: 'Reviewed Support Knowledge',
        },
        searchableText: 'Telegram 通知怎么设置？ 在钱包监控里配置 Telegram Bot。',
        text: 'Telegram 通知怎么设置？\n在钱包监控里配置 Telegram Bot。',
        tokens: ['telegram', 'bot'],
      },
    ] satisfies PreparedKnowledgeChunk[];
    const embedTexts = vi.fn(() => {
      events.push('embed');
      return Promise.resolve([[0.1, 0.2, 0.3]]);
    });
    const migrate = vi.fn(() => {
      events.push('vector:migrate');
      return Promise.resolve();
    });
    const replaceChunks = vi.fn(() => {
      events.push('vector:replace');
      return Promise.resolve();
    });
    const recordIngestionRun = vi.fn(() => {
      events.push('vector:record');
      return Promise.resolve();
    });
    const migratePgKnowledgeOpsStore = vi.fn(() => {
      events.push('knowledge-ops:migrate:ingest');
      return Promise.resolve();
    });
    const migratePgSessionContextStore = vi.fn(() => {
      events.push('session-context:migrate:ingest');
      return Promise.resolve();
    });
    const storeMigrate = vi.fn(() => {
      events.push('knowledge-ops:migrate:gate');
      return Promise.resolve();
    });
    const getCandidate = vi.fn((candidateId: string) => {
      events.push(`candidate:get:${candidateId}`);
      return Promise.resolve(publishedCandidate);
    });
    const markCandidateIngested = vi.fn((candidateId: string, _input: { ingestedAt?: string }) => {
      events.push(`candidate:ingested:${candidateId}`);
      return Promise.resolve({
        ...publishedCandidate,
        status: 'ingested',
        updatedAt: '2026-06-17T06:00:00.000Z',
      });
    });
    const markCandidateEvalResult = vi.fn(
      (candidateId: string, input: { evaluatedAt?: string; passed: boolean }) => {
        events.push(`candidate:eval:${candidateId}:${input.passed ? 'passed' : 'failed'}`);
        return Promise.resolve({
          ...publishedCandidate,
          status: input.passed ? 'eval_passed' : 'eval_failed',
          updatedAt: '2026-06-17T06:10:00.000Z',
        });
      },
    );
    const recordCandidateRun = vi.fn((input: { runId: string; runType: string }) => {
      const runIdPrefix = input.runId.startsWith('ingest_')
        ? 'ingest_'
        : input.runId.startsWith('eval_')
          ? 'eval_'
          : input.runId;
      events.push(`candidate:run:${input.runType}:${runIdPrefix}`);
      return Promise.resolve({
        candidateId: 'kc_telegram_setup',
        createdAt: '2026-06-17T06:10:00.000Z',
        metadata: {},
        runId: input.runId,
        runType: input.runType,
        status: input.runType === 'eval' ? 'passed' : 'completed',
      });
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });
    const createCustomerAgentChatService = vi.fn(
      (_options: CreateCustomerAgentChatServiceOptions) => ({
        ask: vi.fn(),
        stream: vi.fn(),
      }),
    );
    const evaluateCases = vi.fn(
      (
        cases: EvaluationCase[],
        _service: unknown,
        options?: EvaluateCasesOptions,
      ): Promise<EvaluationReport> => {
        events.push(`evaluate:${cases.map((item) => item.name).join('|')}`);
        expect(cases).toEqual([
          expect.objectContaining({
            expectedIntent: 'how_to',
            minCitations: 0,
            name: 'knowledge candidate kc_telegram_setup / Telegram 通知怎么设置？',
            request: {
              channel: 'cli',
              message: 'Telegram 通知怎么设置？',
            },
          }),
        ]);
        expect(cases[0]).not.toHaveProperty('requiredAnswerIncludes');
        const result: EvaluationResult = {
          actualIntent: 'how_to',
          citationCount: 0,
          expectedIntent: 'how_to',
          failureReasons: [],
          minCitations: 0,
          name: cases[0]?.name ?? 'knowledge candidate',
          passed: true,
        };
        options?.onResult?.(result, 1, 1);
        return Promise.resolve({
          passed: 1,
          total: 1,
          results: [result],
        });
      },
    );

    vi.doMock('@xxyy/agent-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createCustomerAgentChatService,
        migratePgSessionContextStore,
      };
    });
    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts })),
        loadProductDocuments: vi.fn(() => Promise.resolve(documents)),
        prepareKnowledgeChunks: vi.fn(() => chunks),
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        createPgVectorStore: vi.fn(() => ({
          getStats: vi.fn(),
          migrate,
          recordIngestionRun,
          replaceChunks,
          retrieve: vi.fn(),
          upsertChunks: vi.fn(),
        })),
        evaluateCases,
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
          txAnalysisProvider: 'none',
          txAnalysisReportStore: 'file',
          txAnalysisReviewer: 'none',
        })),
      };
    });
    vi.doMock('@xxyy/knowledge-ops', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgKnowledgeOpsStore: vi.fn(() => ({
          getCandidate,
          markCandidateEvalResult,
          markCandidateIngested,
          migrate: storeMigrate,
          recordCandidateRun,
        })),
        migratePgKnowledgeOpsStore,
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');
      const stdout: string[] = [];

      const exitCode = await runCliWithMocks(
        ['gate:knowledge', '--id', 'kc_telegram_setup', '--fast'],
        {
          cwd: process.cwd(),
          env: { DATABASE_URL: 'postgres://example.test/db' },
          stderr: { write: () => true },
          stdout: {
            write: (message: string) => {
              stdout.push(message);
              return true;
            },
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(events).toEqual([
        'knowledge-ops:migrate:gate',
        'candidate:get:kc_telegram_setup',
        'vector:migrate',
        'knowledge-ops:migrate:ingest',
        'session-context:migrate:ingest',
        'embed',
        'vector:replace',
        'vector:record',
        'pool.end',
        'candidate:ingested:kc_telegram_setup',
        'candidate:run:ingest:ingest_',
        'evaluate:knowledge candidate kc_telegram_setup / Telegram 通知怎么设置？',
        'candidate:eval:kc_telegram_setup:passed',
        'candidate:run:eval:eval_',
        'pool.end',
      ]);
      const ingestedCall = markCandidateIngested.mock.calls[0];
      expect(ingestedCall?.[0]).toBe('kc_telegram_setup');
      expect(typeof ingestedCall?.[1].ingestedAt).toBe('string');
      const evalCall = markCandidateEvalResult.mock.calls[0];
      expect(evalCall?.[0]).toBe('kc_telegram_setup');
      expect(evalCall?.[1].passed).toBe(true);
      expect(typeof evalCall?.[1].evaluatedAt).toBe('string');
      expect(createCustomerAgentChatService).toHaveBeenCalledTimes(1);
      const runInputs = recordCandidateRun.mock.calls.map(([input]) => input);
      const ingestRunInput = runInputs.find((input) => input.runType === 'ingest');
      expect(ingestRunInput).toMatchObject({
        candidateId: 'kc_telegram_setup',
        metadata: {
          chunkCount: 1,
          documentCount: 1,
          indexPath: 'pgvector',
        },
        runType: 'ingest',
        status: 'completed',
      });
      const evalRunInput = runInputs.find((input) => input.runType === 'eval');
      expect(evalRunInput).toMatchObject({
        candidateId: 'kc_telegram_setup',
        metadata: {
          failures: [],
          passed: 1,
          total: 1,
        },
        runType: 'eval',
        status: 'passed',
      });
      expect(stdout.join('')).toContain('Knowledge gate passed for candidate kc_telegram_setup.');
      expect(stdout.join('')).toContain('Ingest run: ingest_');
      expect(stdout.join('')).toContain('Eval run: eval_');
      expect(stdout.join('')).toContain('Evaluation: 1/1 passed');
    } finally {
      vi.doUnmock('@xxyy/agent-core');
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
      vi.doUnmock('@xxyy/knowledge-ops');
    }
  });

  it('runs the knowledge gate for approved eval-only candidates without ingesting knowledge', async () => {
    vi.resetModules();

    const events: string[] = [];
    const evalCandidate = {
      confidence: 0.35,
      createdAt: '2026-06-19T08:00:00.000Z',
      existingKnowledgeMatches: [],
      generatedEvalCases: [
        {
          expectedAnswer:
            '交易哈希夹子检测功能暂未启用。当前不会编造链上分析结论；接入正式链上数据源后才能判断是否被夹并生成截图。',
          expectedIntent: 'tx_sandwich_detection',
          minCitations: 0,
          question: '[evm_tx_hash]',
          requireExpectedAnswerText: false,
        },
      ],
      id: 'kc_tx_eval',
      proposedAnswer:
        '交易哈希夹子检测功能暂未启用。当前不会编造链上分析结论；接入正式链上数据源后才能判断是否被夹并生成截图。',
      question: '[evm_tx_hash]',
      redactionReport: { entities: [], riskFlags: [], riskLevel: 'low' },
      reviewer: 'ops@example.com',
      riskLevel: 'low',
      sourceRefs: [
        { source: 'answer_quality_signal', chatIdHash: 'session_present', messageId: 'aqs_tx' },
      ],
      status: 'approved',
      targetCategory: 'eval_case',
      type: 'eval_case',
      updatedAt: '2026-06-19T09:00:00.000Z',
    };
    const storeMigrate = vi.fn(() => {
      events.push('knowledge-ops:migrate:gate');
      return Promise.resolve();
    });
    const getCandidate = vi.fn((candidateId: string) => {
      events.push(`candidate:get:${candidateId}`);
      return Promise.resolve(evalCandidate);
    });
    const markCandidateIngested = vi.fn(() => {
      throw new Error('eval-only gate should not ingest knowledge');
    });
    const markCandidateEvalResult = vi.fn(
      (candidateId: string, input: { evaluatedAt?: string; passed: boolean }) => {
        events.push(`candidate:eval:${candidateId}:${input.passed ? 'passed' : 'failed'}`);
        return Promise.resolve({
          ...evalCandidate,
          status: input.passed ? 'eval_passed' : 'eval_failed',
          updatedAt: '2026-06-19T09:10:00.000Z',
        });
      },
    );
    const recordCandidateRun = vi.fn((input: { runId: string; runType: string }) => {
      const runIdPrefix = input.runId.startsWith('eval_') ? 'eval_' : input.runId;
      events.push(`candidate:run:${input.runType}:${runIdPrefix}`);
      return Promise.resolve({
        candidateId: 'kc_tx_eval',
        createdAt: '2026-06-19T09:10:00.000Z',
        metadata: {},
        runId: input.runId,
        runType: input.runType,
        status: input.runType === 'eval' ? 'passed' : 'completed',
      });
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });
    const createCustomerAgentChatService = vi.fn(
      (_options: CreateCustomerAgentChatServiceOptions) => ({
        ask: vi.fn(),
        stream: vi.fn(),
      }),
    );
    const evaluateCases = vi.fn(
      (
        cases: EvaluationCase[],
        _service: unknown,
        options?: EvaluateCasesOptions,
      ): Promise<EvaluationReport> => {
        events.push(`evaluate:${cases.map((item) => item.name).join('|')}`);
        expect(cases).toEqual([
          expect.objectContaining({
            expectedIntent: 'tx_sandwich_detection',
            minCitations: 0,
            name: 'knowledge candidate kc_tx_eval / [evm_tx_hash]',
            request: {
              channel: 'cli',
              message: '[evm_tx_hash]',
            },
          }),
        ]);
        expect(cases[0]).not.toHaveProperty('requiredAnswerIncludes');
        const result: EvaluationResult = {
          actualIntent: 'tx_sandwich_detection',
          citationCount: 0,
          expectedIntent: 'tx_sandwich_detection',
          failureReasons: [],
          minCitations: 0,
          name: cases[0]?.name ?? 'knowledge candidate',
          passed: true,
        };
        options?.onResult?.(result, 1, 1);
        return Promise.resolve({
          passed: 1,
          total: 1,
          results: [result],
        });
      },
    );

    vi.doMock('@xxyy/agent-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createCustomerAgentChatService,
      };
    });
    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        loadProductDocuments: vi.fn(() => {
          throw new Error('eval-only gate should not load product documents');
        }),
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        evaluateCases,
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
          txAnalysisProvider: 'none',
          txAnalysisReportStore: 'file',
          txAnalysisReviewer: 'none',
        })),
      };
    });
    vi.doMock('@xxyy/knowledge-ops', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgKnowledgeOpsStore: vi.fn(() => ({
          getCandidate,
          markCandidateEvalResult,
          markCandidateIngested,
          migrate: storeMigrate,
          recordCandidateRun,
        })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');
      const stdout: string[] = [];

      const exitCode = await runCliWithMocks(['gate:knowledge', '--id', 'kc_tx_eval', '--fast'], {
        cwd: process.cwd(),
        env: { DATABASE_URL: 'postgres://example.test/db' },
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual([
        'knowledge-ops:migrate:gate',
        'candidate:get:kc_tx_eval',
        'evaluate:knowledge candidate kc_tx_eval / [evm_tx_hash]',
        'candidate:eval:kc_tx_eval:passed',
        'candidate:run:eval:eval_',
        'pool.end',
      ]);
      expect(markCandidateIngested).not.toHaveBeenCalled();
      expect(createCustomerAgentChatService).toHaveBeenCalledTimes(1);
      expect(recordCandidateRun).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateId: 'kc_tx_eval',
          metadata: {
            failures: [],
            passed: 1,
            total: 1,
          },
          runType: 'eval',
          status: 'passed',
        }),
      );
      expect(stdout.join('')).toContain('Knowledge gate passed for candidate kc_tx_eval.');
      expect(stdout.join('')).toContain('Ingest run: skipped');
      expect(stdout.join('')).toContain('Eval run: eval_');
      expect(stdout.join('')).toContain('Evaluation: 1/1 passed');
    } finally {
      vi.doUnmock('@xxyy/agent-core');
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
      vi.doUnmock('@xxyy/knowledge-ops');
    }
  });

  it('runs database migrations without generating embeddings', async () => {
    vi.resetModules();

    const events: string[] = [];
    const migrate = vi.fn(() => {
      events.push('rag:migrate');
      return Promise.resolve();
    });
    const migratePgKnowledgeOpsStore = vi.fn(() => {
      events.push('knowledge-ops:migrate');
      return Promise.resolve();
    });
    const migratePgSessionContextStore = vi.fn(() => {
      events.push('session-context:migrate');
      return Promise.resolve();
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        createPgVectorStore: vi.fn(() => ({
          getFeedbackStats: vi.fn(),
          getStats: vi.fn(),
          migrate,
          recordFeedback: vi.fn(),
          recordIngestionRun: vi.fn(),
          replaceChunks: vi.fn(),
          retrieve: vi.fn(),
          upsertChunks: vi.fn(),
        })),
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: undefined,
          openAiApiKeyPresent: false,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: undefined,
          openAiRequestTimeoutMs: 30000,
          topK: 6,
        })),
      };
    });
    vi.doMock('@xxyy/knowledge-ops', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        migratePgKnowledgeOpsStore,
      };
    });
    vi.doMock('@xxyy/agent-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        migratePgSessionContextStore,
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const stdout: string[] = [];
      const exitCode = await runCliWithMocks(['migrate'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual([
        'rag:migrate',
        'knowledge-ops:migrate',
        'session-context:migrate',
        'pool.end',
      ]);
      expect(stdout.join('')).toContain('Database migrations applied.');
    } finally {
      vi.doUnmock('@xxyy/agent-core');
      vi.doUnmock('@xxyy/rag-core');
      vi.doUnmock('@xxyy/knowledge-ops');
    }
  });

  it('prints pgvector knowledge stats', async () => {
    vi.resetModules();

    const stdout: string[] = [];
    const getStats = vi.fn(() =>
      Promise.resolve({
        chunkCount: 64,
        documentCount: 12,
        latestChunkUpdatedAt: '2026-06-06T01:02:03.000Z',
        latestIngestionRun: {
          chunkCount: 64,
          contentHash: 'content-hash-1',
          createdAt: '2026-06-06T01:03:04.000Z',
          documentCount: 12,
          runId: 'ingest_20260606T010203Z_abcd1234',
          source: 'cli',
          sourceCounts: { official_docs: 48, x_updates: 16 },
        },
        sourceStats: [
          { chunkCount: 48, documentCount: 10, sourceType: 'official_docs' },
          { chunkCount: 16, documentCount: 2, sourceType: 'x_updates' },
        ],
        sourceUrlCount: 8,
      } satisfies KnowledgeStats),
    );
    const end = vi.fn(() => Promise.resolve());

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        createPgVectorStore: vi.fn(() => ({
          getStats,
          migrate: vi.fn(),
          recordIngestionRun: vi.fn(),
          replaceChunks: vi.fn(),
          retrieve: vi.fn(),
          upsertChunks: vi.fn(),
        })),
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
        })),
      };
    });
    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn() })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(['stats'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(getStats).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(stdout.join('')).toContain('Knowledge stats:');
      expect(stdout.join('')).toContain('Run ID: ingest_20260606T010203Z_abcd1234');
    } finally {
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
  });

  it('prints feedback stats for quality operations', async () => {
    vi.resetModules();

    const stdout: string[] = [];
    const getFeedbackStats = vi.fn(() =>
      Promise.resolve({
        latest: [
          {
            answer: '根据知识库，XXYY Pro 提供更多权益。',
            channel: 'web',
            citationCount: 2,
            comment: '没有讲清楚监控数量上限',
            createdAt: '2026-06-06T02:03:04.000Z',
            intent: 'product_qa',
            question: 'XXYY Pro 有哪些权益？',
            rating: 'negative',
            sessionId: 'session-1',
          },
        ],
        negativeCount: 1,
        positiveCount: 2,
        totalCount: 3,
      } satisfies FeedbackStats),
    );
    const end = vi.fn(() => Promise.resolve());

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgFeedbackStore: vi.fn(() => ({ getFeedbackStats })),
        createPgPool: vi.fn(() => ({ end })),
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
        })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(['feedback'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(getFeedbackStats).toHaveBeenCalledWith({ limit: 10 });
      expect(end).toHaveBeenCalledTimes(1);
      expect(stdout.join('')).toContain('Feedback stats:');
      expect(stdout.join('')).toContain('negative product_qa citations 2 web');
    } finally {
      vi.doUnmock('@xxyy/rag-core');
    }
  });

  it('prints filtered feedback stats as JSON for operations automation', async () => {
    vi.resetModules();

    const stdout: string[] = [];
    const getFeedbackStats = vi.fn(() =>
      Promise.resolve({
        latest: [
          {
            answer: '根据知识库，XXYY Pro 提供更多权益。',
            channel: 'web',
            citationCount: 2,
            comment: '没有讲清楚监控数量上限',
            createdAt: '2026-06-06T02:03:04.000Z',
            intent: 'product_qa',
            question: 'XXYY Pro 有哪些权益？',
            rating: 'negative',
            sessionId: 'session-1',
          },
        ],
        negativeCount: 1,
        positiveCount: 0,
        totalCount: 1,
      } satisfies FeedbackStats),
    );
    const end = vi.fn(() => Promise.resolve());

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgFeedbackStore: vi.fn(() => ({ getFeedbackStats })),
        createPgPool: vi.fn(() => ({ end })),
        loadRagConfig: vi.fn(() => ({
          answerProvider: 'openai',
          databaseUrl: 'postgres://example.test/db',
          openAiApiKey: 'test-key',
          openAiApiKeyPresent: true,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
        })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(
        ['feedback', '--rating', 'negative', '--limit', '25', '--json'],
        {
          cwd: process.cwd(),
          env: {},
          stderr: { write: () => true },
          stdout: {
            write: (message: string) => {
              stdout.push(message);
              return true;
            },
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(getFeedbackStats).toHaveBeenCalledWith({ limit: 25, rating: 'negative' });
      expect(JSON.parse(stdout.join(''))).toEqual(
        expect.objectContaining({
          latest: [expect.objectContaining({ rating: 'negative' })],
          negativeCount: 1,
          totalCount: 1,
        }),
      );
    } finally {
      vi.doUnmock('@xxyy/rag-core');
    }
  });
});
