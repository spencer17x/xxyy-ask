import { describe, expect, it } from 'vitest';

import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import { createSamplingCandidateHandoff } from '@xxyy/evm-chain-analysis-readiness';
import {
  createContractOnlySamplingFixture,
  createContractOnlySamplingHandoffFixture,
} from '@xxyy/evm-chain-analysis-readiness/test-fixtures';

import { createGovernanceAuthorization, createPgEvmChainAnalysisSamplingStore } from './index.js';
import { testHash } from './fixtures.test-helper.js';
import { ScriptedPgClient, authorizationRow } from './scripted-pg.test-helper.js';

describe('PostgreSQL mainnet sampling control store', () => {
  it('records policy/plan from a persisted approval and enqueues every quota slot', async () => {
    const { approval, plan, policy } = createContractOnlySamplingFixture();
    const planner = testHash('sampling-planner');
    const authorization = plannerAuthorization(planner);
    const client = new ScriptedPgClient();
    client.enqueue(
      'authorization-read',
      [authorizationRow(authorization)],
      [authorizationRow(authorization)],
    );
    client.enqueue('sampling-approval-read', [{ payload: approval }], [{ payload: approval }]);
    client.enqueue('sampling-policy-read', [{ payload: policy }]);
    const store = createPgEvmChainAnalysisSamplingStore({ client });

    await expect(store.recordPolicy({ actorIdHash: planner, policy })).resolves.toEqual(policy);
    await expect(store.recordPlan({ actorIdHash: planner, plan })).resolves.toEqual(plan);

    expect(client.queries.filter((query) => query.tag === 'sampling-job-enqueue')).toHaveLength(
      plan.totalTargetSamples,
    );
    expect(client.auditEvents.map(eventKind)).toEqual([
      'sampling_policy_recorded',
      'sampling_plan_recorded',
    ]);
    expect(client.transactionEvents).toEqual(['begin', 'commit', 'begin', 'commit']);
  });

  it('claims with SKIP LOCKED, records a fenced failure, and requires planner retry', async () => {
    const { plan } = createContractOnlySamplingFixture();
    const planner = testHash('sampling-planner');
    const worker = testHash('sampling-worker');
    const client = new ScriptedPgClient();
    client.enqueue(
      'authorization-read',
      [authorizationRow(workerAuthorization(worker))],
      [authorizationRow(workerAuthorization(worker))],
      [authorizationRow(plannerAuthorization(planner))],
    );
    const queued = samplingJobRow(plan, 'queued');
    const running = {
      ...queued,
      attempt_count: 1,
      lease_expires_at: '2026-07-24T00:05:00.000Z',
      status: 'running',
      worker_id_hash: worker,
    };
    const failed = {
      ...running,
      failed_at: '2026-07-24T00:02:00.000Z',
      failure_code_hash: testHash('provider-timeout'),
      lease_expires_at: null,
      status: 'failed',
    };
    const retried = {
      ...failed,
      failed_at: null,
      failure_code_hash: null,
      status: 'queued',
      worker_id_hash: null,
    };
    client.enqueue('sampling-job-claim', [running]);
    client.enqueue('sampling-job-read', [running], [failed]);
    client.enqueue('sampling-job-fail', [failed]);
    client.enqueue('sampling-job-retry', [retried]);
    const store = createPgEvmChainAnalysisSamplingStore({ client });

    const claimed = await store.claimIntakeJob({
      asOf: '2026-07-24T00:00:00.000Z',
      workerIdHash: worker,
    });
    expect(claimed?.status).toBe('running');
    const claimSql = client.queries.find((query) => query.tag === 'sampling-job-claim')!.sql;
    expect(claimSql.toLowerCase()).toContain('for update skip locked');
    expect(claimSql.toLowerCase()).toContain('attempt_count < max_attempts');

    const failure = await store.failIntakeJob({
      failedAt: '2026-07-24T00:02:00.000Z',
      failureCodeHash: testHash('provider-timeout'),
      jobId: claimed!.jobId,
      workerIdHash: worker,
    });
    expect(failure.status).toBe('failed');
    const retry = await store.retryIntakeJob({
      actorIdHash: planner,
      jobId: claimed!.jobId,
      retriedAt: '2026-07-24T00:03:00.000Z',
    });
    expect(retry.status).toBe('queued');
    expect(retry.attemptCount).toBe(1);
  });

  it('atomically completes a leased job with a deduplicated immutable manifest', async () => {
    const { manifests, plan } = createContractOnlySamplingFixture();
    const worker = testHash('sampling-worker');
    const manifest = manifests[0]!;
    const running = {
      ...samplingJobRow(plan, 'running', manifest.slotId),
      attempt_count: 1,
      lease_expires_at: '2026-07-24T09:00:00.000Z',
      worker_id_hash: worker,
    };
    const succeeded = {
      ...running,
      completed_at: '2026-07-24T08:00:00.000Z',
      lease_expires_at: null,
      manifest_fingerprint: manifest.manifestFingerprint,
      manifest_id: manifest.manifestId,
      status: 'succeeded',
    };
    const client = new ScriptedPgClient();
    client.enqueue('authorization-read', [authorizationRow(workerAuthorization(worker))]);
    client.enqueue('sampling-job-read', [running]);
    client.enqueue('sampling-plan-read', [{ payload: plan }]);
    client.enqueue('sampling-job-complete', [succeeded]);
    const store = createPgEvmChainAnalysisSamplingStore({ client });

    const completion = await store.completeIntakeJob({
      completedAt: '2026-07-24T08:00:00.000Z',
      jobId: running.job_id,
      manifest,
      workerIdHash: worker,
    });

    expect(completion.job.status).toBe('succeeded');
    expect(completion.manifest).toEqual(manifest);
    expect(client.queries.some((query) => query.tag === 'sampling-manifest-insert')).toBe(true);
    expect(client.auditEvents.map(eventKind)).toEqual([
      'sampling_manifest_recorded',
      'sampling_job_completed',
    ]);
  });

  it('reproduces a manifest from the persisted plan instead of trusting a self-hashed retention date', async () => {
    const { manifests, plan } = createContractOnlySamplingFixture();
    const worker = testHash('sampling-worker');
    const original = manifests[0]!;
    const {
      manifestFingerprint: _manifestFingerprint,
      manifestId: _manifestId,
      ...originalBody
    } = original;
    const body = { ...originalBody, retainUntil: '2026-09-30T00:00:00.000Z' };
    const manifestFingerprint = sha256Fingerprint(body);
    const tampered = {
      ...body,
      manifestFingerprint,
      manifestId: `sample_manifest_${manifestFingerprint.slice(7)}`,
    };
    const running = {
      ...samplingJobRow(plan, 'running', original.slotId),
      attempt_count: 1,
      lease_expires_at: '2026-07-24T09:00:00.000Z',
      worker_id_hash: worker,
    };
    const client = new ScriptedPgClient();
    client.enqueue('authorization-read', [authorizationRow(workerAuthorization(worker))]);
    client.enqueue('sampling-job-read', [running]);
    client.enqueue('sampling-plan-read', [{ payload: plan }]);
    const store = createPgEvmChainAnalysisSamplingStore({ client });

    await expect(
      store.completeIntakeJob({
        completedAt: '2026-07-24T08:00:00.000Z',
        jobId: running.job_id,
        manifest: tampered,
        workerIdHash: worker,
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(client.queries.some((query) => query.tag === 'sampling-manifest-insert')).toBe(false);
  });

  it('persists a deterministic coverage run from stored manifests', async () => {
    const { approval, manifests, plan } = createContractOnlySamplingFixture();
    const planner = testHash('sampling-planner');
    const client = new ScriptedPgClient();
    client.enqueue('authorization-read', [authorizationRow(plannerAuthorization(planner))]);
    client.enqueue('sampling-plan-read', [{ payload: plan }]);
    client.enqueue('sampling-approval-read', [{ payload: approval }]);
    client.enqueue(
      'sampling-manifests-read',
      manifests.map((payload) => ({ payload })),
    );
    const store = createPgEvmChainAnalysisSamplingStore({ client });

    const result = await store.recordCoverageRun({
      actorIdHash: planner,
      evaluatedAt: '2026-07-25T00:00:00.000Z',
      planId: plan.planId,
    });

    expect(result.status).toBe('complete');
    expect(client.queries.some((query) => query.tag === 'sampling-run-insert')).toBe(true);
    expect(client.auditEvents.map(eventKind)).toEqual(['sampling_run_recorded']);
  });

  it('atomically persists a handoff, candidate, retention job, and two review slots', async () => {
    const { handoff, manifest } = await createContractOnlySamplingHandoffFixture({
      targetLabel: 'negative',
    });
    const submitter = handoff.candidate.submitterIdHash;
    const client = new ScriptedPgClient();
    client.enqueue('authorization-read', [authorizationRow(candidateAuthorization(submitter))]);
    client.enqueue('sampling-manifest-read', [{ payload: manifest }]);
    const store = createPgEvmChainAnalysisSamplingStore({ client });

    await expect(
      store.recordCandidateHandoff({ actorIdHash: submitter, handoff }),
    ).resolves.toEqual(handoff);

    expect(client.queries.some((query) => query.tag === 'sampling-candidate-insert')).toBe(true);
    expect(client.queries.some((query) => query.tag === 'sampling-retention-enqueue')).toBe(true);
    const reviewJobs = client.queries.filter((query) => query.tag === 'review-job-enqueue');
    expect(reviewJobs).toHaveLength(2);
    expect(reviewJobs.map((query) => query.values[3])).toEqual([1, 2]);
    expect(new Set(reviewJobs.map((query) => query.values[0])).size).toBe(2);
    expect(client.queries.some((query) => query.tag === 'sampling-handoff-insert')).toBe(true);
    expect(
      client.queries.find((query) => query.tag === 'sampling-handoff-insert')?.values,
    ).toContain('deviated');
    expect(client.auditEvents.map(eventKind)).toEqual([
      'candidate_recorded',
      'sampling_candidate_handoff_recorded',
    ]);
    expect(client.transactionEvents).toEqual(['begin', 'commit']);
  });

  it('makes an identical handoff idempotent and rejects one-to-one conflicts', async () => {
    const { handoff, manifest, payload } = await createContractOnlySamplingHandoffFixture();
    const submitter = handoff.candidate.submitterIdHash;
    const idempotentClient = new ScriptedPgClient();
    idempotentClient.enqueue('authorization-read', [
      authorizationRow(candidateAuthorization(submitter)),
    ]);
    idempotentClient.enqueue('sampling-manifest-read', [{ payload: manifest }]);
    idempotentClient.enqueue('sampling-handoff-read', [{ payload: handoff }]);
    const idempotentStore = createPgEvmChainAnalysisSamplingStore({ client: idempotentClient });

    await expect(
      idempotentStore.recordCandidateHandoff({ actorIdHash: submitter, handoff }),
    ).resolves.toEqual(handoff);
    expect(
      idempotentClient.queries.some((query) => query.tag === 'sampling-candidate-insert'),
    ).toBe(false);
    expect(idempotentClient.auditEvents).toEqual([]);

    const conflicting = createSamplingCandidateHandoff(manifest, {
      additionalSourcePayloadHashes: [testHash('different-normalized-replay')],
      payload,
      scannedAt: handoff.candidate.scanner.scannedAt,
      scannerVersion: handoff.candidate.scanner.scannerVersion,
      submittedAt: handoff.candidate.submittedAt,
      submitterIdHash: submitter,
    });
    const conflictClient = new ScriptedPgClient();
    conflictClient.enqueue('authorization-read', [
      authorizationRow(candidateAuthorization(submitter)),
    ]);
    conflictClient.enqueue('sampling-manifest-read', [{ payload: manifest }]);
    conflictClient.enqueue('sampling-handoff-read', [{ payload: handoff }]);
    const conflictStore = createPgEvmChainAnalysisSamplingStore({ client: conflictClient });

    await expect(
      conflictStore.recordCandidateHandoff({ actorIdHash: submitter, handoff: conflicting }),
    ).rejects.toMatchObject({ code: 'immutable_conflict' });
    expect(conflictClient.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('refuses to attach sampling lineage to a candidate persisted outside the handoff', async () => {
    const { handoff, manifest } = await createContractOnlySamplingHandoffFixture();
    const submitter = handoff.candidate.submitterIdHash;
    const client = new ScriptedPgClient();
    client.enqueue('authorization-read', [authorizationRow(candidateAuthorization(submitter))]);
    client.enqueue('sampling-manifest-read', [{ payload: manifest }]);
    client.enqueue('sampling-candidate-read', [{ payload: handoff.candidate }]);
    const store = createPgEvmChainAnalysisSamplingStore({ client });

    await expect(
      store.recordCandidateHandoff({ actorIdHash: submitter, handoff }),
    ).rejects.toMatchObject({ code: 'immutable_conflict' });
    expect(client.queries.some((query) => query.tag === 'sampling-handoff-insert')).toBe(false);
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('requires an explicit candidate submitter grant for handoff persistence', async () => {
    const { handoff } = await createContractOnlySamplingHandoffFixture();
    const store = createPgEvmChainAnalysisSamplingStore({ client: new ScriptedPgClient() });

    await expect(
      store.recordCandidateHandoff({
        actorIdHash: handoff.candidate.submitterIdHash,
        handoff,
      }),
    ).rejects.toMatchObject({ code: 'authorization_missing' });
  });

  it('does not expose source approval bootstrap and fails closed without a planner grant', async () => {
    const { policy } = createContractOnlySamplingFixture();
    const store = createPgEvmChainAnalysisSamplingStore({ client: new ScriptedPgClient() });

    expect(store).not.toHaveProperty('recordSourceApproval');
    await expect(
      store.recordPolicy({ actorIdHash: testHash('unauthorized'), policy }),
    ).rejects.toMatchObject({
      code: 'authorization_missing',
    });
  });
});

function plannerAuthorization(principalIdHash: string) {
  return createGovernanceAuthorization({
    grantedAt: '2026-06-01T00:00:00.000Z',
    grantedByHash: testHash('governance-publisher'),
    principalIdHash,
    roles: ['sampling_planner'],
    validUntil: '2026-09-01T00:00:00.000Z',
  });
}

function workerAuthorization(principalIdHash: string) {
  return createGovernanceAuthorization({
    grantedAt: '2026-06-01T00:00:00.000Z',
    grantedByHash: testHash('governance-publisher'),
    principalIdHash,
    roles: ['sampling_worker'],
    validUntil: '2026-09-01T00:00:00.000Z',
  });
}

function candidateAuthorization(principalIdHash: string) {
  return createGovernanceAuthorization({
    grantedAt: '2026-06-01T00:00:00.000Z',
    grantedByHash: testHash('governance-publisher'),
    principalIdHash,
    roles: ['candidate_submitter'],
    validUntil: '2026-09-01T00:00:00.000Z',
  });
}

function samplingJobRow(
  plan: ReturnType<typeof createContractOnlySamplingFixture>['plan'],
  status: 'queued' | 'running',
  selectedSlotId = plan.slots[0]!.slotId,
) {
  const slot = plan.slots.find((candidate) => candidate.slotId === selectedSlotId)!;
  return {
    attempt_count: 0,
    completed_at: null,
    expires_at: plan.samplingEndsAt,
    failed_at: null,
    failure_code_hash: null,
    job_id: `sampling_job_${testHash(`job-${slot.slotId}`).slice(7)}`,
    lease_expires_at: status === 'running' ? '2026-07-24T09:00:00.000Z' : null,
    manifest_fingerprint: null,
    manifest_id: null,
    max_attempts: 3,
    not_before: plan.samplingStartsAt,
    plan_fingerprint: plan.planFingerprint,
    plan_id: plan.planId,
    slot_id: slot.slotId,
    status,
    stratum_id: slot.stratumId,
    worker_id_hash: null,
  };
}

function eventKind(event: unknown): unknown {
  return (event as { eventKind?: unknown }).eventKind;
}
