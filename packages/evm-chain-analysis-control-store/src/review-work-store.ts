import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import type {
  ReviewedReplayCandidate,
  ReviewedReplayReview,
} from '@xxyy/evm-chain-analysis-readiness';

import {
  ChainAnalysisControlStoreError,
  REQUIRED_REVIEW_WORK_SLOTS,
  reviewWorkJobId,
  reviewWorkJobSchema,
  type ReviewWorkJob,
} from './contracts.js';
import {
  appendControlAuditEvent,
  assertGovernanceAuthorization,
} from './control-store-internals.js';
import { migrateEvmChainAnalysisControlStore } from './migrations.js';
import {
  acquireControlLock,
  parseSafeInteger,
  queryControlDatabase,
  withControlTransaction,
  type PgControlClientLike,
} from './postgres.js';

const ISO_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const DEFAULT_REVIEW_MAX_ATTEMPTS = 3;

interface ReviewWorkJobRow {
  attempt_count: number | string;
  candidate_fingerprint: string;
  candidate_id: string;
  completed_at: string | null;
  expires_at: string;
  failed_at: string | null;
  failure_code_hash: string | null;
  job_id: string;
  lease_expires_at: string | null;
  max_attempts: number | string;
  not_before: string;
  review_fingerprint: string | null;
  review_id: string | null;
  reviewer_id_hash: string | null;
  slot_ordinal: number | string;
  status: 'failed' | 'queued' | 'running' | 'succeeded';
}

export interface ReviewWorkLeaseReference {
  attemptCount: number;
  jobId: string;
}

export interface PgEvmChainAnalysisReviewWorkStore {
  claimReviewJob(input: {
    asOf: string;
    leaseSeconds?: number;
    reviewerIdHash: string;
  }): Promise<ReviewWorkJob | undefined>;
  failReviewJob(input: {
    attemptCount: number;
    failedAt: string;
    failureCodeHash: string;
    jobId: string;
    reviewerIdHash: string;
  }): Promise<ReviewWorkJob>;
  getReviewJob(jobId: string): Promise<ReviewWorkJob | undefined>;
  listCandidateReviewJobs(candidateId: string): Promise<ReviewWorkJob[]>;
  migrate(): Promise<void>;
}

