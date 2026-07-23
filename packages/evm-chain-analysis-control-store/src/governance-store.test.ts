import { describe, expect, it } from 'vitest';

import {
  fingerprintReviewedReplayLabel,
  recordReviewedReplayDecision,
} from '@xxyy/evm-chain-analysis-readiness';
import { createContractOnlySamplingHandoffFixture } from '@xxyy/evm-chain-analysis-readiness/test-fixtures';

import {
  createGovernanceAuthorization,
  createPgEvmChainAnalysisGovernanceStore,
  reviewWorkJobId,
  type GovernanceAuthorization,
} from './index.js';
import { createGovernanceStoreFixture, testHash } from './fixtures.test-helper.js';
import { authorizationRow, ScriptedPgClient } from './scripted-pg.test-helper.js';

const PUBLISHER = testHash('publisher');
const RETENTION_WORKER = testHash('retention-worker');

describe('PostgreSQL reviewed replay governance store', () => {
  it('persists and audits the candidate-to-reviewed-corpus state machine transactionally', async () => {
    const fixture = await createGovernanceStoreFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisGovernanceStore({ client });
    const grants = createGrants(fixture);
    client.enqueue(
      'authorization-read',
      [authorizationRow(grants.submitter)],
      [authorizationRow(grants.reviewerA)],
      [authorizationRow(grants.reviewerB)],
      [authorizationRow(grants.publisher)],
      [authorizationRow(grants.publisher)],
      [authorizationRow(grants.publisher)],
    );
    client.enqueue(
      'candidate-read',
      [],
      [{ payload: fixture.candidate }],
      [{ payload: fixture.candidate }],
      [{ payload: fixture.candidate }],
      [{ payload: fixture.candidate }],
    );
    client.enqueue(
      'reviews-read',
      fixture.reviews.map((payload) => ({ payload })),
      fixture.reviews.map((payload) => ({ payload })),
    );
    client.enqueue('decision-read', [], [{ payload: fixture.decision }]);
    client.enqueue('promotion-read', []);
    client.enqueue('promotions-read', [{ payload: fixture.promotion }]);

    expect(
      await store.recordCandidate({
        actorIdHash: fixture.candidate.submitterIdHash,
        candidate: fixture.candidate,
      }),
    ).toEqual(fixture.candidate);
    expect(
      await store.recordReview({
        actorIdHash: fixture.reviews[0]!.reviewerIdHash,
        review: fixture.reviews[0],
      }),
    ).toEqual(fixture.reviews[0]);
    expect(
      await store.recordReview({
        actorIdHash: fixture.reviews[1]!.reviewerIdHash,
        review: fixture.reviews[1],
      }),
    ).toEqual(fixture.reviews[1]);
    expect(
      await store.evaluateCandidate({
        actorIdHash: PUBLISHER,
        candidateId: fixture.candidate.candidateId,
        evaluatedAt: fixture.decision.evaluatedAt,
      }),
    ).toEqual(fixture.decision);
    expect(
      await store.promoteCandidate({
        actorIdHash: PUBLISHER,
        candidateId: fixture.candidate.candidateId,
        decisionFingerprint: fixture.decision.decisionFingerprint,
        promotedAt: fixture.promotion.promotedAt,
      }),
    ).toEqual(fixture.promotion);
    const corpusExport = await store.exportCorpus({
      actorIdHash: PUBLISHER,
      corpusId: 'contract-only-control-store',
      description: 'Contract-only persistence test; not reviewed mainnet evidence.',
      exportedAt: '2026-07-22T05:00:00.000Z',
    });

    expect(corpusExport.included).toHaveLength(1);
    expect(corpusExport.corpus.cases[0]?.id).toBe(fixture.candidate.payload.id);
    expect((await store.readAudit('governance')).map((event) => event.eventKind)).toEqual([
      'candidate_recorded',
      'review_recorded',
      'review_recorded',
      'governance_decision_recorded',
      'promotion_recorded',
      'corpus_export_recorded',
    ]);
    expect(client.transactionEvents.filter((event) => event === 'commit')).toHaveLength(6);
    expect(client.queries.some((query) => query.tag === 'retention-enqueue')).toBe(true);
  });

  it('does not expose unauthenticated grant bootstrap on the public governance store', () => {
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisGovernanceStore({ client });

    expect(store).not.toHaveProperty('recordAuthorization');
  });

  it('revokes an authorization under the shared role schedule lock and audits the change', async () => {
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisGovernanceStore({ client });
    const authorization = createGovernanceAuthorization({
      grantedAt: '2026-07-22T00:00:00.000Z',
      grantedByHash: PUBLISHER,
      principalIdHash: testHash('revoked-sampling-worker'),
      roles: ['sampling_worker'],
      validUntil: '2027-07-22T00:00:00.000Z',
    });
    client.enqueue('authorization-read', [
      authorizationRow(grant(PUBLISHER, ['governance_publisher'])),
    ]);
    client.enqueue('authorization-by-id', [{ payload: authorization }]);

    const revocation = await store.revokeAuthorization({
      authorizationId: authorization.authorizationId,
      reasonCode: 'identity_disabled',
      revokedAt: '2026-07-23T00:00:00.000Z',
      revokedByHash: PUBLISHER,
    });

    expect(revocation.authorizationId).toBe(authorization.authorizationId);
    expect(
      client.queries
        .filter((query) => query.tag === 'advisory-lock')
        .map((query) => query.values[0]),
    ).toContain('authorization-role-schedule:sampling_worker');
    expect(client.auditEvents.map(eventKind)).toEqual(['authorization_revoked']);
    expect(client.transactionEvents).toEqual(['begin', 'commit']);
  });

  it('fails closed when a candidate submitter lacks a persisted active grant', async () => {
    const { candidate } = await createGovernanceStoreFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisGovernanceStore({ client });

    await expect(
      store.recordCandidate({ actorIdHash: candidate.submitterIdHash, candidate }),
    ).rejects.toMatchObject({ code: 'authorization_missing' });
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
    expect(client.queries.some((query) => query.tag === 'candidate-insert')).toBe(false);
  });

  it('rejects a second immutable decision from the same reviewer identity', async () => {
    const fixture = await createGovernanceStoreFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisGovernanceStore({ client });
    const grant = createGrants(fixture).reviewerA;
    client.enqueue('authorization-read', [authorizationRow(grant)]);
    client.enqueue('candidate-read', [{ payload: fixture.candidate }]);
    client.enqueue('review-by-reviewer', [{ payload: fixture.reviews[1] }]);

    await expect(
      store.recordReview({
        actorIdHash: fixture.reviews[0]!.reviewerIdHash,
        review: fixture.reviews[0],
      }),
    ).rejects.toMatchObject({ code: 'reviewer_conflict' });
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('atomically records a handoff review and completes its attempt-fenced work slot', async () => {
    const { handoff } = await createContractOnlySamplingHandoffFixture();
    const reviewer = testHash('handoff-reviewer-a');
    const review = approvedHandoffReview(handoff.candidate, reviewer, '2026-07-24T13:00:00.000Z');
    const running = handoffReviewJobRow(handoff.candidate, review, {
      attemptCount: 1,
      leaseExpiresAt: '2026-07-24T13:05:00.000Z',
      slotOrdinal: 1,
      status: 'running',
    });
    const succeeded = handoffReviewJobRow(handoff.candidate, review, {
      attemptCount: 1,
      slotOrdinal: 1,
      status: 'succeeded',
    });
    const client = new ScriptedPgClient();
    client.enqueue('authorization-read', [
      authorizationRow(grant(reviewer, ['independent_reviewer'])),
    ]);
    client.enqueue('candidate-read', [{ payload: handoff.candidate }]);
    client.enqueue('review-handoff-read', [{ candidate_id: handoff.candidate.candidateId }]);
    client.enqueue('review-job-read', [running]);
    client.enqueue('review-job-complete', [succeeded]);
    const store = createPgEvmChainAnalysisGovernanceStore({ client });

    await expect(
      store.recordReview({
        actorIdHash: reviewer,
        review,
        reviewWorkLease: { attemptCount: 1, jobId: running.job_id },
      }),
    ).resolves.toEqual(review);

    expect(client.queries.some((query) => query.tag === 'review-insert')).toBe(true);
    expect(client.queries.some((query) => query.tag === 'review-job-complete')).toBe(true);
    expect(client.auditEvents.map((event) => (event as { eventKind: string }).eventKind)).toEqual([
      'review_recorded',
      'review_job_completed',
    ]);
    expect(client.transactionEvents).toEqual(['begin', 'commit']);
  });

  it('requires a claimed work lease before reviewing a sampling handoff candidate', async () => {
    const { handoff } = await createContractOnlySamplingHandoffFixture();
    const reviewer = testHash('handoff-reviewer-without-lease');
    const review = approvedHandoffReview(handoff.candidate, reviewer, '2026-07-24T13:00:00.000Z');
    const client = new ScriptedPgClient();
    client.enqueue('authorization-read', [
      authorizationRow(grant(reviewer, ['independent_reviewer'])),
    ]);
    client.enqueue('candidate-read', [{ payload: handoff.candidate }]);
    client.enqueue('review-handoff-read', [{ candidate_id: handoff.candidate.candidateId }]);
    const store = createPgEvmChainAnalysisGovernanceStore({ client });

    await expect(store.recordReview({ actorIdHash: reviewer, review })).rejects.toMatchObject({
      code: 'review_lease_required',
    });
    expect(client.queries.some((query) => query.tag === 'review-insert')).toBe(false);
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('leases and completes an expired unpromoted retention job with an expiry decision', async () => {
    const { candidate } = await createGovernanceStoreFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisGovernanceStore({ client });
    const workerGrant = grant(RETENTION_WORKER, ['retention_worker']);
    const jobId = `retention_${testHash('retention-job').slice(7)}`;
    const asOf = '2027-07-22T00:01:00.000Z';
    const leaseExpiresAt = '2027-07-22T00:06:00.000Z';
    const runningRow = {
      attempt_count: 1,
      candidate_id: candidate.candidateId,
      completed_at: null,
      job_id: jobId,
      lease_expires_at: leaseExpiresAt,
      outcome: null,
      retain_until: candidate.retainUntil,
      status: 'running',
      worker_id_hash: RETENTION_WORKER,
    } as const;
    const completedRow = {
      ...runningRow,
      completed_at: asOf,
      lease_expires_at: null,
      outcome: 'expired_unpromoted',
      status: 'completed',
    } as const;
    client.enqueue(
      'authorization-read',
      [authorizationRow(workerGrant)],
      [authorizationRow(workerGrant)],
    );
    client.enqueue('retention-claim', [runningRow]);
    client.enqueue('retention-lock', [runningRow]);
    client.enqueue('candidate-read', [{ payload: candidate }]);
    client.enqueue('retention-complete', [completedRow]);

    expect(await store.claimRetentionJob({ asOf, workerIdHash: RETENTION_WORKER })).toMatchObject({
      jobId,
      status: 'running',
    });
    expect(
      await store.completeRetentionJob({
        completedAt: asOf,
        jobId,
        workerIdHash: RETENTION_WORKER,
      }),
    ).toMatchObject({ outcome: 'expired_unpromoted', status: 'completed' });
    expect(client.auditEvents).toHaveLength(3);
    expect(client.queries.some((query) => query.tag === 'decision-insert')).toBe(true);
  });
});

function createGrants(fixture: Awaited<ReturnType<typeof createGovernanceStoreFixture>>) {
  return {
    publisher: grant(PUBLISHER, ['governance_publisher']),
    reviewerA: grant(fixture.reviews[0]!.reviewerIdHash, ['independent_reviewer']),
    reviewerB: grant(fixture.reviews[1]!.reviewerIdHash, ['independent_reviewer']),
    submitter: grant(fixture.candidate.submitterIdHash, ['candidate_submitter']),
  };
}

function eventKind(value: unknown): unknown {
  return (value as { eventKind?: unknown }).eventKind;
}

function grant(
  principalIdHash: string,
  roles: Parameters<typeof createGovernanceAuthorization>[0]['roles'],
): GovernanceAuthorization {
  return createGovernanceAuthorization({
    grantedAt: '2026-07-21T00:00:00.000Z',
    grantedByHash: PUBLISHER,
    principalIdHash,
    roles,
    validUntil: '2028-07-22T00:00:00.000Z',
  });
}

function approvedHandoffReview(
  candidate: Awaited<
    ReturnType<typeof createContractOnlySamplingHandoffFixture>
  >['handoff']['candidate'],
  reviewerIdHash: string,
  reviewedAt: string,
) {
  return recordReviewedReplayDecision(candidate, {
    attestations: {
      independentReview: true,
      payloadReplayed: true,
      privacyVerified: true,
      sourceIntegrityVerified: true,
    },
    decision: 'approve',
    evidencePayloadHashes: candidate.sourcePayloadHashes,
    labelFingerprint: fingerprintReviewedReplayLabel(candidate.payload),
    reasonCodes: [],
    reviewedAt,
    reviewerIdHash,
  });
}

function handoffReviewJobRow(
  candidate: Awaited<
    ReturnType<typeof createContractOnlySamplingHandoffFixture>
  >['handoff']['candidate'],
  review: ReturnType<typeof approvedHandoffReview>,
  input:
    | {
        attemptCount: number;
        leaseExpiresAt: string;
        slotOrdinal: number;
        status: 'running';
      }
    | {
        attemptCount: number;
        slotOrdinal: number;
        status: 'succeeded';
      },
) {
  return {
    attempt_count: input.attemptCount,
    candidate_fingerprint: candidate.candidateFingerprint,
    candidate_id: candidate.candidateId,
    completed_at: input.status === 'succeeded' ? review.reviewedAt : null,
    expires_at: candidate.retainUntil,
    failed_at: null,
    failure_code_hash: null,
    job_id: reviewWorkJobId({
      candidateFingerprint: candidate.candidateFingerprint,
      candidateId: candidate.candidateId,
      slotOrdinal: input.slotOrdinal,
    }),
    lease_expires_at: input.status === 'running' ? input.leaseExpiresAt : null,
    max_attempts: 3,
    not_before: candidate.submittedAt,
    review_fingerprint: input.status === 'succeeded' ? review.reviewFingerprint : null,
    review_id: input.status === 'succeeded' ? review.reviewId : null,
    reviewer_id_hash: review.reviewerIdHash,
    slot_ordinal: input.slotOrdinal,
    status: input.status,
  };
}
