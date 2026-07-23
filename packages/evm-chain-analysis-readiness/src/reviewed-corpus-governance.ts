import {
  EVM_CHAIN_ANALYSIS_CORPUS_VERSION,
  compareCanonicalStrings,
  sha256Fingerprint,
} from '@xxyy/evm-chain-analysis-harness';

import {
  EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  MAX_REVIEWED_REPLAY_PROMOTIONS,
  MAX_REVIEWED_REPLAY_REVIEWS,
  compareIsoDate,
  datetimeMs,
} from './common.js';
import {
  replayIntakeScannerSchema,
  reviewedReplayCandidateIntakeSchema,
  reviewedReplayCandidateSchema,
  reviewedReplayCasePayloadSchema,
  reviewedReplayCorpusExportSchema,
  reviewedReplayGovernanceDecisionSchema,
  reviewedReplayPromotionSchema,
  reviewedReplayReviewInputSchema,
  reviewedReplayReviewSchema,
  reviewedReplayTombstoneInputSchema,
  reviewedReplayTombstoneSchema,
  type ReviewedReplayCandidate,
  type ReviewedReplayCandidateIntake,
  type ReviewedReplayCasePayload,
  type ReviewedReplayCorpusExport,
  type ReviewedReplayGovernanceDecision,
  type ReviewedReplayPromotion,
  type ReplayIntakeScanner,
  type ReviewedReplayReview,
  type ReviewedReplayReviewInput,
  type ReviewedReplayTombstone,
  type ReviewedReplayTombstoneInput,
} from './governance-contracts.js';

export const reviewedReplayGovernanceErrorCodes = [
  'candidate_not_approved',
  'candidate_unchanged',
  'duplicate_candidate',
  'duplicate_case',
  'duplicate_tombstone',
  'invalid_evaluation_time',
  'invalid_candidate_anchor',
  'invalid_review_time',
  'invalid_revision_time',
  'invalid_supersession',
  'invalid_tombstone',
  'promotion_time_invalid',
  'review_evidence_mismatch',
  'review_label_mismatch',
  'reviewer_not_independent',
  'review_limit_exceeded',
  'revision_submitter_mismatch',
  'scanner_fingerprint_mismatch',
  'sensitive_material_detected',
  'supersession_target_missing',
  'tombstone_target_missing',
] as const;

export type ReviewedReplayGovernanceErrorCode = (typeof reviewedReplayGovernanceErrorCodes)[number];

export class ReviewedReplayGovernanceError extends Error {
  readonly code: ReviewedReplayGovernanceErrorCode;

  constructor(code: ReviewedReplayGovernanceErrorCode, message: string) {
    super(message);
    this.name = 'ReviewedReplayGovernanceError';
    this.code = code;
  }
}

export function fingerprintReviewedReplayPayload(input: unknown): string {
  rejectSensitiveReplayMaterial(input);
  return sha256Fingerprint(reviewedReplayCasePayloadSchema.parse(input));
}

export function scanReviewedReplayPayload(
  input: unknown,
  scannedAt: string,
  scannerVersion: string,
): ReplayIntakeScanner {
  return replayIntakeScannerSchema.parse({
    credentialScan: 'passed',
    payloadFingerprint: fingerprintReviewedReplayPayload(input),
    privateDataScan: 'passed',
    scannedAt,
    scannerVersion,
  });
}

export function fingerprintReviewedReplayLabel(payloadInput: ReviewedReplayCasePayload): string {
  const payload = reviewedReplayCasePayloadSchema.parse(payloadInput);
  return sha256Fingerprint({ expected: payload.expected, groundTruth: payload.groundTruth });
}

export function createReviewedReplayCandidate(
  input: ReviewedReplayCandidateIntake,
): ReviewedReplayCandidate {
  return createCandidateRecord(input, {
    revision: 1,
  });
}

