import { z } from 'zod';

import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import { evmChainIdSchema, evmHashSchema } from '@xxyy/transaction-analysis-core';

import {
  EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  fingerprintSchema,
  stableIdSchema,
  uniqueValues,
} from './common.js';

export const MAX_MAINNET_SAMPLING_STRATA = 128;
export const MAX_MAINNET_SAMPLING_SLOTS = 500;
export const MAX_MAINNET_SAMPLING_MANIFESTS = 1_000;

export const mainnetSamplingSourceKinds = [
  'official_explorer_export',
  'protocol_event_archive',
  'public_rpc',
] as const;
export const mainnetSamplingProtocols = ['uniswap_v2', 'uniswap_v3'] as const;
export const mainnetSamplingRouteClasses = [
  'allowlisted_router',
  'complex_route',
  'direct_pool',
] as const;
export const mainnetSamplingTargetLabels = ['negative', 'positive', 'unsupported'] as const;
export const mainnetSamplingDataCompleteness = ['complete', 'partial', 'unsupported'] as const;
export const mainnetSamplingChainConditions = [
  'canonical',
  'provider_conflict',
  'reorged',
] as const;
export const mainnetSamplingTokenBehaviors = [
  'fee_on_transfer',
  'rebasing',
  'standard',
  'unknown',
] as const;

const sourceApprovalIdSchema = z.string().regex(/^sampling_approval_[0-9a-f]{64}$/u);
const samplingPolicyIdSchema = z.string().regex(/^sampling_policy_[0-9a-f]{64}$/u);
const samplingStratumIdSchema = z.string().regex(/^sampling_stratum_[0-9a-f]{64}$/u);
const samplingPlanIdSchema = z.string().regex(/^sampling_plan_[0-9a-f]{64}$/u);
const samplingSlotIdSchema = z.string().regex(/^sampling_slot_[0-9a-f]{64}$/u);
const sampleManifestIdSchema = z.string().regex(/^sample_manifest_[0-9a-f]{64}$/u);
const samplingRunIdSchema = z.string().regex(/^sampling_run_[0-9a-f]{64}$/u);

