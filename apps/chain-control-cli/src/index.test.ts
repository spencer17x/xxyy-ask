import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  productionProvisioningAuthorityAttestationSchema,
  productionProvisioningPlanSchema,
} from '@xxyy/evm-chain-analysis-control-store';

import { parseChainControlCliArgs, runChainControlCli } from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('chain-control CLI', () => {
  it('creates a content-addressed plan and signed authority attestation', async () => {
    const directory = await temporaryDirectory();
    const requestFile = path.join(directory, 'request.json');
    const planFile = path.join(directory, 'plan.json');
    const attestationFile = path.join(directory, 'attestation.json');
    const privateKeyFile = path.join(directory, 'authority-private.pem');
    const { privateKey } = generateKeyPairSync('ed25519');
    await writeFile(requestFile, JSON.stringify(provisioningRequest()), { mode: 0o600 });
    await writeFile(privateKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    });
    const planIo = bufferedIo();

    await expect(
      runChainControlCli(['plan', '--input', requestFile, '--out', planFile], planIo.io),
    ).resolves.toBe(0);
    const plan = productionProvisioningPlanSchema.parse(
      JSON.parse(await readFile(planFile, 'utf8')),
    );
    expect(plan.governanceProfile.mode).toBe('single_owner');
    expect(plan.authorizations).toHaveLength(8);
    expect(planIo.stdout()).not.toContain('principalIdHash');

    const attestIo = bufferedIo();
    await expect(
      runChainControlCli(
        [
          'attest',
          '--plan',
          planFile,
          '--private-key',
          privateKeyFile,
          '--policy-evidence-hash',
          hash('policy-evidence'),
          '--authority-system-id',
          'platform_policy_verifier',
          '--out',
          attestationFile,
        ],
        attestIo.io,
      ),
    ).resolves.toBe(0);
    const attestation = productionProvisioningAuthorityAttestationSchema.parse(
      JSON.parse(await readFile(attestationFile, 'utf8')),
    );
    expect(attestation.verification.planFingerprint).toBe(plan.planFingerprint);
    expect(JSON.stringify(attestation)).not.toContain('PRIVATE KEY');
    expect(attestIo.stderr()).toBe('');
  });

  it('rejects permissive private-key files and never overwrites outputs', async () => {
    const directory = await temporaryDirectory();
    const requestFile = path.join(directory, 'request.json');
    const planFile = path.join(directory, 'plan.json');
    const attestationFile = path.join(directory, 'attestation.json');
    const privateKeyFile = path.join(directory, 'authority-private.pem');
    const { privateKey } = generateKeyPairSync('ed25519');
    await writeFile(requestFile, JSON.stringify(provisioningRequest()), { mode: 0o600 });
    await writeFile(privateKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    });
    await expect(
      runChainControlCli(['plan', '--input', requestFile, '--out', planFile], bufferedIo().io),
    ).resolves.toBe(0);
    await chmod(privateKeyFile, 0o644);
    const insecureKeyIo = bufferedIo();

    await expect(
      runChainControlCli(
        [
          'attest',
          '--plan',
          planFile,
          '--private-key',
          privateKeyFile,
          '--policy-evidence-hash',
          hash('policy-evidence'),
          '--authority-system-id',
          'platform_policy_verifier',
          '--out',
          attestationFile,
        ],
        insecureKeyIo.io,
      ),
    ).resolves.toBe(1);
    expect(insecureKeyIo.stderr()).toContain('must not be accessible');

    const overwriteIo = bufferedIo();
    await expect(
      runChainControlCli(['plan', '--input', requestFile, '--out', planFile], overwriteIo.io),
    ).resolves.toBe(1);
    expect(overwriteIo.stderr()).toContain('never overwritten');
  });

  it('does not follow symbolic links for controlled inputs', async () => {
    const directory = await temporaryDirectory();
    const requestFile = path.join(directory, 'request.json');
    const requestLink = path.join(directory, 'request-link.json');
    const planFile = path.join(directory, 'plan.json');
    await writeFile(requestFile, JSON.stringify(provisioningRequest()), { mode: 0o600 });
    await symlink(requestFile, requestLink);
    const io = bufferedIo();

    await expect(
      runChainControlCli(['plan', '--input', requestLink, '--out', planFile], io.io),
    ).resolves.toBe(1);
    expect(io.stderr()).toContain('Could not read the controlled input file');
  });

  it('rejects unknown, repeated, or malformed flags', () => {
    expect(parseChainControlCliArgs(['plan', '--', '--input', 'a', '--out', 'b'])).toEqual({
      command: 'plan',
      input: 'a',
      output: 'b',
    });
    expect(() => parseChainControlCliArgs(['plan', '--input', 'a'])).toThrow(/--out/u);
    expect(() =>
      parseChainControlCliArgs(['plan', '--input', 'a', '--input', 'b', '--out', 'c']),
    ).toThrow(/unknown or repeated/u);
    expect(() => parseChainControlCliArgs(['migrate', '--force'])).toThrow(/does not accept/u);
    expect(() =>
      parseChainControlCliArgs([
        'verify',
        '--plan-id',
        `production_provisioning_plan_${'a'.repeat(64)}`,
      ]),
    ).toThrow(/--attestation/u);
    expect(() =>
      parseChainControlCliArgs([
        'attest',
        '--plan',
        'plan.json',
        '--private-key',
        'key.pem',
        '--policy-evidence-hash',
        hash('policy'),
        '--authority-system-id',
        'authority',
        '--out',
        'attestation.json',
        '--verified-at',
        '2099-01-01T00:00:00Z',
      ]),
    ).toThrow(/unknown or repeated/u);
  });
});

function bufferedIo(): {
  io: Parameters<typeof runChainControlCli>[1];
  stderr(): string;
  stdout(): string;
} {
  let stderr = '';
  let stdout = '';
  return {
    io: {
      env: {},
      now: () => new Date('2026-07-24T00:30:00.000Z'),
      stderr: { write: (value) => ((stderr += String(value)), true) },
      stdout: { write: (value) => ((stdout += String(value)), true) },
    },
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'xxyy-chain-control-'));
  temporaryDirectories.push(directory);
  return directory;
}

function provisioningRequest(): Record<string, unknown> {
  const owner = hash('production-owner');
  return {
    approval: {
      approvalName: 'production_mainnet_sources_v1',
      approvedAt: '2026-07-23T23:00:00.000Z',
      approvedByHashes: [owner],
      credentialsAllowed: false,
      legalReviewEvidenceHash: hash('legal-review'),
      privateDataAllowed: false,
      publicChainDataOnly: true,
      retentionDays: 90,
      retentionPolicyId: 'public_chain_90d_v1',
      retentionReviewEvidenceHash: hash('retention-review'),
      sourceApprovalEvidenceHashes: [hash('explorer-review'), hash('rpc-review')],
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
    identityEvidenceHash: hash(`identity-evidence-${role}`),
    identityKind,
    ownerDomain:
      role === 'readiness_attestor'
        ? 'technical_owner'
        : identityKind === 'platform_service_account'
          ? 'platform_operations'
          : 'product_owner',
    principalIdHash: owner ?? hash(`service-principal-${role}`),
    role,
  };
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
