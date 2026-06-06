import { describe, expect, it } from 'vitest';

import { createOpsCheckPlan, runOpsCheck } from './ops-check.mjs';

describe('createOpsCheckPlan', () => {
  it('runs the repository check by default', () => {
    expect(createOpsCheckPlan([])).toEqual([
      {
        args: ['check'],
        command: 'pnpm',
        label: 'workspace check',
      },
    ]);
  });

  it('adds RAG production checks when requested', () => {
    expect(createOpsCheckPlan(['--rag'])).toEqual([
      {
        args: ['check'],
        command: 'pnpm',
        label: 'workspace check',
      },
      {
        args: ['rag:stats'],
        command: 'pnpm',
        label: 'knowledge stats',
      },
      {
        args: ['rag:evaluate', '--', '--fast'],
        command: 'pnpm',
        label: 'fast RAG evaluation',
      },
    ]);
  });

  it('adds full LLM evaluation only for the full gate', () => {
    expect(createOpsCheckPlan(['--rag', '--full'])).toEqual([
      {
        args: ['check'],
        command: 'pnpm',
        label: 'workspace check',
      },
      {
        args: ['rag:stats'],
        command: 'pnpm',
        label: 'knowledge stats',
      },
      {
        args: ['rag:evaluate', '--', '--fast'],
        command: 'pnpm',
        label: 'fast RAG evaluation',
      },
      {
        args: ['rag:evaluate'],
        command: 'pnpm',
        label: 'full RAG evaluation',
      },
    ]);
  });
});

describe('runOpsCheck', () => {
  it('stops at the first failed command', async () => {
    const commands = [];
    const exitCode = await runOpsCheck({
      args: ['--rag'],
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve(command.label === 'knowledge stats' ? 1 : 0);
      },
    });

    expect(exitCode).toBe(1);
    expect(commands).toEqual(['workspace check', 'knowledge stats']);
  });
});
