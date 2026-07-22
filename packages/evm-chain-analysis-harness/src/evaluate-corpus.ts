import { canonicalJson, compareCanonicalStrings, sha256Fingerprint } from './canonical-json.js';
import { composeEvmChainAnalysis } from './compose-chain-analysis.js';
import {
  EVM_CHAIN_ANALYSIS_HARNESS_VERSION,
  type ChainAnalysisCapabilityResult,
  type ChainAnalysisCompositionDiagnosticCode,
  type DetectSandwichCapabilityResult,
  type EvmChainAnalysisPipelineResult,
} from './contracts.js';
import {
  EVM_CHAIN_ANALYSIS_EVALUATION_VERSION,
  PARTS_PER_MILLION,
  chainAnalysisCorpusSchema,
  chainAnalysisEvaluationReportSchema,
  chainAnalysisMatrixDimensions,
  chainAnalysisQualityGateResultSchema,
  chainAnalysisQualityGateSchema,
  type ChainAnalysisCorpus,
  type ChainAnalysisCorpusCase,
  type ChainAnalysisCoverageMatrixRow,
  type ChainAnalysisEvaluationCaseResult,
  type ChainAnalysisEvaluationReport,
  type ChainAnalysisMatrixDimension,
  type ChainAnalysisPrediction,
  type ChainAnalysisQualityGateResult,
  type ChainAnalysisRatioMetric,
} from './evaluation-contracts.js';

export interface EvaluateChainAnalysisCorpusOptions {
  evaluatedAt?: string;
}

export function evaluateEvmChainAnalysisCorpus(
  corpusInput: unknown,
  options: EvaluateChainAnalysisCorpusOptions = {},
): ChainAnalysisEvaluationReport {
  const corpus = chainAnalysisCorpusSchema.parse(corpusInput);
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const orderedCases = [...corpus.cases].sort((left, right) =>
    compareCanonicalStrings(left.id, right.id),
  );
  const corpusFingerprint = sha256Fingerprint({ ...corpus, cases: orderedCases });
  const evaluations = orderedCases.map(evaluateCase);
  const evaluatedCases = evaluations.map((item) => item.caseResult);
  const confusion = createConfusion(evaluatedCases);
  const detectCases = evaluatedCases.filter((item) => item.prediction !== 'not_applicable');
  const supervisedDetectCases = evaluatedCases.filter(
    (item) => item.groundTruth === 'positive' || item.groundTruth === 'negative',
  );
  const classifiedDetectCases = supervisedDetectCases.filter(
    (item) => item.prediction === 'positive' || item.prediction === 'negative',
  ).length;
  const unsupportedPredictions = evaluations.filter((item) => item.unsupported).length;
  const providerCostUnits = safeSum(evaluatedCases.map((item) => item.providerCostUnits));
  const totals = {
    cases: evaluatedCases.length,
    classifiedDetectCases,
    detectCases: detectCases.length,
    expectedMatches: evaluatedCases.filter((item) => item.expectedMatch).length,
    insufficient: evaluatedCases.filter((item) => item.actualPipelineStatus === 'insufficient_data')
      .length,
    partial: evaluatedCases.filter((item) => item.actualPipelineStatus === 'partial').length,
    providerCostUnits,
    reviewedCases: evaluatedCases.filter((item) => item.tier === 'reviewed').length,
    success: evaluatedCases.filter((item) => item.actualPipelineStatus === 'success').length,
    syntheticCases: evaluatedCases.filter((item) => item.tier === 'synthetic').length,
    unsupportedCases: evaluatedCases.filter((item) => item.groundTruth === 'unsupported').length,
    unsupportedPredictions,
  };
  const metrics = {
    classificationCoverage: ratioMetric(classifiedDetectCases, supervisedDetectCases.length),
    determinism: ratioMetric(
      evaluatedCases.filter((item) => item.deterministic).length,
      evaluatedCases.length,
    ),
    expectedMatch: ratioMetric(totals.expectedMatches, evaluatedCases.length),
    precision: ratioMetric(
      confusion.truePositives,
      confusion.truePositives + confusion.falsePositives,
    ),
    recall: ratioMetric(
      confusion.truePositives,
      confusion.truePositives + confusion.falseNegatives + confusion.positiveAbstentions,
    ),
    successRate: ratioMetric(totals.success, evaluatedCases.length),
    unsupportedRate: ratioMetric(unsupportedPredictions, detectCases.length),
  };
  const reportWithoutFingerprint = {
    cases: evaluatedCases,
    confusion,
    corpusFingerprint,
    corpusId: corpus.corpusId,
    coverageMatrix: createCoverageMatrix(corpus, evaluatedCases),
    evaluatedAt,
    harnessVersion: EVM_CHAIN_ANALYSIS_HARNESS_VERSION,
    metrics,
    totals,
    version: EVM_CHAIN_ANALYSIS_EVALUATION_VERSION,
  };
  return chainAnalysisEvaluationReportSchema.parse({
    ...reportWithoutFingerprint,
    reportFingerprint: sha256Fingerprint(reportWithoutFingerprint),
  });
}

