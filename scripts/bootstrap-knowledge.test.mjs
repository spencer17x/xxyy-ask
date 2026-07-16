import { describe, expect, it } from 'vitest';

import { runKnowledgeBootstrap } from './bootstrap-knowledge.mjs';

describe('runKnowledgeBootstrap', () => {
  it('migrates and ingests an empty knowledge base', async () => {
    const commands = [];
    const exitCode = await runKnowledgeBootstrap({
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: 0,
          stdout: command.label === 'inspect knowledge' ? 'Chunks: 0\n' : '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual(['migrate database', 'inspect knowledge', 'ingest knowledge']);
  });

  it('skips embeddings when knowledge already exists', async () => {
    const commands = [];
    const exitCode = await runKnowledgeBootstrap({
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: 0,
          stdout: command.label === 'inspect knowledge' ? 'Chunks: 42\n' : '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual(['migrate database', 'inspect knowledge']);
  });

  it('stops when migration fails', async () => {
    const commands = [];
    const exitCode = await runKnowledgeBootstrap({
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({ exitCode: 1, stdout: '' });
      },
    });

    expect(exitCode).toBe(1);
    expect(commands).toEqual(['migrate database']);
  });

  it('does not ingest when knowledge inspection fails', async () => {
    const commands = [];
    const exitCode = await runKnowledgeBootstrap({
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: command.label === 'inspect knowledge' ? 1 : 0,
          stdout: '',
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(commands).toEqual(['migrate database', 'inspect knowledge']);
  });
});
