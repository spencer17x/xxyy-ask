#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const COMMANDS = {
  fullRagGate: {
    args: ['ops:check:full'],
    command: 'pnpm',
    label: 'full RAG production gate',
  },
  ingestKnowledge: {
    args: ['rag:ingest'],
    command: 'pnpm',
    label: 'ingest knowledge',
  },
  negativeFeedbackQueue: (limit) => ({
    args: ['rag:feedback', '--', '--rating', 'negative', '--limit', String(limit), '--json'],
    command: 'pnpm',
    label: 'negative feedback triage queue',
  }),
  ragGate: {
    args: ['ops:check:rag'],
    command: 'pnpm',
    label: 'RAG production gate',
  },
  refreshXUpdates: {
    args: ['x:scrape'],
    command: 'pnpm',
    label: 'refresh X updates',
  },
};

export function createRagRefreshPlan(args) {
  const options = parseRagRefreshArgs(args);
  const plan = [];

  if (!options.skipScrape) {
    plan.push(COMMANDS.refreshXUpdates);
  }

  plan.push(
    COMMANDS.ingestKnowledge,
    options.full ? COMMANDS.fullRagGate : COMMANDS.ragGate,
    COMMANDS.negativeFeedbackQueue(options.feedbackLimit),
  );

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
  let feedbackLimit = 25;
  let full = false;
  let skipScrape = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];

    if (option === '--full') {
      full = true;
      continue;
    }

    if (option === '--skip-scrape') {
      skipScrape = true;
      continue;
    }

    if (option === '--feedback-limit') {
      const rawLimit = args[index + 1];
      if (rawLimit === undefined) {
        throw new Error('Missing value for --feedback-limit.');
      }
      const parsedLimit = Number(rawLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        throw new Error(`Invalid --feedback-limit: ${rawLimit}`);
      }
      feedbackLimit = parsedLimit;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${option}`);
  }

  return { feedbackLimit, full, skipScrape };
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