export const mainnetSamplingSourceApprovalInputSchema = z
  .object({
    approvalName: stableIdSchema,
    approvedAt: z.string().datetime({ offset: true }),
    approvedByHashes: z
      .array(fingerprintSchema)
      .min(1)
      .max(8)
      .refine(uniqueValues, 'Approver identities must be unique.'),
    legalReviewEvidenceHash: fingerprintSchema,
    publicChainDataOnly: z.literal(true),
    credentialsAllowed: z.literal(false),
    privateDataAllowed: z.literal(false),
    retentionDays: z.number().int().positive().max(3_650),
    retentionPolicyId: stableIdSchema,
    retentionReviewEvidenceHash: fingerprintSchema,
    sourceApprovalEvidenceHashes: z
      .array(fingerprintSchema)
      .min(1)
      .max(16)
      .refine(uniqueValues, 'Source approval evidence must be unique.'),
    sourceKinds: z
      .array(z.enum(mainnetSamplingSourceKinds))
      .min(1)
      .max(mainnetSamplingSourceKinds.length)
      .refine(uniqueValues, 'Source kinds must be unique.'),
    validFrom: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((approval, context) => {
    if (Date.parse(approval.approvedAt) > Date.parse(approval.validFrom)) {
      context.addIssue({
        code: 'custom',
        message: 'Approval must be recorded no later than the validity start.',
        path: ['approvedAt'],
      });
    }
    if (Date.parse(approval.validUntil) <= Date.parse(approval.validFrom)) {
      context.addIssue({
        code: 'custom',
        message: 'Approval validity must have a positive duration.',
        path: ['validUntil'],
      });
    }
  });

export const mainnetSamplingSourceApprovalSchema = z
  .object({
    ...mainnetSamplingSourceApprovalInputSchema.shape,
    approvalFingerprint: fingerprintSchema,
    approvalId: sourceApprovalIdSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((approval, context) => {
    validateSourceApprovalInput(approval, context);
    if (approval.approvalId !== `sampling_approval_${approval.approvalFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling approval id must be content-addressed.',
        path: ['approvalId'],
      });
    }
    const { approvalFingerprint, approvalId: _approvalId, ...body } = approval;
    if (approvalFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling approval fingerprint must cover the normalized record.',
        path: ['approvalFingerprint'],
      });
    }
  });

export const mainnetSamplingStratumInputSchema = z
  .object({
    chainCondition: z.enum(mainnetSamplingChainConditions),
    chainId: evmChainIdSchema,
    dataCompleteness: z.enum(mainnetSamplingDataCompleteness),
    protocol: z.enum(mainnetSamplingProtocols),
    routeClass: z.enum(mainnetSamplingRouteClasses),
    targetLabel: z.enum(mainnetSamplingTargetLabels),
    targetSamples: z.number().int().positive().max(100),
    tokenBehavior: z.enum(mainnetSamplingTokenBehaviors),
  })
  .strict()
  .superRefine((stratum, context) => {
    if ((stratum.targetLabel === 'unsupported') !== (stratum.dataCompleteness === 'unsupported')) {
      context.addIssue({
        code: 'custom',
        message: 'Unsupported targets and unsupported data completeness must align.',
        path: ['targetLabel'],
      });
    }
  });

export const mainnetSamplingStratumSchema = z
  .object({
    ...mainnetSamplingStratumInputSchema.shape,
    stratumFingerprint: fingerprintSchema,
    stratumId: samplingStratumIdSchema,
  })
  .strict()
  .superRefine((stratum, context) => {
    if ((stratum.targetLabel === 'unsupported') !== (stratum.dataCompleteness === 'unsupported')) {
      context.addIssue({
        code: 'custom',
        message: 'Unsupported targets and unsupported data completeness must align.',
        path: ['targetLabel'],
      });
    }
    if (stratum.stratumId !== `sampling_stratum_${stratum.stratumFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling stratum id must be content-addressed.',
        path: ['stratumId'],
      });
    }
    const { stratumFingerprint: _stratumFingerprint, stratumId: _stratumId, ...body } = stratum;
    if (stratum.stratumFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling stratum fingerprint must cover every dimension and its quota.',
        path: ['stratumFingerprint'],
      });
    }
  });

export const mainnetSamplingPolicyInputSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    policyName: stableIdSchema,
    samplingEndsAt: z.string().datetime({ offset: true }),
    samplingStartsAt: z.string().datetime({ offset: true }),
    strata: z.array(mainnetSamplingStratumInputSchema).min(1).max(MAX_MAINNET_SAMPLING_STRATA),
  })
  .strict()
  .superRefine((policy, context) => {
    if (Date.parse(policy.samplingEndsAt) <= Date.parse(policy.samplingStartsAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling window must have a positive duration.',
        path: ['samplingEndsAt'],
      });
    }
  });

