import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';

import { EVM_CHAIN_ANALYSIS_READINESS_VERSION } from './common.js';
import {
  mainnetSamplingCoverageResultSchema,
  mainnetSamplingPlanSchema,
  mainnetSamplingPolicyInputSchema,
  mainnetSamplingPolicySchema,
  mainnetSamplingSourceApprovalInputSchema,
  mainnetSamplingSourceApprovalSchema,
  mainnetSamplingStratumInputSchema,
  mainnetSamplingStratumSchema,
  publicChainSampleManifestInputSchema,
  publicChainSampleManifestSchema,
  samplingSlotId,
  type MainnetSamplingCoverageReasonCode,
  type MainnetSamplingCoverageResult,
  type MainnetSamplingManifestRejectionReason,
  type MainnetSamplingPlan,
  type MainnetSamplingPolicy,
  type MainnetSamplingPolicyInput,
  type MainnetSamplingSourceApproval,
  type MainnetSamplingSourceApprovalInput,
  type MainnetSamplingStratum,
  type MainnetSamplingStratumInput,
  type PublicChainSampleManifest,
  type PublicChainSampleManifestInput,
} from './sampling-contracts.js';

export const mainnetSamplingErrorCodes = [
  'approval_anchor_mismatch',
  'approval_inactive',
  'manifest_outside_window',
  'policy_anchor_mismatch',
  'slot_not_found',
  'source_not_approved',
] as const;

export type MainnetSamplingErrorCode = (typeof mainnetSamplingErrorCodes)[number];

export class MainnetSamplingError extends Error {
  readonly code: MainnetSamplingErrorCode;

  constructor(code: MainnetSamplingErrorCode, message: string) {
    super(message);
    this.name = 'MainnetSamplingError';
    this.code = code;
  }
}

