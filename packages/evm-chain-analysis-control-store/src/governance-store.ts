import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import {
  buildReviewedReplayCorpus,
  createReviewedReplayCandidate,
  createReviewedReplayTombstone,
  evaluateReviewedReplayGovernance,
  promoteReviewedReplayCandidate,
  recordReviewedReplayDecision,
  reviseReviewedReplayCandidate,
  reviewedReplayCandidateSchema,
  reviewedReplayCorpusExportSchema,
  reviewedReplayGovernanceDecisionSchema,
  reviewedReplayPromotionSchema,
  reviewedReplayReviewSchema,
  reviewedReplayTombstoneSchema,
  type ReviewedReplayCandidate,
  type ReviewedReplayCorpusExport,
  type ReviewedReplayGovernanceDecision,
  type ReviewedReplayPromotion,
  type ReviewedReplayReview,
  type ReviewedReplayTombstone,
  type ReviewedReplayTombstoneInput,
} from '@xxyy/evm-chain-analysis-readiness';

import {
  ChainAnalysisControlStoreError,
  createGovernanceAuthorization,
  createGovernanceAuthorizationRevocation,
  governanceAuthorizationRevocationSchema,
  governanceAuthorizationSchema,
  retentionJobSchema,
  verifyChainAnalysisControlAuditEvents,
  type ChainAnalysisControlAuditEvent,
  type ChainAnalysisControlAuditStream,
  type GovernanceAuthorization,
  type GovernanceAuthorizationInput,
  type GovernanceAuthorizationRevocation,
  type GovernanceAuthorizationRevocationInput,
  type RetentionJob,
} from './contracts.js';
import {
  appendControlAuditEvent,
  assertActor,
  assertGovernanceAuthorization,
  assertSameFingerprint,
  readControlAuditEvents,
} from './control-store-internals.js';
import { migrateEvmChainAnalysisControlStore } from './migrations.js';
import {
  acquireControlLock,
  parseSafeInteger,
  queryControlDatabase,
  withControlTransaction,
  type PgControlClientLike,
} from './postgres.js';
import {
  completeHandoffReviewWorkJob,
  requireHandoffReviewLease,
  type ReviewWorkLeaseReference,
} from './review-work-store.js';

interface PayloadRow {
  payload: unknown;
}

interface RetentionJobRow {
  attempt_count: number | string;
  candidate_id: string;
  completed_at: string | null;
  job_id: string;
  lease_expires_at: string | null;
  outcome: 'expired_unpromoted' | 'tombstoned' | null;
  retain_until: string;
  status: 'completed' | 'queued' | 'running';
  worker_id_hash: string | null;
}

const ISO_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

export interface EvmChainAnalysisGovernanceStore {
  claimRetentionJob(input: {
    asOf: string;
    leaseSeconds?: number;
    workerIdHash: string;
  }): Promise<RetentionJob | undefined>;
  completeRetentionJob(input: {
    completedAt: string;
    jobId: string;
    workerIdHash: string;
  }): Promise<RetentionJob>;
  evaluateCandidate(input: {
    actorIdHash: string;
    candidateId: string;
    evaluatedAt: string;
  }): Promise<ReviewedReplayGovernanceDecision>;
  exportCorpus(input: {
    actorIdHash: string;
    corpusId: string;
    description: string;
    exportedAt: string;
  }): Promise<ReviewedReplayCorpusExport>;
  getCandidate(candidateId: string): Promise<ReviewedReplayCandidate | undefined>;
  getReviews(candidateId: string): Promise<ReviewedReplayReview[]>;
  migrate(): Promise<void>;
  promoteCandidate(input: {
    actorIdHash: string;
    candidateId: string;
    decisionFingerprint: string;
    promotedAt: string;
  }): Promise<ReviewedReplayPromotion>;
  readAudit(stream: ChainAnalysisControlAuditStream): Promise<ChainAnalysisControlAuditEvent[]>;
  recordAuthorization(input: GovernanceAuthorizationInput): Promise<GovernanceAuthorization>;
  recordCandidate(input: {
    actorIdHash: string;
    candidate: unknown;
  }): Promise<ReviewedReplayCandidate>;
  recordReview(input: {
    actorIdHash: string;
    review: unknown;
    reviewWorkLease?: ReviewWorkLeaseReference;
  }): Promise<ReviewedReplayReview>;
  revokeAuthorization(
    input: GovernanceAuthorizationRevocationInput,
  ): Promise<GovernanceAuthorizationRevocation>;
  tombstonePromotion(input: {
    actorIdHash: string;
    candidateId: string;
    tombstone: ReviewedReplayTombstoneInput;
  }): Promise<ReviewedReplayTombstone>;
}

