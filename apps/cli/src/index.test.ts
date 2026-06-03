import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PreparedKnowledgeChunk } from '@xxyy/knowledge';
import type { SourceDocument } from '@xxyy/shared';

import {
  formatChatResponse,
  formatEvaluationReport,
  formatIngestSummary,
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
    expect(parseCliArgs(['evaluate'])).toEqual({ command: 'evaluate' });
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

describe('CLI output formatting', () => {
  it('formats chat responses with readable citations', () => {
    expect(
      formatChatResponse({
        answer: '根据知识库，XXYY Pro 提供更多权益。',
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
            minCitations: 1,
            name: 'pro benefits',
            passed: true,
          },
          {
            actualIntent: 'unknown',
            citationCount: 0,
            expectedIntent: 'how_to',
            minCitations: 1,
            name: 'telegram setup',
            passed: false,
          },
        ],
      }),
    ).toContain('Evaluation: 1/2 passed');
  });

  it('formats pgvector ingest summaries', () => {
    expect(
      formatIngestSummary({
        chunkCount: 491,
        documentCount: 65,
        indexPath: 'pgvector',
      }),
    ).toContain('Saved index: pgvector');
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

  it('migrates pgvector storage before embedding prepared chunks', async () => {
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
    const upsertChunks = vi.fn(() => {
      events.push('upsert');
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
          migrate,
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

      const exitCode = await runCliWithMocks(['ingest'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: { write: () => true },
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual(['migrate', 'embed', 'upsert', 'pool.end']);
    } finally {
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
  });
});
