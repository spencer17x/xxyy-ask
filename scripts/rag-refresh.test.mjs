import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RAG_REFRESH_STALE_LOCK_MS,
  RAG_REFRESH_RECEIPT_VERSION,
  acquireRagRefreshLock,
  createRagRefreshPlan,
  executeRagRefresh,
  isRagRefreshLockStale,
  persistRagRefreshReceipt,
  releaseRagRefreshLock,
  runRagRefresh,
  runScheduledRagRefresh,
} from './rag-refresh.mjs';

const FIXED_NOW = new Date('2026-07-23T12:00:00.000Z');

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
      {
        args: ['rag:knowledge:automation:work', '--', '--limit', '20'],
        command: 'pnpm',
        label: 'automate governed knowledge',
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
      {
        args: ['rag:knowledge:automation:work', '--', '--limit', '20'],
        command: 'pnpm',
        label: 'automate governed knowledge',
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
      {
        args: ['rag:knowledge:automation:work', '--', '--limit', '20'],
        command: 'pnpm',
        label: 'automate governed knowledge',
      },
    ]);
  });

  it('accepts dry-run without changing the fixed command plan', () => {
    expect(createRagRefreshPlan(['--dry-run'])).toEqual(createRagRefreshPlan([]));
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

  it('returns a step-level failure receipt without retaining thrown error text', async () => {
    const receipt = await executeRagRefresh({
      args: [],
      log: () => {},
      now: () => FIXED_NOW,
      runCommand(command) {
        if (command.label === 'sync X knowledge') {
          throw new Error('provider endpoint and credential must not enter the receipt');
        }
        return Promise.resolve(0);
      },
      runId: 'knowledge_refresh_test_failure',
    });

    expect(receipt).toMatchObject({
      exitCode: 1,
      failedStep: 'sync X knowledge',
      mode: 'incremental',
      status: 'failed',
      version: RAG_REFRESH_RECEIPT_VERSION,
    });
    expect(receipt.steps).toHaveLength(2);
    expect(receipt.steps[1]).toMatchObject({
      failureKind: 'command_error',
      status: 'failed',
    });
    expect(JSON.stringify(receipt)).not.toContain('provider endpoint and credential');
  });

  it('plans without executing commands or writing a scheduled receipt in dry-run mode', async () => {
    let commandCalls = 0;
    const exitCode = await runScheduledRagRefresh({
      args: ['--dry-run', '--full'],
      log: () => {},
      runCommand() {
        commandCalls += 1;
        return Promise.resolve(0);
      },
      runId: 'knowledge_refresh_test_dry_run',
    });

    expect(exitCode).toBe(0);
    expect(commandCalls).toBe(0);
  });
});

