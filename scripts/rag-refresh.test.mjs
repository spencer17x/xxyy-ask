import { describe, expect, it } from 'vitest';

import { createRagRefreshPlan, runRagRefresh } from './rag-refresh.mjs';

describe('createRagRefreshPlan', () => {
  it('refreshes sources, ingests knowledge, runs the RAG gate, and exports negative feedback', () => {
    expect(createRagRefreshPlan([])).toEqual([
      {
        args: ['x:scrape'],
        command: 'pnpm',
        label: 'refresh X updates',
      },
      {
        args: ['rag:ingest'],
        command: 'pnpm',
        label: 'ingest knowledge',
      },
      {
        args: ['ops:check:rag'],
        command: 'pnpm',
        label: 'RAG production gate',
      },
      {
        args: ['rag:feedback', '--', '--rating', 'negative', '--limit', '25', '--json'],
        command: 'pnpm',
        label: 'negative feedback triage queue',
      },
    ]);
  });

  it('supports full evaluation and source refresh overrides', () => {
    expect(createRagRefreshPlan(['--skip-scrape', '--full', '--feedback-limit', '50'])).toEqual([
      {
        args: ['rag:ingest'],
        command: 'pnpm',
        label: 'ingest knowledge',
      },
      {
        args: ['ops:check:full'],
        command: 'pnpm',
        label: 'full RAG production gate',
      },
      {
        args: ['rag:feedback', '--', '--rating', 'negative', '--limit', '50', '--json'],
        command: 'pnpm',
        label: 'negative feedback triage queue',
      },
    ]);
  });

  it('rejects invalid feedback limits', () => {
    expect(() => createRagRefreshPlan(['--feedback-limit', '0'])).toThrow(
      'Invalid --feedback-limit: 0',
    );
  });
});

describe('runRagRefresh', () => {
  it('stops at the first failed command', async () => {
    const commands = [];
    const exitCode = await runRagRefresh({
      args: ['--skip-scrape'],
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve(command.label === 'RAG production gate' ? 1 : 0);
      },
    });

    expect(exitCode).toBe(1);
    expect(commands).toEqual(['ingest knowledge', 'RAG production gate']);
  });
});