export const mainnetSamplingPolicySchema = z
  .object({
    approvalFingerprint: fingerprintSchema,
    createdAt: z.string().datetime({ offset: true }),
    policyFingerprint: fingerprintSchema,
    policyId: samplingPolicyIdSchema,
    policyName: stableIdSchema,
    retentionDays: z.number().int().positive().max(3_650),
    retentionPolicyId: stableIdSchema,
    samplingEndsAt: z.string().datetime({ offset: true }),
    samplingStartsAt: z.string().datetime({ offset: true }),
    sourceKinds: z
      .array(z.enum(mainnetSamplingSourceKinds))
      .min(1)
      .max(mainnetSamplingSourceKinds.length)
      .refine(uniqueValues)
      .refine(isSorted),
    strata: z
      .array(mainnetSamplingStratumSchema)
      .min(1)
      .max(MAX_MAINNET_SAMPLING_STRATA)
      .refine((strata) => uniqueValues(strata.map((stratum) => stratum.stratumId)))
      .refine(
        (strata) => isSorted(strata.map((stratum) => stratum.stratumId)),
        'Sampling strata must be canonically sorted.',
      ),
    targetChainIds: z
      .array(evmChainIdSchema)
      .min(1)
      .max(32)
      .refine(uniqueValues)
      .refine(isChainIdSorted),
    totalTargetSamples: z.number().int().positive().max(MAX_MAINNET_SAMPLING_SLOTS),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((policy, context) => {
    if (Date.parse(policy.samplingEndsAt) <= Date.parse(policy.samplingStartsAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling window must have a positive duration.',
        path: ['samplingEndsAt'],
      });
    }
    const chainIds = sortChainIds([...new Set(policy.strata.map((stratum) => stratum.chainId))]);
    if (chainIds.join('|') !== policy.targetChainIds.join('|')) {
      context.addIssue({
        code: 'custom',
        message: 'Target chains must be derived from the sampling strata.',
        path: ['targetChainIds'],
      });
    }
    const expectedTotal = policy.strata.reduce(
      (total, stratum) => total + stratum.targetSamples,
      0,
    );
    if (expectedTotal !== policy.totalTargetSamples) {
      context.addIssue({
        code: 'custom',
        message: 'Total target samples must equal the sum of stratum quotas.',
        path: ['totalTargetSamples'],
      });
    }
    validateBaselineCoverage(policy.strata, context);
    if (policy.policyId !== `sampling_policy_${policy.policyFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling policy id must be content-addressed.',
        path: ['policyId'],
      });
    }
    const { policyFingerprint: _policyFingerprint, policyId: _policyId, ...body } = policy;
    if (policy.policyFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling policy fingerprint must cover the normalized policy.',
        path: ['policyFingerprint'],
      });
    }
  });

export const mainnetSamplingSlotSchema = z
  .object({
    quotaOrdinal: z.number().int().positive().max(100),
    slotId: samplingSlotIdSchema,
    stratumId: samplingStratumIdSchema,
  })
  .strict();

export const mainnetSamplingPlanSchema = z
  .object({
    approvalFingerprint: fingerprintSchema,
    planFingerprint: fingerprintSchema,
    planId: samplingPlanIdSchema,
    plannedAt: z.string().datetime({ offset: true }),
    policyFingerprint: fingerprintSchema,
    policyId: samplingPolicyIdSchema,
    retentionDays: z.number().int().positive().max(3_650),
    retentionPolicyId: stableIdSchema,
    samplingEndsAt: z.string().datetime({ offset: true }),
    samplingStartsAt: z.string().datetime({ offset: true }),
    slots: z
      .array(mainnetSamplingSlotSchema)
      .min(1)
      .max(MAX_MAINNET_SAMPLING_SLOTS)
      .refine((slots) => uniqueValues(slots.map((slot) => slot.slotId)))
      .refine(
        (slots) =>
          isSorted(slots.map((slot) => `${slot.stratumId}:${padOrdinal(slot.quotaOrdinal)}`)),
        'Sampling slots must be canonically sorted.',
      ),
    sourceKinds: z
      .array(z.enum(mainnetSamplingSourceKinds))
      .min(1)
      .max(mainnetSamplingSourceKinds.length)
      .refine(uniqueValues)
      .refine(isSorted),
    strata: z
      .array(mainnetSamplingStratumSchema)
      .min(1)
      .max(MAX_MAINNET_SAMPLING_STRATA)
      .refine((strata) => uniqueValues(strata.map((stratum) => stratum.stratumId)))
      .refine(
        (strata) => isSorted(strata.map((stratum) => stratum.stratumId)),
        'Sampling plan strata must be canonically sorted.',
      ),
    totalTargetSamples: z.number().int().positive().max(MAX_MAINNET_SAMPLING_SLOTS),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((plan, context) => {
    if (Date.parse(plan.samplingEndsAt) <= Date.parse(plan.samplingStartsAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling plan window must have a positive duration.',
        path: ['samplingEndsAt'],
      });
    }
    if (plan.policyId !== `sampling_policy_${plan.policyFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling plan policy id must match its policy fingerprint.',
        path: ['policyId'],
      });
    }
    const expectedTotal = plan.strata.reduce((total, stratum) => total + stratum.targetSamples, 0);
    if (plan.totalTargetSamples !== expectedTotal) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling plan target must equal the sum of stratum quotas.',
        path: ['totalTargetSamples'],
      });
    }
    if (plan.slots.length !== plan.totalTargetSamples) {
      context.addIssue({
        code: 'custom',
        message: 'Materialized slots must equal the plan target total.',
        path: ['slots'],
      });
    }
    const strataById = new Map(plan.strata.map((stratum) => [stratum.stratumId, stratum]));
    const ordinalsByStratum = new Map<string, number[]>();
    for (const [index, slot] of plan.slots.entries()) {
      const stratum = strataById.get(slot.stratumId);
      if (stratum === undefined || slot.quotaOrdinal > stratum.targetSamples) {
        context.addIssue({
          code: 'custom',
          message: 'Sampling slot must reference an in-quota stratum ordinal.',
          path: ['slots', index],
        });
        continue;
      }
      const expected = samplingSlotId({
        plannedAt: plan.plannedAt,
        policyFingerprint: plan.policyFingerprint,
        quotaOrdinal: slot.quotaOrdinal,
        stratumId: slot.stratumId,
      });
      if (slot.slotId !== expected) {
        context.addIssue({
          code: 'custom',
          message: 'Sampling slot id must be derived from policy, plan time, stratum, and ordinal.',
          path: ['slots', index, 'slotId'],
        });
      }
      const ordinals = ordinalsByStratum.get(slot.stratumId) ?? [];
      ordinals.push(slot.quotaOrdinal);
      ordinalsByStratum.set(slot.stratumId, ordinals);
    }
    for (const stratum of plan.strata) {
      const ordinals = ordinalsByStratum.get(stratum.stratumId) ?? [];
      const expectedOrdinals = Array.from(
        { length: stratum.targetSamples },
        (_, index) => index + 1,
      );
      if (ordinals.join('|') !== expectedOrdinals.join('|')) {
        context.addIssue({
          code: 'custom',
          message: 'Sampling plan must materialize every stratum quota ordinal exactly once.',
          path: ['slots'],
        });
      }
    }
    if (plan.planId !== `sampling_plan_${plan.planFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling plan id must be content-addressed.',
        path: ['planId'],
      });
    }
    const { planFingerprint: _planFingerprint, planId: _planId, ...body } = plan;
    if (plan.planFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling plan fingerprint must cover every materialized slot.',
        path: ['planFingerprint'],
      });
    }
  });

export const publicChainSampleManifestInputSchema = z
  .object({
    blockHash: evmHashSchema,
    blockNumber: z
      .string()
      .max(78)
      .regex(/^(?:0|[1-9]\d*)$/u),
    collectedAt: z.string().datetime({ offset: true }),
    credentialScan: z.literal('passed'),
    privateDataScan: z.literal('passed'),
    providerObservationHashes: z.array(fingerprintSchema).min(1).max(8).refine(uniqueValues),
    reorgEvidence: z
      .object({
        canonicalReplacementBlockHash: evmHashSchema,
        orphanedBlockHash: evmHashSchema,
      })
      .strict()
      .optional(),
    scannedAt: z.string().datetime({ offset: true }),
    scannerVersion: stableIdSchema,
    slotId: samplingSlotIdSchema,
    sourceKind: z.enum(mainnetSamplingSourceKinds),
    sourcePayloadHashes: z.array(fingerprintSchema).min(1).max(16).refine(uniqueValues),
    transactionHash: evmHashSchema,
    transactionIndex: z.number().int().nonnegative().max(1_000_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (Date.parse(manifest.scannedAt) > Date.parse(manifest.collectedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Intake scan cannot happen after collection.',
        path: ['scannedAt'],
      });
    }
  });

export const publicChainSampleManifestSchema = z
  .object({
    ...publicChainSampleManifestInputSchema.shape,
    approvalFingerprint: fingerprintSchema,
    chainCondition: z.enum(mainnetSamplingChainConditions),
    chainId: evmChainIdSchema,
    dataCompleteness: z.enum(mainnetSamplingDataCompleteness),
    manifestFingerprint: fingerprintSchema,
    manifestId: sampleManifestIdSchema,
    planFingerprint: fingerprintSchema,
    planId: samplingPlanIdSchema,
    policyFingerprint: fingerprintSchema,
    protocol: z.enum(mainnetSamplingProtocols),
    retainUntil: z.string().datetime({ offset: true }),
    retentionPolicyId: stableIdSchema,
    routeClass: z.enum(mainnetSamplingRouteClasses),
    sampleIdentityFingerprint: fingerprintSchema,
    stratumId: samplingStratumIdSchema,
    targetLabel: z.enum(mainnetSamplingTargetLabels),
    tokenBehavior: z.enum(mainnetSamplingTokenBehaviors),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (Date.parse(manifest.scannedAt) > Date.parse(manifest.collectedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Intake scan cannot happen after collection.',
        path: ['scannedAt'],
      });
    }
    if (
      manifest.chainCondition === 'provider_conflict' &&
      manifest.providerObservationHashes.length < 2
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Provider-conflict samples require at least two provider observations.',
        path: ['providerObservationHashes'],
      });
    }
    if (manifest.chainCondition === 'reorged') {
      if (manifest.reorgEvidence === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Reorg samples require orphaned and replacement block evidence.',
          path: ['reorgEvidence'],
        });
      } else if (
        manifest.reorgEvidence.orphanedBlockHash !== manifest.blockHash ||
        manifest.reorgEvidence.canonicalReplacementBlockHash === manifest.blockHash
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Reorg evidence must identify the observed orphan and a distinct replacement.',
          path: ['reorgEvidence'],
        });
      }
    } else if (manifest.reorgEvidence !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Only reorg strata may carry reorg evidence.',
        path: ['reorgEvidence'],
      });
    }
    if (!isSorted(manifest.providerObservationHashes)) {
      context.addIssue({
        code: 'custom',
        message: 'Provider observation hashes must be canonically sorted.',
        path: ['providerObservationHashes'],
      });
    }
    if (!isSorted(manifest.sourcePayloadHashes)) {
      context.addIssue({
        code: 'custom',
        message: 'Source payload hashes must be canonically sorted.',
        path: ['sourcePayloadHashes'],
      });
    }
    if (Date.parse(manifest.retainUntil) <= Date.parse(manifest.collectedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Sample retention must extend beyond collection.',
        path: ['retainUntil'],
      });
    }
    if (
      (manifest.targetLabel === 'unsupported') !==
      (manifest.dataCompleteness === 'unsupported')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Manifest unsupported target and data completeness must align.',
        path: ['targetLabel'],
      });
    }
    const identity = sha256Fingerprint({
      chainId: manifest.chainId,
      transactionHash: manifest.transactionHash,
    });
    if (manifest.sampleIdentityFingerprint !== identity) {
      context.addIssue({
        code: 'custom',
        message: 'Sample identity must deduplicate by chain and transaction hash.',
        path: ['sampleIdentityFingerprint'],
      });
    }
    if (manifest.manifestId !== `sample_manifest_${manifest.manifestFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Sample manifest id must be content-addressed.',
        path: ['manifestId'],
      });
    }
    const {
      manifestFingerprint: _manifestFingerprint,
      manifestId: _manifestId,
      ...body
    } = manifest;
    if (manifest.manifestFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Sample manifest fingerprint must cover the complete intake record.',
        path: ['manifestFingerprint'],
      });
    }
  });

