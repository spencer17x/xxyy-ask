import { describe, expect, it, vi } from 'vitest';

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

import { testHash } from './fixtures.test-helper.js';
import { createProductionWorkerRuntime } from './workers.js';

describe('production worker runtime', () => {
  it('runs sampling, human review, retention, and budget reconciliation through fenced stores', async () => {
    const samplingJob = {
      attemptCount: 1,
      jobId: 'sampling_job',
      planId: 'sampling_plan',
      status: 'running',
    } as SamplingIntakeJob;
    const reviewJob = {
      attemptCount: 1,
      candidateId: 'candidate',
      jobId: 'review_job',
      status: 'running',
    } as ReviewWorkJob;
    const completedReviewJob = { ...reviewJob, status: 'succeeded' } as ReviewWorkJob;
    const retentionJob = {
      jobId: 'retention_job',
      status: 'running',
    } as RetentionJob;
    const completedRetention = {
      ...retentionJob,
      outcome: 'expired_unpromoted',
      status: 'completed',
    } as RetentionJob;
    const plan = { planId: samplingJob.planId } as MainnetSamplingPlan;
    const candidate = { candidateId: reviewJob.candidateId } as ReviewedReplayCandidate;
    const recordReview = vi.fn(() => Promise.resolve({}));
    const samplingStore = {
      claimIntakeJob: vi.fn(() => Promise.resolve(samplingJob)),
      completeIntakeJob: vi.fn(() => Promise.resolve({ job: samplingJob, manifest: {} })),
      failIntakeJob: vi.fn(),
      getPlan: vi.fn(() => Promise.resolve(plan)),
    } as unknown as PgEvmChainAnalysisSamplingStore;
    const reviewWorkStore = {
      claimReviewJob: vi.fn(() => Promise.resolve(reviewJob)),
      failReviewJob: vi.fn(),
      getReviewJob: vi.fn(() => Promise.resolve(completedReviewJob)),
    } as unknown as PgEvmChainAnalysisReviewWorkStore;
    const governanceStore = {
      claimRetentionJob: vi.fn(() => Promise.resolve(retentionJob)),
      completeRetentionJob: vi.fn(() => Promise.resolve(completedRetention)),
      getCandidate: vi.fn(() => Promise.resolve(candidate)),
      recordReview,
    } as unknown as EvmChainAnalysisGovernanceStore;
    const providerControlStore = {
      reconcileExpiredLeases: vi.fn(() => Promise.resolve([{}, {}])),
    } as unknown as PgEvmChainAnalysisProviderControlStore;
    const runtime = createProductionWorkerRuntime({
      governanceStore,
      now: () => '2026-07-23T00:00:00.000Z',
      providerControlStore,
      reconciliationWorkerIdHash: testHash('reconciliation-worker'),
      retentionWorkerIdHash: testHash('retention-worker'),
      reviewHandler: () => Promise.resolve({ decision: 'approve' }),
      reviewerIdHash: testHash('owner-reviewer'),
      reviewWorkStore,
      samplingHandler: () => Promise.resolve({ manifestId: 'manifest' }),
      samplingStore,
      samplingWorkerIdHash: testHash('sampling-worker'),
    });

    expect(await runtime.runSamplingOnce()).toEqual(samplingJob);
    expect(await runtime.runReviewOnce()).toEqual(completedReviewJob);
    expect(await runtime.runRetentionOnce()).toEqual(completedRetention);
    expect(await runtime.reconcileProviderBudgetsOnce()).toBe(2);
    expect(recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewWorkLease: { attemptCount: 1, jobId: reviewJob.jobId },
      }),
    );
  });

  it('records only a hashed stable failure code when a sampling handler fails', async () => {
    const samplingJob = {
      attemptCount: 1,
      jobId: 'sampling_job',
      planId: 'sampling_plan',
      status: 'running',
    } as SamplingIntakeJob;
    const failIntakeJob = vi.fn((_input: { failureCodeHash: string }) =>
      Promise.resolve(samplingJob),
    );
    const runtime = createProductionWorkerRuntime({
      governanceStore: {} as EvmChainAnalysisGovernanceStore,
      now: () => '2026-07-23T00:00:00.000Z',
      providerControlStore: {} as PgEvmChainAnalysisProviderControlStore,
      reconciliationWorkerIdHash: testHash('reconciliation-worker'),
      retentionWorkerIdHash: testHash('retention-worker'),
      reviewHandler: () => Promise.resolve({}),
      reviewerIdHash: testHash('owner-reviewer'),
      reviewWorkStore: {} as PgEvmChainAnalysisReviewWorkStore,
      samplingHandler: () =>
        Promise.reject(
          Object.assign(new Error('sensitive provider detail'), {
            code: 'provider_unavailable',
          }),
        ),
      samplingStore: {
        claimIntakeJob: () => Promise.resolve(samplingJob),
        failIntakeJob,
        getPlan: () => Promise.resolve({ planId: samplingJob.planId } as MainnetSamplingPlan),
      } as unknown as PgEvmChainAnalysisSamplingStore,
      samplingWorkerIdHash: testHash('sampling-worker'),
    });

    await expect(runtime.runSamplingOnce()).rejects.toThrow('sensitive provider detail');
    expect(failIntakeJob).toHaveBeenCalledTimes(1);
    expect(failIntakeJob.mock.calls[0]?.[0].failureCodeHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(failIntakeJob.mock.calls)).not.toContain('sensitive provider detail');
  });
});
