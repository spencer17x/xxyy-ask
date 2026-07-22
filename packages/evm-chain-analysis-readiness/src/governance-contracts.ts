import { z } from 'zod';

import {
  chainAnalysisCorpusCaseSchema,
  chainAnalysisCorpusSchema,
  chainAnalysisGroundTruthLabels,
  sha256Fingerprint,
  type ChainAnalysisCorpusCase,
} from '@xxyy/evm-chain-analysis-harness';

import {
  EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  MAX_REVIEWED_REPLAY_PROMOTIONS,
  MAX_REVIEWED_REPLAY_REVIEWS,
  candidateIdSchema,
  fingerprintSchema,
  reviewIdSchema,
  stableIdSchema,
  tombstoneIdSchema,
  uniqueValues,
} from './common.js';

const PLACEHOLDER_FINGERPRINT = `sha256:${'0'.repeat(64)}`;
const PLACEHOLDER_REVIEW = {
  reviewedAt: '2000-01-01T00:00:00.000Z',
  reviewerIdHash: PLACEHOLDER_FINGERPRINT,
  sourcePayloadHashes: [PLACEHOLDER_FINGERPRINT],
  tier: 'reviewed' as const,
};

export type ReviewedReplayCasePayload = Omit<ChainAnalysisCorpusCase, 'review'>;

export const reviewedReplayCasePayloadSchema = z
  .unknown()
  .transform<ReviewedReplayCasePayload>((value, context) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.hasOwn(value, 'review')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A reviewable replay payload must be an object without review metadata.',
        path: [],
      });
      return z.NEVER;
    }
    const parsed = chainAnalysisCorpusCaseSchema.safeParse({
      ...(value as Record<string, unknown>),
      review: PLACEHOLDER_REVIEW,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path[0] === 'review' ? [] : issue.path,
        });
      }
      return z.NEVER;
    }
    const { review: _review, ...payload } = parsed.data;
    return payload;
  });

export const reviewedReplaySensitiveFindingCodes = [
  'credential_field_present',
  'credential_value_present',
  'source_url_present',
] as const;

export const replayIntakeScannerSchema = z
  .object({
    credentialScan: z.literal('passed'),
    payloadFingerprint: fingerprintSchema,
    privateDataScan: z.literal('passed'),
    scannedAt: z.string().datetime({ offset: true }),
    scannerVersion: stableIdSchema,
  })
  .strict();

const candidateCoreShape = {
  payload: reviewedReplayCasePayloadSchema,
  retainUntil: z.string().datetime({ offset: true }),
  retentionPolicyId: stableIdSchema,
  scanner: replayIntakeScannerSchema,
  sourcePayloadHashes: z
    .array(fingerprintSchema)
    .min(1)
    .max(16)
    .refine(uniqueValues, 'Source payload hashes must be unique.'),
  submittedAt: z.string().datetime({ offset: true }),
  submitterIdHash: fingerprintSchema,
} as const;

export const reviewedReplayCandidateIntakeSchema = z.object(candidateCoreShape).strict();

