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

  it('refreshes official docs and X before full ingestion', () => {
    expect(createRagRefreshPlan(['--full'])).toEqual([
      {
        args: ['docs:sync'],
        command: 'pnpm',
        label: 'refresh official docs',
      },
      {
        args: ['docs:sync:external'],
        command: 'pnpm',
        label: 'refresh external Agent Skill docs',
      },
      {
        args: ['docs:enrich:media'],
        command: 'pnpm',
        label: 'enrich documentation media',
      },
      {
        args: ['docs:audit'],
        command: 'pnpm',
        label: 'audit documentation coverage',
      },
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

  it('rejects unknown refresh options', () => {
    expect(() => createRagRefreshPlan(['--unknown-option'])).toThrow(
      'Unknown option: --unknown-option',
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