export function createPgEvmChainAnalysisReviewWorkStore(options: {
  client: PgControlClientLike;
}): PgEvmChainAnalysisReviewWorkStore {
  const { client } = options;
  return {
    async claimReviewJob(input): Promise<ReviewWorkJob | undefined> {
      const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.asOf,
          principalIdHash: input.reviewerIdHash,
          role: 'independent_reviewer',
        });
        await acquireControlLock(transaction, `review-work:${input.reviewerIdHash}`);
        const response = await queryControlDatabase<ReviewWorkJobRow>(
          transaction,
          `
            /* control:review-job-claim */
            with selected as (
              select job.job_id
              from evm_chain_control_review_work_jobs job
              inner join evm_chain_control_replay_candidates candidate
                on candidate.candidate_id = job.candidate_id
              where
                job.not_before <= $1::timestamptz
                and job.expires_at > $1::timestamptz
                and job.attempt_count < job.max_attempts
                and job.candidate_fingerprint = candidate.candidate_fingerprint
                and candidate.submitter_id_hash <> $2
                and (
                  job.status in ('queued', 'failed')
                  or (job.status = 'running' and job.lease_expires_at <= $1::timestamptz)
                )
                and not exists (
                  select 1
                  from evm_chain_control_replay_reviews prior_review
                  where
                    prior_review.candidate_id = job.candidate_id
                    and prior_review.reviewer_id_hash = $2
                )
                and not exists (
                  select 1
                  from evm_chain_control_review_work_jobs prior_job
                  where
                    prior_job.candidate_id = job.candidate_id
                    and prior_job.job_id <> job.job_id
                    and prior_job.reviewer_id_hash = $2
                    and prior_job.status in ('running', 'succeeded')
                )
              order by job.not_before, job.expires_at, job.candidate_id, job.slot_ordinal
              for update of job skip locked
              limit 1
            )
            update evm_chain_control_review_work_jobs job
            set
              status = 'running',
              attempt_count = job.attempt_count + 1,
              reviewer_id_hash = $2,
              lease_expires_at = least(
                job.expires_at,
                $1::timestamptz + make_interval(secs => $3)
              ),
              completed_at = null,
              failed_at = null,
              failure_code_hash = null,
              review_id = null,
              review_fingerprint = null
            from selected
            where job.job_id = selected.job_id
            returning ${reviewWorkJobColumns('job')}
          `,
          [input.asOf, input.reviewerIdHash, leaseSeconds],
        );
        const row = response.rows[0];
        if (row === undefined) {
          return undefined;
        }
        const job = mapReviewWorkJob(row);
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.reviewerIdHash,
          entityFingerprint: sha256Fingerprint(job),
          entityId: job.jobId,
          entityType: 'review_work_job',
          eventAt: input.asOf,
          eventKind: 'review_job_claimed',
          payload: {
            attemptCount: job.attemptCount,
            candidateId: job.candidateId,
            leaseExpiresAt: job.leaseExpiresAt,
            slotOrdinal: job.slotOrdinal,
          },
          stream: 'governance',
        });
        return job;
      });
    },

    async failReviewJob(input): Promise<ReviewWorkJob> {
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.failedAt,
          principalIdHash: input.reviewerIdHash,
          role: 'independent_reviewer',
        });
        const current = await requireReviewWorkJob(transaction, input.jobId, true);
        if (current.status === 'failed') {
          if (
            current.attemptCount !== input.attemptCount ||
            current.reviewerIdHash !== input.reviewerIdHash ||
            current.failedAt !== input.failedAt ||
            current.failureCodeHash !== input.failureCodeHash
          ) {
            throw new ChainAnalysisControlStoreError(
              'stale_generation',
              'Failed review work is idempotent only for the same reviewer and attempt.',
            );
          }
          return current;
        }
        assertActiveReviewerLease(current, {
          attemptCount: input.attemptCount,
          reviewerIdHash: input.reviewerIdHash,
          transitionAt: input.failedAt,
        });
        const response = await queryControlDatabase<ReviewWorkJobRow>(
          transaction,
          `
            /* control:review-job-fail */
            update evm_chain_control_review_work_jobs
            set
              status = 'failed',
              lease_expires_at = null,
              failed_at = $4::timestamptz,
              failure_code_hash = $5,
              completed_at = null,
              review_id = null,
              review_fingerprint = null
            where
              job_id = $1
              and status = 'running'
              and reviewer_id_hash = $2
              and attempt_count = $3
              and lease_expires_at >= $4::timestamptz
              and expires_at > $4::timestamptz
            returning ${reviewWorkJobColumns()}
          `,
          [
            input.jobId,
            input.reviewerIdHash,
            input.attemptCount,
            input.failedAt,
            input.failureCodeHash,
          ],
        );
        const row = response.rows[0];
        if (row === undefined) {
          throw new ChainAnalysisControlStoreError(
            'stale_generation',
            'Review work changed before the fenced failure transition completed.',
          );
        }
        const failed = mapReviewWorkJob(row);
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.reviewerIdHash,
          entityFingerprint: sha256Fingerprint(failed),
          entityId: failed.jobId,
          entityType: 'review_work_job',
          eventAt: input.failedAt,
          eventKind: 'review_job_failed',
          payload: {
            attemptCount: failed.attemptCount,
            attemptsRemaining: failed.maxAttempts - failed.attemptCount,
            candidateId: failed.candidateId,
            failureCodeHash: input.failureCodeHash,
            slotOrdinal: failed.slotOrdinal,
          },
          stream: 'governance',
        });
        return failed;
      });
    },

    async getReviewJob(jobId): Promise<ReviewWorkJob | undefined> {
      return readReviewWorkJob(client, jobId, false);
    },

    async listCandidateReviewJobs(candidateId): Promise<ReviewWorkJob[]> {
      const response = await queryControlDatabase<ReviewWorkJobRow>(
        client,
        `
          /* control:review-job-list */
          select ${reviewWorkJobColumns()}
          from evm_chain_control_review_work_jobs
          where candidate_id = $1
          order by slot_ordinal
        `,
        [candidateId],
      );
      return response.rows.map(mapReviewWorkJob);
    },

    async migrate(): Promise<void> {
      await migrateEvmChainAnalysisControlStore(client);
    },
  };
}

