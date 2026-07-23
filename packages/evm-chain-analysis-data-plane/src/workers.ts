import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import type {
  EvmChainAnalysisGovernanceStore,
  PgEvmChainAnalysisProviderControlStore,
  PgEvmChainAnalysisReviewWorkStore,
  PgEvmChainAnalysisSamplingStore,
  RetentionJob,
  ReviewWorkJob,
  SamplingIntakeJob,
} from '@xxyy/evm-chain-analysis-control-store';
import type {
  MainnetSamplingPlan,
  ReviewedReplayCandidate,
} from '@xxyy/evm-chain-analysis-readiness';

export interface ProductionWorkerRuntime {
  reconcileProviderBudgetsOnce(): Promise<number>;
  runRetentionOnce(): Promise<RetentionJob | undefined>;
  runReviewOnce(): Promise<ReviewWorkJob | undefined>;
  runSamplingOnce(): Promise<SamplingIntakeJob | undefined>;
}

export interface SamplingWorkerHandlerInput {
  job: SamplingIntakeJob;
  plan: MainnetSamplingPlan;
}

export interface ReviewWorkerHandlerInput {
  candidate: ReviewedReplayCandidate;
  job: ReviewWorkJob;
}

export function createProductionWorkerRuntime(options: {
  governanceStore: EvmChainAnalysisGovernanceStore;
  now?: (() => string) | undefined;
  providerControlStore: PgEvmChainAnalysisProviderControlStore;
  reconciliationWorkerIdHash: string;
  retentionLeaseSeconds?: number | undefined;
  retentionWorkerIdHash: string;
  reviewHandler: (input: ReviewWorkerHandlerInput) => Promise<unknown>;
  reviewLeaseSeconds?: number | undefined;
  reviewerIdHash: string;
  reviewWorkStore: PgEvmChainAnalysisReviewWorkStore;
  samplingHandler: (input: SamplingWorkerHandlerInput) => Promise<unknown>;
  samplingLeaseSeconds?: number | undefined;
  samplingStore: PgEvmChainAnalysisSamplingStore;
  samplingWorkerIdHash: string;
}): ProductionWorkerRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async reconcileProviderBudgetsOnce() {
      return (
        await options.providerControlStore.reconcileExpiredLeases({
          asOf: now(),
          workerIdHash: options.reconciliationWorkerIdHash,
        })
      ).length;
    },

    async runRetentionOnce() {
      const claimed = await options.governanceStore.claimRetentionJob({
        asOf: now(),
        ...(options.retentionLeaseSeconds === undefined
          ? {}
          : { leaseSeconds: options.retentionLeaseSeconds }),
        workerIdHash: options.retentionWorkerIdHash,
      });
      if (claimed === undefined) {
        return undefined;
      }
      return options.governanceStore.completeRetentionJob({
        completedAt: now(),
        jobId: claimed.jobId,
        workerIdHash: options.retentionWorkerIdHash,
      });
    },

    async runReviewOnce() {
      const claimed = await options.reviewWorkStore.claimReviewJob({
        asOf: now(),
        ...(options.reviewLeaseSeconds === undefined
          ? {}
          : { leaseSeconds: options.reviewLeaseSeconds }),
        reviewerIdHash: options.reviewerIdHash,
      });
      if (claimed === undefined) {
        return undefined;
      }
      let review: unknown;
      try {
        const candidate = await options.governanceStore.getCandidate(claimed.candidateId);
        if (candidate === undefined) {
          throw workerError('candidate_not_found');
        }
        review = await options.reviewHandler({ candidate, job: claimed });
      } catch (cause) {
        await options.reviewWorkStore.failReviewJob({
          attemptCount: claimed.attemptCount,
          failedAt: now(),
          failureCodeHash: failureCodeHash('review', cause),
          jobId: claimed.jobId,
          reviewerIdHash: options.reviewerIdHash,
        });
        throw cause;
      }
      await options.governanceStore.recordReview({
        actorIdHash: options.reviewerIdHash,
        review,
        reviewWorkLease: {
          attemptCount: claimed.attemptCount,
          jobId: claimed.jobId,
        },
      });
      const completed = await options.reviewWorkStore.getReviewJob(claimed.jobId);
      if (completed === undefined) {
        throw workerError('completed_review_job_not_found');
      }
      return completed;
    },

    async runSamplingOnce() {
      const claimed = await options.samplingStore.claimIntakeJob({
        asOf: now(),
        ...(options.samplingLeaseSeconds === undefined
          ? {}
          : { leaseSeconds: options.samplingLeaseSeconds }),
        workerIdHash: options.samplingWorkerIdHash,
      });
      if (claimed === undefined) {
        return undefined;
      }
      try {
        const plan = await options.samplingStore.getPlan(claimed.planId);
        if (plan === undefined) {
          throw workerError('sampling_plan_not_found');
        }
        const manifest = await options.samplingHandler({ job: claimed, plan });
        const completed = await options.samplingStore.completeIntakeJob({
          completedAt: now(),
          jobId: claimed.jobId,
          manifest,
          workerIdHash: options.samplingWorkerIdHash,
        });
        return completed.job;
      } catch (cause) {
        await options.samplingStore.failIntakeJob({
          failedAt: now(),
          failureCodeHash: failureCodeHash('sampling', cause),
          jobId: claimed.jobId,
          workerIdHash: options.samplingWorkerIdHash,
        });
        throw cause;
      }
    },
  };
}

function failureCodeHash(worker: 'review' | 'sampling', cause: unknown): string {
  return sha256Fingerprint({
    code:
      cause !== null &&
      typeof cause === 'object' &&
      'code' in cause &&
      typeof cause.code === 'string'
        ? cause.code
        : 'unexpected_failure',
    worker,
  });
}

function workerError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