export function createPgEvmChainAnalysisGovernanceStore(options: {
  client: PgControlClientLike;
}): EvmChainAnalysisGovernanceStore {
  const { client } = options;
  return {
    async claimRetentionJob(input): Promise<RetentionJob | undefined> {
      const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.asOf,
          principalIdHash: input.workerIdHash,
          role: 'retention_worker',
        });
        const response = await queryControlDatabase<RetentionJobRow>(
          transaction,
          `
            /* control:retention-claim */
            with selected as (
              select job_id
              from evm_chain_control_retention_jobs
              where
                retain_until <= $1::timestamptz
                and (
                  status = 'queued'
                  or (status = 'running' and lease_expires_at <= $1::timestamptz)
                )
              order by retain_until, job_id
              for update skip locked
              limit 1
            )
            update evm_chain_control_retention_jobs job
            set
              status = 'running',
              attempt_count = attempt_count + 1,
              worker_id_hash = $2,
              lease_expires_at = $1::timestamptz + make_interval(secs => $3),
              completed_at = null,
              outcome = null
            from selected
            where job.job_id = selected.job_id
            returning ${retentionJobColumns('job')}
          `,
          [input.asOf, input.workerIdHash, leaseSeconds],
        );
        const row = response.rows[0];
        if (row === undefined) {
          return undefined;
        }
        const job = mapRetentionJob(row);
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.workerIdHash,
          entityFingerprint: sha256Fingerprint(job),
          entityId: job.jobId,
          entityType: 'retention_job',
          eventAt: input.asOf,
          eventKind: 'retention_job_claimed',
          payload: {
            attemptCount: job.attemptCount,
            candidateId: job.candidateId,
            leaseExpiresAt: job.leaseExpiresAt,
          },
          stream: 'governance',
        });
        return job;
      });
    },

    async completeRetentionJob(input): Promise<RetentionJob> {
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.completedAt,
          principalIdHash: input.workerIdHash,
          role: 'retention_worker',
        });
        const jobResponse = await queryControlDatabase<RetentionJobRow>(
          transaction,
          `
            /* control:retention-lock */
            select ${retentionJobColumns()}
            from evm_chain_control_retention_jobs
            where job_id = $1
            for update
          `,
          [input.jobId],
        );
        const row = jobResponse.rows[0];
        if (row === undefined) {
          throw new ChainAnalysisControlStoreError(
            'retention_job_not_found',
            `Retention job ${input.jobId} was not found.`,
          );
        }
        const current = mapRetentionJob(row);
        if (current.status === 'completed') {
          if (
            current.workerIdHash !== input.workerIdHash ||
            current.completedAt !== input.completedAt
          ) {
            throw new ChainAnalysisControlStoreError(
              'invalid_state',
              'Completed retention jobs are idempotent only for the completing worker and time.',
            );
          }
          return current;
        }
        if (
          current.status !== 'running' ||
          current.workerIdHash !== input.workerIdHash ||
          current.leaseExpiresAt === undefined ||
          Date.parse(input.completedAt) >= Date.parse(current.leaseExpiresAt) ||
          Date.parse(input.completedAt) < Date.parse(current.retainUntil)
        ) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Retention completion requires the active worker lease after retention expiry.',
          );
        }
        const candidate = await requireCandidate(transaction, current.candidateId, true);
        const reviews = await readReviews(transaction, candidate.candidateId);
        const decision = evaluateReviewedReplayGovernance(candidate, reviews, input.completedAt);
        await insertDecision(transaction, decision, input.workerIdHash);
        const promotion = await readPromotion(transaction, candidate.candidateId, true);
        let outcome: RetentionJob['outcome'];
        if (promotion === undefined) {
          outcome = 'expired_unpromoted';
        } else {
          outcome = 'tombstoned';
          const existing = await readTombstone(transaction, candidate.candidateId, true);
          if (existing === undefined) {
            const tombstone = createReviewedReplayTombstone(promotion, {
              deletedAt: input.completedAt,
              deletedByHash: input.workerIdHash,
              reason: 'retention_expired',
            });
            await insertTombstone(transaction, tombstone, input.workerIdHash);
          }
        }
        const completed = await queryControlDatabase<RetentionJobRow>(
          transaction,
          `
            /* control:retention-complete */
            update evm_chain_control_retention_jobs
            set
              status = 'completed',
              lease_expires_at = null,
              completed_at = $2::timestamptz,
              outcome = $3
            where job_id = $1 and status = 'running' and worker_id_hash = $4
            returning ${retentionJobColumns()}
          `,
          [input.jobId, input.completedAt, outcome, input.workerIdHash],
        );
        const completedRow = completed.rows[0];
        if (completedRow === undefined) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Retention job lost its generation-fenced worker lease.',
          );
        }
        const job = mapRetentionJob(completedRow);
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.workerIdHash,
          entityFingerprint: sha256Fingerprint(job),
          entityId: job.jobId,
          entityType: 'retention_job',
          eventAt: input.completedAt,
          eventKind: 'retention_completed',
          payload: { candidateId: job.candidateId, outcome: job.outcome },
          stream: 'governance',
        });
        return job;
      });
    },

    async evaluateCandidate(input): Promise<ReviewedReplayGovernanceDecision> {
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.evaluatedAt,
          principalIdHash: input.actorIdHash,
          role: 'governance_publisher',
        });
        const candidate = await requireCandidate(transaction, input.candidateId, true);
        const reviews = await readReviews(transaction, candidate.candidateId);
        const decision = evaluateReviewedReplayGovernance(candidate, reviews, input.evaluatedAt);
        await insertDecision(transaction, decision, input.actorIdHash);
        return decision;
      });
    },

    async exportCorpus(input): Promise<ReviewedReplayCorpusExport> {
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.exportedAt,
          principalIdHash: input.actorIdHash,
          role: 'governance_publisher',
        });
        const promotions = await readAllPromotions(transaction);
        const tombstones = await readAllTombstones(transaction);
        const corpusExport = buildReviewedReplayCorpus({
          corpusId: input.corpusId,
          description: input.description,
          exportedAt: input.exportedAt,
          promotions,
          tombstones,
        });
        await acquireControlLock(transaction, `corpus-export:${corpusExport.exportFingerprint}`);
        const existing = await readPayloadByKey(
          transaction,
          `
            /* control:corpus-export-read */
            select payload from evm_chain_control_corpus_exports where export_fingerprint = $1
          `,
          corpusExport.exportFingerprint,
        );
        if (existing !== undefined) {
          const parsed = reviewedReplayCorpusExportSchema.parse(existing);
          assertSameFingerprint(
            corpusExport.exportFingerprint,
            parsed.exportFingerprint,
            'Corpus export',
          );
          return parsed;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:corpus-export-insert */
            insert into evm_chain_control_corpus_exports (
              export_fingerprint, exported_at, corpus_id, payload
            ) values ($1, $2::timestamptz, $3, $4::jsonb)
          `,
          [
            corpusExport.exportFingerprint,
            corpusExport.exportedAt,
            corpusExport.corpus.corpusId,
            JSON.stringify(corpusExport),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: corpusExport.exportFingerprint,
          entityId: corpusExport.corpus.corpusId,
          entityType: 'corpus_export',
          eventAt: corpusExport.exportedAt,
          eventKind: 'corpus_export_recorded',
          payload: {
            excluded: corpusExport.excluded.length,
            included: corpusExport.included.length,
          },
          stream: 'governance',
        });
        return corpusExport;
      });
    },

    async getCandidate(candidateId): Promise<ReviewedReplayCandidate | undefined> {
      return readCandidate(client, candidateId, false);
    },

    async getReviews(candidateId): Promise<ReviewedReplayReview[]> {
      return readReviews(client, candidateId);
    },

    async migrate(): Promise<void> {
      await migrateEvmChainAnalysisControlStore(client);
    },

    async promoteCandidate(input): Promise<ReviewedReplayPromotion> {
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.promotedAt,
          principalIdHash: input.actorIdHash,
          role: 'governance_publisher',
        });
        await acquireControlLock(transaction, `promotion:${input.candidateId}`);
        const candidate = await requireCandidate(transaction, input.candidateId, true);
        const reviews = await readReviews(transaction, candidate.candidateId);
        const decisionPayload = await readPayloadByKey(
          transaction,
          `
            /* control:decision-read */
            select payload from evm_chain_control_replay_decisions
            where decision_fingerprint = $1
          `,
          input.decisionFingerprint,
        );
        if (decisionPayload === undefined) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Promotion requires a persisted governance decision.',
          );
        }
        const decision = reviewedReplayGovernanceDecisionSchema.parse(decisionPayload);
        const reproduced = evaluateReviewedReplayGovernance(
          candidate,
          reviews,
          decision.evaluatedAt,
        );
        if (
          reproduced.decisionFingerprint !== decision.decisionFingerprint ||
          decision.status !== 'approved'
        ) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Promotion decision does not cover the current reviewed candidate state.',
          );
        }
        const promotion = promoteReviewedReplayCandidate(candidate, reviews, input.promotedAt);
        const existing = await readPromotion(transaction, candidate.candidateId, true);
        if (existing !== undefined) {
          assertSameFingerprint(
            promotion.promotionFingerprint,
            existing.promotionFingerprint,
            'Promotion',
          );
          return existing;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:promotion-insert */
            insert into evm_chain_control_replay_promotions (
              candidate_id, promotion_fingerprint, promoted_at, retain_until, payload
            ) values ($1, $2, $3::timestamptz, $4::timestamptz, $5::jsonb)
          `,
          [
            promotion.candidateId,
            promotion.promotionFingerprint,
            promotion.promotedAt,
            promotion.retainUntil,
            JSON.stringify(promotion),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: promotion.promotionFingerprint,
          entityId: promotion.candidateId,
          entityType: 'replay_promotion',
          eventAt: promotion.promotedAt,
          eventKind: 'promotion_recorded',
          payload: {
            approvalReviewFingerprints: promotion.approvalReviewFingerprints,
            decisionFingerprint: decision.decisionFingerprint,
          },
          stream: 'governance',
        });
        return promotion;
      });
    },

    async readAudit(stream): Promise<ChainAnalysisControlAuditEvent[]> {
      return verifyChainAnalysisControlAuditEvents(await readControlAuditEvents(client, stream));
    },

    async recordAuthorization(input): Promise<GovernanceAuthorization> {
      const authorization = createGovernanceAuthorization(input);
      return withControlTransaction(client, async (transaction) => {
        await acquireControlLock(transaction, `authorization:${authorization.authorizationId}`);
        const existing = await readPayloadByKey(
          transaction,
          `
            /* control:authorization-by-id */
            select payload from evm_chain_control_authorizations where authorization_id = $1
          `,
          authorization.authorizationId,
        );
        if (existing !== undefined) {
          const parsed = governanceAuthorizationSchema.parse(existing);
          assertSameFingerprint(
            authorization.authorizationFingerprint,
            parsed.authorizationFingerprint,
            'Authorization',
          );
          return parsed;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:authorization-insert */
            insert into evm_chain_control_authorizations (
              authorization_id,
              authorization_fingerprint,
              principal_id_hash,
              roles,
              granted_at,
              valid_until,
              payload
            ) values ($1, $2, $3, $4::text[], $5::timestamptz, $6::timestamptz, $7::jsonb)
          `,
          [
            authorization.authorizationId,
            authorization.authorizationFingerprint,
            authorization.principalIdHash,
            authorization.roles,
            authorization.grantedAt,
            authorization.validUntil ?? null,
            JSON.stringify(authorization),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: authorization.grantedByHash,
          entityFingerprint: authorization.authorizationFingerprint,
          entityId: authorization.authorizationId,
          entityType: 'authorization',
          eventAt: authorization.grantedAt,
          eventKind: 'authorization_recorded',
          payload: {
            principalIdHash: authorization.principalIdHash,
            roles: authorization.roles,
            validUntil: authorization.validUntil ?? null,
          },
          stream: 'governance',
        });
        return authorization;
      });
    },

    async recordCandidate(input): Promise<ReviewedReplayCandidate> {
      const candidate = reviewedReplayCandidateSchema.parse(input.candidate);
      assertActor(candidate.submitterIdHash, input.actorIdHash, 'Candidate submitter');
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: candidate.submittedAt,
          principalIdHash: input.actorIdHash,
          role: 'candidate_submitter',
        });
        await acquireControlLock(transaction, `candidate:${candidate.candidateId}`);
        if (candidate.supersedesCandidateId !== undefined) {
          await acquireControlLock(
            transaction,
            `candidate-successor:${candidate.supersedesCandidateId}`,
          );
        }
        const existing = await readCandidate(transaction, candidate.candidateId, true);
        if (existing !== undefined) {
          assertSameFingerprint(
            candidate.candidateFingerprint,
            existing.candidateFingerprint,
            'Candidate',
          );
          return existing;
        }
        await validateCandidateTransition(transaction, candidate);
        await queryControlDatabase(
          transaction,
          `
            /* control:candidate-insert */
            insert into evm_chain_control_replay_candidates (
              candidate_id,
              candidate_fingerprint,
              submitter_id_hash,
              revision,
              supersedes_candidate_id,
              submitted_at,
              retain_until,
              payload
            ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::jsonb)
          `,
          [
            candidate.candidateId,
            candidate.candidateFingerprint,
            candidate.submitterIdHash,
            candidate.revision,
            candidate.supersedesCandidateId ?? null,
            candidate.submittedAt,
            candidate.retainUntil,
            JSON.stringify(candidate),
          ],
        );
        const retentionJobId = `retention_${sha256Fingerprint({
          candidateId: candidate.candidateId,
          retainUntil: candidate.retainUntil,
        }).slice(7)}`;
        await queryControlDatabase(
          transaction,
          `
            /* control:retention-enqueue */
            insert into evm_chain_control_retention_jobs (
              job_id, candidate_id, retain_until, status
            ) values ($1, $2, $3::timestamptz, 'queued')
            on conflict (candidate_id) do nothing
          `,
          [retentionJobId, candidate.candidateId, candidate.retainUntil],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: candidate.candidateFingerprint,
          entityId: candidate.candidateId,
          entityType: 'replay_candidate',
          eventAt: candidate.submittedAt,
          eventKind: 'candidate_recorded',
          payload: {
            payloadFingerprint: candidate.payloadFingerprint,
            retainUntil: candidate.retainUntil,
            revision: candidate.revision,
            supersedesCandidateId: candidate.supersedesCandidateId ?? null,
          },
          stream: 'governance',
        });
        return candidate;
      });
    },

    async recordReview(input): Promise<ReviewedReplayReview> {
      const supplied = reviewedReplayReviewSchema.parse(input.review);
      assertActor(supplied.reviewerIdHash, input.actorIdHash, 'Reviewer');
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: supplied.reviewedAt,
          principalIdHash: input.actorIdHash,
          role: 'independent_reviewer',
        });
        await acquireControlLock(
          transaction,
          `reviewer:${supplied.candidateId}:${supplied.reviewerIdHash}`,
        );
        const candidate = await requireCandidate(transaction, supplied.candidateId, true);
        const reproduced = recordReviewedReplayDecision(candidate, reviewInputOf(supplied));
        assertSameFingerprint(
          reproduced.reviewFingerprint,
          supplied.reviewFingerprint,
          'Review transition',
        );
        const existingPayload = await readPayloadByTwoKeys(
          transaction,
          `
            /* control:review-by-reviewer */
            select payload from evm_chain_control_replay_reviews
            where candidate_id = $1 and reviewer_id_hash = $2
          `,
          supplied.candidateId,
          supplied.reviewerIdHash,
        );
        if (existingPayload !== undefined) {
          const existing = reviewedReplayReviewSchema.parse(existingPayload);
          if (existing.reviewFingerprint !== supplied.reviewFingerprint) {
            throw new ChainAnalysisControlStoreError(
              'reviewer_conflict',
              'A reviewer can record only one immutable decision per candidate revision.',
            );
          }
          return existing;
        }
        const reviewWorkJob = await requireHandoffReviewLease(transaction, {
          review: supplied,
          ...(input.reviewWorkLease === undefined ? {} : { lease: input.reviewWorkLease }),
        });
        await queryControlDatabase(
          transaction,
          `
            /* control:review-insert */
            insert into evm_chain_control_replay_reviews (
              review_id,
              review_fingerprint,
              candidate_id,
              reviewer_id_hash,
              reviewed_at,
              payload
            ) values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
          `,
          [
            supplied.reviewId,
            supplied.reviewFingerprint,
            supplied.candidateId,
            supplied.reviewerIdHash,
            supplied.reviewedAt,
            JSON.stringify(supplied),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: supplied.reviewFingerprint,
          entityId: supplied.reviewId,
          entityType: 'replay_review',
          eventAt: supplied.reviewedAt,
          eventKind: 'review_recorded',
          payload: {
            candidateFingerprint: supplied.candidateFingerprint,
            candidateId: supplied.candidateId,
            decision: supplied.decision,
          },
          stream: 'governance',
        });
        if (reviewWorkJob !== undefined) {
          await completeHandoffReviewWorkJob(transaction, {
            actorIdHash: input.actorIdHash,
            job: reviewWorkJob,
            review: supplied,
          });
        }
        return supplied;
      });
    },

    async revokeAuthorization(
      input: GovernanceAuthorizationRevocationInput,
    ): Promise<GovernanceAuthorizationRevocation> {
      const revocation = createGovernanceAuthorizationRevocation(input);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: revocation.revokedAt,
          principalIdHash: revocation.revokedByHash,
          role: 'governance_publisher',
        });
        await acquireControlLock(
          transaction,
          `authorization-revocation:${revocation.authorizationId}`,
        );
        const authorizationPayload = await readPayloadByKey(
          transaction,
          `
            /* control:authorization-by-id */
            select payload from evm_chain_control_authorizations where authorization_id = $1
          `,
          revocation.authorizationId,
        );
        if (authorizationPayload === undefined) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            `Authorization ${revocation.authorizationId} was not found.`,
          );
        }
        const authorization = governanceAuthorizationSchema.parse(authorizationPayload);
        for (const role of authorization.roles) {
          await acquireControlLock(
            transaction,
            `authorization-role:${authorization.principalIdHash}:${role}`,
          );
        }
        if (Date.parse(revocation.revokedAt) < Date.parse(authorization.grantedAt)) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Authorization revocation cannot predate the grant.',
          );
        }
        const existingPayload = await readPayloadByKey(
          transaction,
          `
            /* control:authorization-revocation-read */
            select payload from evm_chain_control_authorization_revocations
            where authorization_id = $1
          `,
          revocation.authorizationId,
        );
        if (existingPayload !== undefined) {
          const existing = governanceAuthorizationRevocationSchema.parse(existingPayload);
          assertSameFingerprint(
            revocation.revocationFingerprint,
            existing.revocationFingerprint,
            'Authorization revocation',
          );
          return existing;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:authorization-revocation-insert */
            insert into evm_chain_control_authorization_revocations (
              revocation_id, revocation_fingerprint, authorization_id, revoked_at, payload
            ) values ($1, $2, $3, $4::timestamptz, $5::jsonb)
          `,
          [
            revocation.revocationId,
            revocation.revocationFingerprint,
            revocation.authorizationId,
            revocation.revokedAt,
            JSON.stringify(revocation),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: revocation.revokedByHash,
          entityFingerprint: revocation.revocationFingerprint,
          entityId: revocation.revocationId,
          entityType: 'authorization_revocation',
          eventAt: revocation.revokedAt,
          eventKind: 'authorization_revoked',
          payload: {
            authorizationFingerprint: authorization.authorizationFingerprint,
            authorizationId: authorization.authorizationId,
            reasonCode: revocation.reasonCode,
          },
          stream: 'governance',
        });
        return revocation;
      });
    },

    async tombstonePromotion(input): Promise<ReviewedReplayTombstone> {
      assertActor(input.tombstone.deletedByHash, input.actorIdHash, 'Tombstone actor');
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.tombstone.deletedAt,
          principalIdHash: input.actorIdHash,
          role:
            input.tombstone.reason === 'retention_expired'
              ? 'retention_worker'
              : 'governance_publisher',
        });
        await acquireControlLock(transaction, `tombstone:${input.candidateId}`);
        const promotion = await readPromotion(transaction, input.candidateId, true);
        if (promotion === undefined) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            `Promoted candidate ${input.candidateId} was not found.`,
          );
        }
        const tombstone = createReviewedReplayTombstone(promotion, input.tombstone);
        const existing = await readTombstone(transaction, input.candidateId, true);
        if (existing !== undefined) {
          assertSameFingerprint(
            tombstone.tombstoneFingerprint,
            existing.tombstoneFingerprint,
            'Tombstone',
          );
          return existing;
        }
        await insertTombstone(transaction, tombstone, input.actorIdHash);
        return tombstone;
      });
    },
  };
}