export async function enqueueRequiredReviewWorkJobs(
  client: PgControlClientLike,
  candidate: ReviewedReplayCandidate,
): Promise<void> {
  for (let slotOrdinal = 1; slotOrdinal <= REQUIRED_REVIEW_WORK_SLOTS; slotOrdinal += 1) {
    await queryControlDatabase(
      client,
      `
        /* control:review-job-enqueue */
        insert into evm_chain_control_review_work_jobs (
          job_id,
          candidate_id,
          candidate_fingerprint,
          slot_ordinal,
          not_before,
          expires_at,
          status,
          max_attempts
        ) values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, 'queued', $7)
      `,
      [
        reviewWorkJobId({
          candidateFingerprint: candidate.candidateFingerprint,
          candidateId: candidate.candidateId,
          slotOrdinal,
        }),
        candidate.candidateId,
        candidate.candidateFingerprint,
        slotOrdinal,
        candidate.submittedAt,
        candidate.retainUntil,
        DEFAULT_REVIEW_MAX_ATTEMPTS,
      ],
    );
  }
}

export async function requireHandoffReviewLease(
  client: PgControlClientLike,
  input: {
    lease?: ReviewWorkLeaseReference;
    review: ReviewedReplayReview;
  },
): Promise<ReviewWorkJob | undefined> {
  const handoffResponse = await queryControlDatabase<{ candidate_id: string }>(
    client,
    `
      /* control:review-handoff-read */
      select candidate_id
      from evm_chain_control_sampling_candidate_handoffs
      where candidate_id = $1
      for update
    `,
    [input.review.candidateId],
  );
  const requiresLease = handoffResponse.rows[0] !== undefined;
  if (!requiresLease) {
    if (input.lease !== undefined) {
      throw new ChainAnalysisControlStoreError(
        'invalid_state',
        'Review work leases apply only to sampling handoff candidates.',
      );
    }
    return undefined;
  }
  if (input.lease === undefined) {
    throw new ChainAnalysisControlStoreError(
      'review_lease_required',
      'Sampling handoff review requires a claimed review work lease.',
    );
  }
  const job = await requireReviewWorkJob(client, input.lease.jobId, true);
  if (
    job.candidateId !== input.review.candidateId ||
    job.candidateFingerprint !== input.review.candidateFingerprint
  ) {
    throw new ChainAnalysisControlStoreError(
      'review_lease_required',
      'The supplied review work lease belongs to another candidate revision.',
    );
  }
  assertActiveReviewerLease(job, {
    attemptCount: input.lease.attemptCount,
    reviewerIdHash: input.review.reviewerIdHash,
    transitionAt: input.review.reviewedAt,
  });
  return job;
}

export async function completeHandoffReviewWorkJob(
  client: PgControlClientLike,
  input: {
    actorIdHash: string;
    job: ReviewWorkJob;
    review: ReviewedReplayReview;
  },
): Promise<ReviewWorkJob> {
  const response = await queryControlDatabase<ReviewWorkJobRow>(
    client,
    `
      /* control:review-job-complete */
      update evm_chain_control_review_work_jobs
      set
        status = 'succeeded',
        lease_expires_at = null,
        completed_at = $4::timestamptz,
        failed_at = null,
        failure_code_hash = null,
        review_id = $5,
        review_fingerprint = $6
      where
        job_id = $1
        and status = 'running'
        and reviewer_id_hash = $2
        and attempt_count = $3
        and lease_expires_at >= $4::timestamptz
        and expires_at > $4::timestamptz
      returning ${reviewWorkJobColumns()}
    `,
    [
      input.job.jobId,
      input.review.reviewerIdHash,
      input.job.attemptCount,
      input.review.reviewedAt,
      input.review.reviewId,
      input.review.reviewFingerprint,
    ],
  );
  const row = response.rows[0];
  if (row === undefined) {
    throw new ChainAnalysisControlStoreError(
      'stale_generation',
      'Review work changed before the fenced completion transition completed.',
    );
  }
  const completed = mapReviewWorkJob(row);
  await appendControlAuditEvent(client, {
    actorIdHash: input.actorIdHash,
    entityFingerprint: sha256Fingerprint(completed),
    entityId: completed.jobId,
    entityType: 'review_work_job',
    eventAt: input.review.reviewedAt,
    eventKind: 'review_job_completed',
    payload: {
      attemptCount: completed.attemptCount,
      candidateId: completed.candidateId,
      reviewFingerprint: input.review.reviewFingerprint,
      reviewId: input.review.reviewId,
      slotOrdinal: completed.slotOrdinal,
    },
    stream: 'governance',
  });
  return completed;
}

