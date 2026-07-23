import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';
import { z } from 'zod';

import {
  ChainAnalysisControlStoreError,
  createPgEvmChainAnalysisGovernanceStore,
  createPgEvmChainAnalysisProviderControlStore,
} from '@xxyy/evm-chain-analysis-control-store';
import {
  bootstrapProductionProviderControls,
  createMemoryProviderResponseCache,
  createProductionChainDataPlane,
  ProductionDataPlaneError,
  productionDataPlaneManifestSchema,
  resolveProductionProviders,
  type ProductionDataPlaneAlert,
  type ProductionDataPlaneMetric,
  type ProductionDataPlaneManifest,
  type ResolvedProductionProvider,
} from '@xxyy/evm-chain-analysis-data-plane';
import { evmHashSchema } from '@xxyy/transaction-analysis-core';

import { createPgControlClient } from './pg-control-client.js';
import {
  ChainOperationsCliError,
  loadChainOperationsRuntimeConfig,
  type ChainOperationsEnv,
  type ChainOperationsRuntimeConfig,
} from './runtime-config.js';
import { createMountedSecretResolver, readControlledManifest } from './secure-files.js';

type ChainOperationsCommand =
  | { command: 'bootstrap' }
  | { command: 'help' }
  | { command: 'probe_snapshot'; transactionHash: string }
  | { command: 'validate' }
  | { command: 'worker_reconcile' }
  | { command: 'worker_retention' };

export interface ChainOperationsCliIo {
  env: ChainOperationsEnv;
  now(): Date;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
}

const HELP_TEXT = [
  'Usage:',
  '  pnpm chain:ops:validate',
  '  pnpm chain:ops:bootstrap',
  '  pnpm chain:ops:probe -- --transaction-hash <0x...>',
  '  pnpm chain:worker:reconcile',
  '  pnpm chain:worker:retention',
].join('\n');

export function parseChainOperationsArgs(args: readonly string[]): ChainOperationsCommand {
  const [command, ...rawRest] = args;
  const rest = rawRest[0] === '--' ? rawRest.slice(1) : rawRest;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    if (rest.length > 0) {
      throw new ChainOperationsCliError('invalid_command', 'Help does not accept arguments.');
    }
    return { command: 'help' };
  }
  if (command === 'validate' || command === 'bootstrap') {
    if (rest.length > 0) {
      throw new ChainOperationsCliError('invalid_command', `${command} does not accept arguments.`);
    }
    return { command };
  }
  if (command === 'probe:snapshot') {
    const flags = parseValueFlags(rest, ['transaction-hash']);
    return {
      command: 'probe_snapshot',
      transactionHash: evmHashSchema.parse(requiredFlag(flags, 'transaction-hash')),
    };
  }
  if (command === 'worker:reconcile' || command === 'worker:retention') {
    if (rest.length > 0) {
      throw new ChainOperationsCliError('invalid_command', `${command} does not accept arguments.`);
    }
    return {
      command: command === 'worker:reconcile' ? 'worker_reconcile' : 'worker_retention',
    };
  }
  throw new ChainOperationsCliError('invalid_command', 'Unknown chain-operations command.');
}