async function validateCandidateTransition(
  client: PgControlClientLike,
  candidate: ReviewedReplayCandidate,
): Promise<void> {
  const intake = candidateIntakeOf(candidate);
  if (candidate.revision === 1) {
    const reproduced = createReviewedReplayCandidate(intake);
    assertSameFingerprint(
      reproduced.candidateFingerprint,
      candidate.candidateFingerprint,
      'Candidate transition',
    );
    return;
  }
  if (candidate.supersedesCandidateId === undefined) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'A revised candidate must identify its predecessor.',
    );
  }
  const predecessor = await readCandidate(client, candidate.supersedesCandidateId, true);
  if (predecessor === undefined) {
    throw new ChainAnalysisControlStoreError(
      'candidate_not_found',
      `Superseded candidate ${candidate.supersedesCandidateId} was not found.`,
    );
  }
  const successorPayload = await readPayloadByKey(
    client,
    `
      /* control:candidate-successor-read */
      select payload from evm_chain_control_replay_candidates
      where supersedes_candidate_id = $1
    `,
    predecessor.candidateId,
  );
  if (successorPayload !== undefined) {
    const successor = reviewedReplayCandidateSchema.parse(successorPayload);
    if (successor.candidateFingerprint !== candidate.candidateFingerprint) {
      throw new ChainAnalysisControlStoreError(
        'immutable_conflict',
        `Candidate ${predecessor.candidateId} already has a different successor.`,
      );
    }
  }
  const reproduced = reviseReviewedReplayCandidate(predecessor, intake);
  assertSameFingerprint(
    reproduced.candidateFingerprint,
    candidate.candidateFingerprint,
    'Candidate revision transition',
  );
}

