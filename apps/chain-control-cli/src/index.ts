import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';
import { z } from 'zod';

import {
  ChainAnalysisControlStoreError,
  createEd25519ProductionProvisioningAuthorityAttestation,
  createEd25519ProductionProvisioningAuthorityVerifier,
  createPgEvmChainAnalysisGovernanceStore,
  createPgEvmChainAnalysisProductionProvisioningStore,
  createProductionProvisioningPlanFromRequest,
  migrateEvmChainAnalysisControlStore,
  productionProvisioningAuthorityAttestationSchema,
  productionProvisioningPlanRequestSchema,
  productionProvisioningPlanSchema,
  type ChainAnalysisControlAuditEvent,
  type PgControlClientLike,
  type ProductionProvisioningAuthorityVerifier,
  type ProductionProvisioningReceipt,
} from '@xxyy/evm-chain-analysis-control-store';

import { createPgControlClient } from './pg-control-client.js';
import {
  ChainControlCliError,
  loadChainControlAuthorityConfig,
  loadChainControlDatabaseUrl,
  type ChainControlCliEnv,
} from './runtime-config.js';
import {
  readControlledJson,
  readPrivateKeyFile,
  readPublicKeyFile,
  writeControlledJson,
} from './secure-files.js';

type ChainControlCommand =
  | { command: 'help' }
  | { command: 'migrate' }
  | { command: 'plan'; input: string; output: string }
  | {
      attestation: string;
      command: 'apply';
      output?: string;
      plan: string;
    }
  | {
      authoritySystemId: string;
      command: 'attest';
      output: string;
      plan: string;
      policyEvidenceHash: string;
      privateKey: string;
    }
  | { command: 'receipt'; output?: string; planId: string }
  | { attestation: string; command: 'verify'; output?: string; planId: string };

export interface ChainControlCliIo {
  env: ChainControlCliEnv;
  now(): Date;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
}

const HELP_TEXT = [
  'Usage:',
  '  pnpm chain:control:migrate',
  '  pnpm chain:provision:plan -- --input <request.json> --out <plan.json>',
  '  pnpm chain:provision:attest -- --plan <plan.json> --private-key <key.pem> --policy-evidence-hash <sha256:...> --authority-system-id <id> --out <attestation.json>',
  '  pnpm chain:provision:apply -- --plan <plan.json> --attestation <attestation.json> [--out <receipt.json>]',
  '  pnpm chain:provision:receipt -- --plan-id <production_provisioning_plan_...> [--out <receipt.json>]',
  '  pnpm chain:provision:verify -- --plan-id <production_provisioning_plan_...> --attestation <attestation.json> [--out <verification.json>]',
].join('\n');

const planIdSchema = z.string().regex(/^production_provisioning_plan_[0-9a-f]{64}$/u);

export function parseChainControlCliArgs(args: readonly string[]): ChainControlCommand {
  const [command, ...rest] = args;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    if (rest.length > 0) {
      throw new ChainControlCliError('invalid_command', 'Help does not accept arguments.');
    }
    return { command: 'help' };
  }
  if (command === 'migrate') {
    if (rest.length > 0) {
      throw new ChainControlCliError('invalid_command', 'Migrate does not accept arguments.');
    }
    return { command: 'migrate' };
  }
  if (command === 'plan') {
    const flags = parseValueFlags(rest, ['input', 'out']);
    return {
      command: 'plan',
      input: requiredFlag(flags, 'input'),
      output: requiredFlag(flags, 'out'),
    };
  }
  if (command === 'attest') {
    const flags = parseValueFlags(rest, [
      'authority-system-id',
      'out',
      'plan',
      'policy-evidence-hash',
      'private-key',
    ]);
    return {
      authoritySystemId: requiredFlag(flags, 'authority-system-id'),
      command: 'attest',
      output: requiredFlag(flags, 'out'),
      plan: requiredFlag(flags, 'plan'),
      policyEvidenceHash: requiredFlag(flags, 'policy-evidence-hash'),
      privateKey: requiredFlag(flags, 'private-key'),
    };
  }
  if (command === 'apply') {
    const flags = parseValueFlags(rest, ['attestation', 'out', 'plan']);
    return {
      attestation: requiredFlag(flags, 'attestation'),
      command: 'apply',
      ...(flags.get('out') === undefined ? {} : { output: flags.get('out')! }),
      plan: requiredFlag(flags, 'plan'),
    };
  }
  if (command === 'receipt') {
    const flags = parseValueFlags(rest, ['out', 'plan-id']);
    return {
      command: 'receipt',
      ...(flags.get('out') === undefined ? {} : { output: flags.get('out')! }),
      planId: planIdSchema.parse(requiredFlag(flags, 'plan-id')),
    };
  }
  if (command === 'verify') {
    const flags = parseValueFlags(rest, ['attestation', 'out', 'plan-id']);
    return {
      attestation: requiredFlag(flags, 'attestation'),
      command: 'verify',
      ...(flags.get('out') === undefined ? {} : { output: flags.get('out')! }),
      planId: planIdSchema.parse(requiredFlag(flags, 'plan-id')),
    };
  }
  throw new ChainControlCliError('invalid_command', 'Unknown chain-control command.');
}

