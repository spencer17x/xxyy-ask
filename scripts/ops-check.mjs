import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const COMMANDS = {
  check: {
    args: ['check'],
    command: 'pnpm',
    label: 'workspace check',
  },
  fullRagEvaluation: {
    args: ['rag:evaluate'],
    command: 'pnpm',
    label: 'full RAG evaluation',
  },
  ragStats: {
    args: ['rag:stats'],
    command: 'pnpm',
    label: 'knowledge stats',
  },
  ragEvaluationFast: {
    args: ['rag:evaluate', '--', '--fast'],
    command: 'pnpm',
    label: 'fast RAG evaluation',
  },
};

export function createOpsCheckPlan(args) {
  const flags = new Set(args);
  const plan = [COMMANDS.check];

  if (flags.has('--rag')) {
    plan.push(COMMANDS.ragStats, COMMANDS.ragEvaluationFast);
  }

  if (flags.has('--full')) {
    plan.push(COMMANDS.fullRagEvaluation);
  }

  return plan.map((command) => ({
    args: [...command.args],
    command: command.command,
    label: command.label,
  }));
}

export async function runOpsCheck(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const runCommand = options.runCommand ?? runShellCommand;
  const plan = createOpsCheckPlan(args);

  for (const command of plan) {
    log(`\n==> ${command.label}`);
    log(`$ ${[command.command, ...command.args].join(' ')}`);
    const exitCode = await runCommand(command);
    if (exitCode !== 0) {
      log(`Command failed: ${command.label}`);
      return exitCode;
    }
  }

  log('\nOps check passed.');
  return 0;
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
  const exitCode = await runOpsCheck();
  process.exitCode = exitCode;
}
