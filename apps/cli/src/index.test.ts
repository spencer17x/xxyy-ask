import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
  it('prints database configuration errors from pgvector mode', async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(['ask', 'XXYY Pro 有哪些权益？'], {
      cwd: process.cwd(),
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_MODEL: 'test-model',
        RAG_VECTOR_STORE: 'pgvector',
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
    expect(stderr.join('')).toContain('DATABASE_URL is required when RAG_VECTOR_STORE=pgvector');
  });
});
