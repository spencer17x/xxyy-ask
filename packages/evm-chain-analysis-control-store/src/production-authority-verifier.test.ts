import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';

import {
  createEd25519ProductionProvisioningAuthorityAttestation,
  createEd25519ProductionProvisioningAuthorityVerifier,
  createProductionProvisioningVerificationClaim,
  fingerprintEd25519PublicKey,
  productionProvisioningAuthorityAttestationSchema,
} from './index.js';
import { testHash } from './fixtures.test-helper.js';
import { createContractOnlyProductionProvisioningFixture } from './production-provisioning.test-helper.js';

describe('Ed25519 production provisioning authority verifier', () => {
  it('signs and verifies the exact single-owner provisioning plan', async () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    const keys = generateEd25519Pem();
    const attestation = createEd25519ProductionProvisioningAuthorityAttestation({
      authoritySystemId: 'platform_policy_verifier',
      plan: fixture.plan,
      policyEvidenceHash: testHash('policy-evidence'),
      privateKey: keys.privateKey,
      verifiedAt: fixture.verification.verifiedAt,
    });
    const verifier = createEd25519ProductionProvisioningAuthorityVerifier({
      attestation,
      expectedAuthoritySystemId: 'platform_policy_verifier',
      publicKey: keys.publicKey,
    });

    await expect(
      verifier.verify({
        plan: fixture.plan,
        verification: attestation.verification,
      }),
    ).resolves.toBeUndefined();
    expect(attestation.decision.verifiedByHash).toBe(fingerprintEd25519PublicKey(keys.publicKey));
    expect(JSON.stringify(attestation)).not.toContain('PRIVATE KEY');
  });

  it('rejects a forged signature even when its content fingerprints are internally consistent', async () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    const keys = generateEd25519Pem();
    const otherKeys = generateEd25519Pem();
    const attestation = createEd25519ProductionProvisioningAuthorityAttestation({
      authoritySystemId: 'platform_policy_verifier',
      plan: fixture.plan,
      policyEvidenceHash: testHash('policy-evidence'),
      privateKey: keys.privateKey,
      verifiedAt: fixture.verification.verifiedAt,
    });
    const tamperedSignature = `${attestation.signature.startsWith('A') ? 'B' : 'A'}${attestation.signature.slice(1)}`;
    const forgedVerification = createProductionProvisioningVerificationClaim({
      authoritySystemId: attestation.decision.authoritySystemId,
      planFingerprint: attestation.decision.planFingerprint,
      verificationEvidenceHash: sha256Fingerprint({
        algorithm: 'Ed25519',
        decision: attestation.decision,
        signature: tamperedSignature,
      }),
      verifiedAt: attestation.decision.verifiedAt,
      verifiedByHash: attestation.decision.verifiedByHash,
    });
    const forgedAttestation = productionProvisioningAuthorityAttestationSchema.parse({
      ...attestation,
      signature: tamperedSignature,
      verification: forgedVerification,
    });
    const forgedVerifier = createEd25519ProductionProvisioningAuthorityVerifier({
      attestation: forgedAttestation,
      expectedAuthoritySystemId: 'platform_policy_verifier',
      publicKey: keys.publicKey,
    });

    await expect(
      forgedVerifier.verify({
        plan: fixture.plan,
        verification: forgedVerification,
      }),
    ).rejects.toThrow(/signature is invalid/u);
    expect(() =>
      createEd25519ProductionProvisioningAuthorityVerifier({
        attestation,
        expectedAuthoritySystemId: 'platform_policy_verifier',
        publicKey: otherKeys.publicKey,
      }),
    ).toThrow();
    expect(() =>
      createEd25519ProductionProvisioningAuthorityVerifier({
        attestation,
        expectedAuthoritySystemId: 'another_policy_verifier',
        publicKey: keys.publicKey,
      }),
    ).toThrow();
  });

  it('rejects non-Ed25519 authority keys', () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    expect(() =>
      createEd25519ProductionProvisioningAuthorityAttestation({
        authoritySystemId: 'platform_policy_verifier',
        plan: fixture.plan,
        policyEvidenceHash: testHash('policy-evidence'),
        privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
        verifiedAt: fixture.verification.verifiedAt,
      }),
    ).toThrow(/Ed25519/u);
  });
});

function generateEd25519Pem(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}