export function evaluateChainAnalysisQualityGate(
  reportInput: unknown,
  gateInput: unknown,
): ChainAnalysisQualityGateResult {
  const report = chainAnalysisEvaluationReportSchema.parse(reportInput);
  const gate = chainAnalysisQualityGateSchema.parse(gateInput);
  const failures: ChainAnalysisQualityGateResult['failures'] = [];

  addMinimumCountFailure(
    failures,
    report.totals.cases,
    gate.minCases,
    'insufficient_case_count',
    'corpus cases',
  );
  addMinimumCountFailure(
    failures,
    report.totals.reviewedCases,
    gate.minReviewedCases,
    'insufficient_reviewed_cases',
    'reviewed corpus cases',
  );
  addMinimumMetricFailure(
    failures,
    report.metrics.determinism,
    gate.minDeterminismPpm,
    'insufficient_determinism',
    'byte determinism',
  );
  addMinimumMetricFailure(
    failures,
    report.metrics.expectedMatch,
    gate.minExpectedMatchPpm,
    'insufficient_expected_match',
    'expected-label match',
  );
  addMinimumMetricFailure(
    failures,
    report.metrics.precision,
    gate.minPrecisionPpm,
    'insufficient_precision',
    'sandwich precision',
  );
  addMinimumMetricFailure(
    failures,
    report.metrics.recall,
    gate.minRecallPpm,
    'insufficient_recall',
    'sandwich recall including positive abstentions',
  );
  addMinimumMetricFailure(
    failures,
    report.metrics.classificationCoverage,
    gate.minClassificationCoveragePpm,
    'insufficient_classification_coverage',
    'supported detection classification coverage',
  );
  addMaximumMetricFailure(
    failures,
    report.metrics.unsupportedRate,
    gate.maxUnsupportedRatePpm,
    'unsupported_rate_exceeded',
    'unsupported detection rate',
  );
  addMaximumCountFailure(
    failures,
    report.confusion.falseNegatives,
    gate.maxFalseNegatives,
    'false_negatives_exceeded',
    'false negatives',
  );
  addMaximumCountFailure(
    failures,
    report.confusion.falsePositives,
    gate.maxFalsePositives,
    'false_positives_exceeded',
    'false positives',
  );
  addMaximumCountFailure(
    failures,
    report.confusion.positiveAbstentions,
    gate.maxPositiveAbstentions,
    'positive_abstentions_exceeded',
    'positive abstentions',
  );
  if (
    report.totals.cases > 0 &&
    BigInt(report.totals.providerCostUnits) >
      BigInt(gate.maxAverageProviderCostUnits) * BigInt(report.totals.cases)
  ) {
    failures.push({
      actual: `${report.totals.providerCostUnits}/${report.totals.cases}`,
      code: 'average_provider_cost_exceeded',
      subject: 'average provider cost units per case',
      threshold: `<=${gate.maxAverageProviderCostUnits}`,
    });
  }
  for (const requirement of gate.dimensionRequirements) {
    const actual =
      report.coverageMatrix.find(
        (row) => row.dimension === requirement.dimension && row.value === requirement.value,
      )?.cases ?? 0;
    if (actual < requirement.minCases) {
      failures.push({
        actual: String(actual),
        code: 'dimension_coverage_missing',
        subject: `${requirement.dimension}:${requirement.value}`,
        threshold: `>=${requirement.minCases}`,
      });
    }
  }
  const orderedFailures = failures.sort(compareGateFailures);
  return chainAnalysisQualityGateResultSchema.parse({
    failures: orderedFailures,
    gateFingerprint: sha256Fingerprint(gate),
    reportFingerprint: report.reportFingerprint,
    status: orderedFailures.length === 0 ? 'pass' : 'fail',
  });
}