export const mainnetSamplingCoverageReasonCodes = [
  'approval_anchor_mismatch',
  'approval_expired',
  'approval_not_yet_valid',
  'duplicate_sample_identity',
  'duplicate_slot',
  'foreign_manifest',
  'manifest_dimension_mismatch',
  'quota_missing',
  'sampling_window_expired',
  'sampling_window_not_started',
] as const;

export const mainnetSamplingManifestRejectionReasons = [
  'duplicate_sample_identity',
  'duplicate_slot',
  'foreign_manifest',
  'manifest_dimension_mismatch',
] as const;

export const mainnetSamplingCoverageRowSchema = z
  .object({
    acceptedSamples: z.number().int().nonnegative().max(100),
    remainingSamples: z.number().int().nonnegative().max(100),
    stratumId: samplingStratumIdSchema,
    targetSamples: z.number().int().positive().max(100),
  })
  .strict()
  .refine((row) => row.acceptedSamples + row.remainingSamples === row.targetSamples, {
    message: 'Accepted and remaining samples must reconcile to the stratum target.',
  });

export const mainnetSamplingRejectedManifestSchema = z
  .object({
    manifestFingerprint: fingerprintSchema,
    reasonCodes: z
      .array(z.enum(mainnetSamplingManifestRejectionReasons))
      .min(1)
      .max(mainnetSamplingManifestRejectionReasons.length)
      .refine(uniqueValues)
      .refine(isSorted),
  })
  .strict();