export const reviewedReplayCandidateSchema = z
  .object({
    ...candidateCoreShape,
    candidateFingerprint: fingerprintSchema,
    candidateId: candidateIdSchema,
    payloadFingerprint: fingerprintSchema,
    revision: z.number().int().positive().max(1_000),
    status: z.literal('pending_review'),
    supersedesCandidateFingerprint: fingerprintSchema.optional(),
    supersedesCandidateId: candidateIdSchema.optional(),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.candidateId !== `reviewed_${candidate.candidateFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate id must be derived from its candidate fingerprint.',
        path: ['candidateId'],
      });
    }
    if (candidate.payloadFingerprint !== candidate.scanner.payloadFingerprint) {
      context.addIssue({
        code: 'custom',
        message: 'Scanner attestation must cover the normalized replay payload.',
        path: ['scanner', 'payloadFingerprint'],
      });
    }
    if (candidate.payloadFingerprint !== sha256Fingerprint(candidate.payload)) {
      context.addIssue({
        code: 'custom',
        message: 'Payload fingerprint must cover the normalized replay payload.',
        path: ['payloadFingerprint'],
      });
    }
    if (Date.parse(candidate.scanner.scannedAt) > Date.parse(candidate.submittedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Payload scan cannot happen after candidate submission.',
        path: ['scanner', 'scannedAt'],
      });
    }
    if (Date.parse(candidate.retainUntil) <= Date.parse(candidate.submittedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate retention must extend beyond submission.',
        path: ['retainUntil'],
      });
    }
    const hasSupersededId = candidate.supersedesCandidateId !== undefined;
    const hasSupersededFingerprint = candidate.supersedesCandidateFingerprint !== undefined;
    if (hasSupersededId !== hasSupersededFingerprint) {
      context.addIssue({
        code: 'custom',
        message: 'Superseded candidate id and fingerprint must be supplied together.',
        path: ['supersedesCandidateId'],
      });
    }
    if (candidate.revision === 1 && hasSupersededId) {
      context.addIssue({
        code: 'custom',
        message: 'Initial candidates cannot supersede another revision.',
        path: ['revision'],
      });
    }
    if (candidate.revision > 1 && !hasSupersededId) {
      context.addIssue({
        code: 'custom',
        message: 'Revised candidates must identify the superseded revision.',
        path: ['supersedesCandidateId'],
      });
    }
    const { candidateFingerprint, candidateId: _candidateId, ...fingerprintPayload } = candidate;
    if (candidateFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate fingerprint must cover the normalized candidate record.',
        path: ['candidateFingerprint'],
      });
    }
  });

export const reviewedReplayReviewDecisions = ['approve', 'reject'] as const;
export const reviewedReplayReviewReasonCodes = [
  'duplicate_or_superseded',
  'evidence_insufficient',
  'label_disagreement',
  'privacy_risk',
  'replay_not_deterministic',
  'source_integrity_failed',
  'unsupported_scope',
] as const;

const reviewAttestationsSchema = z
  .object({
    independentReview: z.boolean(),
    payloadReplayed: z.boolean(),
    privacyVerified: z.boolean(),
    sourceIntegrityVerified: z.boolean(),
  })
  .strict();

export const reviewedReplayReviewInputSchema = z
  .object({
    attestations: reviewAttestationsSchema,
    decision: z.enum(reviewedReplayReviewDecisions),
    evidencePayloadHashes: z
      .array(fingerprintSchema)
      .min(1)
      .max(16)
      .refine(uniqueValues, 'Review evidence hashes must be unique.'),
    labelFingerprint: fingerprintSchema,
    noteHash: fingerprintSchema.optional(),
    reasonCodes: z
      .array(z.enum(reviewedReplayReviewReasonCodes))
      .max(reviewedReplayReviewReasonCodes.length)
      .refine(uniqueValues, 'Review reason codes must be unique.'),
    reviewedAt: z.string().datetime({ offset: true }),
    reviewerIdHash: fingerprintSchema,
    suggestedGroundTruth: z.enum(chainAnalysisGroundTruthLabels).optional(),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.decision === 'approve') {
      if (review.reasonCodes.length > 0 || review.suggestedGroundTruth !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Approval cannot carry rejection reasons or a replacement label.',
          path: ['decision'],
        });
      }
      if (Object.values(review.attestations).some((value) => value !== true)) {
        context.addIssue({
          code: 'custom',
          message: 'Approval requires every independent review attestation.',
          path: ['attestations'],
        });
      }
    } else {
      if (review.reasonCodes.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Rejection requires at least one stable reason code.',
          path: ['reasonCodes'],
        });
      }
      if (
        review.reasonCodes.includes('label_disagreement') !==
        (review.suggestedGroundTruth !== undefined)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'A replacement label is required exactly for label disagreement.',
          path: ['suggestedGroundTruth'],
        });
      }
    }
  });

export const reviewedReplayReviewSchema = z
  .object({
    ...reviewedReplayReviewInputSchema.shape,
    candidateFingerprint: fingerprintSchema,
    candidateId: candidateIdSchema,
    candidateRevision: z.number().int().positive().max(1_000),
    reviewFingerprint: fingerprintSchema,
    reviewId: reviewIdSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.reviewId !== `review_${review.reviewFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Review id must be derived from its review fingerprint.',
        path: ['reviewId'],
      });
    }
    if (review.decision === 'approve') {
      if (review.reasonCodes.length > 0 || review.suggestedGroundTruth !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Approval cannot carry rejection reasons or a replacement label.',
          path: ['decision'],
        });
      }
      if (Object.values(review.attestations).some((value) => value !== true)) {
        context.addIssue({
          code: 'custom',
          message: 'Approval requires every independent review attestation.',
          path: ['attestations'],
        });
      }
    } else {
      if (review.reasonCodes.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Rejection requires at least one stable reason code.',
          path: ['reasonCodes'],
        });
      }
      if (
        review.reasonCodes.includes('label_disagreement') !==
        (review.suggestedGroundTruth !== undefined)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'A replacement label is required exactly for label disagreement.',
          path: ['suggestedGroundTruth'],
        });
      }
    }
    const { reviewFingerprint, reviewId: _reviewId, ...fingerprintPayload } = review;
    if (reviewFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Review fingerprint must cover the normalized review record.',
        path: ['reviewFingerprint'],
      });
    }
  });