describe('scheduled knowledge refresh state', () => {
  it('writes history/latest receipts atomically and releases the workspace lock', async () => {
    const cwd = await createTemporaryWorkspace();
    try {
      const runId = 'knowledge_refresh_test_success';
      const exitCode = await runScheduledRagRefresh({
        args: ['--skip-scrape'],
        cwd,
        log: () => {},
        now: () => FIXED_NOW,
        runCommand: () => Promise.resolve(0),
        runId,
      });
      const stateDirectory = path.join(cwd, '.rag/knowledge-refresh');
      const historyPath = path.join(stateDirectory, 'receipts', `${runId}.json`);
      const latestPath = path.join(stateDirectory, 'latest.json');
      const [history, latest] = await Promise.all([
        readFile(historyPath, 'utf8'),
        readFile(latestPath, 'utf8'),
      ]);
      const [historyDetails, latestDetails] = await Promise.all([
        stat(historyPath),
        stat(latestPath),
      ]);

      expect(exitCode).toBe(0);
      expect(latest).toBe(history);
      expect(historyDetails.mode & 0o777).toBe(0o600);
      expect(latestDetails.mode & 0o777).toBe(0o600);
      expect(JSON.parse(history)).toMatchObject({
        mode: 'incremental',
        runId,
        status: 'succeeded',
        steps: [
          { args: ['rag:sync:x'], command: 'pnpm' },
          {
            args: ['rag:knowledge:automation:work', '--', '--limit', '20'],
            command: 'pnpm',
          },
        ],
      });
      await expect(stat(path.join(stateDirectory, 'refresh.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });

  it('rejects an active same-host lock and safely recovers a dead-owner lock', async () => {
    const cwd = await createTemporaryWorkspace();
    try {
      const first = await acquireRagRefreshLock({
        cwd,
        hostname: 'worker-a',
        isProcessAlive: () => true,
        now: () => FIXED_NOW,
        pid: 101,
        runId: 'knowledge_refresh_first_lock',
      });
      expect((await stat(first.lockPath)).mode & 0o777).toBe(0o600);
      await expect(
        acquireRagRefreshLock({
          cwd,
          hostname: 'worker-a',
          isProcessAlive: () => true,
          now: () => FIXED_NOW,
          pid: 202,
          runId: 'knowledge_refresh_second_lock',
        }),
      ).rejects.toThrow('already running');

      const recovered = await acquireRagRefreshLock({
        cwd,
        hostname: 'worker-a',
        isProcessAlive: (pid) => pid !== 101,
        now: () => FIXED_NOW,
        pid: 202,
        runId: 'knowledge_refresh_recovered_lock',
      });
      await releaseRagRefreshLock(first);
      await expect(stat(recovered.lockPath)).resolves.toBeDefined();
      await releaseRagRefreshLock(recovered);
      await expect(stat(recovered.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });

  it('only treats a different-host lock as stale after the bounded age', () => {
    const metadata = {
      acquiredAt: '2026-07-23T00:00:00.000Z',
      hostname: 'worker-b',
      pid: 303,
      runId: 'knowledge_refresh_remote_lock',
      token: 'lock-token',
      version: RAG_REFRESH_RECEIPT_VERSION,
    };
    const common = {
      currentHostname: 'worker-a',
      isProcessAlive: () => {
        throw new Error('remote process state must not be guessed');
      },
      metadata,
      modifiedAt: new Date('2026-07-23T10:00:00.000Z'),
      staleLockMs: DEFAULT_RAG_REFRESH_STALE_LOCK_MS,
    };

    expect(isRagRefreshLockStale({ ...common, now: new Date('2026-07-23T11:00:00.000Z') })).toBe(
      false,
    );
    expect(isRagRefreshLockStale({ ...common, now: new Date('2026-07-23T17:00:00.000Z') })).toBe(
      true,
    );
  });

  it('drops unknown receipt fields and rejects non-allowlisted commands', async () => {
    const cwd = await createTemporaryWorkspace();
    try {
      const receipt = await executeRagRefresh({
        args: ['--dry-run'],
        log: () => {},
        now: () => FIXED_NOW,
        runId: 'knowledge_refresh_safe_receipt',
      });
      receipt.untrustedEnvironment = 'sensitive-value';
      receipt.steps[0].rawOutput = 'sensitive-value';
      const paths = await persistRagRefreshReceipt({ cwd, receipt });
      const persisted = await readFile(paths.historyPath, 'utf8');
      expect(persisted).not.toContain('sensitive-value');

      const unsafeReceipt = structuredClone(receipt);
      unsafeReceipt.steps[0].command = 'sh';
      await expect(persistRagRefreshReceipt({ cwd, receipt: unsafeReceipt })).rejects.toThrow(
        'non-allowlisted command',
      );

      const invalidTimelineReceipt = structuredClone(receipt);
      invalidTimelineReceipt.finishedAt = '2026-07-23T11:59:59.000Z';
      await expect(
        persistRagRefreshReceipt({ cwd, receipt: invalidTimelineReceipt }),
      ).rejects.toThrow('timeline is invalid');
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });
});

function createTemporaryWorkspace() {
  return mkdtemp(path.join(tmpdir(), 'xxyy-rag-refresh-'));
}
