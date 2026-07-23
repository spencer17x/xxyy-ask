import { z } from 'zod';

import {
  chainAnalysisGroundTruthLabels,
  sha256Fingerprint,
} from '@xxyy/evm-chain-analysis-harness';

import {
  EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  fingerprintSchema,
  stableIdSchema,
  uniqueValues,
} from './common.js';
import {
  reviewedReplayCandidateSchema,
  reviewedReplayCasePayloadSchema,
  type ReviewedReplayCandidate,
} from './governance-contracts.js';
import {
  createReviewedReplayCandidate,
  scanReviewedReplayPayload,
} from './reviewed-corpus-governance.js';
import {
  mainnetSamplingTargetLabels,
  publicChainSampleManifestSchema,
  type PublicChainSampleManifest,
} from './sampling-contracts.js';

export const samplingCandidateTargetDispositions = ['deviated', 'matched'] as const;
export const SAMPLING_CANDIDATE_SELECTION_POLICY = 'target_agnostic_no_exclusion' as const;

export const samplingCandidateHandoffErrorCodes = [
  'candidate_anchor_mismatch',
  'candidate_dimension_mismatch',
  'candidate_source_lineage_invalid',
  'candidate_time_lineage_invalid',
] as const;

export type SamplingCandidateHandoffErrorCode = (typeof samplingCandidateHandoffErrorCodes)[number];

export class SamplingCandidateHandoffError extends Error {
  readonly code: SamplingCandidateHandoffErrorCode;

  constructor(code: SamplingCandidateHandoffErrorCode, message: string) {
    super(message);
    this.name = 'SamplingCandidateHandoffError';
    this.code = code;
  }
}

export const samplingCandidateHandoffInputSchema = z
  .object({
    additionalSourcePayloadHashes: z
      .array(fingerprintSchema)
      .max(16)
      .refine(uniqueValues, 'Additional source payload hashes must be unique.')
      .optional(),
    payload: reviewedReplayCasePayloadSchema,
    scannedAt: z.string().datetime({ offset: true }),
    scannerVersion: stableIdSchema,
    submittedAt: z.string().datetime({ offset: true }),
    submitterIdHash: fingerprintSchema,
  })
  .strict();

export const samplingCandidateTargetComparisonSchema = z
  .object({
    disposition: z.enum(samplingCandidateTargetDispositions),
    proposedGroundTruth: z.enum(chainAnalysisGroundTruthLabels),
    samplingTargetLabel: z.enum(mainnetSamplingTargetLabels),
  })
  .strict()
  .superRefine((comparison, context) => {
    const expected =
      comparison.proposedGroundTruth === comparison.samplingTargetLabel ? 'matched' : 'deviated';
    if (comparison.disposition !== expected) {
      context.addIssue({
        code: 'custom',
        message:
          'Target disposition must report whether the proposed label differs from the sampling bucket.',
        path: ['disposition'],
      });
    }
  });