async function insertDecision(
  client: PgControlClientLike,
  decision: ReviewedReplayGovernanceDecision,
  actorIdHash: string,
): Promise<void> {
  await acquireControlLock(client, `decision:${decision.decisionFingerprint}`);
  const existing = await readPayloadByKey(
    client,
    `
      /* control:decision-read */
      select payload from evm_chain_control_replay_decisions where decision_fingerprint = $1
    `,
    decision.decisionFingerprint,
  );
  if (existing !== undefined) {
    const parsed = reviewedReplayGovernanceDecisionSchema.parse(existing);
    assertSameFingerprint(
      decision.decisionFingerprint,
      parsed.decisionFingerprint,
      'Governance decision',
    );
    return;
  }
  await queryControlDatabase(
    client,
    `
      /* control:decision-insert */
      insert into evm_chain_control_replay_decisions (
        decision_fingerprint, candidate_id, evaluated_at, status, payload
      ) values ($1, $2, $3::timestamptz, $4, $5::jsonb)
    `,
    [
      decision.decisionFingerprint,
      decision.candidateId,
      decision.evaluatedAt,
      decision.status,
      JSON.stringify(decision),
    ],
  );
  await appendControlAuditEvent(client, {
    actorIdHash,
    entityFingerprint: decision.decisionFingerprint,
    entityId: decision.candidateId,
    entityType: 'replay_governance_decision',
    eventAt: decision.evaluatedAt,
    eventKind: 'governance_decision_recorded',
    payload: {
      reviewFingerprints: decision.reviewFingerprints,
      status: decision.status,
    },
    stream: 'governance',
  });
}

