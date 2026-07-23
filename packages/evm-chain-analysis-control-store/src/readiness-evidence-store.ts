import { z } from 'zod';

import {
  chainAnalysisEvaluationReportSchema,
  evaluateEvmChainAnalysisCorpus,
  type ChainAnalysisEvaluationReport,
} from '@xxyy/evm-chain-analysis-harness';
import {
  evaluateProductionReadiness,
  fingerprintProductionOperationsEvidence,
  productionOperationsEvidenceBundleSchema,
  productionReadinessPolicySchema,
  productionReadinessResultSchema,
  reviewedReplayCorpusExportSchema,
  type ProductionOperationsEvidenceBundle,
  type ProductionReadinessPolicy,
  type ProductionReadinessResult,
  type ReviewedReplayCorpusExport,
} from '@xxyy/evm-chain-analysis-readiness';

import { ChainAnalysisControlStoreError } from './contracts.js';
import {
  appendControlAuditEvent,
  assertGovernanceAuthorization,
  assertSameFingerprint,
} from './control-store-internals.js';
import { migrateEvmChainAnalysisControlStore } from './migrations.js';
import {
  acquireControlLock,
  queryControlDatabase,
  withControlTransaction,
  type PgControlClientLike,
} from './postgres.js';

const ISO_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const timestampSchema = z.string().datetime({ offset: true });

interface PayloadRow {
  payload: unknown;
}

interface RecordedPayloadRow extends PayloadRow {
  recorded_at: string;
}

interface CorpusReportRow extends PayloadRow {
  corpus_export_fingerprint: string;
}

interface ReadinessAttestationRow extends PayloadRow {
  corpus_report_fingerprint: string | null;
  operations_evidence_fingerprint: string | null;
  policy_fingerprint: string | null;
}

interface StoredPolicy {
  policy: ProductionReadinessPolicy;
  recordedAt: string;
}

interface StoredCorpusEvaluation {
  corpusExportFingerprint: string;
  report: ChainAnalysisEvaluationReport;
}

export interface StoredProductionOperationsEvidence {
  evidence: ProductionOperationsEvidenceBundle;
  evidenceFingerprint: string;
  recordedAt: string;
}

export interface PgEvmChainAnalysisReadinessEvidenceStore {
  evaluateCorpus(input: {
    actorIdHash: string;
    corpusExportFingerprint: string;
    evaluatedAt: string;
  }): Promise<ChainAnalysisEvaluationReport>;
  evaluateReadiness(input: {
    actorIdHash: string;
    corpusExportFingerprint: string;
    corpusReportFingerprint: string;
    evaluatedAt: string;
    operationsEvidenceFingerprint: string;
    policyFingerprint: string;
  }): Promise<ProductionReadinessResult>;
  getCorpusEvaluation(
    reportFingerprint: string,
  ): Promise<ChainAnalysisEvaluationReport | undefined>;
  getOperationsEvidence(
    evidenceFingerprint: string,
  ): Promise<StoredProductionOperationsEvidence | undefined>;
  getPolicy(policyFingerprint: string): Promise<ProductionReadinessPolicy | undefined>;
  getReadinessAttestation(
    readinessFingerprint: string,
  ): Promise<ProductionReadinessResult | undefined>;
  migrate(): Promise<void>;
  recordOperationsEvidence(input: {
    actorIdHash: string;
    evidence: unknown;
    recordedAt: string;
  }): Promise<StoredProductionOperationsEvidence>;
  recordPolicy(input: {
    actorIdHash: string;
    policy: unknown;
    recordedAt: string;
  }): Promise<ProductionReadinessPolicy>;
}

