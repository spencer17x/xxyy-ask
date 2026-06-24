#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const COMMANDS = {
  ingestKnowledge: {
    args: ['rag:ingest'],
    command: 'pnpm',
    label: 'ingest knowledge',
  },
  knowledgeStats: {
    args: ['rag:stats'],
    capture: true,
    command: 'pnpm',
    label: 'knowledge stats',
  },
  localPostgres: {
    args: ['compose', 'up', '-d', 'postgres'],
    command: 'docker',
    label: 'start local postgres',
  },
  refreshXUpdates: {
    args: ['x:scrape'],
    command: 'pnpm',
    label: 'refresh X updates',
  },
  startService: {
    args: ['--filter', '@xxyy/api', 'start'],
    command: 'pnpm',
    label: 'start API and Web',
  },
  syncXKnowledge: {
    args: ['rag:sync:x'],
    command: 'pnpm',
    label: 'sync X knowledge',
  },
};

export function createAgentStartMode(rawArgs, env) {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

  if (args.includes('--local') && args.includes('--service')) {
    throw new Error('Use either --local or --service, not both.');
  }
  if (args.includes('--local')) {
    return 'local';
  }
  if (args.includes('--service')) {
    return 'service';
  }

  const configuredMode = normalizeOptionalText(env.XXYY_START_MODE);
  if (configuredMode !== undefined) {
    if (configuredMode !== 'local' && configuredMode !== 'service') {
      throw new Error('XXYY_START_MODE must be local or service.');
    }
    return configuredMode;
  }

  return env.NODE_ENV === 'production' ? 'service' : 'local';
}

export function shouldIngestFromStatsOutput(result) {
  if (result.exitCode !== 0) {
    return true;
  }

  const chunkMatch = /^Chunks:\s*(\d+)\s*$/mu.exec(result.stdout);
  if (chunkMatch === null) {
    return false;
  }

  return Number(chunkMatch[1]) === 0;
}

export async function runAgentStart(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? createStartEnv(cwd, process.env);
  const hasFile =
    options.hasFile ?? ((file) => existsSync(path.resolve(cwd, file.replace(/^\/+/, ''))));
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const runCommand = options.runCommand ?? runShellCommand;
  const mode = createAgentStartMode(args, env);

  if (mode === 'local' && shouldStartLocalPostgres(env, hasFile)) {
    const postgresExitCode = await runLoggedCommand({
      command: COMMANDS.localPostgres,
      cwd,
      env,
      log,
      runCommand,
    });
    if (postgresExitCode !== 0) {
      return postgresExitCode;
    }
  }

  const prepareExitCode = await prepareKnowledgeBeforeServing({ cwd, env, log, runCommand });
  if (prepareExitCode !== 0) {
    return prepareExitCode;
  }

  return runLoggedCommand({
    command: COMMANDS.startService,
    cwd,
    env,
    log,
    runCommand,
  });
}

async function prepareKnowledgeBeforeServing({ cwd, env, log, runCommand }) {
  const statsResult = await runLoggedCommandWithOutput({
    command: COMMANDS.knowledgeStats,
    cwd,
    env,
    log,
    runCommand,
  });
  if (shouldIngestFromStatsOutput(statsResult)) {
    const ingestExitCode = await runLoggedCommand({
      command: COMMANDS.ingestKnowledge,
      cwd,
      env,
      log,
      runCommand,
    });
    if (ingestExitCode !== 0) {
      return ingestExitCode;
    }
  }

  const refreshExitCode = await runLoggedCommand({
    command: COMMANDS.refreshXUpdates,
    cwd,
    env,
    log,
    runCommand,
  });
  if (refreshExitCode !== 0) {
    log('Warning: refresh X updates failed; starting with existing knowledge.');
    return 0;
  }

  const syncExitCode = await runLoggedCommand({
    command: COMMANDS.syncXKnowledge,
    cwd,
    env,
    log,
    runCommand,
  });
  if (syncExitCode !== 0) {
    return syncExitCode;
  }

  return 0;
}

function createStartEnv(cwd, shellEnv) {
  return {
    ...loadDotEnv(path.join(cwd, '.env')),
    ...shellEnv,
  };
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const parsed = parseDotEnvLine(line);
    if (parsed !== undefined) {
      values[parsed.key] = parsed.value;
    }
  }
  return values;
}

function parseDotEnvLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) {
    return undefined;
  }

  const separator = trimmed.indexOf('=');
  if (separator <= 0) {
    return undefined;
  }

  const key = trimmed.slice(0, separator).trim();
  const rawValue = trimmed.slice(separator + 1).trim();
  return {
    key,
    value: stripOptionalQuotes(rawValue),
  };
}

function stripOptionalQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function shouldStartLocalPostgres(env, hasFile) {
  if (isTruthy(env.XXYY_SKIP_DOCKER) || normalizeOptionalText(env.DATABASE_URL) !== undefined) {
    return false;
  }

  return (
    hasFile('docker-compose.yml') &&
    normalizeOptionalText(env.POSTGRES_DB) !== undefined &&
    normalizeOptionalText(env.POSTGRES_PASSWORD) !== undefined &&
    normalizeOptionalText(env.POSTGRES_USER) !== undefined
  );
}

async function runLoggedCommand(options) {
  const result = await runLoggedCommandWithOutput(options);
  return result.exitCode;
}

async function runLoggedCommandWithOutput({ command, cwd, env, log, runCommand }) {
  log(`\n==> ${command.label}`);
  log(`$ ${[command.command, ...command.args].join(' ')}`);
  const result = await runCommand(command, { cwd, env });
  if (result.exitCode !== 0) {
    log(`Command failed: ${command.label}`);
  }
  return result;
}

function runShellCommand(command, options) {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: process.platform === 'win32',
      stdio: command.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';

    if (child.stdout !== null) {
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stdout += text;
        process.stdout.write(text);
      });
    }

    if (child.stderr !== null) {
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr += text;
        process.stderr.write(text);
      });
    }

    child.on('exit', (code) => {
      resolve({ exitCode: code ?? 1, stderr, stdout });
    });
  });
}

function normalizeOptionalText(value) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isTruthy(value) {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
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
    process.exitCode = await runAgentStart();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
