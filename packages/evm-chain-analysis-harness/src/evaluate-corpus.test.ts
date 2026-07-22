import { beforeAll, describe, expect, it } from 'vitest';

import {
  evaluateChainAnalysisQualityGate,
  evaluateEvmChainAnalysisCorpus,
  internalReadinessQualityGate,
  syntheticRegressionQualityGate,
  type ChainAnalysisCorpus,
} from './index.js';
import { createSyntheticChainAnalysisCorpus } from './fixtures/synthetic-corpus.test-helper.js';

const EVALUATED_AT = '2026-07-22T02:00:00.000Z';
let corpus: ChainAnalysisCorpus;

beforeAll(async () => {
  corpus = await createSyntheticChainAnalysisCorpus();
});

describe('chain analysis replay evaluation', () => {
  it('reports deterministic confusion, coverage, unsupported rate, and provider cost', () => {
    const report = evaluateEvmChainAnalysisCorpus(corpus, { evaluatedAt: EVALUATED_AT });

    expect(report.totals).toEqual({
      cases: 6,
      classifiedDetectCases: 2,
      detectCases: 5,
      expectedMatches: 6,
      insufficient: 1,
      partial: 2,
      providerCostUnits: 37,
      reviewedCases: 0,
      success: 3,
      syntheticCases: 6,
      unsupportedCases: 1,
      unsupportedPredictions: 1,
    });
    expect(report.confusion).toEqual({
      falseNegatives: 0,
      falsePositives: 0,
      negativeAbstentions: 0,
      positiveAbstentions: 2,
      trueNegatives: 1,
      truePositives: 1,
    });
    expect(report.metrics).toMatchObject({
      classificationCoverage: { denominator: 4, numerator: 2, ppm: 500_000 },
      determinism: { denominator: 6, numerator: 6, ppm: 1_000_000 },
      expectedMatch: { denominator: 6, numerator: 6, ppm: 1_000_000 },
      precision: { denominator: 1, numerator: 1, ppm: 1_000_000 },
      recall: { denominator: 3, numerator: 1, ppm: 333_333 },
      unsupportedRate: { denominator: 5, numerator: 1, ppm: 200_000 },
    });
    expect(report.coverageMatrix).toContainEqual({
      cases: 3,
      costUnits: 23,
      dimension: 'protocol',
      insufficient: 0,
      partial: 2,
      success: 1,
      value: 'uniswap_v2',
    });
    expect(report.cases.map((item) => item.id)).toEqual(
      [...report.cases.map((item) => item.id)].sort(),
    );
  });

  it('passes synthetic regression but refuses to claim internal readiness', () => {
    const report = evaluateEvmChainAnalysisCorpus(corpus, { evaluatedAt: EVALUATED_AT });
    const regression = evaluateChainAnalysisQualityGate(report, syntheticRegressionQualityGate);
    const readiness = evaluateChainAnalysisQualityGate(report, internalReadinessQualityGate);

    expect(regression).toMatchObject({ failures: [], status: 'pass' });
    expect(readiness.status).toBe('fail');
    expect(readiness.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        'dimension_coverage_missing',
        'insufficient_case_count',
        'insufficient_classification_coverage',
        'insufficient_recall',
        'insufficient_reviewed_cases',
        'positive_abstentions_exceeded',
        'unsupported_rate_exceeded',
      ]),
    );
  });

  it('detects label drift and produces an order-independent report fingerprint', () => {
    const drifted = structuredClone(corpus);
    drifted.cases.find((item) => item.id === 'synthetic.confirmed-v2')!.expected.pipelineStatus =
      'partial';
    const driftReport = evaluateEvmChainAnalysisCorpus(drifted, { evaluatedAt: EVALUATED_AT });
    expect(driftReport.metrics.expectedMatch).toEqual({
      denominator: 6,
      numerator: 5,
      ppm: 833_333,
    });
    expect(
      evaluateChainAnalysisQualityGate(driftReport, syntheticRegressionQualityGate),
    ).toMatchObject({
      failures: [expect.objectContaining({ code: 'insufficient_expected_match' })],
      status: 'fail',
    });

    const reversed = structuredClone(corpus);
    reversed.cases.reverse();
    const normalReport = evaluateEvmChainAnalysisCorpus(corpus, { evaluatedAt: EVALUATED_AT });
    const reversedReport = evaluateEvmChainAnalysisCorpus(reversed, {
      evaluatedAt: EVALUATED_AT,
    });
    expect(reversedReport.reportFingerprint).toBe(normalReport.reportFingerprint);
  });

  it('enforces average provider cost without floating-point comparisons', () => {
    const report = evaluateEvmChainAnalysisCorpus(corpus, { evaluatedAt: EVALUATED_AT });
    const gate = { ...syntheticRegressionQualityGate, maxAverageProviderCostUnits: 6 };
    expect(evaluateChainAnalysisQualityGate(report, gate)).toMatchObject({
      failures: [expect.objectContaining({ code: 'average_provider_cost_exceeded' })],
      status: 'fail',
    });
  });

  it('rejects reports whose metrics or fingerprint were altered after evaluation', () => {
    const report = evaluateEvmChainAnalysisCorpus(corpus, { evaluatedAt: EVALUATED_AT });
    const tampered = structuredClone(report);
    tampered.totals.success += 1;

    expect(() =>
      evaluateChainAnalysisQualityGate(tampered, syntheticRegressionQualityGate),
    ).toThrow();
  });
});
