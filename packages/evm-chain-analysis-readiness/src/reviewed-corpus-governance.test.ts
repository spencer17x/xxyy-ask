import { describe, expect, it } from 'vitest';

import {
  contractHash,
  createContractOnlyReviewedPayload,
  createGovernedContractCorpus,
} from './fixtures/contract-fixtures.test-helper.js';
import { reviewedReplayCandidateSchema } from './governance-contracts.js';
import {
  buildReviewedReplayCorpus,
  createReviewedReplayCandidate,
  createReviewedReplayTombstone,
  evaluateReviewedReplayGovernance,
  fingerprintReviewedReplayLabel,
  fingerprintReviewedReplayPayload,
  promoteReviewedReplayCandidate,
  recordReviewedReplayDecision,
  reviseReviewedReplayCandidate,
  scanReviewedReplayPayload,
} from './reviewed-corpus-governance.js';
import type { ReviewedReplayGovernanceError } from './reviewed-corpus-governance.js';

describe('reviewed replay corpus governance', () => {
  it('content-addresses sanitized intake and rejects sensitive material or stale scanner claims', async () => {
    const payload = await createContractOnlyReviewedPayload();
    const scanner = scanReviewedReplayPayload(payload, '2026-07-22T00:30:00.000Z', 'scanner-v1');
    const input = {
      payload,
      retainUntil: '2027-07-22T00:00:00.000Z',
      retentionPolicyId: 'reviewed-replay-365d',
      scanner,
      sourcePayloadHashes: [contractHash('source-a')],
      submittedAt: '2026-07-22T01:00:00.000Z',
      submitterIdHash: contractHash('submitter'),
    };
    const first = createReviewedReplayCandidate(input);
    const second = createReviewedReplayCandidate(input);

    expect(first).toEqual(second);
    expect(first.candidateId).toBe(`reviewed_${first.candidateFingerprint.slice(7)}`);
    expect(first.payloadFingerprint).toBe(fingerprintReviewedReplayPayload(payload));
    expect(
      reviewedReplayCandidateSchema.safeParse({ ...first, retentionPolicyId: 'tampered' }).success,
    ).toBe(false);
    expect(() =>
      fingerprintReviewedReplayPayload({
        ...payload,
        endpoint: 'https://private-rpc.invalid/api-key',
      }),
    ).toThrowError(expectGovernanceCode('sensitive_material_detected'));
    expect(() =>
      createReviewedReplayCandidate({
        ...input,
        scanner: { ...scanner, payloadFingerprint: contractHash('different-payload') },
      }),
    ).toThrowError(expectGovernanceCode('scanner_fingerprint_mismatch'));
  });

  it('accepts one owner approval and preserves deterministic governance lineage', async () => {
    const { candidate, corpusExport, promotion, reviews } = await createGovernedContractCorpus();
    const ownerDecision = evaluateReviewedReplayGovernance(
      candidate,
      [reviews[0]!],
      '2026-07-22T04:00:00.000Z',
    );
    const ownerPromotion = promoteReviewedReplayCandidate(
      candidate,
      [reviews[0]!],
      '2026-07-22T04:00:00.000Z',
    );
    const decision = evaluateReviewedReplayGovernance(
      candidate,
      [...reviews].reverse(),
      '2026-07-22T04:00:00.000Z',
    );

    expect(ownerDecision).toMatchObject({
      approvalCount: 1,
      reasonCodes: [],
      rejectionCount: 0,
      status: 'approved',
    });
    expect(ownerPromotion.approvalReviewFingerprints).toEqual([reviews[0]!.reviewFingerprint]);
    expect(decision).toMatchObject({
      approvalCount: 2,
      reasonCodes: [],
      rejectionCount: 0,
      status: 'approved',
    });
    expect(promotion.case.review).toMatchObject({
      tier: 'reviewed',
      sourcePayloadHashes: candidate.sourcePayloadHashes,
    });
    expect(corpusExport.corpus.cases).toHaveLength(1);
    expect(corpusExport.included).toEqual([
      {
        approvalReviewFingerprints: promotion.approvalReviewFingerprints,
        candidateFingerprint: candidate.candidateFingerprint,
        candidateId: candidate.candidateId,
        caseId: promotion.case.id,
        promotionFingerprint: promotion.promotionFingerprint,
      },
    ]);
    expect(
      buildReviewedReplayCorpus({
        corpusId: corpusExport.corpus.corpusId,
        description: corpusExport.corpus.description,
        exportedAt: corpusExport.exportedAt,
        promotions: [promotion],
      }),
    ).toEqual(corpusExport);
  });

  it('does not count the submitter or duplicate reviewer identities as independent review', async () => {
    const { candidate, payload, sourcePayloadHashes } = await createGovernedContractCorpus();
    const base = {
      attestations: {
        independentReview: true,
        payloadReplayed: true,
        privacyVerified: true,
        sourceIntegrityVerified: true,
      },
      decision: 'approve' as const,
      evidencePayloadHashes: sourcePayloadHashes,
      labelFingerprint: fingerprintReviewedReplayLabel(payload),
      reasonCodes: [],
    };
    expect(() =>
      recordReviewedReplayDecision(candidate, {
        ...base,
        reviewedAt: '2026-07-22T02:00:00.000Z',
        reviewerIdHash: candidate.submitterIdHash,
      }),
    ).toThrowError(expectGovernanceCode('reviewer_not_independent'));

    const duplicateReviewer = contractHash('one-reviewer');
    const reviews = [
      recordReviewedReplayDecision(candidate, {
        ...base,
        reviewedAt: '2026-07-22T02:00:00.000Z',
        reviewerIdHash: duplicateReviewer,
      }),
      recordReviewedReplayDecision(candidate, {
        ...base,
        reviewedAt: '2026-07-22T03:00:00.000Z',
        reviewerIdHash: duplicateReviewer,
      }),
    ];
    expect(
      evaluateReviewedReplayGovernance(candidate, reviews, '2026-07-22T04:00:00.000Z'),
    ).toMatchObject({
      reasonCodes: ['duplicate_reviewer_identity'],
      status: 'disputed',
    });
  });

  it('lets the owner reject a candidate without a second human decision', async () => {
    const { candidate, payload, sourcePayloadHashes } = await createGovernedContractCorpus();
    const review = recordReviewedReplayDecision(candidate, {
      attestations: {
        independentReview: true,
        payloadReplayed: true,
        privacyVerified: true,
        sourceIntegrityVerified: true,
      },
      decision: 'reject',
      evidencePayloadHashes: sourcePayloadHashes,
      labelFingerprint: fingerprintReviewedReplayLabel(payload),
      reasonCodes: ['evidence_insufficient'],
      reviewedAt: '2026-07-22T02:00:00.000Z',
      reviewerIdHash: contractHash('single-owner-reviewer'),
    });

    expect(
      evaluateReviewedReplayGovernance(candidate, [review], '2026-07-22T04:00:00.000Z'),
    ).toMatchObject({
      reasonCodes: ['review_rejected'],
      rejectionCount: 1,
      status: 'rejected',
    });
  });

  it('preserves revision, supersession, and deletion tombstone lineage', async () => {
    const {
      candidate,
      payload,
      promotion: originalPromotion,
    } = await createGovernedContractCorpus();
    const revisedPayload = { ...payload, id: 'contract-only.reviewed-replay-schema-v2' };
    const revisedSourceHashes = [contractHash('source-payload-v2')];
    const revised = reviseReviewedReplayCandidate(candidate, {
      payload: revisedPayload,
      retainUntil: '2027-07-22T00:00:00.000Z',
      retentionPolicyId: candidate.retentionPolicyId,
      scanner: scanReviewedReplayPayload(revisedPayload, '2026-07-22T04:30:00.000Z', 'scanner-v1'),
      sourcePayloadHashes: revisedSourceHashes,
      submittedAt: '2026-07-22T05:00:00.000Z',
      submitterIdHash: candidate.submitterIdHash,
    });
    const labelFingerprint = fingerprintReviewedReplayLabel(revisedPayload);
    const reviewBase = {
      attestations: {
        independentReview: true,
        payloadReplayed: true,
        privacyVerified: true,
        sourceIntegrityVerified: true,
      },
      decision: 'approve' as const,
      evidencePayloadHashes: revisedSourceHashes,
      labelFingerprint,
      reasonCodes: [],
    };
    const reviews = [
      recordReviewedReplayDecision(revised, {
        ...reviewBase,
        reviewedAt: '2026-07-22T06:00:00.000Z',
        reviewerIdHash: contractHash('revision-reviewer-a'),
      }),
      recordReviewedReplayDecision(revised, {
        ...reviewBase,
        reviewedAt: '2026-07-22T07:00:00.000Z',
        reviewerIdHash: contractHash('revision-reviewer-b'),
      }),
    ];
    const replacement = promoteReviewedReplayCandidate(
      revised,
      reviews,
      '2026-07-22T08:00:00.000Z',
    );
    const tombstone = createReviewedReplayTombstone(originalPromotion, {
      deletedAt: '2026-07-22T08:00:00.000Z',
      deletedByHash: contractHash('retention-worker'),
      reason: 'superseded',
      replacementCandidateId: revised.candidateId,
    });
    const corpusExport = buildReviewedReplayCorpus({
      corpusId: 'contract-only-revision-export',
      description: 'Contract-only supersession fixture; not reviewed mainnet evidence.',
      exportedAt: '2026-07-22T09:00:00.000Z',
      promotions: [replacement, originalPromotion],
      tombstones: [tombstone],
    });

    expect(revised).toMatchObject({
      revision: 2,
      supersedesCandidateFingerprint: candidate.candidateFingerprint,
      supersedesCandidateId: candidate.candidateId,
    });
    expect(corpusExport.corpus.cases.map((item) => item.id)).toEqual([revisedPayload.id]);
    expect(corpusExport.excluded).toEqual([
      { candidateId: candidate.candidateId, reason: 'superseded' },
    ]);
  });

  it('expires retained candidates even when earlier approvals were valid', async () => {
    const { candidate, reviews } = await createGovernedContractCorpus();
    expect(
      evaluateReviewedReplayGovernance(candidate, reviews, '2027-07-22T00:00:00.000Z'),
    ).toMatchObject({
      reasonCodes: ['retention_expired'],
      status: 'retention_expired',
    });
  });
});

function expectGovernanceCode(code: string): ReviewedReplayGovernanceError {
  return expect.objectContaining({ code }) as ReviewedReplayGovernanceError;
}