export function createPgEvmChainAnalysisReadinessEvidenceStore(options: {
  client: PgControlClientLike;
}): PgEvmChainAnalysisReadinessEvidenceStore {
  const { client } = options;
  return {
    async evaluateCorpus(input): Promise<ChainAnalysisEvaluationReport> {
      const evaluatedAt = parseTimestamp(input.evaluatedAt, 'corpus evaluation time');
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: evaluatedAt,
          principalIdHash: input.actorIdHash,
          role: 'readiness_attestor',
        });
        const corpusExport = await requireCorpusExport(transaction, input.corpusExportFingerprint);
        if (Date.parse(evaluatedAt) < Date.parse(corpusExport.exportedAt)) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'A governed corpus cannot be evaluated before it is exported.',
          );
        }
        const report = evaluateEvmChainAnalysisCorpus(corpusExport.corpus, { evaluatedAt });
        await acquireControlLock(
          transaction,
          `corpus-evaluation:${corpusExport.exportFingerprint}:${evaluatedAt}`,
        );
        const existing = await readCorpusEvaluationForTime(
          transaction,
          corpusExport.exportFingerprint,
          evaluatedAt,
        );
        if (existing !== undefined) {
          assertSameFingerprint(
            report.reportFingerprint,
            existing.report.reportFingerprint,
            'Corpus evaluation report',
          );
          return existing.report;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:corpus-evaluation-insert */
            insert into evm_chain_control_corpus_evaluation_reports (
              report_fingerprint,
              corpus_export_fingerprint,
              corpus_fingerprint,
              corpus_id,
              actor_id_hash,
              evaluated_at,
              payload
            ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
          `,
          [
            report.reportFingerprint,
            corpusExport.exportFingerprint,
            report.corpusFingerprint,
            report.corpusId,
            input.actorIdHash,
            report.evaluatedAt,
            JSON.stringify(report),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: report.reportFingerprint,
          entityId: report.reportFingerprint,
          entityType: 'corpus_evaluation_report',
          eventAt: report.evaluatedAt,
          eventKind: 'corpus_evaluation_recorded',
          payload: {
            corpusExportFingerprint: corpusExport.exportFingerprint,
            corpusFingerprint: report.corpusFingerprint,
            corpusId: report.corpusId,
            totalCases: report.totals.cases,
          },
          stream: 'governance',
        });
        return report;
      });
    },

    async evaluateReadiness(input): Promise<ProductionReadinessResult> {
      const evaluatedAt = parseTimestamp(input.evaluatedAt, 'readiness evaluation time');
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: evaluatedAt,
          principalIdHash: input.actorIdHash,
          role: 'readiness_attestor',
        });
        const corpusExport = await requireCorpusExport(transaction, input.corpusExportFingerprint);
        const corpusEvaluation = await requireCorpusEvaluation(
          transaction,
          input.corpusReportFingerprint,
        );
        if (corpusEvaluation.corpusExportFingerprint !== corpusExport.exportFingerprint) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Corpus evaluation report belongs to another governed corpus export.',
          );
        }
        assertCorpusEvaluationWasDerivedFromExport(corpusExport, corpusEvaluation.report);
        const operationsEvidence = await requireOperationsEvidence(
          transaction,
          input.operationsEvidenceFingerprint,
        );
        const policy = await requirePolicy(transaction, input.policyFingerprint);
        assertRecordedNoLaterThan(
          operationsEvidence.recordedAt,
          evaluatedAt,
          'Operations evidence',
        );
        assertRecordedNoLaterThan(policy.recordedAt, evaluatedAt, 'Readiness policy');
        const result = evaluateProductionReadiness({
          corpusExport,
          corpusReport: corpusEvaluation.report,
          evaluatedAt,
          operationsEvidence: operationsEvidence.evidence,
          policy: policy.policy,
        });
        await acquireControlLock(transaction, `readiness:${result.readinessFingerprint}`);
        const existing = await readReadinessAttestation(transaction, result.readinessFingerprint);
        if (existing !== undefined) {
          assertSameFingerprint(
            result.readinessFingerprint,
            existing.result.readinessFingerprint,
            'Readiness attestation',
          );
          assertReadinessLineage(existing, {
            corpusReportFingerprint: corpusEvaluation.report.reportFingerprint,
            operationsEvidenceFingerprint: operationsEvidence.evidenceFingerprint,
            policyFingerprint: policy.policy.policyFingerprint,
          });
          return existing.result;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:readiness-insert */
            insert into evm_chain_control_readiness_attestations (
              readiness_fingerprint,
              corpus_report_fingerprint,
              operations_evidence_fingerprint,
              policy_fingerprint,
              actor_id_hash,
              evaluated_at,
              status,
              payload
            ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::jsonb)
          `,
          [
            result.readinessFingerprint,
            corpusEvaluation.report.reportFingerprint,
            operationsEvidence.evidenceFingerprint,
            policy.policy.policyFingerprint,
            input.actorIdHash,
            result.evaluatedAt,
            result.status,
            JSON.stringify(result),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: result.readinessFingerprint,
          entityId: result.readinessFingerprint,
          entityType: 'readiness_attestation',
          eventAt: result.evaluatedAt,
          eventKind: 'readiness_attested',
          payload: {
            corpusExportFingerprint: result.corpusExportFingerprint,
            corpusReportFingerprint: corpusEvaluation.report.reportFingerprint,
            nextEvaluationAt: result.nextEvaluationAt,
            operationsEvidenceFingerprint: operationsEvidence.evidenceFingerprint,
            policyFingerprint: policy.policy.policyFingerprint,
            status: result.status,
          },
          stream: 'governance',
        });
        return result;
      });
    },

    async getCorpusEvaluation(
      reportFingerprint,
    ): Promise<ChainAnalysisEvaluationReport | undefined> {
      return (await readCorpusEvaluation(client, reportFingerprint))?.report;
    },

    async getOperationsEvidence(
      evidenceFingerprint,
    ): Promise<StoredProductionOperationsEvidence | undefined> {
      return readOperationsEvidence(client, evidenceFingerprint);
    },

    async getPolicy(policyFingerprint): Promise<ProductionReadinessPolicy | undefined> {
      return (await readPolicy(client, policyFingerprint))?.policy;
    },

    async getReadinessAttestation(
      readinessFingerprint,
    ): Promise<ProductionReadinessResult | undefined> {
      return (await readReadinessAttestation(client, readinessFingerprint))?.result;
    },

    async migrate(): Promise<void> {
      await migrateEvmChainAnalysisControlStore(client);
    },

    async recordOperationsEvidence(input): Promise<StoredProductionOperationsEvidence> {
      const evidence = productionOperationsEvidenceBundleSchema.parse(input.evidence);
      const recordedAt = parseTimestamp(input.recordedAt, 'operations evidence record time');
      const evidenceFingerprint = fingerprintProductionOperationsEvidence(evidence);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: recordedAt,
          principalIdHash: input.actorIdHash,
          role: 'provider_operator',
        });
        await acquireControlLock(transaction, `operations-evidence:${evidenceFingerprint}`);
        const existing = await readOperationsEvidence(transaction, evidenceFingerprint);
        if (existing !== undefined) {
          assertSameFingerprint(
            evidenceFingerprint,
            existing.evidenceFingerprint,
            'Operations evidence',
          );
          return existing;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:operations-evidence-insert */
            insert into evm_chain_control_operations_evidence (
              evidence_fingerprint, actor_id_hash, recorded_at, payload
            ) values ($1, $2, $3::timestamptz, $4::jsonb)
          `,
          [evidenceFingerprint, input.actorIdHash, recordedAt, JSON.stringify(evidence)],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: evidenceFingerprint,
          entityId: evidenceFingerprint,
          entityType: 'production_operations_evidence',
          eventAt: recordedAt,
          eventKind: 'operations_evidence_recorded',
          payload: {
            budgetPolicies: evidence.budgetPolicies.length,
            circuitStates: evidence.circuitStates.length,
            drills: evidence.drills.length,
            providers: evidence.providers.length,
            sloReports: evidence.sloReports.length,
          },
          stream: 'governance',
        });
        return { evidence, evidenceFingerprint, recordedAt };
      });
    },

    async recordPolicy(input): Promise<ProductionReadinessPolicy> {
      const policy = productionReadinessPolicySchema.parse(input.policy);
      const recordedAt = parseTimestamp(input.recordedAt, 'readiness policy record time');
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: recordedAt,
          principalIdHash: input.actorIdHash,
          role: 'governance_publisher',
        });
        await acquireControlLock(transaction, `readiness-policy:${policy.policyFingerprint}`);
        const existing = await readPolicy(transaction, policy.policyFingerprint);
        if (existing !== undefined) {
          assertSameFingerprint(
            policy.policyFingerprint,
            existing.policy.policyFingerprint,
            'Readiness policy',
          );
          return existing.policy;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:readiness-policy-insert */
            insert into evm_chain_control_readiness_policies (
              policy_fingerprint, actor_id_hash, recorded_at, payload
            ) values ($1, $2, $3::timestamptz, $4::jsonb)
          `,
          [policy.policyFingerprint, input.actorIdHash, recordedAt, JSON.stringify(policy)],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: policy.policyFingerprint,
          entityId: policy.policyFingerprint,
          entityType: 'production_readiness_policy',
          eventAt: recordedAt,
          eventKind: 'readiness_policy_recorded',
          payload: {
            policyId: policy.policyId,
            requiredAdapters: policy.requiredAdapters,
            requiredChains: policy.requiredChains,
            requiredDrills: policy.requiredDrills,
          },
          stream: 'governance',
        });
        return policy;
      });
    },
  };
}

