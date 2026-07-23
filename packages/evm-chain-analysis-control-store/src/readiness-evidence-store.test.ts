import { describe, expect, it } from 'vitest';

import {
  evaluateEvmChainAnalysisCorpus,
  type ChainAnalysisEvaluationReport,
} from '@xxyy/evm-chain-analysis-harness';
import { createSyntheticChainAnalysisCorpus } from '@xxyy/evm-chain-analysis-harness/test-fixtures';
import {
  evaluateProductionReadiness,
  fingerprintProductionOperationsEvidence,
  type ProductionOperationsEvidenceBundle,
  type ProductionReadinessPolicy,
  type ProductionReadinessResult,
  type ReviewedReplayCorpusExport,
} from '@xxyy/evm-chain-analysis-readiness';
import {
  CONTRACT_FIXTURE_TIMES,
  createGovernedContractCorpus,
  createPassingOperationsEvidence,
  createPassingReadinessPolicy,
} from '@xxyy/evm-chain-analysis-readiness/test-fixtures';

import {
  createGovernanceAuthorization,
  createPgEvmChainAnalysisGovernanceStore,
  createPgEvmChainAnalysisReadinessEvidenceStore,
  verifyChainAnalysisControlAuditEvents,
  type ChainAnalysisGovernanceRole,
  type GovernanceAuthorization,
  type PgControlQueryResult,
} from './index.js';
import { testHash } from './fixtures.test-helper.js';
import { authorizationRow, ScriptedPgClient } from './scripted-pg.test-helper.js';

const PUBLISHER = testHash('readiness-publisher');
const PROVIDER_OPERATOR = testHash('readiness-provider-operator');
const ATTESTOR = testHash('readiness-attestor');
const POLICY_RECORDED_AT = '2026-07-22T11:35:00.000Z';
const EVIDENCE_RECORDED_AT = '2026-07-22T11:36:00.000Z';

interface ReadinessFixture {
  corpusExport: ReviewedReplayCorpusExport;
  evidence: ProductionOperationsEvidenceBundle;
  evidenceFingerprint: string;
  policy: ProductionReadinessPolicy;
  report: ChainAnalysisEvaluationReport;
  result: ProductionReadinessResult;
}

