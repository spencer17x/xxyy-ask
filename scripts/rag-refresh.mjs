#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const COMMANDS = {
  ingestKnowledge: {
    args: ['rag:ingest'],
    command: 'pnpm',
    label: 'ingest knowledge',
  },
  refreshXUpdates: (full) => ({
    args: full ? ['x:scrape', '--', '--full'] : ['x:scrape'],
    command: 'pnpm',
    label: 'refresh X updates',
  }),
  syncXKnowledge: {
    args: ['rag:sync:x'],
    command: 'pnpm',
    label: 'sync X knowledge',
  },
};

export function createRagRefreshPlan(args) {
  const options = parseRagRefreshArgs(args);
  const plan = [];

  if (!options.skipScrape) {
    plan.push(COMMANDS.refreshXUpdates(options.full));
  }

  plan.push(options.full ? COMMANDS.ingestKnowledge : COMMANDS.syncXKnowledge);

  return plan.map((command) => ({
    args: [...command.args],
    command: command.command,
    label: command.label,
  }));
}

export async function runRagRefresh(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const runCommand = options.runCommand ?? runShellCommand;
  const plan = createRagRefreshPlan(args);

  for (const command of plan) {
    log(`\n==> ${command.label}`);
    log(`$ ${[command.command, ...command.args].join(' ')}`);
    const exitCode = await runCommand(command);
    if (exitCode !== 0) {
      log(`Command failed: ${command.label}`);
      return exitCode;
    }
  }

  log('\nRAG refresh passed.');
  return 0;
}

function parseRagRefreshArgs(args) {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  let full = false;
  let skipScrape = false;

  for (const option of normalizedArgs) {
    if (option === '--full') {
      full = true;
      continue;
    }

    if (option === '--skip-scrape') {
      skipScrape = true;
      continue;
    }

    throw new Error(`Unknown option: ${option}`);
  }

  return { full, skipScrape };
}

function runShellCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

function isDirectRun() {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    const exitCode = await runRagRefresh();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