export async function runChainControlCli(
  args: readonly string[],
  io: ChainControlCliIo = defaultIo(),
): Promise<number> {
  try {
    const command = parseChainControlCliArgs(args);
    await executeCommand(command, io);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
    return 1;
  }
}

async function executeCommand(command: ChainControlCommand, io: ChainControlCliIo): Promise<void> {
  if (command.command === 'help') {
    io.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (command.command === 'plan') {
    const request = productionProvisioningPlanRequestSchema.parse(
      await readControlledJson(command.input),
    );
    const plan = createProductionProvisioningPlanFromRequest(request);
    await writeControlledJson(command.output, plan);
    writeSummary(io, {
      command: 'plan',
      planFingerprint: plan.planFingerprint,
      planId: plan.planId,
    });
    return;
  }
  if (command.command === 'attest') {
    const plan = productionProvisioningPlanSchema.parse(await readControlledJson(command.plan));
    const privateKey = await readPrivateKeyFile(command.privateKey);
    const attestation = createEd25519ProductionProvisioningAuthorityAttestation({
      authoritySystemId: command.authoritySystemId,
      plan,
      policyEvidenceHash: command.policyEvidenceHash,
      privateKey,
      verifiedAt: io.now().toISOString(),
    });
    await writeControlledJson(command.output, attestation);
    writeSummary(io, {
      command: 'attest',
      planId: plan.planId,
      verificationFingerprint: attestation.verification.verificationFingerprint,
      verificationId: attestation.verification.verificationId,
    });
    return;
  }
  if (command.command === 'migrate') {
    await withControlPool(io.env, async (pool) => {
      await migrateEvmChainAnalysisControlStore(pool);
    });
    writeSummary(io, { command: 'migrate', status: 'completed' });
    return;
  }
  if (command.command === 'apply') {
    const plan = productionProvisioningPlanSchema.parse(await readControlledJson(command.plan));
    const attestation = productionProvisioningAuthorityAttestationSchema.parse(
      await readControlledJson(command.attestation),
    );
    const authority = loadChainControlAuthorityConfig(io.env);
    const publicKey = await readPublicKeyFile(authority.publicKeyFile);
    const verifier = createEd25519ProductionProvisioningAuthorityVerifier({
      attestation,
      expectedAuthoritySystemId: authority.expectedAuthoritySystemId,
      publicKey,
    });
    const receipt = await withControlPool(io.env, async (pool) => {
      const store = createPgEvmChainAnalysisProductionProvisioningStore({
        authorityVerifier: verifier,
        client: pool,
        clock: () => io.now(),
      });
      return store.apply({ plan, verification: attestation.verification });
    });
    if (command.output !== undefined) {
      await writeControlledJson(command.output, receipt);
    }
    writeSummary(io, {
      command: 'apply',
      planId: plan.planId,
      receiptFingerprint: receipt.receiptFingerprint,
      receiptId: receipt.receiptId,
      status: receipt.status,
    });
    return;
  }
  await withControlPool(io.env, async (pool) => {
    const store = createPgEvmChainAnalysisProductionProvisioningStore({
      authorityVerifier: rejectingReadonlyVerifier(),
      client: pool,
    });
    const receipt = await store.getReceipt(command.planId);
    if (receipt === undefined) {
      throw new ChainControlCliError('not_found', 'Production provisioning receipt was not found.');
    }
    if (command.command === 'receipt') {
      if (command.output !== undefined) {
        await writeControlledJson(command.output, receipt);
      }
      writeSummary(io, {
        command: 'receipt',
        planId: command.planId,
        receiptFingerprint: receipt.receiptFingerprint,
        receiptId: receipt.receiptId,
        status: receipt.status,
      });
      return;
    }
    const attestation = productionProvisioningAuthorityAttestationSchema.parse(
      await readControlledJson(command.attestation),
    );
    const authority = loadChainControlAuthorityConfig(io.env);
    const publicKey = await readPublicKeyFile(authority.publicKeyFile);
    try {
      const verifier = createEd25519ProductionProvisioningAuthorityVerifier({
        attestation,
        expectedAuthoritySystemId: authority.expectedAuthoritySystemId,
        publicKey,
      });
      await verifier.verify({
        plan: receipt.plan,
        verification: receipt.verification,
      });
    } catch (error) {
      throw new ChainControlCliError(
        'invalid_input',
        'Production provisioning receipt does not match the trusted authority attestation.',
        { cause: error },
      );
    }
    const audit = await createPgEvmChainAnalysisGovernanceStore({
      client: pool,
    }).readAudit('governance');
    const verification = verifyProvisioningAuditLineage(receipt, audit);
    if (command.output !== undefined) {
      await writeControlledJson(command.output, verification);
    }
    writeSummary(io, verification);
  });
}

function verifyProvisioningAuditLineage(
  receipt: ProductionProvisioningReceipt,
  audit: readonly ChainAnalysisControlAuditEvent[],
): Record<string, unknown> {
  const expected = [
    {
      entityFingerprint: receipt.approvalFingerprint,
      entityId: receipt.plan.approval.approvalId,
      eventKind: 'sampling_approval_recorded',
    },
    ...receipt.plan.authorizations.map((authorization) => ({
      entityFingerprint: authorization.authorizationFingerprint,
      entityId: authorization.authorizationId,
      eventKind: 'authorization_recorded',
    })),
    {
      entityFingerprint: receipt.receiptFingerprint,
      entityId: receipt.receiptId,
      eventKind: 'production_provisioning_recorded',
    },
  ] as const;
  for (const expectedEvent of expected) {
    const matches = audit.filter(
      (event) =>
        event.entityFingerprint === expectedEvent.entityFingerprint &&
        event.entityId === expectedEvent.entityId &&
        event.eventKind === expectedEvent.eventKind,
    );
    if (matches.length !== 1) {
      throw new ChainControlCliError(
        'invalid_input',
        'Production provisioning audit lineage is missing or ambiguous.',
      );
    }
  }
  const auditHead = audit.at(-1);
  if (auditHead === undefined) {
    throw new ChainControlCliError(
      'invalid_input',
      'Production provisioning audit chain is empty.',
    );
  }
  return {
    auditEventCount: audit.length,
    auditHeadFingerprint: auditHead.eventFingerprint,
    command: 'verify',
    planId: receipt.plan.planId,
    provisioningAuditEventCount: expected.length,
    receiptFingerprint: receipt.receiptFingerprint,
    receiptId: receipt.receiptId,
    verificationFingerprint: receipt.verification.verificationFingerprint,
    status: 'verified',
  };
}

async function withControlPool<T>(
  env: ChainControlCliEnv,
  operation: (client: PgControlClientLike) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    allowExitOnIdle: true,
    connectionString: loadChainControlDatabaseUrl(env),
    connectionTimeoutMillis: 10_000,
    max: 2,
    statement_timeout: 30_000,
  });
  try {
    return await operation(createPgControlClient(pool));
  } finally {
    await pool.end();
  }
}