describe('PostgreSQL reproducible readiness evidence store', () => {
  it('persists exact evidence lineage, recomputes a blocked attestation, and retries idempotently', async () => {
    const fixture = await createReadinessFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisReadinessEvidenceStore({ client });
    client.enqueue(
      'authorization-read',
      [authorizationRow(grant(PUBLISHER, ['governance_publisher']))],
      [authorizationRow(grant(PUBLISHER, ['governance_publisher']))],
      [authorizationRow(grant(PROVIDER_OPERATOR, ['provider_operator']))],
      [authorizationRow(grant(PROVIDER_OPERATOR, ['provider_operator']))],
      [authorizationRow(grant(ATTESTOR, ['readiness_attestor']))],
      [authorizationRow(grant(ATTESTOR, ['readiness_attestor']))],
      [authorizationRow(grant(ATTESTOR, ['readiness_attestor']))],
      [authorizationRow(grant(ATTESTOR, ['readiness_attestor']))],
    );
    client.enqueue(
      'readiness-policy-read',
      [],
      [policyRow(fixture)],
      [policyRow(fixture)],
      [policyRow(fixture)],
    );
    client.enqueue(
      'operations-evidence-read',
      [],
      [evidenceRow(fixture)],
      [evidenceRow(fixture)],
      [evidenceRow(fixture)],
    );
    client.enqueue(
      'readiness-corpus-export-read',
      [corpusExportRow(fixture)],
      [corpusExportRow(fixture)],
      [corpusExportRow(fixture)],
      [corpusExportRow(fixture)],
    );
    client.enqueue('corpus-evaluation-by-time', [], [corpusEvaluationRow(fixture)]);
    client.enqueue(
      'corpus-evaluation-read',
      [corpusEvaluationRow(fixture)],
      [corpusEvaluationRow(fixture)],
    );
    client.enqueue('readiness-read', [], [readinessRow(fixture)]);

    await expect(
      store.recordPolicy({
        actorIdHash: PUBLISHER,
        policy: fixture.policy,
        recordedAt: POLICY_RECORDED_AT,
      }),
    ).resolves.toEqual(fixture.policy);
    await expect(
      store.recordPolicy({
        actorIdHash: PUBLISHER,
        policy: structuredClone(fixture.policy),
        recordedAt: '2026-07-22T19:35:00.000+08:00',
      }),
    ).resolves.toEqual(fixture.policy);
    await expect(
      store.recordOperationsEvidence({
        actorIdHash: PROVIDER_OPERATOR,
        evidence: fixture.evidence,
        recordedAt: EVIDENCE_RECORDED_AT,
      }),
    ).resolves.toEqual({
      evidence: fixture.evidence,
      evidenceFingerprint: fixture.evidenceFingerprint,
      recordedAt: EVIDENCE_RECORDED_AT,
    });
    await expect(
      store.recordOperationsEvidence({
        actorIdHash: PROVIDER_OPERATOR,
        evidence: structuredClone(fixture.evidence),
        recordedAt: '2026-07-22T19:36:00.000+08:00',
      }),
    ).resolves.toEqual({
      evidence: fixture.evidence,
      evidenceFingerprint: fixture.evidenceFingerprint,
      recordedAt: EVIDENCE_RECORDED_AT,
    });
    await expect(evaluateCorpus(store, fixture)).resolves.toEqual(fixture.report);
    await expect(evaluateCorpus(store, fixture, '2026-07-22T19:45:00.000+08:00')).resolves.toEqual(
      fixture.report,
    );
    await expect(evaluateReadiness(store, fixture)).resolves.toEqual(fixture.result);
    await expect(
      evaluateReadiness(store, fixture, '2026-07-22T20:00:00.000+08:00'),
    ).resolves.toEqual(fixture.result);

    expect(fixture.result.status).toBe('blocked');
    expect(fixture.result.reasons.map((reason) => reason.code)).toEqual([
      'corpus_quality_gate_failed',
    ]);
    const audit = verifyChainAnalysisControlAuditEvents(client.auditEvents);
    expect(audit.map((event) => event.eventKind)).toEqual([
      'readiness_policy_recorded',
      'operations_evidence_recorded',
      'corpus_evaluation_recorded',
      'readiness_attested',
    ]);
    expect(client.queries.filter((query) => query.tag === 'readiness-policy-insert')).toHaveLength(
      1,
    );
    expect(
      client.queries.filter((query) => query.tag === 'operations-evidence-insert'),
    ).toHaveLength(1);
    expect(client.queries.filter((query) => query.tag === 'corpus-evaluation-insert')).toHaveLength(
      1,
    );
    expect(client.queries.filter((query) => query.tag === 'readiness-insert')).toHaveLength(1);
    expect(client.transactionEvents.filter((event) => event === 'commit')).toHaveLength(8);
  });

  it('separates publisher, provider operator, and attestor grants and exposes no raw result writer', async () => {
    const fixture = await createReadinessFixture();
    const client = new ScriptedPgClient();
    const evidenceStore = createPgEvmChainAnalysisReadinessEvidenceStore({ client });
    const governanceStore = createPgEvmChainAnalysisGovernanceStore({ client });

    await expect(
      evidenceStore.recordPolicy({
        actorIdHash: PROVIDER_OPERATOR,
        policy: fixture.policy,
        recordedAt: POLICY_RECORDED_AT,
      }),
    ).rejects.toMatchObject({ code: 'authorization_missing' });
    expect(client.queries.find((query) => query.tag === 'authorization-read')?.values[1]).toBe(
      'governance_publisher',
    );
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
    expect(client.queries.some((query) => query.tag === 'readiness-policy-insert')).toBe(false);
    expect(governanceStore).not.toHaveProperty('recordReadinessAttestation');
  });

  it('fails closed when an exact persisted evidence artifact is missing', async () => {
    const fixture = await createReadinessFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisReadinessEvidenceStore({ client });
    client.enqueue('authorization-read', [
      authorizationRow(grant(ATTESTOR, ['readiness_attestor'])),
    ]);
    client.enqueue('readiness-corpus-export-read', [corpusExportRow(fixture)]);
    client.enqueue('corpus-evaluation-read', [corpusEvaluationRow(fixture)]);
    client.enqueue('operations-evidence-read', []);

    await expect(evaluateReadiness(store, fixture)).rejects.toMatchObject({
      code: 'operations_evidence_not_found',
    });
    expect(client.queries.some((query) => query.tag === 'readiness-insert')).toBe(false);
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('rejects a self-hashed report that was not derived from the referenced persisted export', async () => {
    const fixture = await createReadinessFixture();
    const unrelatedCorpus = await createSyntheticChainAnalysisCorpus();
    const unrelatedReport = evaluateEvmChainAnalysisCorpus(unrelatedCorpus, {
      evaluatedAt: CONTRACT_FIXTURE_TIMES.reportEvaluatedAt,
    });
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisReadinessEvidenceStore({ client });
    client.enqueue('authorization-read', [
      authorizationRow(grant(ATTESTOR, ['readiness_attestor'])),
    ]);
    client.enqueue('readiness-corpus-export-read', [corpusExportRow(fixture)]);
    client.enqueue('corpus-evaluation-read', [
      {
        corpus_export_fingerprint: fixture.corpusExport.exportFingerprint,
        payload: unrelatedReport,
      },
    ]);

    await expect(
      store.evaluateReadiness({
        actorIdHash: ATTESTOR,
        corpusExportFingerprint: fixture.corpusExport.exportFingerprint,
        corpusReportFingerprint: unrelatedReport.reportFingerprint,
        evaluatedAt: CONTRACT_FIXTURE_TIMES.evaluatedAt,
        operationsEvidenceFingerprint: fixture.evidenceFingerprint,
        policyFingerprint: fixture.policy.policyFingerprint,
      }),
    ).rejects.toMatchObject({ code: 'immutable_conflict' });
    expect(client.queries.some((query) => query.tag === 'operations-evidence-read')).toBe(false);
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('rejects legacy or tampered attestations without exact persisted lineage', async () => {
    const fixture = await createReadinessFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisReadinessEvidenceStore({ client });
    client.enqueue('readiness-read', [
      {
        corpus_report_fingerprint: null,
        operations_evidence_fingerprint: null,
        payload: fixture.result,
        policy_fingerprint: null,
      },
    ]);

    await expect(
      store.getReadinessAttestation(fixture.result.readinessFingerprint),
    ).rejects.toMatchObject({ code: 'immutable_conflict' });
  });

  it('rolls back and emits no audit event when PostgreSQL rejects an artifact write', async () => {
    const fixture = await createReadinessFixture();
    const client = new FailingPgClient('operations-evidence-insert');
    const store = createPgEvmChainAnalysisReadinessEvidenceStore({ client });
    client.enqueue('authorization-read', [
      authorizationRow(grant(PROVIDER_OPERATOR, ['provider_operator'])),
    ]);
    client.enqueue('operations-evidence-read', []);

    await expect(
      store.recordOperationsEvidence({
        actorIdHash: PROVIDER_OPERATOR,
        evidence: fixture.evidence,
        recordedAt: EVIDENCE_RECORDED_AT,
      }),
    ).rejects.toMatchObject({ code: 'database_unavailable' });
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
    expect(client.auditEvents).toEqual([]);
  });
});

async function createReadinessFixture(): Promise<ReadinessFixture> {
  const { corpusExport } = await createGovernedContractCorpus();
  const evidence = createPassingOperationsEvidence();
  const evidenceFingerprint = fingerprintProductionOperationsEvidence(evidence);
  const policy = createPassingReadinessPolicy();
  const report = evaluateEvmChainAnalysisCorpus(corpusExport.corpus, {
    evaluatedAt: CONTRACT_FIXTURE_TIMES.reportEvaluatedAt,
  });
  const result = evaluateProductionReadiness({
    corpusExport,
    corpusReport: report,
    evaluatedAt: CONTRACT_FIXTURE_TIMES.evaluatedAt,
    operationsEvidence: evidence,
    policy,
  });
  return { corpusExport, evidence, evidenceFingerprint, policy, report, result };
}

function corpusExportRow(fixture: ReadinessFixture) {
  return { payload: fixture.corpusExport };
}

function corpusEvaluationRow(fixture: ReadinessFixture) {
  return {
    corpus_export_fingerprint: fixture.corpusExport.exportFingerprint,
    payload: fixture.report,
  };
}

function evidenceRow(fixture: ReadinessFixture) {
  return { payload: fixture.evidence, recorded_at: EVIDENCE_RECORDED_AT };
}

function policyRow(fixture: ReadinessFixture) {
  return { payload: fixture.policy, recorded_at: POLICY_RECORDED_AT };
}

function readinessRow(fixture: ReadinessFixture) {
  return {
    corpus_report_fingerprint: fixture.report.reportFingerprint,
    operations_evidence_fingerprint: fixture.evidenceFingerprint,
    payload: fixture.result,
    policy_fingerprint: fixture.policy.policyFingerprint,
  };
}

function grant(
  principalIdHash: string,
  roles: ChainAnalysisGovernanceRole[],
): GovernanceAuthorization {
  return createGovernanceAuthorization({
    grantedAt: '2026-07-22T00:00:00.000Z',
    grantedByHash: PUBLISHER,
    principalIdHash,
    roles,
    validUntil: '2027-07-22T00:00:00.000Z',
  });
}

function evaluateCorpus(
  store: ReturnType<typeof createPgEvmChainAnalysisReadinessEvidenceStore>,
  fixture: ReadinessFixture,
  evaluatedAt: string = CONTRACT_FIXTURE_TIMES.reportEvaluatedAt,
) {
  return store.evaluateCorpus({
    actorIdHash: ATTESTOR,
    corpusExportFingerprint: fixture.corpusExport.exportFingerprint,
    evaluatedAt,
  });
}

function evaluateReadiness(
  store: ReturnType<typeof createPgEvmChainAnalysisReadinessEvidenceStore>,
  fixture: ReadinessFixture,
  evaluatedAt: string = CONTRACT_FIXTURE_TIMES.evaluatedAt,
) {
  return store.evaluateReadiness({
    actorIdHash: ATTESTOR,
    corpusExportFingerprint: fixture.corpusExport.exportFingerprint,
    corpusReportFingerprint: fixture.report.reportFingerprint,
    evaluatedAt,
    operationsEvidenceFingerprint: fixture.evidenceFingerprint,
    policyFingerprint: fixture.policy.policyFingerprint,
  });
}

class FailingPgClient extends ScriptedPgClient {
  constructor(private readonly failingTag: string) {
    super();
  }

  override async query<T>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgControlQueryResult<T>> {
    if (sql.includes(`/* control:${this.failingTag} */`)) {
      throw new Error('contract-only database failure');
    }
    return super.query<T>(sql, values);
  }
}