export const mainnetSamplingCoverageResultSchema = z
  .object({
    acceptedManifestFingerprints: z
      .array(fingerprintSchema)
      .max(MAX_MAINNET_SAMPLING_SLOTS)
      .refine(uniqueValues)
      .refine(isSorted),
    approvalFingerprint: fingerprintSchema,
    coverage: z.array(mainnetSamplingCoverageRowSchema).min(1).max(MAX_MAINNET_SAMPLING_STRATA),
    evaluatedAt: z.string().datetime({ offset: true }),
    planFingerprint: fingerprintSchema,
    planId: samplingPlanIdSchema,
    reasonCodes: z
      .array(z.enum(mainnetSamplingCoverageReasonCodes))
      .max(mainnetSamplingCoverageReasonCodes.length)
      .refine(uniqueValues)
      .refine(isSorted),
    rejectedManifests: z
      .array(mainnetSamplingRejectedManifestSchema)
      .max(MAX_MAINNET_SAMPLING_MANIFESTS),
    runFingerprint: fingerprintSchema,
    runId: samplingRunIdSchema,
    status: z.enum(['blocked', 'complete', 'in_progress', 'incomplete']),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((result, context) => {
    const allCovered = result.coverage.every((row) => row.remainingSamples === 0);
    if (
      (result.status === 'complete' && !allCovered) ||
      (allCovered && result.status !== 'complete' && result.status !== 'blocked')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Complete sampling status must exactly match full quota coverage.',
        path: ['status'],
      });
    }
    const blockingReason = result.reasonCodes.some(
      (reason) =>
        reason === 'approval_anchor_mismatch' ||
        reason === 'approval_expired' ||
        reason === 'approval_not_yet_valid' ||
        reason === 'sampling_window_not_started',
    );
    const missingQuota = !allCovered;
    if ((result.status === 'blocked') !== blockingReason) {
      context.addIssue({
        code: 'custom',
        message: 'Blocked status must exactly match a fail-closed approval or window reason.',
        path: ['status'],
      });
    }
    if (result.reasonCodes.includes('quota_missing') !== missingQuota) {
      context.addIssue({
        code: 'custom',
        message: 'Quota-missing reason must match the coverage rows.',
        path: ['reasonCodes'],
      });
    }
    const expiredWithMissingQuota =
      !blockingReason && missingQuota && result.reasonCodes.includes('sampling_window_expired');
    if ((result.status === 'incomplete') !== expiredWithMissingQuota) {
      context.addIssue({
        code: 'custom',
        message: 'Incomplete status requires an expired sampling window with remaining quota.',
        path: ['status'],
      });
    }
    if (result.runId !== `sampling_run_${result.runFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling run id must be content-addressed.',
        path: ['runId'],
      });
    }
    const { runFingerprint: _runFingerprint, runId: _runId, ...body } = result;
    if (result.runFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling run fingerprint must cover the deterministic coverage result.',
        path: ['runFingerprint'],
      });
    }
  });

export type MainnetSamplingSourceKind = (typeof mainnetSamplingSourceKinds)[number];
export type MainnetSamplingProtocol = (typeof mainnetSamplingProtocols)[number];
export type MainnetSamplingRouteClass = (typeof mainnetSamplingRouteClasses)[number];
export type MainnetSamplingTargetLabel = (typeof mainnetSamplingTargetLabels)[number];
export type MainnetSamplingDataCompleteness = (typeof mainnetSamplingDataCompleteness)[number];
export type MainnetSamplingChainCondition = (typeof mainnetSamplingChainConditions)[number];
export type MainnetSamplingTokenBehavior = (typeof mainnetSamplingTokenBehaviors)[number];
export type MainnetSamplingSourceApprovalInput = z.input<
  typeof mainnetSamplingSourceApprovalInputSchema
>;
export type MainnetSamplingSourceApproval = z.output<typeof mainnetSamplingSourceApprovalSchema>;
export type MainnetSamplingStratumInput = z.input<typeof mainnetSamplingStratumInputSchema>;
export type MainnetSamplingStratum = z.output<typeof mainnetSamplingStratumSchema>;
export type MainnetSamplingPolicyInput = z.input<typeof mainnetSamplingPolicyInputSchema>;
export type MainnetSamplingPolicy = z.output<typeof mainnetSamplingPolicySchema>;
export type MainnetSamplingSlot = z.output<typeof mainnetSamplingSlotSchema>;
export type MainnetSamplingPlan = z.output<typeof mainnetSamplingPlanSchema>;
export type PublicChainSampleManifestInput = z.input<typeof publicChainSampleManifestInputSchema>;
export type PublicChainSampleManifest = z.output<typeof publicChainSampleManifestSchema>;
export type MainnetSamplingCoverageReasonCode = (typeof mainnetSamplingCoverageReasonCodes)[number];
export type MainnetSamplingManifestRejectionReason =
  (typeof mainnetSamplingManifestRejectionReasons)[number];
export type MainnetSamplingCoverageResult = z.output<typeof mainnetSamplingCoverageResultSchema>;

export function samplingSlotId(input: {
  plannedAt: string;
  policyFingerprint: string;
  quotaOrdinal: number;
  stratumId: string;
}): string {
  return `sampling_slot_${sha256Fingerprint(input).slice(7)}`;
}

function validateSourceApprovalInput(
  approval: z.output<typeof mainnetSamplingSourceApprovalSchema>,
  context: z.RefinementCtx,
): void {
  if (Date.parse(approval.approvedAt) > Date.parse(approval.validFrom)) {
    context.addIssue({
      code: 'custom',
      message: 'Approval must be recorded no later than the validity start.',
      path: ['approvedAt'],
    });
  }
  if (Date.parse(approval.validUntil) <= Date.parse(approval.validFrom)) {
    context.addIssue({
      code: 'custom',
      message: 'Approval validity must have a positive duration.',
      path: ['validUntil'],
    });
  }
  if (!isSorted(approval.approvedByHashes)) {
    context.addIssue({
      code: 'custom',
      message: 'Approver hashes must be canonically sorted.',
      path: ['approvedByHashes'],
    });
  }
  if (!isSorted(approval.sourceApprovalEvidenceHashes)) {
    context.addIssue({
      code: 'custom',
      message: 'Source evidence hashes must be canonically sorted.',
      path: ['sourceApprovalEvidenceHashes'],
    });
  }
  if (!isSorted(approval.sourceKinds)) {
    context.addIssue({
      code: 'custom',
      message: 'Source kinds must be canonically sorted.',
      path: ['sourceKinds'],
    });
  }
}

function validateBaselineCoverage(
  strata: readonly MainnetSamplingStratum[],
  context: z.RefinementCtx,
): void {
  for (const [field, required] of [
    ['protocol', mainnetSamplingProtocols],
    ['routeClass', mainnetSamplingRouteClasses],
    ['targetLabel', mainnetSamplingTargetLabels],
    ['dataCompleteness', mainnetSamplingDataCompleteness],
    ['chainCondition', mainnetSamplingChainConditions],
  ] as const) {
    const actual = new Set(strata.map((stratum) => stratum[field]));
    for (const value of required) {
      if (!actual.has(value)) {
        context.addIssue({
          code: 'custom',
          message: `Sampling policy is missing baseline ${field} coverage for ${value}.`,
          path: ['strata'],
        });
      }
    }
  }
  const tokenBehaviors = new Set(strata.map((stratum) => stratum.tokenBehavior));
  if (!tokenBehaviors.has('standard')) {
    context.addIssue({
      code: 'custom',
      message: 'Sampling policy requires standard-token coverage.',
      path: ['strata'],
    });
  }
  if (![...tokenBehaviors].some((behavior) => behavior !== 'standard')) {
    context.addIssue({
      code: 'custom',
      message: 'Sampling policy requires at least one special-token stratum.',
      path: ['strata'],
    });
  }
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! <= value);
}

function sortChainIds(chainIds: string[]): string[] {
  return chainIds.sort((left, right) => {
    const difference = BigInt(left) - BigInt(right);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  });
}

function isChainIdSorted(chainIds: readonly string[]): boolean {
  return chainIds.every(
    (chainId, index) => index === 0 || BigInt(chainIds[index - 1]!) <= BigInt(chainId),
  );
}

function padOrdinal(value: number): string {
  return value.toString().padStart(3, '0');
}