function parseValueFlags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  const allowedFlags = new Set(allowed);
  for (let index = 0; index < args.length; index += 2) {
    const rawFlag = args[index];
    const value = args[index + 1];
    if (
      rawFlag === undefined ||
      !rawFlag.startsWith('--') ||
      rawFlag.includes('=') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new ChainControlCliError(
        'invalid_command',
        'Command flags must use --name <value> pairs.',
      );
    }
    const flag = rawFlag.slice(2);
    if (!allowedFlags.has(flag) || values.has(flag)) {
      throw new ChainControlCliError(
        'invalid_command',
        'Command contains an unknown or repeated flag.',
      );
    }
    values.set(flag, value);
  }
  return values;
}

function requiredFlag(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.trim().length === 0) {
    throw new ChainControlCliError('invalid_command', `--${flag} is required.`);
  }
  return value;
}

function rejectingReadonlyVerifier(): ProductionProvisioningAuthorityVerifier {
  return {
    async verify(): Promise<void> {
      await Promise.resolve();
      throw new Error('Read-only receipt access cannot apply provisioning.');
    },
  };
}

function writeSummary(io: ChainControlCliIo, summary: Record<string, unknown>): void {
  io.stdout.write(`${JSON.stringify(summary)}\n`);
}

function formatCliError(error: unknown): { code: string; message: string } {
  if (error instanceof ChainControlCliError || error instanceof ChainAnalysisControlStoreError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'invalid_input',
      message: 'Controlled input failed schema validation.',
    };
  }
  return {
    code: 'unexpected_error',
    message: 'Chain-control command failed without exposing sensitive details.',
  };
}

function defaultIo(): ChainControlCliIo {
  return {
    env: process.env,
    now: () => new Date(),
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runChainControlCli(process.argv.slice(2));
}
