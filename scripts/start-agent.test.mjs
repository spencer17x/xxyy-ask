import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  createAgentStartMode,
  runAgentStart,
  shouldIngestFromStatsOutput,
} from './start-agent.mjs';

describe('createAgentStartMode', () => {
  it('uses service-only mode in production', () => {
    expect(createAgentStartMode([], { NODE_ENV: 'production' })).toBe('service');
  });

  it('uses local bootstrap mode outside production', () => {
    expect(createAgentStartMode([], {})).toBe('local');
  });

  it('allows explicit mode overrides', () => {
    expect(createAgentStartMode(['--service'], {})).toBe('service');
    expect(createAgentStartMode(['--local'], { NODE_ENV: 'production' })).toBe('local');
    expect(createAgentStartMode([], { XXYY_START_MODE: 'service' })).toBe('service');
  });
});

describe('shouldIngestFromStatsOutput', () => {
  it('requests ingestion when stats fail or the knowledge base is empty', () => {
    expect(shouldIngestFromStatsOutput({ exitCode: 1, stdout: '' })).toBe(true);
    expect(
      shouldIngestFromStatsOutput({ exitCode: 0, stdout: 'Knowledge stats:\nChunks: 0\n' }),
    ).toBe(true);
  });

  it('skips ingestion when stats show existing chunks', () => {
    expect(
      shouldIngestFromStatsOutput({ exitCode: 0, stdout: 'Knowledge stats:\nChunks: 42\n' }),
    ).toBe(false);
  });
});

describe('runAgentStart', () => {
  it('checks incremental updates before serving in service mode', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service'],
      env: {},
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: 0,
          stdout: command.label === 'knowledge stats' ? 'Knowledge stats:\nChunks: 42\n' : '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      'knowledge stats',
      'refresh X updates',
      'sync X knowledge',
      'start API and Web',
    ]);
  });

  it('bootstraps local postgres and ingests an empty knowledge base before serving', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--local'],
      env: {
        POSTGRES_DB: 'xxyy_ask',
        POSTGRES_PASSWORD: 'secret',
        POSTGRES_USER: 'xxyy',
      },
      hasFile: (file) => file.endsWith('docker-compose.yml'),
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: 0,
          stdout: command.label === 'knowledge stats' ? 'Knowledge stats:\nChunks: 0\n' : '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      'start local postgres',
      'knowledge stats',
      'ingest knowledge',
      'refresh X updates',
      'sync X knowledge',
      'start API and Web',
    ]);
  });

  it('skips docker and ingestion when using an external populated database', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--local'],
      env: { DATABASE_URL: 'postgres://xxyy:secret@example.com:5432/xxyy_ask' },
      hasFile: () => true,
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: 0,
          stdout: command.label === 'knowledge stats' ? 'Knowledge stats:\nChunks: 42\n' : '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      'knowledge stats',
      'refresh X updates',
      'sync X knowledge',
      'start API and Web',
    ]);
  });

  it('ingests a missing production knowledge base before incremental sync', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service'],
      env: { DATABASE_URL: 'postgres://xxyy:secret@example.com:5432/xxyy_ask' },
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: command.label === 'knowledge stats' ? 1 : 0,
          stdout: '',
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      'knowledge stats',
      'ingest knowledge',
      'refresh X updates',
      'sync X knowledge',
      'start API and Web',
    ]);
  });

  it('does not start the service when incremental sync fails', async () => {
    const commands = [];
    const exitCode = await runAgentStart({
      args: ['--service'],
      env: { DATABASE_URL: 'postgres://xxyy:secret@example.com:5432/xxyy_ask' },
      log: () => {},
      runCommand(command) {
        commands.push(command.label);
        return Promise.resolve({
          exitCode: command.label === 'sync X knowledge' ? 1 : 0,
          stdout: command.label === 'knowledge stats' ? 'Knowledge stats:\nChunks: 42\n' : '',
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(commands).toEqual(['knowledge stats', 'refresh X updates', 'sync X knowledge']);
  });
});

describe('root package scripts', () => {
  it('exposes concise start and sync entrypoints', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

    expect(packageJson.scripts.start).toBe('node scripts/start-agent.mjs');
    expect(packageJson.scripts.sync).toBe('node scripts/rag-refresh.mjs');
  });
});
