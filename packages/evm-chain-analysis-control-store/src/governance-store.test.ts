import { describe, expect, it } from 'vitest';

import { evaluateEvmChainAnalysisCorpus } from '@xxyy/evm-chain-analysis-harness';
import { evaluateProductionReadiness } from '@xxyy/evm-chain-analysis-readiness';
import {
  createPassingOperationsEvidence,
  createPassingReadinessPolicy,
} from '@xxyy/evm-chain-analysis-readiness/test-fixtures';

import {
  createGovernanceAuthorization,
  createPgEvmChainAnalysisGovernanceStore,
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
      [authorizationRow(grants.attestor)],
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
    const readiness = evaluateProductionReadiness({
      corpusExport,
      corpusReport: evaluateEvmChainAnalysisCorpus(corpusExport.corpus, {
        evaluatedAt: '2026-07-22T11:45:00.000Z',
      }),
      evaluatedAt: '2026-07-22T12:00:00.000Z',
      operationsEvidence: createPassingOperationsEvidence(),
      policy: createPassingReadinessPolicy(),
    });
    client.enqueue('corpus-export-read', [{ payload: corpusExport }]);
    expect(
      await store.recordReadinessAttestation({
        actorIdHash: grants.attestor.principalIdHash,
        result: readiness,
      }),
    ).toEqual(readiness);
    expect((await store.readAudit('governance')).map((event) => event.eventKind)).toEqual([
      'candidate_recorded',
      'review_recorded',
      'review_recorded',
      'governance_decision_recorded',
      'promotion_recorded',
      'corpus_export_recorded',
      'readiness_attested',
    ]);
    expect(client.transactionEvents.filter((event) => event === 'commit')).toHaveLength(7);
    expect(client.queries.some((query) => query.tag === 'retention-enqueue')).toBe(true);
  });

  it('records canonical reviewer authorization as an immutable audited artifact', async () => {
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisGovernanceStore({ client });
    const input = {
      grantedAt: '2026-07-22T00:00:00.000Z',
      grantedByHash: PUBLISHER,
      principalIdHash: testHash('reviewer'),
      roles: ['retention_worker', 'independent_reviewer'] as Array<
        'retention_worker' | 'independent_reviewer'
      >,
    };

    const authorization = await store.recordAuthorization(input);

    expect(authorization.roles).toEqual(['independent_reviewer', 'retention_worker']);
    expect(client.auditEvents).toHaveLength(1);
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
    attestor: grant(testHash('readiness-attestor'), ['readiness_attestor']),
    publisher: grant(PUBLISHER, ['governance_publisher']),
    reviewerA: grant(fixture.reviews[0]!.reviewerIdHash, ['independent_reviewer']),
    reviewerB: grant(fixture.reviews[1]!.reviewerIdHash, ['independent_reviewer']),
    submitter: grant(fixture.candidate.submitterIdHash, ['candidate_submitter']),
  };
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