async function requireCorpusExport(
  client: PgControlClientLike,
  exportFingerprint: string,
): Promise<ReviewedReplayCorpusExport> {
  const corpusExport = await readCorpusExport(client, exportFingerprint);
  if (corpusExport === undefined) {
    throw new ChainAnalysisControlStoreError(
      'corpus_export_not_found',
      `Governed corpus export ${exportFingerprint} was not found.`,
    );
  }
  return corpusExport;
}

async function readCorpusExport(
  client: PgControlClientLike,
  exportFingerprint: string,
): Promise<ReviewedReplayCorpusExport | undefined> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:readiness-corpus-export-read */
      select payload
      from evm_chain_control_corpus_exports
      where export_fingerprint = $1
    `,
    [exportFingerprint],
  );
  const payload = response.rows[0]?.payload;
  if (payload === undefined) {
    return undefined;
  }
  const corpusExport = reviewedReplayCorpusExportSchema.parse(payload);
  assertSameFingerprint(
    exportFingerprint,
    corpusExport.exportFingerprint,
    'Governed corpus export',
  );
  return corpusExport;
}

async function requireCorpusEvaluation(
  client: PgControlClientLike,
  reportFingerprint: string,
): Promise<StoredCorpusEvaluation> {
  const evaluation = await readCorpusEvaluation(client, reportFingerprint);
  if (evaluation === undefined) {
    throw new ChainAnalysisControlStoreError(
      'corpus_report_not_found',
      `Corpus evaluation report ${reportFingerprint} was not found.`,
    );
  }
  return evaluation;
}

async function readCorpusEvaluation(
  client: PgControlClientLike,
  reportFingerprint: string,
): Promise<StoredCorpusEvaluation | undefined> {
  const response = await queryControlDatabase<CorpusReportRow>(
    client,
    `
      /* control:corpus-evaluation-read */
      select corpus_export_fingerprint, payload
      from evm_chain_control_corpus_evaluation_reports
      where report_fingerprint = $1
    `,
    [reportFingerprint],
  );
  const row = response.rows[0];
  if (row === undefined) {
    return undefined;
  }
  const report = chainAnalysisEvaluationReportSchema.parse(row.payload);
  assertSameFingerprint(reportFingerprint, report.reportFingerprint, 'Corpus evaluation report');
  return { corpusExportFingerprint: row.corpus_export_fingerprint, report };
}

async function readCorpusEvaluationForTime(
  client: PgControlClientLike,
  corpusExportFingerprint: string,
  evaluatedAt: string,
): Promise<StoredCorpusEvaluation | undefined> {
  const response = await queryControlDatabase<CorpusReportRow>(
    client,
    `
      /* control:corpus-evaluation-by-time */
      select corpus_export_fingerprint, payload
      from evm_chain_control_corpus_evaluation_reports
      where corpus_export_fingerprint = $1 and evaluated_at = $2::timestamptz
    `,
    [corpusExportFingerprint, evaluatedAt],
  );
  const row = response.rows[0];
  if (row === undefined) {
    return undefined;
  }
  if (row.corpus_export_fingerprint !== corpusExportFingerprint) {
    throw new ChainAnalysisControlStoreError(
      'immutable_conflict',
      'Corpus evaluation report row does not match its requested export lineage.',
    );
  }
  return {
    corpusExportFingerprint: row.corpus_export_fingerprint,
    report: chainAnalysisEvaluationReportSchema.parse(row.payload),
  };
}

async function requireOperationsEvidence(
  client: PgControlClientLike,
  evidenceFingerprint: string,
): Promise<StoredProductionOperationsEvidence> {
  const evidence = await readOperationsEvidence(client, evidenceFingerprint);
  if (evidence === undefined) {
    throw new ChainAnalysisControlStoreError(
      'operations_evidence_not_found',
      `Operations evidence ${evidenceFingerprint} was not found.`,
    );
  }
  return evidence;
}

async function readOperationsEvidence(
  client: PgControlClientLike,
  evidenceFingerprint: string,
): Promise<StoredProductionOperationsEvidence | undefined> {
  const response = await queryControlDatabase<RecordedPayloadRow>(
    client,
    `
      /* control:operations-evidence-read */
      select
        to_char(recorded_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as recorded_at,
        payload
      from evm_chain_control_operations_evidence
      where evidence_fingerprint = $1
    `,
    [evidenceFingerprint],
  );
  const row = response.rows[0];
  if (row === undefined) {
    return undefined;
  }
  const evidence = productionOperationsEvidenceBundleSchema.parse(row.payload);
  const storedFingerprint = fingerprintProductionOperationsEvidence(evidence);
  assertSameFingerprint(evidenceFingerprint, storedFingerprint, 'Operations evidence');
  return { evidence, evidenceFingerprint: storedFingerprint, recordedAt: row.recorded_at };
}

async function requirePolicy(
  client: PgControlClientLike,
  policyFingerprint: string,
): Promise<StoredPolicy> {
  const policy = await readPolicy(client, policyFingerprint);
  if (policy === undefined) {
    throw new ChainAnalysisControlStoreError(
      'readiness_policy_not_found',
      `Readiness policy ${policyFingerprint} was not found.`,
    );
  }
  return policy;
}

async function readPolicy(
  client: PgControlClientLike,
  policyFingerprint: string,
): Promise<StoredPolicy | undefined> {
  const response = await queryControlDatabase<RecordedPayloadRow>(
    client,
    `
      /* control:readiness-policy-read */
      select
        to_char(recorded_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as recorded_at,
        payload
      from evm_chain_control_readiness_policies
      where policy_fingerprint = $1
    `,
    [policyFingerprint],
  );
  const row = response.rows[0];
  if (row === undefined) {
    return undefined;
  }
  const policy = productionReadinessPolicySchema.parse(row.payload);
  assertSameFingerprint(policyFingerprint, policy.policyFingerprint, 'Readiness policy');
  return { policy, recordedAt: row.recorded_at };
}

async function readReadinessAttestation(
  client: PgControlClientLike,
  readinessFingerprint: string,
): Promise<
  | {
      corpusReportFingerprint: string | null;
      operationsEvidenceFingerprint: string | null;
      policyFingerprint: string | null;
      result: ProductionReadinessResult;
    }
  | undefined
> {
  const response = await queryControlDatabase<ReadinessAttestationRow>(
    client,
    `
      /* control:readiness-read */
      select
        corpus_report_fingerprint,
        operations_evidence_fingerprint,
        policy_fingerprint,
        payload
      from evm_chain_control_readiness_attestations
      where readiness_fingerprint = $1
    `,
    [readinessFingerprint],
  );
  const row = response.rows[0];
  if (row === undefined) {
    return undefined;
  }
  const result = productionReadinessResultSchema.parse(row.payload);
  assertSameFingerprint(readinessFingerprint, result.readinessFingerprint, 'Readiness attestation');
  assertReadinessLineage(
    {
      corpusReportFingerprint: row.corpus_report_fingerprint,
      operationsEvidenceFingerprint: row.operations_evidence_fingerprint,
      policyFingerprint: row.policy_fingerprint,
    },
    {
      corpusReportFingerprint: result.corpusReportFingerprint,
      operationsEvidenceFingerprint: result.operations.evidenceFingerprint,
      policyFingerprint: result.policyFingerprint,
    },
  );
  return {
    corpusReportFingerprint: row.corpus_report_fingerprint,
    operationsEvidenceFingerprint: row.operations_evidence_fingerprint,
    policyFingerprint: row.policy_fingerprint,
    result,
  };
}

function assertCorpusEvaluationWasDerivedFromExport(
  corpusExport: ReviewedReplayCorpusExport,
  report: ChainAnalysisEvaluationReport,
): void {
  const recomputed = evaluateEvmChainAnalysisCorpus(corpusExport.corpus, {
    evaluatedAt: report.evaluatedAt,
  });
  assertSameFingerprint(
    report.reportFingerprint,
    recomputed.reportFingerprint,
    'Corpus evaluation report lineage',
  );
}

function assertReadinessLineage(
  existing: {
    corpusReportFingerprint: string | null;
    operationsEvidenceFingerprint: string | null;
    policyFingerprint: string | null;
  },
  expected: {
    corpusReportFingerprint: string;
    operationsEvidenceFingerprint: string;
    policyFingerprint: string;
  },
): void {
  if (
    existing.corpusReportFingerprint !== expected.corpusReportFingerprint ||
    existing.operationsEvidenceFingerprint !== expected.operationsEvidenceFingerprint ||
    existing.policyFingerprint !== expected.policyFingerprint
  ) {
    throw new ChainAnalysisControlStoreError(
      'immutable_conflict',
      'Readiness attestation lineage does not match the persisted evaluation inputs.',
    );
  }
}

function assertRecordedNoLaterThan(recordedAt: string, evaluatedAt: string, label: string): void {
  if (Date.parse(recordedAt) > Date.parse(evaluatedAt)) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      `${label} cannot be used before it is recorded.`,
    );
  }
}

function parseTimestamp(value: string, label: string): string {
  const parsed = timestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new ChainAnalysisControlStoreError('invalid_state', `Invalid ${label}.`);
  }
  return new Date(parsed.data).toISOString();
}