export function reviseReviewedReplayCandidate(
  previousInput: unknown,
  input: ReviewedReplayCandidateIntake,
): ReviewedReplayCandidate {
  const previous = reviewedReplayCandidateSchema.parse(previousInput);
  const normalized = reviewedReplayCandidateIntakeSchema.parse(input);
  if (normalized.submitterIdHash !== previous.submitterIdHash) {
    throw new ReviewedReplayGovernanceError(
      'revision_submitter_mismatch',
      'A replay revision must retain the original submitter identity.',
    );
  }
  if (datetimeMs(normalized.submittedAt) <= datetimeMs(previous.submittedAt)) {
    throw new ReviewedReplayGovernanceError(
      'invalid_revision_time',
      'A replay revision must be submitted after the previous revision.',
    );
  }
  const revised = createCandidateRecord(normalized, {
    revision: previous.revision + 1,
    supersedesCandidateFingerprint: previous.candidateFingerprint,
    supersedesCandidateId: previous.candidateId,
  });
  if (
    revised.payloadFingerprint === previous.payloadFingerprint &&
    arraysEqual(revised.sourcePayloadHashes, previous.sourcePayloadHashes)
  ) {
    throw new ReviewedReplayGovernanceError(
      'candidate_unchanged',
      'A replay revision must change its normalized payload or source evidence.',
    );
  }
  return revised;
}

