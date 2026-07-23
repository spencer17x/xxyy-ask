import { describe, expect, it } from 'vitest';

import { createContractOnlySamplingHandoffFixture } from '@xxyy/evm-chain-analysis-readiness/test-fixtures';

import {
  createGovernanceAuthorization,
  createPgEvmChainAnalysisReviewWorkStore,
  reviewWorkJobId,
  type GovernanceAuthorization,
} from './index.js';
import { testHash } from './fixtures.test-helper.js';
import { authorizationRow, ScriptedPgClient } from './scripted-pg.test-helper.js';

describe('PostgreSQL independent review work store', () => {
  it('claims eligible work with authorization, reviewer separation, and SKIP LOCKED', async () => {
    const { handoff } = await createContractOnlySamplingHandoffFixture();
    const reviewer = testHash('review-work-reviewer-a');
    const client = new ScriptedPgClient();
    const running = reviewJobRow(handoff.candidate, {
      attemptCount: 1,
      leaseExpiresAt: '2026-07-24T12:35:00.000Z',
      reviewerIdHash: reviewer,
      slotOrdinal: 1,
      status: 'running',
    });
    client.enqueue('authorization-read', [authorizationRow(reviewerAuthorization(reviewer))]);
    client.enqueue('review-job-claim', [running]);
    const store = createPgEvmChainAnalysisReviewWorkStore({ client });

    await expect(
      store.claimReviewJob({
        asOf: '2026-07-24T12:30:00.000Z',
        reviewerIdHash: reviewer,
      }),
    ).resolves.toMatchObject({ attemptCount: 1, reviewerIdHash: reviewer, status: 'running' });

    const claimSql = client.queries.find((query) => query.tag === 'review-job-claim')!.sql;
    expect(claimSql.toLowerCase()).toContain('for update of job skip locked');
    expect(claimSql.toLowerCase()).toContain('candidate.submitter_id_hash <> $2');
    expect(claimSql.toLowerCase()).toContain('evm_chain_control_replay_reviews prior_review');
    expect(claimSql.toLowerCase()).toContain('job.attempt_count < job.max_attempts');
    expect(claimSql.toLowerCase()).toContain("job.status in ('queued', 'failed')");
    expect(client.auditEvents.map(eventKind)).toEqual(['review_job_claimed']);
    expect(client.transactionEvents).toEqual(['begin', 'commit']);
  });

  it('releases a failed attempt idempotently and fences stale attempt generations', async () => {
    const { handoff } = await createContractOnlySamplingHandoffFixture();
    const reviewer = testHash('review-work-reviewer-b');
    const failureCodeHash = testHash('review-replay-failure');
    const failedAt = '2026-07-24T12:32:00.000Z';
    const running = reviewJobRow(handoff.candidate, {
      attemptCount: 1,
      leaseExpiresAt: '2026-07-24T12:35:00.000Z',
      reviewerIdHash: reviewer,
      slotOrdinal: 1,
      status: 'running',
    });
    const failed = reviewJobRow(handoff.candidate, {
      attemptCount: 1,
      failedAt,
      failureCodeHash,
      reviewerIdHash: reviewer,
      slotOrdinal: 1,
      status: 'failed',
    });
    const client = new ScriptedPgClient();
    const authorization = reviewerAuthorization(reviewer);
    client.enqueue(
      'authorization-read',
      [authorizationRow(authorization)],
      [authorizationRow(authorization)],
    );
    client.enqueue('review-job-read', [running], [failed]);
    client.enqueue('review-job-fail', [failed]);
    const store = createPgEvmChainAnalysisReviewWorkStore({ client });
    const input = {
      attemptCount: 1,
      failedAt,
      failureCodeHash,
      jobId: running.job_id,
      reviewerIdHash: reviewer,
    };

    await expect(store.failReviewJob(input)).resolves.toMatchObject({ status: 'failed' });
    await expect(store.failReviewJob(input)).resolves.toMatchObject({ status: 'failed' });
    expect(client.queries.filter((query) => query.tag === 'review-job-fail')).toHaveLength(1);
    expect(client.auditEvents.map(eventKind)).toEqual(['review_job_failed']);

    const staleClient = new ScriptedPgClient();
    staleClient.enqueue('authorization-read', [authorizationRow(authorization)]);
    staleClient.enqueue('review-job-read', [
      reviewJobRow(handoff.candidate, {
        attemptCount: 2,
        leaseExpiresAt: '2026-07-24T12:40:00.000Z',
        reviewerIdHash: reviewer,
        slotOrdinal: 1,
        status: 'running',
      }),
    ]);
    const staleStore = createPgEvmChainAnalysisReviewWorkStore({ client: staleClient });
    await expect(staleStore.failReviewJob(input)).rejects.toMatchObject({
      code: 'stale_generation',
    });
    expect(staleClient.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('fails closed without an independent reviewer grant and supports deterministic reads', async () => {
    const { handoff } = await createContractOnlySamplingHandoffFixture();
    const reviewer = testHash('review-work-reviewer-c');
    const queued = reviewJobRow(handoff.candidate, {
      attemptCount: 0,
      slotOrdinal: 1,
      status: 'queued',
    });
    const unauthorizedStore = createPgEvmChainAnalysisReviewWorkStore({
      client: new ScriptedPgClient(),
    });

    await expect(
      unauthorizedStore.claimReviewJob({
        asOf: '2026-07-24T12:30:00.000Z',
        reviewerIdHash: reviewer,
      }),
    ).rejects.toMatchObject({ code: 'authorization_missing' });

    const client = new ScriptedPgClient();
    client.enqueue('review-job-read', [queued]);
    client.enqueue('review-job-list', [queued]);
    const store = createPgEvmChainAnalysisReviewWorkStore({ client });
    await expect(store.getReviewJob(queued.job_id)).resolves.toMatchObject({ status: 'queued' });
    await expect(
      store.listCandidateReviewJobs(handoff.candidate.candidateId),
    ).resolves.toHaveLength(1);
  });
});

function reviewJobRow(
  candidate: Awaited<
    ReturnType<typeof createContractOnlySamplingHandoffFixture>
  >['handoff']['candidate'],
  input:
    | {
        attemptCount: number;
        leaseExpiresAt: string;
        reviewerIdHash: string;
        slotOrdinal: number;
        status: 'running';
      }
    | {
        attemptCount: number;
        failedAt: string;
        failureCodeHash: string;
        reviewerIdHash: string;
        slotOrdinal: number;
        status: 'failed';
      }
    | {
        attemptCount: 0;
        slotOrdinal: number;
        status: 'queued';
      },
) {
  return {
    attempt_count: input.attemptCount,
    candidate_fingerprint: candidate.candidateFingerprint,
    candidate_id: candidate.candidateId,
    completed_at: null,
    expires_at: candidate.retainUntil,
    failed_at: input.status === 'failed' ? input.failedAt : null,
    failure_code_hash: input.status === 'failed' ? input.failureCodeHash : null,
    job_id: reviewWorkJobId({
      candidateFingerprint: candidate.candidateFingerprint,
      candidateId: candidate.candidateId,
      slotOrdinal: input.slotOrdinal,
    }),
    lease_expires_at: input.status === 'running' ? input.leaseExpiresAt : null,
    max_attempts: 3,
    not_before: candidate.submittedAt,
    review_fingerprint: null,
    review_id: null,
    reviewer_id_hash: input.status === 'queued' ? null : input.reviewerIdHash,
    slot_ordinal: input.slotOrdinal,
    status: input.status,
  };
}

function reviewerAuthorization(principalIdHash: string): GovernanceAuthorization {
  return createGovernanceAuthorization({
    grantedAt: '2026-06-01T00:00:00.000Z',
    grantedByHash: testHash('review-governance-publisher'),
    principalIdHash,
    roles: ['independent_reviewer'],
    validUntil: '2028-09-01T00:00:00.000Z',
  });
}

function eventKind(event: unknown): unknown {
  return (event as { eventKind?: unknown }).eventKind;
}
