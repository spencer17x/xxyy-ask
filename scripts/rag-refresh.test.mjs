import { describe, expect, it } from 'vitest';

import { createRagRefreshPlan, runRagRefresh } from './rag-refresh.mjs';

describe('createRagRefreshPlan', () => {
  it('refreshes sources and syncs X knowledge by default', () => {
    expect(createRagRefreshPlan([])).toEqual([
      {
        args: ['x:scrape'],
        command: 'pnpm',
        label: 'refresh X updates',
      },
      {
        args: ['rag:sync:x'],
        command: 'pnpm',
        label: 'sync X knowledge',
      },
    ]);
  });

  it('uses full X scraping and full ingestion for explicit full refreshes', () => {
    expect(createRagRefreshPlan(['--full'])).toEqual([
      {
        args: ['x:scrape', '--', '--full'],
        command: 'pnpm',
        label: 'refresh X updates',
      },
      {
        args: ['rag:ingest'],
        command: 'pnpm',
        label: 'ingest knowledge',
      },
    ]);
  });

  it('can skip source refreshes', () => {
    expect(createRagRefreshPlan(['--', '--skip-scrape', '--full'])).toEqual([
      {
        args: ['rag:ingest'],
        command: 'pnpm',
        label: 'ingest knowledge',
      },
    ]);
  });

  it('rejects removed refresh options', () => {
    expect(() => createRagRefreshPlan(['--feedback-limit', '50'])).toThrow(
      'Unknown option: --feedback-limit',
    );
    expect(() => createRagRefreshPlan(['--skip-approved-eval-gate'])).toThrow(
      'Unknown option: --skip-approved-eval-gate',
    );
  });
});

describe('runRagRefresh', () => {
  it('stops at the first failed command', async () => {
    const commands = [];
    const exitCode = await runRagRefresh({
      args: [],
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve(command.label === 'sync X knowledge' ? 1 : 0);
      },
    });

    expect(exitCode).toBe(1);
    expect(commands).toEqual(['refresh X updates', 'sync X knowledge']);
  });
});
