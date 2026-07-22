import {
  compareCanonicalStrings,
  evaluateChainAnalysisQualityGate,
  internalReadinessQualityGate,
  sha256Fingerprint,
} from '@xxyy/evm-chain-analysis-harness';

import { EVM_CHAIN_ANALYSIS_READINESS_VERSION, datetimeMs } from './common.js';
import { fingerprintProductionOperationsEvidence } from './operations-evidence.js';
import {
  productionOperationsEvidenceBundleSchema,
  productionReadinessPolicySchema,
  type ProductionOperationsEvidenceBundle,
  type ProductionReadinessPolicy,
  type ProductionDrillEvidence,
  type ProviderDeploymentDescriptor,
} from './operations-contracts.js';
import {
  productionOperationsAssessmentSchema,
  productionReadinessEvaluationInputSchema,
  productionReadinessResultSchema,
  type ProductionOperationsAssessment,
  type ProductionOperationsCoverage,
  type ProductionReadinessReason,
  type ProductionReadinessResult,
} from './readiness-contracts.js';

const MILLISECONDS_PER_SECOND = 1_000;

export function evaluateProductionOperationsEvidence(
  evidenceInput: unknown,
  policyInput: unknown,
  evaluatedAt: string,
): ProductionOperationsAssessment {
  const evidence = productionOperationsEvidenceBundleSchema.parse(evidenceInput);
  const policy = productionReadinessPolicySchema.parse(policyInput);
  const evaluatedAtMs = datetimeMs(evaluatedAt);
  const reasons = new Map<string, ProductionReadinessReason>();
  const validityCandidates: number[] = [];

  assessTimeBoundControl('alerting control evidence', evidence.alertingControl, evaluatedAtMs);
  assessTimeBoundControl('audit control evidence', evidence.auditControl, evaluatedAtMs);
  assessTimeBoundControl('budget control evidence', evidence.budgetControl, evaluatedAtMs);
  assessTimeBoundControl('circuit control evidence', evidence.circuitControl, evaluatedAtMs);

  addIncompleteReason('alerting_control_incomplete', 'alerting control', [
    evidence.alertingControl.auditSinkAlertsConfigured,
    evidence.alertingControl.budgetAlertsConfigured,
    evidence.alertingControl.circuitAlertsConfigured,
    evidence.alertingControl.notificationTestPassed,
    evidence.alertingControl.providerSloAlertsConfigured,
  ]);
  addIncompleteReason(
    'audit_control_incomplete',
    'persistent audit control',
    [
      evidence.auditControl.accessReviewPassed,
      evidence.auditControl.appendOnly,
      evidence.auditControl.deletionTestPassed,
      evidence.auditControl.encryptedAtRest,
      evidence.auditControl.unavailableFailsClosed,
      evidence.auditControl.retentionDays >= policy.minAuditRetentionDays,
    ],
    `all checks true; retention>=${policy.minAuditRetentionDays}d`,
  );
  addIncompleteReason('budget_control_incomplete', 'distributed budget control', [
    evidence.budgetControl.atomicReservation,
    evidence.budgetControl.globalConcurrency,
    evidence.budgetControl.idempotentSettlement,
    evidence.budgetControl.leaseExpiry,
    evidence.budgetControl.unavailableFailsClosed,
    evidence.budgetControl.usageReconciliation,
  ]);
  addIncompleteReason('circuit_control_incomplete', 'shared circuit control', [
    evidence.circuitControl.atomicTransitions,
    evidence.circuitControl.halfOpenProbeControlled,
    evidence.circuitControl.providerIsolation,
    evidence.circuitControl.staleStateRecovery,
    evidence.circuitControl.unavailableFailsClosed,
  ]);

  validityCandidates.push(
    datetimeMs(evidence.alertingControl.validUntil),
    datetimeMs(evidence.auditControl.validUntil),
    datetimeMs(evidence.budgetControl.validUntil),
    datetimeMs(evidence.circuitControl.validUntil),
    datetimeMs(evidence.runbook.validUntil),
    datetimeMs(evidence.security.validUntil),
  );

  assessReviewedEvidence(
    'runbook',
    evidence.runbook.reviewedAt,
    evidence.runbook.validUntil,
    evaluatedAtMs,
  );
  addIncompleteReason('runbook_control_incomplete', 'incident runbook', [
    evidence.runbook.escalationTestPassed,
    evidence.runbook.rollbackTestPassed,
  ]);
  assessReviewedEvidence(
    'security',
    evidence.security.reviewedAt,
    evidence.security.validUntil,
    evaluatedAtMs,
  );
  addIncompleteReason('security_control_incomplete', 'production security review', [
    evidence.security.credentialRotationTestPassed,
    evidence.security.noLlmSecretExposureTestPassed,
  ]);

  const requiredProviders = collectRequiredProviders(evidence.providers, policy);
  let coveredProviderSlots = 0;
  for (const chainId of policy.requiredChains) {
    for (const adapter of policy.requiredAdapters) {
      const slot = `${chainId}:${adapter}`;
      const providerCount = new Set(
        requiredProviders
          .filter((provider) => provider.chainId === chainId && provider.adapter === adapter)
          .map((provider) => provider.providerId),
      ).size;
      if (providerCount >= policy.minProvidersPerAdapterChain) {
        coveredProviderSlots += 1;
      } else {
        addReason({
          actual: String(providerCount),
          code: 'provider_coverage_missing',
          severity: 'blocking',
          subject: slot,
          threshold: `>=${policy.minProvidersPerAdapterChain} enabled providers`,
        });
      }
    }
  }

  const requiredProviderByKey = new Map(
    requiredProviders.map((provider) => [providerKey(provider), provider]),
  );
  for (const provider of requiredProviderByKey.values()) {
    if (datetimeMs(provider.approvedAt) > evaluatedAtMs) {
      addReason({
        actual: provider.approvedAt,
        code: 'provider_approval_from_future',
        severity: 'blocking',
        subject: providerKey(provider),
        threshold: `<=${evaluatedAt}`,
      });
    }
  }

  const budgetPolicyByKey = new Map(
    evidence.budgetPolicies.map((budget) => [providerKey(budget), budget]),
  );
  const circuitStateByKey = new Map(
    evidence.circuitStates.map((state) => [providerKey(state), state]),
  );
  const sloByKey = new Map(evidence.sloReports.map((report) => [providerKey(report), report]));
  let budgetPolicyCoveredProviders = 0;
  let circuitStateCoveredProviders = 0;
  let closedCircuitProviders = 0;
  let sloCoveredProviders = 0;
  for (const key of requiredProviderByKey.keys()) {
    if (budgetPolicyByKey.has(key)) {
      budgetPolicyCoveredProviders += 1;
    } else {
      addReason({
        actual: 'missing',
        code: 'provider_budget_policy_missing',
        severity: 'blocking',
        subject: key,
        threshold: 'one content-addressed budget policy',
      });
    }

    const circuit = circuitStateByKey.get(key);
    if (circuit === undefined) {
      addReason({
        actual: 'missing',
        code: 'provider_circuit_state_missing',
        severity: 'blocking',
        subject: key,
        threshold: 'one shared circuit state snapshot',
      });
    } else {
      circuitStateCoveredProviders += 1;
      const updatedAtMs = datetimeMs(circuit.updatedAt);
      if (updatedAtMs > evaluatedAtMs) {
        addReason({
          actual: circuit.updatedAt,
          code: 'provider_circuit_state_from_future',
          severity: 'blocking',
          subject: key,
          threshold: `<=${evaluatedAt}`,
        });
      } else {
        const validUntil = addSeconds(updatedAtMs, policy.maxCircuitStateAgeSeconds);
        validityCandidates.push(validUntil);
        if (evaluatedAtMs > validUntil) {
          addReason({
            actual: ageSeconds(evaluatedAtMs, updatedAtMs),
            code: 'provider_circuit_state_stale',
            severity: 'blocking',
            subject: key,
            threshold: `<=${policy.maxCircuitStateAgeSeconds}s`,
          });
        }
      }
      if (circuit.state === 'closed') {
        closedCircuitProviders += 1;
      } else {
        addReason({
          actual: circuit.state,
          code: 'provider_circuit_not_closed',
          severity: 'degraded',
          subject: key,
          threshold: 'closed',
        });
      }
    }

    const slo = sloByKey.get(key);
    if (slo === undefined) {
      addReason({
        actual: 'missing',
        code: 'provider_slo_report_missing',
        severity: 'blocking',
        subject: key,
        threshold: 'one fresh SLO report',
      });
    } else {
      sloCoveredProviders += 1;
      assessSlo(key, slo);
    }
  }

  let passingDrills = 0;
  for (const drillKind of policy.requiredDrills) {
    const drillEvidence = evidence.drills.filter((drill) => drill.drill === drillKind);
    const future = drillEvidence.filter((drill) => datetimeMs(drill.completedAt) > evaluatedAtMs);
    if (future.length > 0) {
      addReason({
        actual: latestDrill(future).completedAt,
        code: 'drill_evidence_from_future',
        severity: 'blocking',
        subject: drillKind,
        threshold: `<=${evaluatedAt}`,
      });
    }
    const eligible = drillEvidence.filter(
      (drill) => datetimeMs(drill.completedAt) <= evaluatedAtMs,
    );
    if (eligible.length === 0) {
      if (future.length === 0) {
        addReason({
          actual: 'missing',
          code: 'drill_evidence_missing',
          severity: 'blocking',
          subject: drillKind,
          threshold: 'one fresh drill result',
        });
      }
      continue;
    }
    const drill = latestDrill(eligible);
    const completedAtMs = datetimeMs(drill.completedAt);
    const validUntil = addSeconds(completedAtMs, policy.maxDrillAgeSeconds);
    validityCandidates.push(validUntil);
    let passesStructuralGate = true;
    if (evaluatedAtMs > validUntil) {
      passesStructuralGate = false;
      addReason({
        actual: ageSeconds(evaluatedAtMs, completedAtMs),
        code: 'drill_evidence_stale',
        severity: 'blocking',
        subject: drillKind,
        threshold: `<=${policy.maxDrillAgeSeconds}s`,
      });
    }
    if (drill.runbookHash !== evidence.runbook.runbookHash) {
      passesStructuralGate = false;
      addReason({
        actual: drill.runbookHash,
        code: 'runbook_hash_mismatch',
        severity: 'blocking',
        subject: drillKind,
        threshold: evidence.runbook.runbookHash,
      });
    }
    if (drill.outcome === 'failed') {
      addReason({
        actual: 'failed',
        code: 'drill_failed',
        severity: 'degraded',
        subject: drillKind,
        threshold: 'passed',
      });
    }
    if (drill.recoveryTimeMs > policy.maxDrillRecoveryTimeMs) {
      addReason({
        actual: `${drill.recoveryTimeMs}ms`,
        code: 'drill_recovery_exceeded',
        severity: 'degraded',
        subject: drillKind,
        threshold: `<=${policy.maxDrillRecoveryTimeMs}ms`,
      });
    }
    if (
      passesStructuralGate &&
      drill.outcome === 'passed' &&
      drill.recoveryTimeMs <= policy.maxDrillRecoveryTimeMs
    ) {
      passingDrills += 1;
    }
  }

  const coverage: ProductionOperationsCoverage = {
    budgetPolicyCoveredProviders,
    circuitStateCoveredProviders,
    closedCircuitProviders,
    coveredProviderSlots,
    enabledRequiredProviders: requiredProviderByKey.size,
    passingDrills,
    requiredDrills: policy.requiredDrills.length,
    requiredProviderSlots: policy.requiredChains.length * policy.requiredAdapters.length,
    sloCoveredProviders,
  };
  const orderedReasons = orderReasons([...reasons.values()]);
  const status = orderedReasons.some((reason) => reason.severity === 'blocking')
    ? 'fail'
    : orderedReasons.some((reason) => reason.severity === 'degraded')
      ? 'degraded'
      : 'pass';
  const body = {
    coverage,
    evaluatedAt,
    evidenceFingerprint: fingerprintProductionOperationsEvidence(evidence),
    policyFingerprint: policy.policyFingerprint,
    reasons: orderedReasons,
    status,
    validUntil: new Date(Math.min(...validityCandidates)).toISOString(),
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return productionOperationsAssessmentSchema.parse({
    ...body,
    assessmentFingerprint: sha256Fingerprint(body),
  });

  function assessTimeBoundControl(
    subject: string,
    control: { testedAt: string; validUntil: string },
    nowMs: number,
  ): void {
    if (datetimeMs(control.testedAt) > nowMs) {
      addReason({
        actual: control.testedAt,
        code: 'control_evidence_from_future',
        severity: 'blocking',
        subject,
        threshold: `<=${evaluatedAt}`,
      });
    }
    if (datetimeMs(control.validUntil) <= nowMs) {
      addReason({
        actual: control.validUntil,
        code: 'control_evidence_expired',
        severity: 'blocking',
        subject,
        threshold: `>${evaluatedAt}`,
      });
    }
  }

  function assessReviewedEvidence(
    kind: 'runbook' | 'security',
    reviewedAt: string,
    validUntil: string,
    nowMs: number,
  ): void {
    const subject = `${kind} evidence`;
    if (datetimeMs(reviewedAt) > nowMs) {
      addReason({
        actual: reviewedAt,
        code: kind === 'runbook' ? 'runbook_evidence_from_future' : 'security_evidence_from_future',
        severity: 'blocking',
        subject,
        threshold: `<=${evaluatedAt}`,
      });
    }
    if (datetimeMs(validUntil) <= nowMs) {
      addReason({
        actual: validUntil,
        code: kind === 'runbook' ? 'runbook_evidence_expired' : 'security_evidence_expired',
        severity: 'blocking',
        subject,
        threshold: `>${evaluatedAt}`,
      });
    }
  }

  function addIncompleteReason(
    code:
      | 'alerting_control_incomplete'
      | 'audit_control_incomplete'
      | 'budget_control_incomplete'
      | 'circuit_control_incomplete'
      | 'runbook_control_incomplete'
      | 'security_control_incomplete',
    subject: string,
    checks: readonly boolean[],
    threshold = 'all required checks true',
  ): void {
    const passed = checks.filter(Boolean).length;
    if (passed !== checks.length) {
      addReason({
        actual: `${passed}/${checks.length} checks passed`,
        code,
        severity: 'blocking',
        subject,
        threshold,
      });
    }
  }

  function assessSlo(
    key: string,
    slo: ProductionOperationsEvidenceBundle['sloReports'][number],
  ): void {
    const endedAtMs = datetimeMs(slo.windowEndedAt);
    if (endedAtMs > evaluatedAtMs) {
      addReason({
        actual: slo.windowEndedAt,
        code: 'provider_slo_report_from_future',
        severity: 'blocking',
        subject: key,
        threshold: `<=${evaluatedAt}`,
      });
    } else {
      const validUntil = addSeconds(endedAtMs, policy.maxSloAgeSeconds);
      validityCandidates.push(validUntil);
      if (evaluatedAtMs > validUntil) {
        addReason({
          actual: ageSeconds(evaluatedAtMs, endedAtMs),
          code: 'provider_slo_report_stale',
          severity: 'blocking',
          subject: key,
          threshold: `<=${policy.maxSloAgeSeconds}s`,
        });
      }
    }
    if (slo.sampleCount < policy.minSloSamples) {
      addReason({
        actual: String(slo.sampleCount),
        code: 'provider_slo_samples_insufficient',
        severity: 'blocking',
        subject: key,
        threshold: `>=${policy.minSloSamples}`,
      });
    }
    const breaches = [
      ...(slo.availabilityPpm < policy.minAvailabilityPpm
        ? [`availability=${slo.availabilityPpm}ppm`]
        : []),
      ...(slo.errorRatePpm > policy.maxErrorRatePpm ? [`error_rate=${slo.errorRatePpm}ppm`] : []),
      ...(slo.p95LatencyMs > policy.maxP95LatencyMs ? [`p95=${slo.p95LatencyMs}ms`] : []),
      ...(slo.averageCostUnits > policy.maxAverageCostUnits
        ? [`cost=${slo.averageCostUnits}`]
        : []),
      ...(slo.openIncidentCount > policy.maxOpenIncidents
        ? [`incidents=${slo.openIncidentCount}`]
        : []),
    ];
    if (breaches.length > 0) {
      addReason({
        actual: breaches.join(', '),
        code: 'provider_slo_breached',
        severity: 'degraded',
        subject: key,
        threshold: `availability>=${policy.minAvailabilityPpm}ppm, error<=${policy.maxErrorRatePpm}ppm, p95<=${policy.maxP95LatencyMs}ms, cost<=${policy.maxAverageCostUnits}, incidents<=${policy.maxOpenIncidents}`,
      });
    }
  }

  function addReason(reason: ProductionReadinessReason): void {
    reasons.set(`${reason.code}:${reason.subject}`, reason);
  }
}

export function evaluateProductionReadiness(input: unknown): ProductionReadinessResult {
  const normalized = productionReadinessEvaluationInputSchema.parse(input);
  const evaluatedAtMs = datetimeMs(normalized.evaluatedAt);
  const operations = evaluateProductionOperationsEvidence(
    normalized.operationsEvidence,
    normalized.policy,
    normalized.evaluatedAt,
  );
  const corpusQualityGate = evaluateChainAnalysisQualityGate(
    normalized.corpusReport,
    internalReadinessQualityGate,
  );
  const reasons = new Map(
    operations.reasons.map((reason) => [`${reason.code}:${reason.subject}`, reason]),
  );
  const expectedCorpusFingerprint = sha256Fingerprint({
    ...normalized.corpusExport.corpus,
    cases: [...normalized.corpusExport.corpus.cases].sort((left, right) =>
      compareCanonicalStrings(left.id, right.id),
    ),
  });
  if (
    normalized.corpusReport.corpusId !== normalized.corpusExport.corpus.corpusId ||
    normalized.corpusReport.corpusFingerprint !== expectedCorpusFingerprint ||
    datetimeMs(normalized.corpusReport.evaluatedAt) < datetimeMs(normalized.corpusExport.exportedAt)
  ) {
    addReason({
      actual: `${normalized.corpusReport.corpusId}:${normalized.corpusReport.corpusFingerprint}`,
      code: 'corpus_report_mismatch',
      severity: 'blocking',
      subject: 'reviewed corpus evaluation lineage',
      threshold: `${normalized.corpusExport.corpus.corpusId}:${expectedCorpusFingerprint}`,
    });
  }
  assessCorpusTime(
    'corpus export',
    normalized.corpusExport.exportedAt,
    'corpus_export_from_future',
    'corpus_export_stale',
  );
  assessCorpusTime(
    'corpus evaluation report',
    normalized.corpusReport.evaluatedAt,
    'corpus_report_from_future',
    'corpus_report_stale',
  );
  if (corpusQualityGate.status === 'fail') {
    const failureCodes = [...new Set(corpusQualityGate.failures.map((failure) => failure.code))];
    addReason({
      actual: `fail (${corpusQualityGate.failures.length}): ${failureCodes.slice(0, 5).join(',')}`,
      code: 'corpus_quality_gate_failed',
      severity: 'blocking',
      subject: 'internal-readiness quality gate',
      threshold: 'pass using the immutable internalReadinessQualityGate',
    });
  }
  const orderedReasons = orderReasons([...reasons.values()]);
  const status = orderedReasons.some((reason) => reason.severity === 'blocking')
    ? 'blocked'
    : orderedReasons.some((reason) => reason.severity === 'degraded')
      ? 'degraded'
      : 'ready';
  const corpusExportValidUntil = addSeconds(
    datetimeMs(normalized.corpusExport.exportedAt),
    normalized.policy.maxCorpusAgeSeconds,
  );
  const corpusReportValidUntil = addSeconds(
    datetimeMs(normalized.corpusReport.evaluatedAt),
    normalized.policy.maxCorpusAgeSeconds,
  );
  const body = {
    corpusExportFingerprint: normalized.corpusExport.exportFingerprint,
    corpusQualityGate,
    corpusReportFingerprint: normalized.corpusReport.reportFingerprint,
    evaluatedAt: normalized.evaluatedAt,
    nextEvaluationAt: new Date(
      Math.min(datetimeMs(operations.validUntil), corpusExportValidUntil, corpusReportValidUntil),
    ).toISOString(),
    operations,
    policyFingerprint: normalized.policy.policyFingerprint,
    reasons: orderedReasons,
    status,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return productionReadinessResultSchema.parse({
    ...body,
    readinessFingerprint: sha256Fingerprint(body),
  });

  function assessCorpusTime(
    subject: string,
    timestamp: string,
    futureCode: 'corpus_export_from_future' | 'corpus_report_from_future',
    staleCode: 'corpus_export_stale' | 'corpus_report_stale',
  ): void {
    const timestampMs = datetimeMs(timestamp);
    if (timestampMs > evaluatedAtMs) {
      addReason({
        actual: timestamp,
        code: futureCode,
        severity: 'blocking',
        subject,
        threshold: `<=${normalized.evaluatedAt}`,
      });
    } else if (evaluatedAtMs > addSeconds(timestampMs, normalized.policy.maxCorpusAgeSeconds)) {
      addReason({
        actual: ageSeconds(evaluatedAtMs, timestampMs),
        code: staleCode,
        severity: 'blocking',
        subject,
        threshold: `<=${normalized.policy.maxCorpusAgeSeconds}s`,
      });
    }
  }

  function addReason(reason: ProductionReadinessReason): void {
    reasons.set(`${reason.code}:${reason.subject}`, reason);
  }
}

function collectRequiredProviders(
  providers: readonly ProviderDeploymentDescriptor[],
  policy: ProductionReadinessPolicy,
): ProviderDeploymentDescriptor[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      policy.requiredChains.includes(provider.chainId) &&
      policy.requiredAdapters.includes(provider.adapter),
  );
}

function providerKey(input: { adapter: string; chainId: string; providerId: string }): string {
  return `${input.chainId}:${input.adapter}:${input.providerId}`;
}

function latestDrill(drills: readonly ProductionDrillEvidence[]): ProductionDrillEvidence {
  return [...drills].sort((left, right) => {
    const timeComparison = datetimeMs(left.completedAt) - datetimeMs(right.completedAt);
    return timeComparison === 0
      ? compareCanonicalStrings(left.evidenceHash, right.evidenceHash)
      : timeComparison;
  })[drills.length - 1]!;
}

function orderReasons(reasons: readonly ProductionReadinessReason[]): ProductionReadinessReason[] {
  return [...reasons].sort((left, right) =>
    compareCanonicalStrings(
      `${left.severity}:${left.code}:${left.subject}`,
      `${right.severity}:${right.code}:${right.subject}`,
    ),
  );
}

function addSeconds(milliseconds: number, seconds: number): number {
  return milliseconds + seconds * MILLISECONDS_PER_SECOND;
}

function ageSeconds(later: number, earlier: number): string {
  return `${Math.floor((later - earlier) / MILLISECONDS_PER_SECOND)}s`;
}