export function recordReviewedReplayDecision(
  candidateInput: unknown,
  input: ReviewedReplayReviewInput,
): ReviewedReplayReview {
  const candidate = reviewedReplayCandidateSchema.parse(candidateInput);
  const review = reviewedReplayReviewInputSchema.parse(input);
  assertReviewCandidateConsistency(candidate, review);
  const reviewEvidence = sorted(review.evidencePayloadHashes);
  const reviewBody = {
    ...review,
    evidencePayloadHashes: reviewEvidence,
    reasonCodes: sorted(review.reasonCodes),
    candidateFingerprint: candidate.candidateFingerprint,
    candidateId: candidate.candidateId,
    candidateRevision: candidate.revision,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const reviewFingerprint = sha256Fingerprint(reviewBody);
  return reviewedReplayReviewSchema.parse({
    ...reviewBody,
    reviewFingerprint,
    reviewId: `review_${reviewFingerprint.slice(7)}`,
  });
}

export function evaluateReviewedReplayGovernance(
  candidateInput: unknown,
  reviewInputs: readonly unknown[],
  evaluatedAt: string,
): ReviewedReplayGovernanceDecision {
  const candidate = reviewedReplayCandidateSchema.parse(candidateInput);
  if (reviewInputs.length > MAX_REVIEWED_REPLAY_REVIEWS) {
    throw new ReviewedReplayGovernanceError(
      'review_limit_exceeded',
      `Replay governance accepts at most ${MAX_REVIEWED_REPLAY_REVIEWS} reviews.`,
    );
  }
  const reviews = reviewInputs.map((review) => reviewedReplayReviewSchema.parse(review));
  const evaluationTime = datetimeMs(evaluatedAt);
  if (evaluationTime < datetimeMs(candidate.submittedAt)) {
    throw new ReviewedReplayGovernanceError(
      'invalid_evaluation_time',
      'Governance evaluation cannot predate candidate submission.',
    );
  }
  const reasonCodes = new Set<ReviewedReplayGovernanceDecision['reasonCodes'][number]>();
  for (const review of reviews) {
    if (
      review.candidateId !== candidate.candidateId ||
      review.candidateFingerprint !== candidate.candidateFingerprint ||
      review.candidateRevision !== candidate.revision
    ) {
      throw new ReviewedReplayGovernanceError(
        'invalid_candidate_anchor',
        'Every review must reference the exact candidate revision being evaluated.',
      );
    }
    assertReviewCandidateConsistency(candidate, review);
    if (datetimeMs(review.reviewedAt) > evaluationTime) {
      throw new ReviewedReplayGovernanceError(
        'invalid_evaluation_time',
        'Governance evaluation cannot include a review from the future.',
      );
    }
  }
  const reviewerIds = reviews.map((review) => review.reviewerIdHash);
  const uniqueReviewers = new Set(reviewerIds);
  if (uniqueReviewers.size !== reviewerIds.length) {
    reasonCodes.add('duplicate_reviewer_identity');
  }
  const approvals = reviews.filter((review) => review.decision === 'approve');
  const rejections = reviews.filter((review) => review.decision === 'reject');
  if (datetimeMs(evaluatedAt) >= datetimeMs(candidate.retainUntil)) {
    reasonCodes.add('retention_expired');
  }
  if (approvals.length > 0 && rejections.length > 0) {
    reasonCodes.add('approval_rejection_conflict');
  }
  for (const rejection of rejections) {
    if (rejection.reasonCodes.includes('label_disagreement')) {
      reasonCodes.add('label_disagreement');
    }
    if (rejection.reasonCodes.includes('privacy_risk')) {
      reasonCodes.add('privacy_rejected');
    }
    if (rejection.reasonCodes.includes('source_integrity_failed')) {
      reasonCodes.add('source_integrity_rejected');
    }
    if (rejection.reasonCodes.includes('replay_not_deterministic')) {
      reasonCodes.add('replay_rejected');
    }
  }

  let status: ReviewedReplayGovernanceDecision['status'];
  if (reasonCodes.has('retention_expired')) {
    status = 'retention_expired';
  } else if (
    approvals.length >= 1 &&
    rejections.length === 0 &&
    uniqueReviewers.size === reviews.length
  ) {
    status = 'approved';
  } else if (
    rejections.length >= 1 &&
    approvals.length === 0 &&
    uniqueReviewers.size === reviews.length
  ) {
    status = 'rejected';
    reasonCodes.add('review_rejected');
  } else if (rejections.length > 0 || reasonCodes.has('duplicate_reviewer_identity')) {
    status = 'disputed';
  } else {
    status = 'pending_review';
    reasonCodes.add('insufficient_independent_reviews');
  }
  const reviewFingerprints = sorted([
    ...new Set(reviews.map((review) => review.reviewFingerprint)),
  ]);
  const orderedReasonCodes = sorted([...reasonCodes]);
  const decisionBody = {
    approvalCount: approvals.length,
    candidateFingerprint: candidate.candidateFingerprint,
    candidateId: candidate.candidateId,
    evaluatedAt,
    reasonCodes: orderedReasonCodes,
    rejectionCount: rejections.length,
    reviewFingerprints,
    status,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return reviewedReplayGovernanceDecisionSchema.parse({
    ...decisionBody,
    decisionFingerprint: sha256Fingerprint(decisionBody),
  });
}

export function promoteReviewedReplayCandidate(
  candidateInput: unknown,
  reviewInputs: readonly unknown[],
  promotedAt: string,
): ReviewedReplayPromotion {
  const candidate = reviewedReplayCandidateSchema.parse(candidateInput);
  const reviews = reviewInputs.map((review) => reviewedReplayReviewSchema.parse(review));
  const decision = evaluateReviewedReplayGovernance(candidate, reviews, promotedAt);
  if (decision.status !== 'approved') {
    throw new ReviewedReplayGovernanceError(
      'candidate_not_approved',
      `Reviewed replay candidate is ${decision.status}, not approved.`,
    );
  }
  const approvals = reviews
    .filter((review) => review.decision === 'approve')
    .sort((left, right) =>
      compareCanonicalStrings(left.reviewFingerprint, right.reviewFingerprint),
    );
  const lastReview = [...approvals]
    .sort((left, right) => compareIsoDate(left.reviewedAt, right.reviewedAt))
    .at(-1);
  if (
    lastReview === undefined ||
    datetimeMs(promotedAt) < datetimeMs(lastReview.reviewedAt) ||
    datetimeMs(promotedAt) >= datetimeMs(candidate.retainUntil)
  ) {
    throw new ReviewedReplayGovernanceError(
      'promotion_time_invalid',
      'Promotion must happen after the owner approval and before retention expiry.',
    );
  }
  const reviewerIdHash = sha256Fingerprint({
    reviewers: sorted(approvals.map((review) => review.reviewerIdHash)),
  });
  const reviewedCase = {
    ...candidate.payload,
    review: {
      reviewedAt: lastReview.reviewedAt,
      reviewerIdHash,
      sourcePayloadHashes: sorted(candidate.sourcePayloadHashes),
      tier: 'reviewed' as const,
    },
  };
  const promotionBody = {
    approvalReviewFingerprints: approvals.map((review) => review.reviewFingerprint),
    candidateFingerprint: candidate.candidateFingerprint,
    candidateId: candidate.candidateId,
    case: reviewedCase,
    promotedAt,
    retainUntil: candidate.retainUntil,
    ...(candidate.supersedesCandidateId === undefined
      ? {}
      : { supersedesCandidateId: candidate.supersedesCandidateId }),
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return reviewedReplayPromotionSchema.parse({
    ...promotionBody,
    promotionFingerprint: sha256Fingerprint(promotionBody),
  });
}

export function createReviewedReplayTombstone(
  promotionInput: unknown,
  input: ReviewedReplayTombstoneInput,
): ReviewedReplayTombstone {
  const promotion = reviewedReplayPromotionSchema.parse(promotionInput);
  const tombstone = reviewedReplayTombstoneInputSchema.parse(input);
  if (datetimeMs(tombstone.deletedAt) < datetimeMs(promotion.promotedAt)) {
    throw new ReviewedReplayGovernanceError(
      'invalid_tombstone',
      'A replay tombstone cannot predate promotion.',
    );
  }
  if (tombstone.replacementCandidateId === promotion.candidateId) {
    throw new ReviewedReplayGovernanceError(
      'invalid_tombstone',
      'A supersession tombstone cannot point to the same candidate.',
    );
  }
  const tombstoneBody = {
    ...tombstone,
    candidateFingerprint: promotion.candidateFingerprint,
    candidateId: promotion.candidateId,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const tombstoneFingerprint = sha256Fingerprint(tombstoneBody);
  return reviewedReplayTombstoneSchema.parse({
    ...tombstoneBody,
    tombstoneFingerprint,
    tombstoneId: `tombstone_${tombstoneFingerprint.slice(7)}`,
  });
}

export interface BuildReviewedReplayCorpusInput {
  corpusId: string;
  description: string;
  exportedAt: string;
  promotions: readonly unknown[];
  tombstones?: readonly unknown[];
}

export function buildReviewedReplayCorpus(
  input: BuildReviewedReplayCorpusInput,
): ReviewedReplayCorpusExport {
  if (input.promotions.length > MAX_REVIEWED_REPLAY_PROMOTIONS) {
    throw new ReviewedReplayGovernanceError(
      'duplicate_candidate',
      `A reviewed corpus export accepts at most ${MAX_REVIEWED_REPLAY_PROMOTIONS} promotions.`,
    );
  }
  if ((input.tombstones?.length ?? 0) > MAX_REVIEWED_REPLAY_PROMOTIONS) {
    throw new ReviewedReplayGovernanceError(
      'duplicate_tombstone',
      `A reviewed corpus export accepts at most ${MAX_REVIEWED_REPLAY_PROMOTIONS} tombstones.`,
    );
  }
  const promotions = input.promotions
    .map((promotion) => reviewedReplayPromotionSchema.parse(promotion))
    .sort((left, right) => compareCanonicalStrings(left.candidateId, right.candidateId));
  const tombstones = (input.tombstones ?? [])
    .map((tombstone) => reviewedReplayTombstoneSchema.parse(tombstone))
    .sort((left, right) => compareCanonicalStrings(left.tombstoneId, right.tombstoneId));
  const promotionById = new Map<string, ReviewedReplayPromotion>();
  for (const promotion of promotions) {
    if (promotionById.has(promotion.candidateId)) {
      throw new ReviewedReplayGovernanceError(
        'duplicate_candidate',
        `Duplicate promoted candidate ${promotion.candidateId}.`,
      );
    }
    promotionById.set(promotion.candidateId, promotion);
  }
  for (const promotion of promotions) {
    if (promotion.supersedesCandidateId !== undefined) {
      const superseded = promotionById.get(promotion.supersedesCandidateId);
      if (superseded === undefined) {
        throw new ReviewedReplayGovernanceError(
          'supersession_target_missing',
          `Missing superseded candidate ${promotion.supersedesCandidateId}.`,
        );
      }
      if (datetimeMs(promotion.promotedAt) < datetimeMs(superseded.promotedAt)) {
        throw new ReviewedReplayGovernanceError(
          'invalid_supersession',
          'A replacement promotion cannot predate the promotion it supersedes.',
        );
      }
    }
  }
  const tombstoneByCandidate = new Map<string, ReviewedReplayTombstone>();
  for (const tombstone of tombstones) {
    const promotion = promotionById.get(tombstone.candidateId);
    if (promotion === undefined) {
      throw new ReviewedReplayGovernanceError(
        'tombstone_target_missing',
        `Missing tombstone candidate ${tombstone.candidateId}.`,
      );
    }
    if (promotion.candidateFingerprint !== tombstone.candidateFingerprint) {
      throw new ReviewedReplayGovernanceError(
        'invalid_tombstone',
        'Tombstone candidate fingerprint does not match the promoted revision.',
      );
    }
    if (tombstoneByCandidate.has(tombstone.candidateId)) {
      throw new ReviewedReplayGovernanceError(
        'duplicate_tombstone',
        `Candidate ${tombstone.candidateId} has multiple deletion tombstones.`,
      );
    }
    if (tombstone.replacementCandidateId !== undefined) {
      const replacement = promotionById.get(tombstone.replacementCandidateId);
      if (replacement === undefined) {
        throw new ReviewedReplayGovernanceError(
          'supersession_target_missing',
          `Missing replacement candidate ${tombstone.replacementCandidateId}.`,
        );
      }
      if (replacement.supersedesCandidateId !== tombstone.candidateId) {
        throw new ReviewedReplayGovernanceError(
          'invalid_tombstone',
          'Supersession tombstone replacement must point back to the deleted candidate.',
        );
      }
      if (datetimeMs(tombstone.deletedAt) < datetimeMs(replacement.promotedAt)) {
        throw new ReviewedReplayGovernanceError(
          'invalid_tombstone',
          'A supersession tombstone cannot become effective before its replacement promotion.',
        );
      }
    }
    tombstoneByCandidate.set(tombstone.candidateId, tombstone);
  }
  const supersededIds = new Set(
    promotions
      .filter((promotion) => datetimeMs(promotion.promotedAt) <= datetimeMs(input.exportedAt))
      .flatMap((promotion) =>
        promotion.supersedesCandidateId === undefined ? [] : [promotion.supersedesCandidateId],
      ),
  );
  const activeCases = [];
  const included: ReviewedReplayCorpusExport['included'] = [];
  const excluded: ReviewedReplayCorpusExport['excluded'] = [];
  for (const promotion of promotions) {
    const tombstone = tombstoneByCandidate.get(promotion.candidateId);
    let reason: ReviewedReplayCorpusExport['excluded'][number]['reason'] | undefined;
    if (datetimeMs(promotion.promotedAt) > datetimeMs(input.exportedAt)) {
      reason = 'not_yet_effective';
    } else if (
      tombstone !== undefined &&
      datetimeMs(tombstone.deletedAt) <= datetimeMs(input.exportedAt)
    ) {
      reason = tombstone.reason === 'superseded' ? 'superseded' : 'deleted';
    } else if (supersededIds.has(promotion.candidateId)) {
      reason = 'superseded';
    } else if (datetimeMs(promotion.retainUntil) <= datetimeMs(input.exportedAt)) {
      reason = 'retention_expired';
    }
    if (reason === undefined) {
      activeCases.push(promotion.case);
      included.push({
        approvalReviewFingerprints: promotion.approvalReviewFingerprints,
        candidateFingerprint: promotion.candidateFingerprint,
        candidateId: promotion.candidateId,
        caseId: promotion.case.id,
        promotionFingerprint: promotion.promotionFingerprint,
      });
    } else {
      excluded.push({ candidateId: promotion.candidateId, reason });
    }
  }
  const caseIds = activeCases.map((item) => item.id);
  if (new Set(caseIds).size !== caseIds.length) {
    throw new ReviewedReplayGovernanceError(
      'duplicate_case',
      'Active reviewed promotions contain duplicate replay case ids.',
    );
  }
  activeCases.sort((left, right) => compareCanonicalStrings(left.id, right.id));
  included.sort((left, right) => compareCanonicalStrings(left.caseId, right.caseId));
  excluded.sort((left, right) => compareCanonicalStrings(left.candidateId, right.candidateId));
  const corpus = {
    cases: activeCases,
    corpusId: input.corpusId,
    createdAt: input.exportedAt,
    description: input.description,
    version: EVM_CHAIN_ANALYSIS_CORPUS_VERSION,
  };
  const exportBody = {
    corpus,
    excluded,
    exportedAt: input.exportedAt,
    included,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return reviewedReplayCorpusExportSchema.parse({
    ...exportBody,
    exportFingerprint: sha256Fingerprint(exportBody),
  });
}

function createCandidateRecord(
  input: ReviewedReplayCandidateIntake,
  revision: {
    revision: number;
    supersedesCandidateFingerprint?: string;
    supersedesCandidateId?: string;
  },
): ReviewedReplayCandidate {
  rejectSensitiveReplayMaterial(input.payload);
  const normalized = reviewedReplayCandidateIntakeSchema.parse(input);
  const payloadFingerprint = sha256Fingerprint(normalized.payload);
  if (normalized.scanner.payloadFingerprint !== payloadFingerprint) {
    throw new ReviewedReplayGovernanceError(
      'scanner_fingerprint_mismatch',
      'Scanner attestation does not cover the normalized replay payload.',
    );
  }
  const candidateBody = {
    ...normalized,
    sourcePayloadHashes: sorted(normalized.sourcePayloadHashes),
    payloadFingerprint,
    revision: revision.revision,
    status: 'pending_review' as const,
    ...(revision.supersedesCandidateFingerprint === undefined
      ? {}
      : { supersedesCandidateFingerprint: revision.supersedesCandidateFingerprint }),
    ...(revision.supersedesCandidateId === undefined
      ? {}
      : { supersedesCandidateId: revision.supersedesCandidateId }),
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const candidateFingerprint = sha256Fingerprint(candidateBody);
  return reviewedReplayCandidateSchema.parse({
    ...candidateBody,
    candidateFingerprint,
    candidateId: `reviewed_${candidateFingerprint.slice(7)}`,
  });
}

function assertReviewCandidateConsistency(
  candidate: ReviewedReplayCandidate,
  review: ReviewedReplayReviewInput,
): void {
  if (review.reviewerIdHash === candidate.submitterIdHash) {
    throw new ReviewedReplayGovernanceError(
      'reviewer_not_independent',
      'The candidate submitter cannot review the same replay candidate.',
    );
  }
  const reviewedAt = datetimeMs(review.reviewedAt);
  if (
    reviewedAt < datetimeMs(candidate.submittedAt) ||
    reviewedAt >= datetimeMs(candidate.retainUntil)
  ) {
    throw new ReviewedReplayGovernanceError(
      'invalid_review_time',
      'Replay review must occur after submission and before retention expiry.',
    );
  }
  const expectedLabelFingerprint = fingerprintReviewedReplayLabel(candidate.payload);
  if (review.decision === 'approve' && review.labelFingerprint !== expectedLabelFingerprint) {
    throw new ReviewedReplayGovernanceError(
      'review_label_mismatch',
      'Approval label fingerprint does not match the proposed reviewed case label.',
    );
  }
  if (
    review.reasonCodes.includes('label_disagreement') &&
    (review.suggestedGroundTruth === undefined ||
      review.suggestedGroundTruth === candidate.payload.groundTruth)
  ) {
    throw new ReviewedReplayGovernanceError(
      'review_label_mismatch',
      'A label disagreement requires a distinct suggested ground-truth label.',
    );
  }
  const candidateEvidence = sorted(candidate.sourcePayloadHashes);
  const reviewEvidence = sorted(review.evidencePayloadHashes);
  if (
    reviewEvidence.some((fingerprint) => !candidateEvidence.includes(fingerprint)) ||
    (review.decision === 'approve' && !arraysEqual(candidateEvidence, reviewEvidence))
  ) {
    throw new ReviewedReplayGovernanceError(
      'review_evidence_mismatch',
      'Review evidence must be drawn from candidate sources; approval must cover all sources.',
    );
  }
}

function rejectSensitiveReplayMaterial(input: unknown): void {
  const findings = new Set<string>();
  const forbiddenKeys = new Set([
    'apikey',
    'authorization',
    'cookie',
    'credential',
    'credentials',
    'endpoint',
    'headers',
    'mnemonic',
    'password',
    'privatekey',
    'secret',
    'seedphrase',
  ]);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value === 'string') {
      if (/https?:\/\//iu.test(value)) {
        findings.add('source_url_present');
      }
      if (/\bbearer\s+[a-z0-9._~+/-]+=*|\bsk-[a-z0-9_-]{12,}/iu.test(value)) {
        findings.add('credential_value_present');
      }
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
      if (
        forbiddenKeys.has(normalizedKey) ||
        normalizedKey.includes('endpoint') ||
        normalizedKey.endsWith('apikey') ||
        normalizedKey.endsWith('privatekey')
      ) {
        findings.add('credential_field_present');
      }
      if (normalizedKey === 'url' || normalizedKey.endsWith('url')) {
        findings.add('source_url_present');
      }
      visit(item);
    }
  };
  visit(input);
  if (findings.size > 0) {
    throw new ReviewedReplayGovernanceError(
      'sensitive_material_detected',
      `Reviewed replay payload failed sensitive-material checks: ${sorted([...findings]).join(', ')}.`,
    );
  }
}

function sorted<T extends string>(values: readonly T[]): T[] {
  return [...values].sort(compareCanonicalStrings);
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