async function insertTombstone(
  client: PgControlClientLike,
  tombstone: ReviewedReplayTombstone,
  actorIdHash: string,
): Promise<void> {
  await queryControlDatabase(
    client,
    `
      /* control:tombstone-insert */
      insert into evm_chain_control_replay_tombstones (
        candidate_id, tombstone_id, tombstone_fingerprint, deleted_at, payload
      ) values ($1, $2, $3, $4::timestamptz, $5::jsonb)
    `,
    [
      tombstone.candidateId,
      tombstone.tombstoneId,
      tombstone.tombstoneFingerprint,
      tombstone.deletedAt,
      JSON.stringify(tombstone),
    ],
  );
  await appendControlAuditEvent(client, {
    actorIdHash,
    entityFingerprint: tombstone.tombstoneFingerprint,
    entityId: tombstone.tombstoneId,
    entityType: 'replay_tombstone',
    eventAt: tombstone.deletedAt,
    eventKind: 'tombstone_recorded',
    payload: {
      candidateId: tombstone.candidateId,
      reason: tombstone.reason,
      replacementCandidateId: tombstone.replacementCandidateId ?? null,
    },
    stream: 'governance',
  });
}

async function requireCandidate(
  client: PgControlClientLike,
  candidateId: string,
  forUpdate: boolean,
): Promise<ReviewedReplayCandidate> {
  const candidate = await readCandidate(client, candidateId, forUpdate);
  if (candidate === undefined) {
    throw new ChainAnalysisControlStoreError(
      'candidate_not_found',
      `Reviewed replay candidate ${candidateId} was not found.`,
    );
  }
  return candidate;
}