export const reviewedReplayGovernanceStatuses = [
  'approved',
  'disputed',
  'pending_review',
  'rejected',
  'retention_expired',
] as const;
export const reviewedReplayGovernanceReasonCodes = [
  'approval_rejection_conflict',
  'duplicate_reviewer_identity',
  'insufficient_independent_reviews',
  'label_disagreement',
  'privacy_rejected',
  'replay_rejected',
  'retention_expired',
  'source_integrity_rejected',
  'two_rejections',
] as const;

export const reviewedReplayGovernanceDecisionSchema = z
  .object({
    approvalCount: z.number().int().nonnegative().max(MAX_REVIEWED_REPLAY_REVIEWS),
    candidateFingerprint: fingerprintSchema,
    candidateId: candidateIdSchema,
    decisionFingerprint: fingerprintSchema,
    evaluatedAt: z.string().datetime({ offset: true }),
    reasonCodes: z
      .array(z.enum(reviewedReplayGovernanceReasonCodes))
      .max(reviewedReplayGovernanceReasonCodes.length)
      .refine(uniqueValues, 'Governance reason codes must be unique.'),
    rejectionCount: z.number().int().nonnegative().max(MAX_REVIEWED_REPLAY_REVIEWS),
    reviewFingerprints: z
      .array(fingerprintSchema)
      .max(MAX_REVIEWED_REPLAY_REVIEWS)
      .refine(uniqueValues, 'Review fingerprints must be unique.'),
    status: z.enum(reviewedReplayGovernanceStatuses),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .refine(
    ({ decisionFingerprint, ...fingerprintPayload }) =>
      decisionFingerprint === sha256Fingerprint(fingerprintPayload),
    {
      message: 'Decision fingerprint must cover the normalized governance decision.',
      path: ['decisionFingerprint'],
    },
  );

export const reviewedReplayPromotionSchema = z
  .object({
    approvalReviewFingerprints: z
      .array(fingerprintSchema)
      .min(2)
      .max(MAX_REVIEWED_REPLAY_REVIEWS)
      .refine(uniqueValues, 'Promotion approvals must be unique.'),
    candidateFingerprint: fingerprintSchema,
    candidateId: candidateIdSchema,
    case: chainAnalysisCorpusCaseSchema,
    promotedAt: z.string().datetime({ offset: true }),
    promotionFingerprint: fingerprintSchema,
    retainUntil: z.string().datetime({ offset: true }),
    supersedesCandidateId: candidateIdSchema.optional(),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((promotion, context) => {
    if (promotion.case.review.tier !== 'reviewed') {
      context.addIssue({
        code: 'custom',
        message: 'Promoted replay cases must use reviewed governance metadata.',
        path: ['case', 'review', 'tier'],
      });
    }
    const { promotionFingerprint, ...fingerprintPayload } = promotion;
    if (promotionFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Promotion fingerprint must cover the normalized promotion record.',
        path: ['promotionFingerprint'],
      });
    }
  });

export const reviewedReplayTombstoneReasons = [
  'legal_or_policy_request',
  'privacy_issue',
  'retention_expired',
  'source_withdrawn',
  'superseded',
] as const;

export const reviewedReplayTombstoneInputSchema = z
  .object({
    deletedAt: z.string().datetime({ offset: true }),
    deletedByHash: fingerprintSchema,
    reason: z.enum(reviewedReplayTombstoneReasons),
    replacementCandidateId: candidateIdSchema.optional(),
  })
  .strict()
  .superRefine((tombstone, context) => {
    if ((tombstone.reason === 'superseded') !== (tombstone.replacementCandidateId !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Supersession tombstones require exactly one replacement candidate.',
        path: ['replacementCandidateId'],
      });
    }
  });

export const reviewedReplayTombstoneSchema = z
  .object({
    ...reviewedReplayTombstoneInputSchema.shape,
    candidateFingerprint: fingerprintSchema,
    candidateId: candidateIdSchema,
    tombstoneFingerprint: fingerprintSchema,
    tombstoneId: tombstoneIdSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((tombstone, context) => {
    if (tombstone.tombstoneId !== `tombstone_${tombstone.tombstoneFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Tombstone id must be derived from its fingerprint.',
        path: ['tombstoneId'],
      });
    }
    if ((tombstone.reason === 'superseded') !== (tombstone.replacementCandidateId !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Supersession tombstones require exactly one replacement candidate.',
        path: ['replacementCandidateId'],
      });
    }
    const { tombstoneFingerprint, tombstoneId: _tombstoneId, ...fingerprintPayload } = tombstone;
    if (tombstoneFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Tombstone fingerprint must cover the normalized tombstone record.',
        path: ['tombstoneFingerprint'],
      });
    }
  });

export const reviewedReplayExportExclusionReasons = [
  'deleted',
  'not_yet_effective',
  'retention_expired',
  'superseded',
] as const;

const replayExportExclusionSchema = z
  .object({
    candidateId: candidateIdSchema,
    reason: z.enum(reviewedReplayExportExclusionReasons),
  })
  .strict();

const replayExportInclusionSchema = z
  .object({
    approvalReviewFingerprints: z
      .array(fingerprintSchema)
      .min(2)
      .max(MAX_REVIEWED_REPLAY_REVIEWS)
      .refine(uniqueValues, 'Included promotion approvals must be unique.'),
    candidateFingerprint: fingerprintSchema,
    candidateId: candidateIdSchema,
    caseId: stableIdSchema,
    promotionFingerprint: fingerprintSchema,
  })
  .strict();

export const reviewedReplayCorpusExportSchema = z
  .object({
    corpus: chainAnalysisCorpusSchema,
    excluded: z
      .array(replayExportExclusionSchema)
      .max(MAX_REVIEWED_REPLAY_PROMOTIONS)
      .refine(
        (items) => uniqueValues(items.map((item) => item.candidateId)),
        'Each candidate can be excluded only once.',
      ),
    included: z
      .array(replayExportInclusionSchema)
      .max(MAX_REVIEWED_REPLAY_PROMOTIONS)
      .superRefine((items, context) => {
        if (!uniqueValues(items.map((item) => item.candidateId))) {
          context.addIssue({
            code: 'custom',
            message: 'Each candidate can be included only once.',
          });
        }
        if (!uniqueValues(items.map((item) => item.caseId))) {
          context.addIssue({
            code: 'custom',
            message: 'Each replay case can be included only once.',
          });
        }
      }),
    exportFingerprint: fingerprintSchema,
    exportedAt: z.string().datetime({ offset: true }),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((corpusExport, context) => {
    if (corpusExport.corpus.createdAt !== corpusExport.exportedAt) {
      context.addIssue({
        code: 'custom',
        message: 'Exported corpus creation time must match the export snapshot time.',
        path: ['corpus', 'createdAt'],
      });
    }
    if (corpusExport.corpus.cases.some((item) => item.review.tier !== 'reviewed')) {
      context.addIssue({
        code: 'custom',
        message: 'Governed corpus exports may contain only reviewed cases.',
        path: ['corpus', 'cases'],
      });
    }
    if (
      corpusExport.included.length !== corpusExport.corpus.cases.length ||
      corpusExport.included.some(
        (item, index) => item.caseId !== corpusExport.corpus.cases[index]?.id,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Included governance lineage must align with ordered corpus cases.',
        path: ['included'],
      });
    }
    const excludedIds = new Set(corpusExport.excluded.map((item) => item.candidateId));
    if (corpusExport.included.some((item) => excludedIds.has(item.candidateId))) {
      context.addIssue({
        code: 'custom',
        message: 'A candidate cannot be both included and excluded in one export snapshot.',
        path: ['included'],
      });
    }
    const { exportFingerprint, ...fingerprintPayload } = corpusExport;
    if (exportFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Export fingerprint must cover the normalized corpus export.',
        path: ['exportFingerprint'],
      });
    }
  });

export type ReviewedReplayCandidateIntake = z.input<typeof reviewedReplayCandidateIntakeSchema>;
export type ReplayIntakeScanner = z.output<typeof replayIntakeScannerSchema>;
export type ReviewedReplayCandidate = z.output<typeof reviewedReplayCandidateSchema>;
export type ReviewedReplayReviewInput = z.input<typeof reviewedReplayReviewInputSchema>;
export type ReviewedReplayReview = z.output<typeof reviewedReplayReviewSchema>;
export type ReviewedReplayGovernanceStatus = (typeof reviewedReplayGovernanceStatuses)[number];
export type ReviewedReplayGovernanceDecision = z.output<
  typeof reviewedReplayGovernanceDecisionSchema
>;
export type ReviewedReplayPromotion = z.output<typeof reviewedReplayPromotionSchema>;
export type ReviewedReplayTombstoneInput = z.input<typeof reviewedReplayTombstoneInputSchema>;
export type ReviewedReplayTombstone = z.output<typeof reviewedReplayTombstoneSchema>;
export type ReviewedReplayCorpusExport = z.output<typeof reviewedReplayCorpusExportSchema>;
