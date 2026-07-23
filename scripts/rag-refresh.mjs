#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname as readHostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAG_REFRESH_RECEIPT_VERSION = 1;
export const DEFAULT_RAG_REFRESH_STALE_LOCK_MS = 6 * 60 * 60 * 1_000;
const RAG_REFRESH_STATE_DIRECTORY = '.rag/knowledge-refresh';

const COMMANDS = {
  ingestKnowledge: {
    args: ['rag:ingest'],
    command: 'pnpm',
    label: 'ingest knowledge',
  },
  refreshDocs: {
    args: ['docs:sync'],
    command: 'pnpm',
    label: 'refresh official docs',
  },
  enrichMedia: {
    args: ['docs:enrich:media'],
    command: 'pnpm',
    label: 'enrich documentation media',
  },
  auditDocs: {
    args: ['docs:audit'],
    command: 'pnpm',
    label: 'audit documentation coverage',
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

const ALLOWED_COMMANDS = [
  COMMANDS.ingestKnowledge,
  COMMANDS.refreshDocs,
  COMMANDS.enrichMedia,
  COMMANDS.auditDocs,
  COMMANDS.refreshXUpdates(false),
  COMMANDS.refreshXUpdates(true),
  COMMANDS.syncXKnowledge,
];

export function createRagRefreshPlan(args) {
  return createPlanFromOptions(parseRagRefreshArgs(args));
}

export function parseRagRefreshArgs(args) {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  let dryRun = false;
  let full = false;
  let skipScrape = false;

  for (const option of normalizedArgs) {
    if (option === '--dry-run') {
      dryRun = true;
      continue;
    }
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

  return {
    dryRun,
    full,
    mode: full ? 'full' : 'incremental',
    skipScrape,
  };
}

export async function executeRagRefresh(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const refreshOptions = parseRagRefreshArgs(args);
  const plan = createPlanFromOptions(refreshOptions);
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const now = options.now ?? (() => new Date());
  const runCommand =
    options.runCommand ?? ((command) => runShellCommand(command, options.cwd ?? process.cwd()));
  const runId = normalizeRunId(options.runId ?? `knowledge_refresh_${randomUUID()}`);
  const startedAt = readIsoTimestamp(now);
  const steps = [];
  log(`RAG refresh run: ${runId} (${refreshOptions.mode})`);

  if (refreshOptions.dryRun) {
    for (const command of plan) {
      log(`\n==> ${command.label} (planned)`);
      log(`$ ${[command.command, ...command.args].join(' ')}`);
      steps.push({
        args: [...command.args],
        command: command.command,
        exitCode: null,
        failureKind: null,
        finishedAt: null,
        label: command.label,
        startedAt: null,
        status: 'planned',
      });
    }
    const receipt = createReceipt({
      exitCode: 0,
      finishedAt: readIsoTimestamp(now),
      refreshOptions,
      runId,
      startedAt,
      status: 'planned',
      steps,
    });
    log('\nRAG refresh dry run passed; no commands were executed.');
    return receipt;
  }

  for (const command of plan) {
    log(`\n==> ${command.label}`);
    log(`$ ${[command.command, ...command.args].join(' ')}`);
    const stepStartedAt = readIsoTimestamp(now);
    let exitCode;
    let failureKind;
    try {
      const commandExitCode = await runCommand(command);
      if (isValidExitCode(commandExitCode)) {
        exitCode = commandExitCode;
        failureKind = exitCode === 0 ? null : 'nonzero_exit';
      } else {
        exitCode = 1;
        failureKind = 'command_error';
      }
    } catch {
      exitCode = 1;
      failureKind = 'command_error';
    }
    steps.push({
      args: [...command.args],
      command: command.command,
      exitCode,
      failureKind,
      finishedAt: readIsoTimestamp(now),
      label: command.label,
      startedAt: stepStartedAt,
      status: exitCode === 0 ? 'succeeded' : 'failed',
    });
    if (exitCode !== 0) {
      log(`Command failed: ${command.label}`);
      return createReceipt({
        exitCode,
        failedStep: command.label,
        finishedAt: readIsoTimestamp(now),
        refreshOptions,
        runId,
        startedAt,
        status: 'failed',
        steps,
      });
    }
  }

  log('\nRAG refresh passed.');
  return createReceipt({
    exitCode: 0,
    finishedAt: readIsoTimestamp(now),
    refreshOptions,
    runId,
    startedAt,
    status: 'succeeded',
    steps,
  });
}

export async function runRagRefresh(options = {}) {
  return (await executeRagRefresh(options)).exitCode;
}

export async function runScheduledRagRefresh(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const refreshOptions = parseRagRefreshArgs(args);
  if (refreshOptions.dryRun) {
    return runRagRefresh(options);
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const runId = normalizeRunId(options.runId ?? `knowledge_refresh_${randomUUID()}`);
  const lock = await acquireRagRefreshLock({
    cwd,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    runId,
    ...(options.staleLockMs === undefined ? {} : { staleLockMs: options.staleLockMs }),
  });
  try {
    const receipt = await executeRagRefresh({
      ...options,
      args,
      cwd,
      runId,
    });
    const receiptPaths = await persistRagRefreshReceipt({ cwd, receipt });
    const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
    log(`Refresh receipt: ${path.relative(cwd, receiptPaths.historyPath)}`);
    return receipt.exitCode;
  } finally {
    await releaseRagRefreshLock(lock);
  }
}

export async function acquireRagRefreshLock(options) {
  const cwd = path.resolve(options.cwd);
  const stateDirectory = path.join(cwd, RAG_REFRESH_STATE_DIRECTORY);
  const lockPath = path.join(stateDirectory, 'refresh.lock');
  const now = options.now ?? (() => new Date());
  const staleLockMs = normalizeStaleLockMs(options.staleLockMs);
  const acquiredAt = readIsoTimestamp(now);
  const metadata = {
    acquiredAt,
    hostname: options.hostname ?? readHostname(),
    pid: options.pid ?? process.pid,
    runId: normalizeRunId(options.runId),
    token: randomUUID(),
    version: RAG_REFRESH_RECEIPT_VERSION,
  };
  await mkdir(stateDirectory, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return { lockPath, token: metadata.token };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
      const existing = await readLockSnapshot(lockPath);
      if (existing === undefined) {
        continue;
      }
      if (
        !isRagRefreshLockStale({
          currentHostname: metadata.hostname,
          isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
          metadata: existing.metadata,
          modifiedAt: existing.modifiedAt,
          now: new Date(acquiredAt),
          staleLockMs,
        })
      ) {
        throw new Error('Knowledge refresh is already running in this workspace.', {
          cause: error,
        });
      }
      const confirmation = await readLockSnapshot(lockPath);
      if (confirmation === undefined || confirmation.content !== existing.content) {
        continue;
      }
      await unlink(lockPath).catch((unlinkError) => {
        if (!hasErrorCode(unlinkError, 'ENOENT')) {
          throw unlinkError;
        }
      });
    }
  }

  throw new Error('Knowledge refresh lock could not be acquired.');
}

export function isRagRefreshLockStale(options) {
  const ageMs = Math.max(0, options.now.getTime() - options.modifiedAt.getTime());
  const metadata = options.metadata;
  if (
    isLockMetadata(metadata) &&
    metadata.hostname === options.currentHostname &&
    Number.isSafeInteger(metadata.pid) &&
    metadata.pid > 0
  ) {
    return !options.isProcessAlive(metadata.pid);
  }
  return ageMs >= options.staleLockMs;
}

export async function releaseRagRefreshLock(lock) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(lock.lockPath, 'utf8'));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  if (!isLockMetadata(metadata) || metadata.token !== lock.token) {
    return;
  }
  await unlink(lock.lockPath).catch((error) => {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  });
}

export async function persistRagRefreshReceipt(options) {
  const cwd = path.resolve(options.cwd);
  const receipt = validateReceiptForPersistence(options.receipt);
  const stateDirectory = path.join(cwd, RAG_REFRESH_STATE_DIRECTORY);
  const receiptsDirectory = path.join(stateDirectory, 'receipts');
  const historyPath = path.join(receiptsDirectory, `${receipt.runId}.json`);
  const latestPath = path.join(stateDirectory, 'latest.json');
  await mkdir(receiptsDirectory, { recursive: true });
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeJsonAtomically(historyPath, content);
  await writeJsonAtomically(latestPath, content);
  return { historyPath, latestPath };
}

function createPlanFromOptions(options) {
  const plan = [];
  if (!options.skipScrape) {
    if (options.full) {
      plan.push(COMMANDS.refreshDocs, COMMANDS.enrichMedia, COMMANDS.auditDocs);
    }
    plan.push(COMMANDS.refreshXUpdates(options.full));
  }
  plan.push(options.full ? COMMANDS.ingestKnowledge : COMMANDS.syncXKnowledge);
  return plan.map((command) => ({
    args: [...command.args],
    command: command.command,
    label: command.label,
  }));
}

function createReceipt(input) {
  return {
    dryRun: input.refreshOptions.dryRun,
    exitCode: input.exitCode,
    ...(input.failedStep === undefined ? {} : { failedStep: input.failedStep }),
    finishedAt: input.finishedAt,
    mode: input.refreshOptions.mode,
    runId: input.runId,
    skipScrape: input.refreshOptions.skipScrape,
    startedAt: input.startedAt,
    status: input.status,
    steps: input.steps,
    version: RAG_REFRESH_RECEIPT_VERSION,
  };
}

function normalizeRunId(value) {
  const normalized = value.trim();
  if (!/^knowledge_refresh_[A-Za-z0-9_-]{8,100}$/u.test(normalized)) {
    throw new Error('Knowledge refresh run id is invalid.');
  }
  return normalized;
}

function normalizeStaleLockMs(value) {
  if (value === undefined) {
    return DEFAULT_RAG_REFRESH_STALE_LOCK_MS;
  }
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 24 * 60 * 60 * 1_000) {
    throw new Error('staleLockMs must be an integer between 60000 and 86400000.');
  }
  return value;
}

