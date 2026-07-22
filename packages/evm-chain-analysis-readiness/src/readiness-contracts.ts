import { z } from 'zod';

import {
  chainAnalysisEvaluationReportSchema,
  chainAnalysisQualityGateResultSchema,
  sha256Fingerprint,
} from '@xxyy/evm-chain-analysis-harness';

import {
  EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  MAX_READINESS_PROVIDERS,
  fingerprintSchema,
  uniqueValues,
} from './common.js';
import { reviewedReplayCorpusExportSchema } from './governance-contracts.js';
import {
  productionOperationsEvidenceBundleSchema,
  productionReadinessPolicySchema,
} from './operations-contracts.js';

export const productionReadinessStatuses = ['blocked', 'degraded', 'ready'] as const;
export const productionOperationsAssessmentStatuses = ['degraded', 'fail', 'pass'] as const;
export const productionReadinessSeverities = ['blocking', 'degraded'] as const;

export const productionReadinessReasonCodes = [
  'alerting_control_incomplete',
  'audit_control_incomplete',
  'budget_control_incomplete',
  'circuit_control_incomplete',
  'control_evidence_expired',
  'control_evidence_from_future',
  'corpus_export_from_future',
  'corpus_export_stale',
  'corpus_quality_gate_failed',
  'corpus_report_from_future',
  'corpus_report_mismatch',
  'corpus_report_stale',
  'drill_evidence_from_future',
  'drill_evidence_missing',
  'drill_evidence_stale',
  'drill_failed',
  'drill_recovery_exceeded',
  'provider_approval_from_future',
  'provider_budget_policy_missing',
  'provider_circuit_not_closed',
  'provider_circuit_state_from_future',
  'provider_circuit_state_missing',
  'provider_circuit_state_stale',
  'provider_coverage_missing',
  'provider_slo_breached',
  'provider_slo_report_from_future',
  'provider_slo_report_missing',
  'provider_slo_report_stale',
  'provider_slo_samples_insufficient',
  'runbook_control_incomplete',
  'runbook_evidence_expired',
  'runbook_evidence_from_future',
  'runbook_hash_mismatch',
  'security_control_incomplete',
  'security_evidence_expired',
  'security_evidence_from_future',
] as const;

export const productionReadinessReasonSchema = z
  .object({
    actual: z.string().trim().min(1).max(256),
    code: z.enum(productionReadinessReasonCodes),
    severity: z.enum(productionReadinessSeverities),
    subject: z.string().trim().min(1).max(256),
    threshold: z.string().trim().min(1).max(256),
  })
  .strict();

export const productionOperationsCoverageSchema = z
  .object({
    budgetPolicyCoveredProviders: z.number().int().nonnegative().max(MAX_READINESS_PROVIDERS),
    circuitStateCoveredProviders: z.number().int().nonnegative().max(MAX_READINESS_PROVIDERS),
    closedCircuitProviders: z.number().int().nonnegative().max(MAX_READINESS_PROVIDERS),
    coveredProviderSlots: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_READINESS_PROVIDERS * 3),
    enabledRequiredProviders: z.number().int().nonnegative().max(MAX_READINESS_PROVIDERS),
    passingDrills: z.number().int().nonnegative().max(64),
    requiredDrills: z.number().int().nonnegative().max(64),
    requiredProviderSlots: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_READINESS_PROVIDERS * 3),
    sloCoveredProviders: z.number().int().nonnegative().max(MAX_READINESS_PROVIDERS),
  })
  .strict();

export const productionOperationsAssessmentSchema = z
  .object({
    assessmentFingerprint: fingerprintSchema,
    coverage: productionOperationsCoverageSchema,
    evaluatedAt: z.string().datetime({ offset: true }),
    evidenceFingerprint: fingerprintSchema,
    policyFingerprint: fingerprintSchema,
    reasons: z
      .array(productionReadinessReasonSchema)
      .max(500)
      .refine(
        (reasons) => uniqueValues(reasons.map((reason) => `${reason.code}:${reason.subject}`)),
        'Operations reasons must be unique by code and subject.',
      ),
    status: z.enum(productionOperationsAssessmentStatuses),
    validUntil: z.string().datetime({ offset: true }),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((assessment, context) => {
    const hasBlocking = assessment.reasons.some((reason) => reason.severity === 'blocking');
    const hasDegraded = assessment.reasons.some((reason) => reason.severity === 'degraded');
    const expectedStatus = hasBlocking ? 'fail' : hasDegraded ? 'degraded' : 'pass';
    if (assessment.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        message: 'Operations status must match the highest reason severity.',
        path: ['status'],
      });
    }
    const { assessmentFingerprint, ...fingerprintPayload } = assessment;
    if (assessmentFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Operations assessment fingerprint must cover the normalized result.',
        path: ['assessmentFingerprint'],
      });
    }
  });

export const productionReadinessEvaluationInputSchema = z
  .object({
    corpusExport: reviewedReplayCorpusExportSchema,
    corpusReport: chainAnalysisEvaluationReportSchema,
    evaluatedAt: z.string().datetime({ offset: true }),
    operationsEvidence: productionOperationsEvidenceBundleSchema,
    policy: productionReadinessPolicySchema,
  })
  .strict();

export const productionReadinessResultSchema = z
  .object({
    corpusExportFingerprint: fingerprintSchema,
    corpusQualityGate: chainAnalysisQualityGateResultSchema,
    corpusReportFingerprint: fingerprintSchema,
    evaluatedAt: z.string().datetime({ offset: true }),
    nextEvaluationAt: z.string().datetime({ offset: true }),
    operations: productionOperationsAssessmentSchema,
    policyFingerprint: fingerprintSchema,
    readinessFingerprint: fingerprintSchema,
    reasons: z
      .array(productionReadinessReasonSchema)
      .max(700)
      .refine(
        (reasons) => uniqueValues(reasons.map((reason) => `${reason.code}:${reason.subject}`)),
        'Readiness reasons must be unique by code and subject.',
      ),
    status: z.enum(productionReadinessStatuses),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((result, context) => {
    const hasBlocking = result.reasons.some((reason) => reason.severity === 'blocking');
    const hasDegraded = result.reasons.some((reason) => reason.severity === 'degraded');
    const expectedStatus = hasBlocking ? 'blocked' : hasDegraded ? 'degraded' : 'ready';
    if (result.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        message: 'Readiness status must match the highest reason severity.',
        path: ['status'],
      });
    }
    const { readinessFingerprint, ...fingerprintPayload } = result;
    if (readinessFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Readiness fingerprint must cover the normalized result.',
        path: ['readinessFingerprint'],
      });
    }
  });

export type ProductionReadinessReasonCode = (typeof productionReadinessReasonCodes)[number];
export type ProductionReadinessReason = z.output<typeof productionReadinessReasonSchema>;
export type ProductionOperationsCoverage = z.output<typeof productionOperationsCoverageSchema>;
export type ProductionOperationsAssessment = z.output<typeof productionOperationsAssessmentSchema>;
export type ProductionReadinessEvaluationInput = z.input<
  typeof productionReadinessEvaluationInputSchema
>;
export type ProductionReadinessResult = z.output<typeof productionReadinessResultSchema>;