function evaluateCase(item: ChainAnalysisCorpusCase): {
  caseResult: ChainAnalysisEvaluationCaseResult;
  unsupported: boolean;
} {
  const first = composeEvmChainAnalysis(item.input);
  const second = composeEvmChainAnalysis(structuredClone(item.input));
  const deterministic = canonicalJson(first) === canonicalJson(second);
  const actualCapabilities = first.capabilities.map((capability) => ({
    capability: capability.capability,
    status: capability.status,
  }));
  const detect = getDetectionCapability(first.capabilities);
  const actualSandwichVerdict = detect?.verdict;
  const compositionDiagnosticCodes = first.diagnostics.map(
    (diagnostic) => diagnostic.code as ChainAnalysisCompositionDiagnosticCode,
  );
  const expectedMatch =
    canonicalJson(actualCapabilities) === canonicalJson(item.expected.capabilities) &&
    first.status === item.expected.pipelineStatus &&
    canonicalJson(compositionDiagnosticCodes) ===
      canonicalJson(item.expected.compositionDiagnosticCodes) &&
    actualSandwichVerdict === item.expected.sandwichVerdict;
  return {
    caseResult: {
      actualCapabilities,
      actualPipelineStatus: normalizePipelineStatus(first.status),
      ...(actualSandwichVerdict === undefined ? {} : { actualSandwichVerdict }),
      compositionDiagnosticCodes,
      deterministic,
      expectedMatch,
      groundTruth: item.groundTruth,
      id: item.id,
      pipelineFingerprint: sha256Fingerprint(first),
      prediction: derivePrediction(first),
      providerCostUnits: first.coverage.providerCostUnits,
      tier: item.review.tier,
    },
    unsupported:
      first.mev?.coverage.quote === 'unsupported' ||
      detect?.refusalCodes.includes('unsupported_semantics') === true,
  };
}

function derivePrediction(result: EvmChainAnalysisPipelineResult): ChainAnalysisPrediction {
  const detect = getDetectionCapability(result.capabilities);
  if (detect === undefined) {
    return 'not_applicable';
  }
  if (detect.verdict === 'confirmed' || detect.verdict === 'likely') {
    return 'positive';
  }
  return detect.verdict === 'unlikely' ? 'negative' : 'abstain';
}

function getDetectionCapability(
  capabilities: readonly ChainAnalysisCapabilityResult[],
): DetectSandwichCapabilityResult | undefined {
  return capabilities.find(
    (capability): capability is DetectSandwichCapabilityResult =>
      capability.capability === 'chain.detect_sandwich',
  );
}

function createConfusion(cases: readonly ChainAnalysisEvaluationCaseResult[]) {
  const counts = {
    falseNegatives: 0,
    falsePositives: 0,
    negativeAbstentions: 0,
    positiveAbstentions: 0,
    trueNegatives: 0,
    truePositives: 0,
  };
  for (const item of cases) {
    if (item.groundTruth === 'positive') {
      if (item.prediction === 'positive') {
        counts.truePositives += 1;
      } else if (item.prediction === 'negative') {
        counts.falseNegatives += 1;
      } else {
        counts.positiveAbstentions += 1;
      }
    } else if (item.groundTruth === 'negative') {
      if (item.prediction === 'negative') {
        counts.trueNegatives += 1;
      } else if (item.prediction === 'positive') {
        counts.falsePositives += 1;
      } else {
        counts.negativeAbstentions += 1;
      }
    }
  }
  return counts;
}