function readIsoTimestamp(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Knowledge refresh clock returned an invalid date.');
  }
  return value.toISOString();
}

async function readLockSnapshot(lockPath) {
  try {
    const [content, details] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
    let metadata;
    try {
      metadata = JSON.parse(content);
    } catch {
      metadata = undefined;
    }
    return { content, metadata, modifiedAt: details.mtime };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

function isLockMetadata(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.acquiredAt === 'string' &&
    typeof value.hostname === 'string' &&
    typeof value.pid === 'number' &&
    typeof value.runId === 'string' &&
    typeof value.token === 'string' &&
    value.version === RAG_REFRESH_RECEIPT_VERSION
  );
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

function validateReceiptForPersistence(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    value.version !== RAG_REFRESH_RECEIPT_VERSION ||
    typeof value.runId !== 'string' ||
    (value.mode !== 'incremental' && value.mode !== 'full') ||
    (value.status !== 'planned' && value.status !== 'succeeded' && value.status !== 'failed') ||
    !Array.isArray(value.steps)
  ) {
    throw new Error('Knowledge refresh receipt is invalid.');
  }
  const dryRun = value.dryRun === true;
  const exitCode = normalizeExitCode(value.exitCode);
  const finishedAt = normalizeTimestamp(value.finishedAt);
  const runId = normalizeRunId(value.runId);
  const startedAt = normalizeTimestamp(value.startedAt);
  const steps = value.steps.map(normalizeReceiptStep);
  const failedStep =
    typeof value.failedStep === 'string' &&
    ALLOWED_COMMANDS.some((command) => command.label === value.failedStep)
      ? value.failedStep
      : undefined;
  const expectedPlan = createPlanFromOptions({
    dryRun,
    full: value.mode === 'full',
    mode: value.mode,
    skipScrape: value.skipScrape === true,
  });
  if (
    steps.length > expectedPlan.length ||
    steps.some(
      (step, index) =>
        step.command !== expectedPlan[index]?.command ||
        step.label !== expectedPlan[index]?.label ||
        step.args.length !== expectedPlan[index]?.args.length ||
        step.args.some(
          (argument, argumentIndex) => argument !== expectedPlan[index]?.args[argumentIndex],
        ),
    )
  ) {
    throw new Error('Knowledge refresh receipt steps do not match the fixed plan.');
  }
  if (
    (value.status === 'planned' &&
      (!dryRun ||
        exitCode !== 0 ||
        failedStep !== undefined ||
        steps.length !== expectedPlan.length ||
        steps.some((step) => step.status !== 'planned'))) ||
    (value.status === 'succeeded' &&
      (dryRun ||
        exitCode !== 0 ||
        failedStep !== undefined ||
        steps.length !== expectedPlan.length ||
        steps.some((step) => step.status !== 'succeeded'))) ||
    (value.status === 'failed' &&
      (dryRun ||
        exitCode === 0 ||
        steps.length === 0 ||
        steps.slice(0, -1).some((step) => step.status !== 'succeeded') ||
        steps.at(-1)?.status !== 'failed' ||
        failedStep !== steps.at(-1)?.label))
  ) {
    throw new Error('Knowledge refresh receipt status does not match its execution steps.');
  }
  let timelineCursor = Date.parse(startedAt);
  if (Date.parse(finishedAt) < timelineCursor) {
    throw new Error('Knowledge refresh receipt timeline is invalid.');
  }
  for (const step of steps) {
    if (step.startedAt === null || step.finishedAt === null) {
      continue;
    }
    const stepStartedAt = Date.parse(step.startedAt);
    const stepFinishedAt = Date.parse(step.finishedAt);
    if (
      stepStartedAt < timelineCursor ||
      stepFinishedAt < stepStartedAt ||
      stepFinishedAt > Date.parse(finishedAt)
    ) {
      throw new Error('Knowledge refresh receipt step timeline is invalid.');
    }
    timelineCursor = stepFinishedAt;
  }
  return {
    dryRun,
    exitCode,
    ...(failedStep === undefined ? {} : { failedStep }),
    finishedAt,
    mode: value.mode,
    runId,
    skipScrape: value.skipScrape === true,
    startedAt,
    status: value.status,
    steps,
    version: RAG_REFRESH_RECEIPT_VERSION,
  };
}

function normalizeReceiptStep(value) {
  if (typeof value !== 'object' || value === null || !Array.isArray(value.args)) {
    throw new Error('Knowledge refresh receipt step is invalid.');
  }
  const command = ALLOWED_COMMANDS.find(
    (allowed) =>
      value.command === allowed.command &&
      value.label === allowed.label &&
      value.args.length === allowed.args.length &&
      value.args.every((argument, index) => argument === allowed.args[index]),
  );
  if (command === undefined) {
    throw new Error('Knowledge refresh receipt contains a non-allowlisted command.');
  }
  if (value.status !== 'planned' && value.status !== 'succeeded' && value.status !== 'failed') {
    throw new Error('Knowledge refresh receipt step status is invalid.');
  }
  const planned = value.status === 'planned';
  const failureKind =
    value.failureKind === null ||
    value.failureKind === 'nonzero_exit' ||
    value.failureKind === 'command_error'
      ? value.failureKind
      : null;
  const exitCode = planned ? null : normalizeExitCode(value.exitCode);
  if (
    (planned && failureKind !== null) ||
    (value.status === 'succeeded' && (exitCode !== 0 || failureKind !== null)) ||
    (value.status === 'failed' && (exitCode === 0 || failureKind === null))
  ) {
    throw new Error('Knowledge refresh receipt step result is inconsistent.');
  }
  return {
    args: [...command.args],
    command: command.command,
    exitCode,
    failureKind,
    finishedAt: planned ? null : normalizeTimestamp(value.finishedAt),
    label: command.label,
    startedAt: planned ? null : normalizeTimestamp(value.startedAt),
    status: value.status,
  };
}

function normalizeExitCode(value) {
  if (!isValidExitCode(value)) {
    throw new Error('Knowledge refresh exit code is invalid.');
  }
  return value;
}

function isValidExitCode(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255;
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Knowledge refresh timestamp is invalid.');
  }
  return new Date(value).toISOString();
}

async function writeJsonAtomically(file, content) {
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryFile, file);
  } catch (error) {
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
}

function hasErrorCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function runShellCommand(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    child.on('error', () => resolve(1));
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
    const exitCode = await runScheduledRagRefresh();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