async function requireReviewWorkJob(
  client: PgControlClientLike,
  jobId: string,
  forUpdate: boolean,
): Promise<ReviewWorkJob> {
  const job = await readReviewWorkJob(client, jobId, forUpdate);
  if (job === undefined) {
    throw new ChainAnalysisControlStoreError(
      'review_job_not_found',
      `Review work job ${jobId} was not found.`,
    );
  }
  return job;
}

async function readReviewWorkJob(
  client: PgControlClientLike,
  jobId: string,
  forUpdate: boolean,
): Promise<ReviewWorkJob | undefined> {
  const response = await queryControlDatabase<ReviewWorkJobRow>(
    client,
    `
      /* control:review-job-read */
      select ${reviewWorkJobColumns()}
      from evm_chain_control_review_work_jobs
      where job_id = $1
      ${forUpdate ? 'for update' : ''}
    `,
    [jobId],
  );
  const row = response.rows[0];
  return row === undefined ? undefined : mapReviewWorkJob(row);
}

function assertActiveReviewerLease(
  job: ReviewWorkJob,
  input: {
    attemptCount: number;
    reviewerIdHash: string;
    transitionAt: string;
  },
): void {
  if (
    job.status !== 'running' ||
    job.attemptCount !== input.attemptCount ||
    job.reviewerIdHash !== input.reviewerIdHash ||
    job.leaseExpiresAt === undefined ||
    Date.parse(job.leaseExpiresAt) < Date.parse(input.transitionAt) ||
    Date.parse(job.expiresAt) <= Date.parse(input.transitionAt)
  ) {
    throw new ChainAnalysisControlStoreError(
      'stale_generation',
      'Review transition requires the current unexpired attempt-fenced reviewer lease.',
    );
  }
}

function mapReviewWorkJob(row: ReviewWorkJobRow): ReviewWorkJob {
  return reviewWorkJobSchema.parse({
    attemptCount: parseSafeInteger(row.attempt_count, 'review work attempt count'),
    candidateFingerprint: row.candidate_fingerprint,
    candidateId: row.candidate_id,
    expiresAt: row.expires_at,
    jobId: row.job_id,
    maxAttempts: parseSafeInteger(row.max_attempts, 'review work maximum attempts'),
    notBefore: row.not_before,
    slotOrdinal: parseSafeInteger(row.slot_ordinal, 'review work slot ordinal'),
    status: row.status,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.failed_at === null ? {} : { failedAt: row.failed_at }),
    ...(row.failure_code_hash === null ? {} : { failureCodeHash: row.failure_code_hash }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.review_fingerprint === null ? {} : { reviewFingerprint: row.review_fingerprint }),
    ...(row.review_id === null ? {} : { reviewId: row.review_id }),
    ...(row.reviewer_id_hash === null ? {} : { reviewerIdHash: row.reviewer_id_hash }),
  });
}

function reviewWorkJobColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return `
    ${prefix}job_id,
    ${prefix}candidate_id,
    ${prefix}candidate_fingerprint,
    ${prefix}slot_ordinal,
    to_char(${prefix}not_before at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as not_before,
    to_char(${prefix}expires_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as expires_at,
    ${prefix}status,
    ${prefix}attempt_count,
    ${prefix}max_attempts,
    ${prefix}reviewer_id_hash,
    to_char(${prefix}lease_expires_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as lease_expires_at,
    to_char(${prefix}completed_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as completed_at,
    to_char(${prefix}failed_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as failed_at,
    ${prefix}failure_code_hash,
    ${prefix}review_id,
    ${prefix}review_fingerprint
  `;
}

function normalizeLeaseSeconds(value: number | undefined): number {
  const normalized = value ?? 300;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 3_600) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'Review leaseSeconds must be an integer between 1 and 3600.',
    );
  }
  return normalized;
}