async function readCandidate(
  client: PgControlClientLike,
  candidateId: string,
  forUpdate: boolean,
): Promise<ReviewedReplayCandidate | undefined> {
  const payload = await readPayloadByKey(
    client,
    `
      /* control:candidate-read */
      select payload from evm_chain_control_replay_candidates
      where candidate_id = $1
      ${forUpdate ? 'for update' : ''}
    `,
    candidateId,
  );
  return payload === undefined ? undefined : reviewedReplayCandidateSchema.parse(payload);
}

async function readReviews(
  client: PgControlClientLike,
  candidateId: string,
): Promise<ReviewedReplayReview[]> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:reviews-read */
      select payload from evm_chain_control_replay_reviews
      where candidate_id = $1
      order by reviewed_at, review_id
    `,
    [candidateId],
  );
  return response.rows.map((row) => reviewedReplayReviewSchema.parse(row.payload));
}

async function readPromotion(
  client: PgControlClientLike,
  candidateId: string,
  forUpdate: boolean,
): Promise<ReviewedReplayPromotion | undefined> {
  const payload = await readPayloadByKey(
    client,
    `
      /* control:promotion-read */
      select payload from evm_chain_control_replay_promotions
      where candidate_id = $1
      ${forUpdate ? 'for update' : ''}
    `,
    candidateId,
  );
  return payload === undefined ? undefined : reviewedReplayPromotionSchema.parse(payload);
}

async function readTombstone(
  client: PgControlClientLike,
  candidateId: string,
  forUpdate: boolean,
): Promise<ReviewedReplayTombstone | undefined> {
  const payload = await readPayloadByKey(
    client,
    `
      /* control:tombstone-read */
      select payload from evm_chain_control_replay_tombstones
      where candidate_id = $1
      ${forUpdate ? 'for update' : ''}
    `,
    candidateId,
  );
  return payload === undefined ? undefined : reviewedReplayTombstoneSchema.parse(payload);
}

async function readAllPromotions(client: PgControlClientLike): Promise<ReviewedReplayPromotion[]> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:promotions-read */
      select payload from evm_chain_control_replay_promotions
      order by candidate_id
      limit 501
    `,
  );
  return response.rows.map((row) => reviewedReplayPromotionSchema.parse(row.payload));
}

