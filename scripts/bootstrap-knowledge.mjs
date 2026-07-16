#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { shouldIngestFromStatsOutput } from './start-agent.mjs';

const COMMANDS = {
  ingest: { args: ['rag:ingest'], label: 'ingest knowledge' },
  migrate: { args: ['rag:migrate'], label: 'migrate database' },
  stats: { args: ['rag:stats'], capture: true, label: 'inspect knowledge' },
};

export async function runKnowledgeBootstrap(options = {}) {
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const runCommand = options.runCommand ?? runPnpmCommand;

  const migration = await runStep(COMMANDS.migrate, runCommand, log);
  if (migration.exitCode !== 0) {
    return migration.exitCode;
  }

  const stats = await runStep(COMMANDS.stats, runCommand, log);
  if (stats.exitCode !== 0) {
    return stats.exitCode;
  }

  if (!shouldIngestFromStatsOutput(stats)) {
    log('Knowledge base already contains chunks; skipping initial ingest.');
    return 0;
  }

  log('Knowledge base is empty; running initial ingest.');
  const ingestion = await runStep(COMMANDS.ingest, runCommand, log);
  return ingestion.exitCode;
}

async function runStep(command, runCommand, log) {
  log(`\n==> ${command.label}`);
  const result = await runCommand(command);
  if (result.exitCode !== 0) {
    log(`Command failed: ${command.label}`);
  }
  return result;
}

function runPnpmCommand(command) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', command.args, {
      env: process.env,
      stdio: command.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let stdout = '';

    if (child.stdout !== null) {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stdout += text;
        process.stdout.write(text);
      });
    }

    child.on('exit', (code) => {
      resolve({ exitCode: code ?? 1, stdout });
    });
  });
}

function isDirectRun() {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    process.exitCode = await runKnowledgeBootstrap();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
