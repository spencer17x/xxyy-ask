import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { CreateCustomerAgentChatServiceOptions } from '@xxyy/agent-core';
import type { PreparedKnowledgeChunk } from '@xxyy/knowledge';
import type { EmbeddedKnowledgeChunk, KnowledgeStats } from '@xxyy/rag-core';
import type { SourceDocument } from '@xxyy/shared';

import {
  createDefaultCliIo,
  formatChatResponse,
  formatIngestSummary,
  formatKnowledgeStats,
  formatMigrationSummary,
  formatSyncXUpdatesSummary,
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

  it('parses retained commands that do not require extra arguments', () => {
    expect(parseCliArgs(['ingest'])).toEqual({ command: 'ingest' });
    expect(parseCliArgs(['migrate'])).toEqual({ command: 'migrate' });
    expect(parseCliArgs(['stats'])).toEqual({ command: 'stats' });
    expect(parseCliArgs(['sync:x'])).toEqual({ command: 'sync:x' });
  });

  it('rejects unknown commands', () => {
    expect(parseCliArgs(['unknown'])).toEqual({
      command: 'help',
      error: 'Unknown command: unknown',
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
  it('formats chat responses with readable citations and attachments', () => {
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
            url: '/assets/tx-analysis-browser-window.svg',
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
        '    /assets/tx-analysis-browser-window.svg',
      ].join('\n'),
    );
  });

  it('formats retained command summaries', () => {
    expect(
      formatIngestSummary({
        chunkCount: 64,
        documentCount: 12,
        indexPath: 'pgvector',
        runId: 'ingest_20260606T010203Z_abcd1234',
      }),
    ).toContain('Run ID: ingest_20260606T010203Z_abcd1234');
    expect(
      formatSyncXUpdatesSummary({
        changedChunkCount: 3,
        chunkCount: 8,
        documentCount: 2,
        indexPath: 'pgvector',
        skippedChunkCount: 5,
      }),
    ).toContain('Synced 3 changed X chunks (5 skipped).');
    expect(formatMigrationSummary()).toBe('Database migrations applied.');
  });

  it('formats knowledge stats for retained stats command', () => {
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
});

describe('runCli', () => {
  it('answers boundary questions before requiring vector configuration', async () => {
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

  it('creates the customer chat service without session, audit, feedback, or quality options', async () => {
    vi.resetModules();

    const stdout: string[] = [];
    const ask = vi.fn((request: unknown) => {
      expect(request).toEqual({
        channel: 'cli',
        message: 'XXYY Pro 怎么升级？',
      });
      return Promise.resolve({
        answer: 'trimmed runtime response',
        citations: [],
        confidence: 0.8,
        intent: 'how_to' as const,
      });
    });
    const createCustomerAgentChatService = vi.fn(
      (options: CreateCustomerAgentChatServiceOptions) => {
        expect(Object.keys(options).sort()).toEqual([
          'answerProvider',
          'config',
          'retriever',
          'txAnalysisProvider',
        ]);
        return {
          ask,
          stream: vi.fn(),
        };
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
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn() })),
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createConfiguredTxAnalysisProvider: vi.fn(() => undefined),
        createLazyRetriever: vi.fn(() => ({ retrieve: vi.fn() })),
        createPgPool: vi.fn(() => ({ end: vi.fn() })),
        createPgVectorStore: vi.fn(() => ({ retrieve: vi.fn() })),
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

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(['ask', 'XXYY Pro 怎么升级？'], {
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
      expect(createCustomerAgentChatService).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(stdout.join('')).toContain('trimmed runtime response');
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

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(['ingest'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: { write: () => true },
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual(['migrate', 'embed', 'replace', 'record', 'pool.end']);
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
    }
  });

  it('runs database migrations without generating embeddings', async () => {
    vi.resetModules();

    const events: string[] = [];
    const migrate = vi.fn(() => {
      events.push('rag:migrate');
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
          getStats: vi.fn(),
          migrate,
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
      expect(events).toEqual(['rag:migrate', 'pool.end']);
      expect(stdout.join('')).toContain('Database migrations applied.');
    } finally {
      vi.doUnmock('@xxyy/rag-core');
    }
  });

  it('prints pgvector knowledge stats', async () => {
    vi.resetModules();

    const stdout: string[] = [];
    const getStats = vi.fn(
      () =>
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
        }) satisfies Promise<KnowledgeStats>,
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
});