async function readAllTombstones(client: PgControlClientLike): Promise<ReviewedReplayTombstone[]> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:tombstones-read */
      select payload from evm_chain_control_replay_tombstones
      order by candidate_id
      limit 501
    `,
  );
  return response.rows.map((row) => reviewedReplayTombstoneSchema.parse(row.payload));
}

async function readPayloadByKey(
  client: PgControlClientLike,
  sql: string,
  key: string,
): Promise<unknown> {
  const response = await queryControlDatabase<PayloadRow>(client, sql, [key]);
  return response.rows[0]?.payload;
}

async function readPayloadByTwoKeys(
  client: PgControlClientLike,
  sql: string,
  first: string,
  second: string,
): Promise<unknown> {
  const response = await queryControlDatabase<PayloadRow>(client, sql, [first, second]);
  return response.rows[0]?.payload;
}

function candidateIntakeOf(candidate: ReviewedReplayCandidate) {
  return {
    payload: candidate.payload,
    retainUntil: candidate.retainUntil,
    retentionPolicyId: candidate.retentionPolicyId,
    scanner: candidate.scanner,
    sourcePayloadHashes: candidate.sourcePayloadHashes,
    submittedAt: candidate.submittedAt,
    submitterIdHash: candidate.submitterIdHash,
  };
}

function reviewInputOf(review: ReviewedReplayReview) {
  return {
    attestations: review.attestations,
    decision: review.decision,
    evidencePayloadHashes: review.evidencePayloadHashes,
    labelFingerprint: review.labelFingerprint,
    ...(review.noteHash === undefined ? {} : { noteHash: review.noteHash }),
    reasonCodes: review.reasonCodes,
    reviewedAt: review.reviewedAt,
    reviewerIdHash: review.reviewerIdHash,
    ...(review.suggestedGroundTruth === undefined
      ? {}
      : { suggestedGroundTruth: review.suggestedGroundTruth }),
  };
}

function mapRetentionJob(row: RetentionJobRow): RetentionJob {
  return retentionJobSchema.parse({
    attemptCount: parseSafeInteger(row.attempt_count, 'retention attempt count'),
    candidateId: row.candidate_id,
    jobId: row.job_id,
    retainUntil: row.retain_until,
    status: row.status,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.worker_id_hash === null ? {} : { workerIdHash: row.worker_id_hash }),
  });
}

function normalizeLeaseSeconds(value: number | undefined): number {
  const normalized = value ?? 300;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 3_600) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'Retention leaseSeconds must be an integer between 1 and 3600.',
    );
  }
  return normalized;
}

function retentionJobColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return `
    ${prefix}job_id,
    ${prefix}candidate_id,
    to_char(${prefix}retain_until at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as retain_until,
    ${prefix}status,
    ${prefix}attempt_count,
    ${prefix}worker_id_hash,
    to_char(${prefix}lease_expires_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as lease_expires_at,
    to_char(${prefix}completed_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as completed_at,
    ${prefix}outcome
  `;
}