export async function runChainOperationsCli(
  args: readonly string[],
  io: ChainOperationsCliIo = defaultIo(),
): Promise<number> {
  try {
    const command = parseChainOperationsArgs(args);
    if (command.command === 'help') {
      io.stdout.write(`${HELP_TEXT}\n`);
      return 0;
    }
    const config = loadChainOperationsRuntimeConfig(io.env);
    const runtime = await loadDataPlaneRuntime(config);
    if (command.command === 'validate') {
      writeOutput(io, {
        chainId: runtime.manifest.chainId,
        command: 'validate',
        providerCount: runtime.providers.length,
        providers: runtime.providers.map((provider) => ({
          adapter: provider.adapter,
          providerId: provider.binding.descriptor.providerId,
        })),
        status: 'valid',
        version: runtime.manifest.version,
      });
      return 0;
    }
    await withControlPool(config, async (pool) => {
      const providerStore = createPgEvmChainAnalysisProviderControlStore({
        client: pool,
        coordinatorInstanceIdHash: config.instanceIdHash,
        now: () => io.now().toISOString(),
      });
      if (command.command === 'bootstrap') {
        await bootstrapProductionProviderControls({
          actorIdHash: config.instanceIdHash,
          bootstrappedAt: io.now().toISOString(),
          controls: providerStore,
          manifest: runtime.manifest,
        });
        writeOutput(io, {
          command: 'bootstrap',
          initializedProviders: runtime.providers.length,
          status: 'completed',
        });
        return;
      }
      if (command.command === 'worker_reconcile') {
        const settlements = await providerStore.reconcileExpiredLeases({
          asOf: io.now().toISOString(),
          workerIdHash: config.reconciliationWorkerIdHash,
        });
        writeOutput(io, {
          command: 'worker:reconcile',
          reconciledLeases: settlements.length,
          status: 'completed',
        });
        return;
      }
      if (command.command === 'worker_retention') {
        const governance = createPgEvmChainAnalysisGovernanceStore({ client: pool });
        const job = await governance.claimRetentionJob({
          asOf: io.now().toISOString(),
          workerIdHash: config.retentionWorkerIdHash,
        });
        if (job === undefined) {
          writeOutput(io, { command: 'worker:retention', status: 'idle' });
          return;
        }
        const completed = await governance.completeRetentionJob({
          completedAt: io.now().toISOString(),
          jobId: job.jobId,
          workerIdHash: config.retentionWorkerIdHash,
        });
        writeOutput(io, {
          command: 'worker:retention',
          jobId: completed.jobId,
          outcome: completed.outcome,
          status: completed.status,
        });
        return;
      }
      const dataPlane = createProductionChainDataPlane({
        alertSink: (alert) => writeOperational(io, 'alert', alert),
        allowInsecureLocalhost: config.allowInsecureLocalhost,
        cache: createMemoryProviderResponseCache({
          maxEntries: 512,
          maxTotalBytes: 64 * 1024 * 1024,
        }),
        controls: providerStore,
        instanceIdHash: config.instanceIdHash,
        manifest: runtime.manifest,
        metricSink: (metric) => writeOperational(io, 'metric', metric),
        now: () => io.now().toISOString(),
        nowMs: () => io.now().getTime(),
        providers: runtime.providers,
      });
      const result = await dataPlane.snapshot.loadTransactionSnapshot({
        chainId: runtime.manifest.chainId,
        transactionHash: command.transactionHash,
      });
      writeOutput(io, {
        command: 'probe:snapshot',
        result,
        status: 'completed',
      });
    });
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify(formatError(error))}\n`);
    return 1;
  }
}

async function loadDataPlaneRuntime(config: ChainOperationsRuntimeConfig): Promise<{
  manifest: ProductionDataPlaneManifest;
  providers: ResolvedProductionProvider[];
}> {
  const manifest = productionDataPlaneManifestSchema.parse(
    await readControlledManifest(config.manifestFile),
  );
  return resolveProductionProviders(manifest, createMountedSecretResolver(config.secretDirectory), {
    allowInsecureLocalhost: config.allowInsecureLocalhost,
  });
}

async function withControlPool<T>(
  config: ChainOperationsRuntimeConfig,
  operation: (pool: ReturnType<typeof createPgControlClient>) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString: config.controlDatabaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 4,
  });
  try {
    return await operation(createPgControlClient(pool));
  } finally {
    await pool.end();
  }
}

function parseValueFlags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  const allowedSet = new Set(allowed);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith('--') ||
      value.startsWith('--')
    ) {
      throw new ChainOperationsCliError(
        'invalid_command',
        'Command flags require explicit values.',
      );
    }
    const name = flag.slice(2);
    if (!allowedSet.has(name) || result.has(name)) {
      throw new ChainOperationsCliError(
        'invalid_command',
        'Command contains an unknown or duplicate flag.',
      );
    }
    result.set(name, value);
  }
  return result;
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new ChainOperationsCliError('invalid_command', `Command requires --${name}.`);
  }
  return value;
}

function writeOutput(io: ChainOperationsCliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeOperational(
  io: ChainOperationsCliIo,
  kind: 'alert' | 'metric',
  value: ProductionDataPlaneAlert | ProductionDataPlaneMetric,
): void {
  io.stderr.write(`${JSON.stringify({ kind, ...value })}\n`);
}

function formatError(error: unknown): { code: string; message: string } {
  if (error instanceof ChainOperationsCliError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (
    error instanceof ChainAnalysisControlStoreError ||
    error instanceof ProductionDataPlaneError
  ) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'invalid_input',
      message: 'Chain operations input failed validation.',
    };
  }
  return {
    code: 'operation_failed',
    message: 'Chain operations failed without exposing provider or database details.',
  };
}

function defaultIo(): ChainOperationsCliIo {
  return {
    env: process.env,
    now: () => new Date(),
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  process.exitCode = await runChainOperationsCli(process.argv.slice(2));
}
