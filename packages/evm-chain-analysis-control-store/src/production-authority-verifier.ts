import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import { z } from 'zod';

import { canonicalJson, sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';

import { EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION } from './contracts.js';
import {
  createProductionProvisioningVerificationClaim,
  productionProvisioningApplicationSchema,
  productionProvisioningPlanSchema,
  productionProvisioningVerificationClaimSchema,
} from './production-provisioning-contracts.js';
import type { ProductionProvisioningAuthorityVerifier } from './production-provisioning-store.js';

const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const authoritySystemIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);
const signatureSchema = z
  .string()
  .min(86)
  .max(86)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const PRODUCTION_PROVISIONING_AUTHORITY_CONTEXT =
  'xxyy-chain-control-production-provisioning-v1' as const;

export const productionProvisioningAuthorityDecisionSchema = z
  .object({
    authoritySystemId: authoritySystemIdSchema,
    context: z.literal(PRODUCTION_PROVISIONING_AUTHORITY_CONTEXT),
    planFingerprint: fingerprintSchema,
    policyEvidenceHash: fingerprintSchema,
    verifiedAt: z.string().datetime({ offset: true }),
    verifiedByHash: fingerprintSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION),
  })
  .strict();

export const productionProvisioningAuthorityAttestationSchema = z
  .object({
    algorithm: z.literal('Ed25519'),
    decision: productionProvisioningAuthorityDecisionSchema,
    signature: signatureSchema,
    verification: productionProvisioningVerificationClaimSchema,
  })
  .strict()
  .superRefine((attestation, context) => {
    const { decision, verification } = attestation;
    if (
      verification.authoritySystemId !== decision.authoritySystemId ||
      verification.planFingerprint !== decision.planFingerprint ||
      verification.verifiedAt !== decision.verifiedAt ||
      verification.verifiedByHash !== decision.verifiedByHash
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Authority attestation decision and verification claim must match exactly.',
        path: ['verification'],
      });
    }
    const expectedEvidenceHash = fingerprintAuthorityEvidence(decision, attestation.signature);
    if (verification.verificationEvidenceHash !== expectedEvidenceHash) {
      context.addIssue({
        code: 'custom',
        message: 'Authority attestation evidence fingerprint must cover the signed decision.',
        path: ['verification', 'verificationEvidenceHash'],
      });
    }
  });

export type ProductionProvisioningAuthorityDecision = z.output<
  typeof productionProvisioningAuthorityDecisionSchema
>;
export type ProductionProvisioningAuthorityAttestation = z.output<
  typeof productionProvisioningAuthorityAttestationSchema
>;

export function fingerprintEd25519PublicKey(publicKeyInput: string | Buffer): string {
  const publicKey = parseEd25519PublicKey(publicKeyInput);
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

export function createEd25519ProductionProvisioningAuthorityAttestation(input: {
  authoritySystemId: string;
  plan: unknown;
  policyEvidenceHash: string;
  privateKey: string | Buffer;
  verifiedAt: string;
}): ProductionProvisioningAuthorityAttestation {
  const plan = productionProvisioningPlanSchema.parse(input.plan);
  const privateKey = parseEd25519PrivateKey(input.privateKey);
  const verifiedByHash = fingerprintEd25519KeyObject(createPublicKey(privateKey));
  const decision = productionProvisioningAuthorityDecisionSchema.parse({
    authoritySystemId: input.authoritySystemId,
    context: PRODUCTION_PROVISIONING_AUTHORITY_CONTEXT,
    planFingerprint: plan.planFingerprint,
    policyEvidenceHash: input.policyEvidenceHash,
    verifiedAt: input.verifiedAt,
    verifiedByHash,
    version: EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  });
  const signature = sign(null, authorityDecisionPayload(decision), privateKey).toString(
    'base64url',
  );
  const verification = createProductionProvisioningVerificationClaim({
    authoritySystemId: decision.authoritySystemId,
    planFingerprint: decision.planFingerprint,
    verificationEvidenceHash: fingerprintAuthorityEvidence(decision, signature),
    verifiedAt: decision.verifiedAt,
    verifiedByHash: decision.verifiedByHash,
  });
  productionProvisioningApplicationSchema.parse({ plan, verification });
  return productionProvisioningAuthorityAttestationSchema.parse({
    algorithm: 'Ed25519',
    decision,
    signature,
    verification,
  });
}

export function createEd25519ProductionProvisioningAuthorityVerifier(options: {
  attestation: unknown;
  expectedAuthoritySystemId: string;
  publicKey: string | Buffer;
}): ProductionProvisioningAuthorityVerifier {
  const attestation = productionProvisioningAuthorityAttestationSchema.parse(options.attestation);
  const publicKey = parseEd25519PublicKey(options.publicKey);
  const publicKeyFingerprint = fingerprintEd25519KeyObject(publicKey);
  if (
    attestation.decision.authoritySystemId !== options.expectedAuthoritySystemId ||
    attestation.decision.verifiedByHash !== publicKeyFingerprint
  ) {
    throw new Error('Authority identity does not match the trusted verifier configuration.');
  }

  return {
    async verify(input): Promise<void> {
      const plan = productionProvisioningPlanSchema.parse(input.plan);
      const verification = productionProvisioningVerificationClaimSchema.parse(input.verification);
      if (
        plan.planFingerprint !== attestation.decision.planFingerprint ||
        verification.verificationFingerprint !== attestation.verification.verificationFingerprint
      ) {
        throw new Error('Authority attestation does not bind the requested provisioning plan.');
      }
      if (
        !verify(
          null,
          authorityDecisionPayload(attestation.decision),
          publicKey,
          Buffer.from(attestation.signature, 'base64url'),
        )
      ) {
        throw new Error('Authority attestation signature is invalid.');
      }
      await Promise.resolve();
    },
  };
}

function authorityDecisionPayload(decision: ProductionProvisioningAuthorityDecision): Buffer {
  return Buffer.from(canonicalJson(decision), 'utf8');
}

function fingerprintAuthorityEvidence(
  decision: ProductionProvisioningAuthorityDecision,
  signature: string,
): string {
  return sha256Fingerprint({
    algorithm: 'Ed25519',
    decision,
    signature,
  });
}

function parseEd25519PrivateKey(input: string | Buffer): KeyObject {
  const key = createPrivateKey(input);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Production authority private key must use Ed25519.');
  }
  return key;
}

function parseEd25519PublicKey(input: string | Buffer): KeyObject {
  return assertEd25519PublicKey(createPublicKey(input));
}

function assertEd25519PublicKey(key: KeyObject): KeyObject {
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Production authority public key must use Ed25519.');
  }
  return key;
}

function fingerprintEd25519KeyObject(key: KeyObject): string {
  const publicKey = assertEd25519PublicKey(key);
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}