function createCoverageMatrix(
  corpus: ChainAnalysisCorpus,
  results: readonly ChainAnalysisEvaluationCaseResult[],
): ChainAnalysisCoverageMatrixRow[] {
  const rows = new Map<string, ChainAnalysisCoverageMatrixRow>();
  for (const item of corpus.cases) {
    const result = results.find((candidate) => candidate.id === item.id);
    if (result === undefined) {
      throw new Error(`Evaluation result missing for corpus case ${item.id}.`);
    }
    const values: Record<ChainAnalysisMatrixDimension, string> = {
      chain: item.dimensions.chainId,
      data_state: item.dimensions.dataState,
      protocol: item.dimensions.protocol,
      router: item.dimensions.router,
      tier: item.review.tier,
    };
    for (const dimension of chainAnalysisMatrixDimensions) {
      const value = values[dimension];
      const key = `${dimension}:${value}`;
      const existing = rows.get(key) ?? {
        cases: 0,
        costUnits: 0,
        dimension,
        insufficient: 0,
        partial: 0,
        success: 0,
        value,
      };
      existing.cases += 1;
      existing.costUnits = safeSum([existing.costUnits, result.providerCostUnits]);
      if (result.actualPipelineStatus === 'success') {
        existing.success += 1;
      } else if (result.actualPipelineStatus === 'partial') {
        existing.partial += 1;
      } else {
        existing.insufficient += 1;
      }
      rows.set(key, existing);
    }
  }
  const dimensionOrder = new Map(
    chainAnalysisMatrixDimensions.map((dimension, index) => [dimension, index]),
  );
  return [...rows.values()].sort(
    (left, right) =>
      (dimensionOrder.get(left.dimension) ?? 0) - (dimensionOrder.get(right.dimension) ?? 0) ||
      compareCanonicalStrings(left.value, right.value),
  );
}

function ratioMetric(numerator: number, denominator: number): ChainAnalysisRatioMetric {
  return {
    denominator,
    numerator,
    ppm: denominator === 0 ? null : Math.floor((numerator * PARTS_PER_MILLION) / denominator),
  };
}

function normalizePipelineStatus(
  status: EvmChainAnalysisPipelineResult['status'],
): 'success' | 'partial' | 'insufficient_data' {
  if (status === 'failed') {
    throw new Error('The deterministic chain analysis pipeline must not emit failed status.');
  }
  return status;
}

type GateFailure = ChainAnalysisQualityGateResult['failures'][number];
type GateFailureCode = GateFailure['code'];

function addMinimumCountFailure(
  failures: GateFailure[],
  actual: number,
  threshold: number,
  code: GateFailureCode,
  subject: string,
): void {
  if (actual < threshold) {
    failures.push({ actual: String(actual), code, subject, threshold: `>=${threshold}` });
  }
}

function addMaximumCountFailure(
  failures: GateFailure[],
  actual: number,
  threshold: number,
  code: GateFailureCode,
  subject: string,
): void {
  if (actual > threshold) {
    failures.push({ actual: String(actual), code, subject, threshold: `<=${threshold}` });
  }
}

function addMinimumMetricFailure(
  failures: GateFailure[],
  metric: ChainAnalysisRatioMetric,
  threshold: number,
  code: GateFailureCode,
  subject: string,
): void {
  if ((metric.ppm === null && threshold > 0) || (metric.ppm !== null && metric.ppm < threshold)) {
    failures.push({
      actual: metric.ppm === null ? 'undefined' : String(metric.ppm),
      code,
      subject,
      threshold: `>=${threshold}`,
    });
  }
}

function addMaximumMetricFailure(
  failures: GateFailure[],
  metric: ChainAnalysisRatioMetric,
  threshold: number,
  code: GateFailureCode,
  subject: string,
): void {
  if (metric.ppm !== null && metric.ppm > threshold) {
    failures.push({
      actual: String(metric.ppm),
      code,
      subject,
      threshold: `<=${threshold}`,
    });
  }
}

function compareGateFailures(left: GateFailure, right: GateFailure): number {
  return (
    compareCanonicalStrings(left.code, right.code) ||
    compareCanonicalStrings(left.subject, right.subject)
  );
}

function safeSum(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('Provider cost aggregation exceeds Number.MAX_SAFE_INTEGER.');
  }
  return total;
}