export const samplingCandidateHandoffSchema = z
  .object({
    additionalSourcePayloadHashes: z
      .array(fingerprintSchema)
      .max(16)
      .refine(uniqueValues, 'Additional source payload hashes must be unique.')
      .refine(isSorted, 'Additional source payload hashes must be canonically sorted.'),
    candidate: reviewedReplayCandidateSchema,
    handoffFingerprint: fingerprintSchema,
    handoffId: z.string().regex(/^sampling_handoff_[0-9a-f]{64}$/u),
    manifest: publicChainSampleManifestSchema,
    selectionPolicy: z.literal(SAMPLING_CANDIDATE_SELECTION_POLICY),
    targetComparison: samplingCandidateTargetComparisonSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((handoff, context) => {
    for (const issue of candidateManifestIssues(
      handoff.manifest,
      handoff.candidate,
      handoff.additionalSourcePayloadHashes,
    )) {
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
    if (
      handoff.targetComparison.samplingTargetLabel !== handoff.manifest.targetLabel ||
      handoff.targetComparison.proposedGroundTruth !== handoff.candidate.payload.groundTruth
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Target comparison must be derived from the manifest and proposed replay label.',
        path: ['targetComparison'],
      });
    }
    if (handoff.handoffId !== `sampling_handoff_${handoff.handoffFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling candidate handoff id must be content-addressed.',
        path: ['handoffId'],
      });
    }
    const { handoffFingerprint, handoffId: _handoffId, ...body } = handoff;
    if (handoffFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling candidate handoff fingerprint must cover the complete lineage record.',
        path: ['handoffFingerprint'],
      });
    }
  });

export type SamplingCandidateHandoffInput = z.input<typeof samplingCandidateHandoffInputSchema>;
export type SamplingCandidateTargetDisposition =
  (typeof samplingCandidateTargetDispositions)[number];
export type SamplingCandidateHandoff = z.output<typeof samplingCandidateHandoffSchema>;

export function createSamplingCandidateHandoff(
  manifestInput: unknown,
  input: SamplingCandidateHandoffInput,
): SamplingCandidateHandoff {
  const manifest = publicChainSampleManifestSchema.parse(manifestInput);
  const parsed = samplingCandidateHandoffInputSchema.parse(input);
  const additionalSourcePayloadHashes = [...new Set(parsed.additionalSourcePayloadHashes ?? [])]
    .filter((fingerprint) => !manifest.sourcePayloadHashes.includes(fingerprint))
    .sort();
  const sourcePayloadHashes = [
    ...new Set([...manifest.sourcePayloadHashes, ...additionalSourcePayloadHashes]),
  ].sort();
  if (sourcePayloadHashes.length > 16) {
    throw new SamplingCandidateHandoffError(
      'candidate_source_lineage_invalid',
      'Manifest and additional replay source evidence exceeds the candidate source limit.',
    );
  }
  const candidate = createReviewedReplayCandidate({
    payload: parsed.payload,
    retainUntil: manifest.retainUntil,
    retentionPolicyId: manifest.retentionPolicyId,
    scanner: scanReviewedReplayPayload(parsed.payload, parsed.scannedAt, parsed.scannerVersion),
    sourcePayloadHashes,
    submittedAt: parsed.submittedAt,
    submitterIdHash: parsed.submitterIdHash,
  });
  const issues = candidateManifestIssues(manifest, candidate, additionalSourcePayloadHashes);
  if (issues[0] !== undefined) {
    throw new SamplingCandidateHandoffError(issues[0].code, issues[0].message);
  }
  const targetComparison = {
    disposition:
      candidate.payload.groundTruth === manifest.targetLabel
        ? ('matched' as const)
        : ('deviated' as const),
    proposedGroundTruth: candidate.payload.groundTruth,
    samplingTargetLabel: manifest.targetLabel,
  };
  const body = {
    additionalSourcePayloadHashes,
    candidate,
    manifest,
    selectionPolicy: SAMPLING_CANDIDATE_SELECTION_POLICY,
    targetComparison,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const handoffFingerprint = sha256Fingerprint(body);
  return samplingCandidateHandoffSchema.parse({
    ...body,
    handoffFingerprint,
    handoffId: `sampling_handoff_${handoffFingerprint.slice(7)}`,
  });
}

interface CandidateManifestIssue {
  code: SamplingCandidateHandoffErrorCode;
  message: string;
  path: Array<string | number>;
}

function candidateManifestIssues(
  manifest: PublicChainSampleManifest,
  candidate: ReviewedReplayCandidate,
  additionalSourcePayloadHashes: readonly string[],
): CandidateManifestIssue[] {
  const issues: CandidateManifestIssue[] = [];
  const snapshot = candidate.payload.input.snapshot;
  const add = (
    code: SamplingCandidateHandoffErrorCode,
    message: string,
    path: Array<string | number>,
  ): void => {
    issues.push({ code, message, path });
  };
  if (
    candidate.revision !== 1 ||
    candidate.supersedesCandidateId !== undefined ||
    candidate.supersedesCandidateFingerprint !== undefined
  ) {
    add(
      'candidate_anchor_mismatch',
      'A sampling handoff can create only an initial replay candidate.',
      ['candidate', 'revision'],
    );
  }
  if (
    candidate.retainUntil !== manifest.retainUntil ||
    candidate.retentionPolicyId !== manifest.retentionPolicyId
  ) {
    add(
      'candidate_time_lineage_invalid',
      'Candidate retention must exactly preserve the sampling manifest policy and deadline.',
      ['candidate', 'retainUntil'],
    );
  }
  if (
    Date.parse(candidate.scanner.scannedAt) < Date.parse(manifest.collectedAt) ||
    Date.parse(candidate.submittedAt) < Date.parse(manifest.collectedAt) ||
    Date.parse(candidate.scanner.scannedAt) > Date.parse(candidate.submittedAt) ||
    Date.parse(candidate.submittedAt) >= Date.parse(manifest.retainUntil)
  ) {
    add(
      'candidate_time_lineage_invalid',
      'Replay scan and submission must follow collection and precede retention expiry.',
      ['candidate', 'submittedAt'],
    );
  }
  const expectedSourceHashes = [
    ...new Set([...manifest.sourcePayloadHashes, ...additionalSourcePayloadHashes]),
  ].sort();
  if (
    !arraysEqual(candidate.sourcePayloadHashes, expectedSourceHashes) ||
    additionalSourcePayloadHashes.some((hash) => manifest.sourcePayloadHashes.includes(hash))
  ) {
    add(
      'candidate_source_lineage_invalid',
      'Candidate sources must be the exact union of manifest and additional replay payload hashes.',
      ['candidate', 'sourcePayloadHashes'],
    );
  }
  const snapshotPayloadHashes = snapshot.sources.flatMap((source) =>
    source.payloadHash === undefined ? [] : [normalizePayloadHash(source.payloadHash)],
  );
  if (
    (manifest.dataCompleteness === 'complete' &&
      snapshotPayloadHashes.length !== snapshot.sources.length) ||
    snapshotPayloadHashes.some((hash) => !manifest.sourcePayloadHashes.includes(hash))
  ) {
    add(
      'candidate_source_lineage_invalid',
      'Snapshot source hashes must be preserved by the sampling manifest; complete samples require every source hash.',
      ['candidate', 'payload', 'input', 'snapshot', 'sources'],
    );
  }
  const observationProviders = candidate.payload.input.observation?.providers ?? [];
  const observationFingerprints = observationProviders.flatMap((provider) =>
    provider.fingerprint === undefined ? [] : [provider.fingerprint],
  );
  if (
    observationFingerprints.some(
      (fingerprint) => !manifest.providerObservationHashes.includes(fingerprint),
    )
  ) {
    add(
      'candidate_source_lineage_invalid',
      'Replay observation fingerprints must be preserved by the sampling manifest.',
      ['candidate', 'payload', 'input', 'observation', 'providers'],
    );
  }
  if (
    observationProviders.some(
      (provider) => provider.blockHash !== undefined && provider.blockHash !== manifest.blockHash,
    )
  ) {
    add(
      'candidate_anchor_mismatch',
      'Replay observation provider blocks must match the sampling manifest.',
      ['candidate', 'payload', 'input', 'observation', 'providers'],
    );
  }
  if (
    candidate.payload.dimensions.chainId !== manifest.chainId ||
    snapshot.chainId !== manifest.chainId ||
    snapshot.requestedTransactionHash !== manifest.transactionHash
  ) {
    add(
      'candidate_anchor_mismatch',
      'Candidate chain and requested transaction must match the sampling manifest.',
      ['candidate', 'payload', 'input', 'snapshot'],
    );
  }
  validateOptionalAnchor(
    snapshot.transaction?.hash,
    manifest.transactionHash,
    'Transaction hash',
    ['candidate', 'payload', 'input', 'snapshot', 'transaction', 'hash'],
    issues,
  );
  validateOptionalAnchor(
    snapshot.receipt?.transactionHash,
    manifest.transactionHash,
    'Receipt transaction hash',
    ['candidate', 'payload', 'input', 'snapshot', 'receipt', 'transactionHash'],
    issues,
  );
  validateOptionalAnchor(
    snapshot.block?.hash,
    manifest.blockHash,
    'Block hash',
    ['candidate', 'payload', 'input', 'snapshot', 'block', 'hash'],
    issues,
  );
  validateOptionalAnchor(
    snapshot.transaction?.blockNumber,
    manifest.blockNumber,
    'Transaction block number',
    ['candidate', 'payload', 'input', 'snapshot', 'transaction', 'blockNumber'],
    issues,
  );
  validateOptionalAnchor(
    snapshot.receipt?.blockNumber,
    manifest.blockNumber,
    'Receipt block number',
    ['candidate', 'payload', 'input', 'snapshot', 'receipt', 'blockNumber'],
    issues,
  );
  validateOptionalAnchor(
    snapshot.block?.number,
    manifest.blockNumber,
    'Block number',
    ['candidate', 'payload', 'input', 'snapshot', 'block', 'number'],
    issues,
  );
  validateOptionalAnchor(
    snapshot.transaction?.transactionIndex,
    manifest.transactionIndex,
    'Transaction index',
    ['candidate', 'payload', 'input', 'snapshot', 'transaction', 'transactionIndex'],
    issues,
  );
  validateOptionalAnchor(
    snapshot.receipt?.transactionIndex,
    manifest.transactionIndex,
    'Receipt transaction index',
    ['candidate', 'payload', 'input', 'snapshot', 'receipt', 'transactionIndex'],
    issues,
  );
  if (
    manifest.dataCompleteness === 'complete' &&
    (snapshot.transaction?.blockNumber === undefined ||
      snapshot.transaction.transactionIndex === undefined ||
      snapshot.receipt?.transactionIndex === undefined ||
      snapshot.block === undefined)
  ) {
    add(
      'candidate_anchor_mismatch',
      'Complete samples require transaction, receipt, block, block number, and transaction index anchors.',
      ['candidate', 'payload', 'input', 'snapshot'],
    );
  }
  const expectedDataState =
    manifest.chainCondition === 'provider_conflict'
      ? 'provider_conflict'
      : manifest.dataCompleteness;
  const expectedRouter =
    manifest.routeClass === 'complex_route' ? 'aggregator' : manifest.routeClass;
  if (
    candidate.payload.dimensions.dataState !== expectedDataState ||
    candidate.payload.dimensions.protocol !== manifest.protocol ||
    candidate.payload.dimensions.router !== expectedRouter
  ) {
    add(
      'candidate_dimension_mismatch',
      'Candidate protocol, route, and data-state dimensions must be derived from the manifest.',
      ['candidate', 'payload', 'dimensions'],
    );
  }
  return issues;
}

function validateOptionalAnchor(
  actual: number | string | undefined,
  expected: number | string,
  label: string,
  path: Array<string | number>,
  issues: CandidateManifestIssue[],
): void {
  if (actual !== undefined && actual !== expected) {
    issues.push({
      code: 'candidate_anchor_mismatch',
      message: `${label} must match the sampling manifest.`,
      path,
    });
  }
}

function normalizePayloadHash(value: string): string {
  return value.startsWith('0x') ? `sha256:${value.slice(2).toLowerCase()}` : value.toLowerCase();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! <= value);
}