export function createMainnetSamplingSourceApproval(
  input: MainnetSamplingSourceApprovalInput,
): MainnetSamplingSourceApproval {
  const parsed = mainnetSamplingSourceApprovalInputSchema.parse({
    ...input,
    approvedByHashes: [...input.approvedByHashes].sort(),
    sourceApprovalEvidenceHashes: [...input.sourceApprovalEvidenceHashes].sort(),
    sourceKinds: [...input.sourceKinds].sort(),
  });
  const body = {
    ...parsed,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const approvalFingerprint = sha256Fingerprint(body);
  return mainnetSamplingSourceApprovalSchema.parse({
    ...body,
    approvalFingerprint,
    approvalId: `sampling_approval_${approvalFingerprint.slice(7)}`,
  });
}

export function createMainnetSamplingPolicy(
  approvalInput: MainnetSamplingSourceApproval,
  input: MainnetSamplingPolicyInput,
): MainnetSamplingPolicy {
  const approval = mainnetSamplingSourceApprovalSchema.parse(approvalInput);
  const parsed = mainnetSamplingPolicyInputSchema.parse(input);
  if (
    Date.parse(parsed.createdAt) < Date.parse(approval.approvedAt) ||
    Date.parse(parsed.createdAt) > Date.parse(parsed.samplingStartsAt) ||
    Date.parse(parsed.samplingStartsAt) < Date.parse(approval.validFrom) ||
    Date.parse(parsed.samplingEndsAt) > Date.parse(approval.validUntil)
  ) {
    throw new MainnetSamplingError(
      'approval_inactive',
      'Sampling policy creation and collection window must remain within recorded approval validity.',
    );
  }
  const strata = parsed.strata.map(createSamplingStratum).sort(compareStrata);
  const targetChainIds = sortChainIds([...new Set(strata.map((stratum) => stratum.chainId))]);
  const totalTargetSamples = strata.reduce((total, stratum) => total + stratum.targetSamples, 0);
  const body = {
    approvalFingerprint: approval.approvalFingerprint,
    createdAt: parsed.createdAt,
    policyName: parsed.policyName,
    retentionDays: approval.retentionDays,
    samplingEndsAt: parsed.samplingEndsAt,
    samplingStartsAt: parsed.samplingStartsAt,
    sourceKinds: approval.sourceKinds,
    strata,
    targetChainIds,
    totalTargetSamples,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const policyFingerprint = sha256Fingerprint(body);
  return mainnetSamplingPolicySchema.parse({
    ...body,
    policyFingerprint,
    policyId: `sampling_policy_${policyFingerprint.slice(7)}`,
  });
}

export function materializeMainnetSamplingPlan(
  approvalInput: MainnetSamplingSourceApproval,
  policyInput: MainnetSamplingPolicy,
  plannedAt: string,
): MainnetSamplingPlan {
  const approval = mainnetSamplingSourceApprovalSchema.parse(approvalInput);
  const policy = mainnetSamplingPolicySchema.parse(policyInput);
  if (
    policy.approvalFingerprint !== approval.approvalFingerprint ||
    policy.retentionDays !== approval.retentionDays ||
    policy.sourceKinds.join('|') !== approval.sourceKinds.join('|')
  ) {
    throw new MainnetSamplingError(
      'approval_anchor_mismatch',
      'Sampling policy does not reproduce the supplied source and retention approval anchors.',
    );
  }
  const plannedAtMs = Date.parse(plannedAt);
  if (
    !Number.isFinite(plannedAtMs) ||
    plannedAtMs < Date.parse(approval.validFrom) ||
    plannedAtMs >= Date.parse(approval.validUntil) ||
    plannedAtMs < Date.parse(policy.createdAt) ||
    plannedAtMs > Date.parse(policy.samplingEndsAt)
  ) {
    throw new MainnetSamplingError(
      'approval_inactive',
      'Plan materialization requires an active approval and a current policy.',
    );
  }
  const slots = policy.strata.flatMap((stratum) =>
    Array.from({ length: stratum.targetSamples }, (_, index) => {
      const quotaOrdinal = index + 1;
      return {
        quotaOrdinal,
        slotId: samplingSlotId({
          plannedAt,
          policyFingerprint: policy.policyFingerprint,
          quotaOrdinal,
          stratumId: stratum.stratumId,
        }),
        stratumId: stratum.stratumId,
      };
    }),
  );
  const body = {
    approvalFingerprint: approval.approvalFingerprint,
    plannedAt,
    policyFingerprint: policy.policyFingerprint,
    policyId: policy.policyId,
    retentionDays: policy.retentionDays,
    samplingEndsAt: policy.samplingEndsAt,
    samplingStartsAt: policy.samplingStartsAt,
    slots,
    sourceKinds: policy.sourceKinds,
    strata: policy.strata,
    totalTargetSamples: policy.totalTargetSamples,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const planFingerprint = sha256Fingerprint(body);
  return mainnetSamplingPlanSchema.parse({
    ...body,
    planFingerprint,
    planId: `sampling_plan_${planFingerprint.slice(7)}`,
  });
}

export function createPublicChainSampleManifest(
  planInput: MainnetSamplingPlan,
  input: PublicChainSampleManifestInput,
): PublicChainSampleManifest {
  const plan = mainnetSamplingPlanSchema.parse(planInput);
  const parsed = publicChainSampleManifestInputSchema.parse({
    ...input,
    providerObservationHashes: [...input.providerObservationHashes].sort(),
    sourcePayloadHashes: [...input.sourcePayloadHashes].sort(),
  });
  const slot = plan.slots.find((candidate) => candidate.slotId === parsed.slotId);
  if (slot === undefined) {
    throw new MainnetSamplingError('slot_not_found', 'Sample manifest references an unknown slot.');
  }
  const stratum = plan.strata.find((candidate) => candidate.stratumId === slot.stratumId);
  if (stratum === undefined) {
    throw new MainnetSamplingError(
      'policy_anchor_mismatch',
      'Materialized sampling slot has no matching policy stratum.',
    );
  }
  if (!plan.sourceKinds.includes(parsed.sourceKind)) {
    throw new MainnetSamplingError(
      'source_not_approved',
      'Sample manifest source kind is outside the recorded approval.',
    );
  }
  if (
    Date.parse(parsed.collectedAt) < Date.parse(plan.samplingStartsAt) ||
    Date.parse(parsed.collectedAt) > Date.parse(plan.samplingEndsAt)
  ) {
    throw new MainnetSamplingError(
      'manifest_outside_window',
      'Sample collection time is outside the materialized sampling window.',
    );
  }
  const body = {
    ...parsed,
    approvalFingerprint: plan.approvalFingerprint,
    chainCondition: stratum.chainCondition,
    chainId: stratum.chainId,
    dataCompleteness: stratum.dataCompleteness,
    planFingerprint: plan.planFingerprint,
    planId: plan.planId,
    policyFingerprint: plan.policyFingerprint,
    protocol: stratum.protocol,
    retainUntil: addUtcDays(parsed.collectedAt, plan.retentionDays),
    routeClass: stratum.routeClass,
    sampleIdentityFingerprint: sha256Fingerprint({
      chainId: stratum.chainId,
      transactionHash: parsed.transactionHash,
    }),
    stratumId: stratum.stratumId,
    targetLabel: stratum.targetLabel,
    tokenBehavior: stratum.tokenBehavior,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const manifestFingerprint = sha256Fingerprint(body);
  return publicChainSampleManifestSchema.parse({
    ...body,
    manifestFingerprint,
    manifestId: `sample_manifest_${manifestFingerprint.slice(7)}`,
  });
}

export function evaluateMainnetSamplingCoverage(input: {
  approval: MainnetSamplingSourceApproval;
  evaluatedAt: string;
  manifests: readonly PublicChainSampleManifest[];
  plan: MainnetSamplingPlan;
}): MainnetSamplingCoverageResult {
  const approval = mainnetSamplingSourceApprovalSchema.parse(input.approval);
  const plan = mainnetSamplingPlanSchema.parse(input.plan);
  const manifests = input.manifests
    .map((manifest) => publicChainSampleManifestSchema.parse(manifest))
    .sort((left, right) => left.manifestFingerprint.localeCompare(right.manifestFingerprint));
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    throw new TypeError('Expected a valid sampling evaluation date-time.');
  }

  const reasonCodes = new Set<MainnetSamplingCoverageReasonCode>();
  if (plan.approvalFingerprint !== approval.approvalFingerprint) {
    reasonCodes.add('approval_anchor_mismatch');
  }
  if (evaluatedAtMs < Date.parse(approval.validFrom)) {
    reasonCodes.add('approval_not_yet_valid');
  }
  if (evaluatedAtMs >= Date.parse(approval.validUntil)) {
    reasonCodes.add('approval_expired');
  }
  if (evaluatedAtMs < Date.parse(plan.samplingStartsAt)) {
    reasonCodes.add('sampling_window_not_started');
  }

  const slotsById = new Map(plan.slots.map((slot) => [slot.slotId, slot]));
  const strataById = new Map(plan.strata.map((stratum) => [stratum.stratumId, stratum]));
  const acceptedSlots = new Set<string>();
  const acceptedIdentities = new Set<string>();
  const acceptedManifestFingerprints: string[] = [];
  const acceptedByStratum = new Map<string, number>();
  const rejectedManifests: Array<{
    manifestFingerprint: string;
    reasonCodes: MainnetSamplingManifestRejectionReason[];
  }> = [];

  for (const manifest of manifests) {
    const rejectionReasons = new Set<MainnetSamplingManifestRejectionReason>();
    const slot = slotsById.get(manifest.slotId);
    const stratum = slot === undefined ? undefined : strataById.get(slot.stratumId);
    if (
      manifest.planId !== plan.planId ||
      manifest.planFingerprint !== plan.planFingerprint ||
      manifest.policyFingerprint !== plan.policyFingerprint ||
      manifest.approvalFingerprint !== plan.approvalFingerprint ||
      slot === undefined ||
      stratum === undefined
    ) {
      rejectionReasons.add('foreign_manifest');
    } else if (!manifestMatchesStratum(manifest, stratum, plan)) {
      rejectionReasons.add('manifest_dimension_mismatch');
    }
    if (acceptedSlots.has(manifest.slotId)) {
      rejectionReasons.add('duplicate_slot');
    }
    if (acceptedIdentities.has(manifest.sampleIdentityFingerprint)) {
      rejectionReasons.add('duplicate_sample_identity');
    }
    if (rejectionReasons.size > 0) {
      const sorted = [...rejectionReasons].sort();
      rejectedManifests.push({
        manifestFingerprint: manifest.manifestFingerprint,
        reasonCodes: sorted,
      });
      for (const reason of sorted) {
        reasonCodes.add(reason);
      }
      continue;
    }
    acceptedSlots.add(manifest.slotId);
    acceptedIdentities.add(manifest.sampleIdentityFingerprint);
    acceptedManifestFingerprints.push(manifest.manifestFingerprint);
    acceptedByStratum.set(manifest.stratumId, (acceptedByStratum.get(manifest.stratumId) ?? 0) + 1);
  }

  const coverage = plan.strata.map((stratum) => {
    const acceptedSamples = acceptedByStratum.get(stratum.stratumId) ?? 0;
    return {
      acceptedSamples,
      remainingSamples: stratum.targetSamples - acceptedSamples,
      stratumId: stratum.stratumId,
      targetSamples: stratum.targetSamples,
    };
  });
  const complete = coverage.every((row) => row.remainingSamples === 0);
  if (!complete) {
    reasonCodes.add('quota_missing');
    if (evaluatedAtMs > Date.parse(plan.samplingEndsAt)) {
      reasonCodes.add('sampling_window_expired');
    }
  }
  const blocked =
    reasonCodes.has('approval_anchor_mismatch') ||
    reasonCodes.has('approval_expired') ||
    reasonCodes.has('approval_not_yet_valid') ||
    reasonCodes.has('sampling_window_not_started');
  const status = blocked
    ? 'blocked'
    : complete
      ? 'complete'
      : reasonCodes.has('sampling_window_expired')
        ? 'incomplete'
        : 'in_progress';
  const body = {
    acceptedManifestFingerprints: acceptedManifestFingerprints.sort(),
    approvalFingerprint: approval.approvalFingerprint,
    coverage,
    evaluatedAt: input.evaluatedAt,
    planFingerprint: plan.planFingerprint,
    planId: plan.planId,
    reasonCodes: [...reasonCodes].sort(),
    rejectedManifests,
    status,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const runFingerprint = sha256Fingerprint(body);
  return mainnetSamplingCoverageResultSchema.parse({
    ...body,
    runFingerprint,
    runId: `sampling_run_${runFingerprint.slice(7)}`,
  });
}

function createSamplingStratum(input: MainnetSamplingStratumInput): MainnetSamplingStratum {
  const body = mainnetSamplingStratumInputSchema.parse(input);
  const stratumFingerprint = sha256Fingerprint(body);
  return mainnetSamplingStratumSchema.parse({
    ...body,
    stratumFingerprint,
    stratumId: `sampling_stratum_${stratumFingerprint.slice(7)}`,
  });
}

function manifestMatchesStratum(
  manifest: PublicChainSampleManifest,
  stratum: MainnetSamplingStratum,
  plan: MainnetSamplingPlan,
): boolean {
  return (
    manifest.stratumId === stratum.stratumId &&
    manifest.chainId === stratum.chainId &&
    manifest.chainCondition === stratum.chainCondition &&
    manifest.dataCompleteness === stratum.dataCompleteness &&
    manifest.protocol === stratum.protocol &&
    manifest.routeClass === stratum.routeClass &&
    manifest.targetLabel === stratum.targetLabel &&
    manifest.tokenBehavior === stratum.tokenBehavior &&
    plan.sourceKinds.includes(manifest.sourceKind) &&
    Date.parse(manifest.collectedAt) >= Date.parse(plan.samplingStartsAt) &&
    Date.parse(manifest.collectedAt) <= Date.parse(plan.samplingEndsAt)
  );
}

function compareStrata(left: MainnetSamplingStratum, right: MainnetSamplingStratum): number {
  return left.stratumId.localeCompare(right.stratumId);
}

function sortChainIds(chainIds: string[]): string[] {
  return chainIds.sort((left, right) => {
    const difference = BigInt(left) - BigInt(right);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  });
}

function addUtcDays(timestamp: string, days: number): string {
  const date = new Date(timestamp);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}
