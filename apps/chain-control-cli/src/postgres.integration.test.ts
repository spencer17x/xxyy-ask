import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { productionProvisioningReceiptSchema } from '@xxyy/evm-chain-analysis-control-store';

import { runChainControlCli, type ChainControlCliIo } from './index.js';

const databaseUrl = process.env.CHAIN_CONTROL_INTEGRATION_DATABASE_URL;
const integrationDescribe = databaseUrl === undefined ? describe.skip : describe;
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

integrationDescribe('chain-control CLI PostgreSQL integration', () => {
  it('migrates idempotently and atomically applies one approval, eight grants, and one receipt', async () => {
    if (databaseUrl === undefined) {
      throw new Error('CHAIN_CONTROL_INTEGRATION_DATABASE_URL is required.');
    }
    const directory = await temporaryDirectory();
    const requestFile = path.join(directory, 'request.json');
    const planFile = path.join(directory, 'plan.json');
    const attestationFile = path.join(directory, 'attestation.json');
    const receiptFile = path.join(directory, 'receipt.json');
    const readReceiptFile = path.join(directory, 'read-receipt.json');
    const verificationFile = path.join(directory, 'verification.json');
    const privateKeyFile = path.join(directory, 'authority-private.pem');
    const publicKeyFile = path.join(directory, 'authority-public.pem');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeFile(requestFile, JSON.stringify(provisioningRequest()), { mode: 0o600 });
    await writeFile(privateKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    });
    await writeFile(publicKeyFile, publicKey.export({ format: 'pem', type: 'spki' }), {
      mode: 0o644,
    });
    const databaseEnv = {
      CHAIN_CONTROL_DATABASE_URL: databaseUrl,
    };

    expect(await runChainControlCli(['migrate'], silentIo(databaseEnv))).toBe(0);
    expect(await runChainControlCli(['migrate'], silentIo(databaseEnv))).toBe(0);
    expect(
      await runChainControlCli(['plan', '--input', requestFile, '--out', planFile], silentIo({})),
    ).toBe(0);
    expect(
      await runChainControlCli(
        [
          'attest',
          '--plan',
          planFile,
          '--private-key',
          privateKeyFile,
          '--policy-evidence-hash',
          hash('integration-policy-evidence'),
          '--authority-system-id',
          'platform_policy_verifier',
          '--out',
          attestationFile,
        ],
        silentIo({}, '2026-07-24T00:30:00.000Z'),
      ),
    ).toBe(0);
    const authorityEnv = {
      ...databaseEnv,
      CHAIN_CONTROL_AUTHORITY_PUBLIC_KEY_FILE: publicKeyFile,
      CHAIN_CONTROL_AUTHORITY_SYSTEM_ID: 'platform_policy_verifier',
    };
    expect(
      await runChainControlCli(
        ['apply', '--plan', planFile, '--attestation', attestationFile, '--out', receiptFile],
        silentIo(authorityEnv, '2026-07-24T01:05:00.000Z'),
      ),
    ).toBe(0);
    expect(
      await runChainControlCli(
        ['apply', '--plan', planFile, '--attestation', attestationFile],
        silentIo(authorityEnv, '2026-07-25T01:05:00.000Z'),
      ),
    ).toBe(0);

    const receipt = productionProvisioningReceiptSchema.parse(
      JSON.parse(await readFile(receiptFile, 'utf8')),
    );
    expect(
      await runChainControlCli(
        ['receipt', '--plan-id', receipt.plan.planId, '--out', readReceiptFile],
        silentIo(databaseEnv),
      ),
    ).toBe(0);
    expect(
      productionProvisioningReceiptSchema.parse(
        JSON.parse(await readFile(readReceiptFile, 'utf8')),
      ),
    ).toEqual(receipt);
    expect(
      await runChainControlCli(
        [
          'verify',
          '--plan-id',
          receipt.plan.planId,
          '--attestation',
          attestationFile,
          '--out',
          verificationFile,
        ],
        silentIo(authorityEnv),
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(verificationFile, 'utf8'))).toMatchObject({
      planId: receipt.plan.planId,
      provisioningAuditEventCount: 10,
      receiptId: receipt.receiptId,
      status: 'verified',
    });

    const pool = new Pool({ allowExitOnIdle: true, connectionString: databaseUrl, max: 1 });
    try {
      const counts = await readProvisioningCounts(pool);
      expect(counts).toEqual({
        approvals: 1,
        auditEvents: 10,
        authorizations: 8,
        grantLineage: 8,
        receipts: 1,
      });
      await expect(
        pool.query(
          `
            update evm_chain_control_production_provisioning_receipts
            set plan_id = plan_id
            where receipt_id = $1
          `,
          [receipt.receiptId],
        ),
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  }, 30_000);
});

async function readProvisioningCounts(pool: Pool): Promise<{
  approvals: number;
  auditEvents: number;
  authorizations: number;
  grantLineage: number;
  receipts: number;
}> {
  const result = await pool.query<{
    approvals: string;
    audit_events: string;
    authorizations: string;
    grant_lineage: string;
    receipts: string;
  }>(`
    select
      (select count(*) from evm_chain_control_sampling_approvals) as approvals,
      (select count(*) from evm_chain_control_authorizations) as authorizations,
      (select count(*) from evm_chain_control_production_provisioning_receipts) as receipts,
      (select count(*) from evm_chain_control_provisioning_receipt_grants) as grant_lineage,
      (select count(*) from evm_chain_control_audit_events) as audit_events
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Provisioning count query returned no row.');
  }
  return {
    approvals: Number(row.approvals),
    auditEvents: Number(row.audit_events),
    authorizations: Number(row.authorizations),
    grantLineage: Number(row.grant_lineage),
    receipts: Number(row.receipts),
  };
}

function silentIo(
  env: ChainControlCliIo['env'],
  now = '2026-07-24T01:05:00.000Z',
): ChainControlCliIo {
  return {
    env,
    now: () => new Date(now),
    stderr: { write: () => true },
    stdout: { write: () => true },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'xxyy-chain-control-postgres-'));
  temporaryDirectories.push(directory);
  return directory;
}

function provisioningRequest(): Record<string, unknown> {
  const owner = hash('integration-owner');
  return {
    approval: {
      approvalName: 'production_mainnet_sources_v1',
      approvedAt: '2026-07-23T23:00:00.000Z',
      approvedByHashes: [owner],
      credentialsAllowed: false,
      legalReviewEvidenceHash: hash('integration-legal-review'),
      privateDataAllowed: false,
      publicChainDataOnly: true,
      retentionDays: 90,
      retentionPolicyId: 'public_chain_90d_v1',
      retentionReviewEvidenceHash: hash('integration-retention-review'),
      sourceApprovalEvidenceHashes: [
        hash('integration-explorer-review'),
        hash('integration-rpc-review'),
      ],
      sourceKinds: ['official_explorer_export', 'public_rpc'],
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: '2027-07-24T00:00:00.000Z',
    },
    authorizationValidUntil: '2027-01-24T00:00:00.000Z',
    identities: [
      identity('candidate_submitter', 'platform_service_account'),
      identity('governance_publisher', 'controlled_human_account', owner),
      identity('independent_reviewer', 'controlled_human_account', owner),
      identity('provider_operator', 'platform_service_account'),
      identity('readiness_attestor', 'controlled_human_account', owner),
      identity('retention_worker', 'platform_service_account'),
      identity('sampling_planner', 'controlled_human_account', owner),
      identity('sampling_worker', 'platform_service_account'),
    ],
    provisionedAt: '2026-07-24T01:00:00.000Z',
    provisionedByHash: owner,
  };
}

function identity(
  role: string,
  identityKind: 'controlled_human_account' | 'platform_service_account',
  owner?: string,
): Record<string, unknown> {
  return {
    identityEvidenceHash: hash(`integration-identity-evidence-${role}`),
    identityKind,
    ownerDomain:
      role === 'readiness_attestor'
        ? 'technical_owner'
        : identityKind === 'platform_service_account'
          ? 'platform_operations'
          : 'product_owner',
    principalIdHash: owner ?? hash(`integration-service-principal-${role}`),
    role,
  };
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
