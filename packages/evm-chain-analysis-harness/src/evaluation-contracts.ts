import { z } from 'zod';

import { evmSandwichVerdicts } from '@xxyy/evm-price-impact-sandwich-core';
import { evmChainIdSchema } from '@xxyy/transaction-analysis-core';

import {
  EVM_CHAIN_ANALYSIS_HARNESS_VERSION,
  chainAnalysisCapabilityIds,
  chainAnalysisCompositionDiagnosticCodes,
  evmChainAnalysisPipelineInputSchema,
} from './contracts.js';
import { sha256Fingerprint } from './canonical-json.js';

export const EVM_CHAIN_ANALYSIS_CORPUS_VERSION = '0.1.0' as const;
export const EVM_CHAIN_ANALYSIS_EVALUATION_VERSION = '0.1.0' as const;
export const PARTS_PER_MILLION = 1_000_000;
export const MAX_CHAIN_ANALYSIS_CORPUS_CASES = 500;

export const chainAnalysisCorpusTiers = ['reviewed', 'synthetic'] as const;
export const chainAnalysisGroundTruthLabels = [
  'negative',
  'not_applicable',
  'positive',
  'unsupported',
] as const;
export const chainAnalysisPredictions = [
  'abstain',
  'negative',
  'not_applicable',
  'positive',
] as const;
export const chainAnalysisMatrixDimensions = [
  'chain',
  'data_state',
  'protocol',
  'router',
  'tier',
] as const;

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);
const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const ppmSchema = z.number().int().min(0).max(PARTS_PER_MILLION);

const privacySchema = z
  .object({
    addressPolicy: z.enum(['public_chain', 'synthetic']),
    containsCredentials: z.literal(false),
    containsPrivateData: z.literal(false),
    redactionVersion: stableIdSchema,
  })
  .strict();

const syntheticReviewSchema = z
  .object({
    generatorVersion: stableIdSchema,
    tier: z.literal('synthetic'),
  })
  .strict();

const reviewedReviewSchema = z
  .object({
    reviewedAt: z.string().datetime({ offset: true }),
    reviewerIdHash: fingerprintSchema,
    sourcePayloadHashes: z
      .array(fingerprintSchema)
      .min(1)
      .max(16)
      .refine((values) => new Set(values).size === values.length),
    tier: z.literal('reviewed'),
  })
  .strict();

const reviewSchema = z.discriminatedUnion('tier', [syntheticReviewSchema, reviewedReviewSchema]);

const dimensionsSchema = z
  .object({
    chainId: evmChainIdSchema,
    dataState: z.enum(['complete', 'partial', 'provider_conflict', 'unsupported']),
    protocol: z.enum(['none', 'other', 'uniswap_v2', 'uniswap_v3']),
    router: z.enum(['aggregator', 'allowlisted_router', 'direct_pool', 'unknown']),
  })
  .strict();

const expectedCapabilitySchema = z
  .object({
    capability: z.enum(chainAnalysisCapabilityIds),
    status: z.enum(['success', 'partial', 'insufficient_data']),
  })
  .strict();

const expectedSchema = z
  .object({
    capabilities: z
      .array(expectedCapabilitySchema)
      .min(1)
      .max(chainAnalysisCapabilityIds.length)
      .refine((values) => new Set(values.map((value) => value.capability)).size === values.length),
    compositionDiagnosticCodes: z
      .array(z.enum(chainAnalysisCompositionDiagnosticCodes))
      .max(chainAnalysisCompositionDiagnosticCodes.length)
      .refine((values) => new Set(values).size === values.length),
    pipelineStatus: z.enum(['success', 'partial', 'insufficient_data']),
    sandwichVerdict: z.enum(evmSandwichVerdicts).optional(),
  })
  .strict();

export const chainAnalysisCorpusCaseSchema = z
  .object({
    dimensions: dimensionsSchema,
    expected: expectedSchema,
    groundTruth: z.enum(chainAnalysisGroundTruthLabels),
    id: stableIdSchema,
    input: evmChainAnalysisPipelineInputSchema,
    privacy: privacySchema,
    review: reviewSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const requestCapabilities = value.input.requests.map((request) => request.capability);
    if (
      value.expected.capabilities.length !== requestCapabilities.length ||
      value.expected.capabilities.some(
        (capability, index) => capability.capability !== requestCapabilities[index],
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expected capability labels must align with request order.',
        path: ['expected', 'capabilities'],
      });
    }
    const detectsSandwich = requestCapabilities.includes('chain.detect_sandwich');
    if (detectsSandwich === (value.groundTruth === 'not_applicable')) {
      context.addIssue({
        code: 'custom',
        message: 'Sandwich ground truth must be applicable exactly when detection is requested.',
        path: ['groundTruth'],
      });
    }
    if (!detectsSandwich && value.expected.sandwichVerdict !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Cases without sandwich detection must omit a sandwich verdict.',
        path: ['expected', 'sandwichVerdict'],
      });
    }
    const expectedDetection = value.expected.capabilities.find(
      (capability) => capability.capability === 'chain.detect_sandwich',
    );
    if (
      expectedDetection !== undefined &&
      expectedDetection.status !== 'insufficient_data' &&
      value.expected.sandwichVerdict === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Usable expected detection results require an expected sandwich verdict.',
        path: ['expected', 'sandwichVerdict'],
      });
    }
    if (value.review.tier === 'reviewed' && value.privacy.addressPolicy !== 'public_chain') {
      context.addIssue({
        code: 'custom',
        message: 'Reviewed cases must explicitly use the public-chain address policy.',
        path: ['privacy', 'addressPolicy'],
      });
    }
    if (value.review.tier === 'synthetic' && value.privacy.addressPolicy !== 'synthetic') {
      context.addIssue({
        code: 'custom',
        message: 'Synthetic cases must use synthetic addresses.',
        path: ['privacy', 'addressPolicy'],
      });
    }
    if (value.dimensions.chainId !== value.input.snapshot.chainId) {
      context.addIssue({
        code: 'custom',
        message: 'Coverage dimension chain must match the pipeline input.',
        path: ['dimensions', 'chainId'],
      });
    }
    if (value.groundTruth === 'unsupported' && value.dimensions.dataState !== 'unsupported') {
      context.addIssue({
        code: 'custom',
        message: 'Unsupported ground truth requires the unsupported data-state dimension.',
        path: ['dimensions', 'dataState'],
      });
    }
    if (value.dimensions.dataState === 'unsupported' && value.groundTruth !== 'unsupported') {
      context.addIssue({
        code: 'custom',
        message: 'The unsupported data-state dimension requires unsupported ground truth.',
        path: ['groundTruth'],
      });
    }
    const observedProtocol = value.input.observation?.analysisInput?.pool.protocol;
    if (observedProtocol !== undefined && value.dimensions.protocol !== observedProtocol) {
      context.addIssue({
        code: 'custom',
        message: 'Protocol coverage must match the observed MEV pool.',
        path: ['dimensions', 'protocol'],
      });
    }
  });

export const chainAnalysisCorpusSchema = z
  .object({
    cases: z.array(chainAnalysisCorpusCaseSchema).max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    corpusId: stableIdSchema,
    createdAt: z.string().datetime({ offset: true }),
    description: z.string().trim().min(1).max(1_000),
    version: z.literal(EVM_CHAIN_ANALYSIS_CORPUS_VERSION),
  })
  .strict()
  .superRefine((corpus, context) => {
    const ids = new Set<string>();
    for (const [index, item] of corpus.cases.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate corpus case id: ${item.id}`,
          path: ['cases', index, 'id'],
        });
      }
      ids.add(item.id);
    }
  });

export const chainAnalysisRatioMetricSchema = z
  .object({
    denominator: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    numerator: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    ppm: ppmSchema.nullable(),
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.numerator > metric.denominator) {
      context.addIssue({
        code: 'custom',
        message: 'Ratio numerator cannot exceed its denominator.',
        path: ['numerator'],
      });
    }
    if ((metric.denominator === 0) !== (metric.ppm === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Undefined ratios require a null ppm exactly when the denominator is zero.',
        path: ['ppm'],
      });
    }
    const expectedPpm =
      metric.denominator === 0
        ? null
        : Math.floor((metric.numerator * PARTS_PER_MILLION) / metric.denominator);
    if (metric.ppm !== expectedPpm) {
      context.addIssue({
        code: 'custom',
        message: 'Ratio ppm must be the deterministic floor of numerator/denominator.',
        path: ['ppm'],
      });
    }
  });

const actualCapabilitySchema = z
  .object({
    capability: z.enum(chainAnalysisCapabilityIds),
    status: z.enum(['success', 'partial', 'insufficient_data']),
  })
  .strict();

export const chainAnalysisEvaluationCaseResultSchema = z
  .object({
    actualCapabilities: z.array(actualCapabilitySchema).min(1).max(2),
    actualPipelineStatus: z.enum(['success', 'partial', 'insufficient_data']),
    actualSandwichVerdict: z.enum(evmSandwichVerdicts).optional(),
    compositionDiagnosticCodes: z.array(z.enum(chainAnalysisCompositionDiagnosticCodes)),
    deterministic: z.boolean(),
    expectedMatch: z.boolean(),
    groundTruth: z.enum(chainAnalysisGroundTruthLabels),
    id: stableIdSchema,
    pipelineFingerprint: fingerprintSchema,
    prediction: z.enum(chainAnalysisPredictions),
    providerCostUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tier: z.enum(chainAnalysisCorpusTiers),
  })
  .strict()
  .superRefine((result, context) => {
    const capabilityIds = result.actualCapabilities.map((capability) => capability.capability);
    if (new Set(capabilityIds).size !== capabilityIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Actual capability results must be unique.',
        path: ['actualCapabilities'],
      });
    }
    const detectsSandwich = capabilityIds.includes('chain.detect_sandwich');
    if (detectsSandwich === (result.prediction === 'not_applicable')) {
      context.addIssue({
        code: 'custom',
        message: 'Detection predictions must be applicable exactly when detection ran.',
        path: ['prediction'],
      });
    }
    if (detectsSandwich === (result.groundTruth === 'not_applicable')) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluation ground truth must align with whether detection ran.',
        path: ['groundTruth'],
      });
    }
    const expectedPrediction =
      result.actualSandwichVerdict === 'confirmed' || result.actualSandwichVerdict === 'likely'
        ? 'positive'
        : result.actualSandwichVerdict === 'unlikely'
          ? 'negative'
          : detectsSandwich
            ? 'abstain'
            : 'not_applicable';
    if (result.prediction !== expectedPrediction) {
      context.addIssue({
        code: 'custom',
        message: 'Prediction must be derived from the structured sandwich verdict.',
        path: ['prediction'],
      });
    }
    if (!detectsSandwich && result.actualSandwichVerdict !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Inspection-only results cannot carry a sandwich verdict.',
        path: ['actualSandwichVerdict'],
      });
    }
    if (
      new Set(result.compositionDiagnosticCodes).size !== result.compositionDiagnosticCodes.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Composition diagnostic codes must be unique.',
        path: ['compositionDiagnosticCodes'],
      });
    }
  });

const confusionSchema = z
  .object({
    falseNegatives: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    falsePositives: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    negativeAbstentions: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    positiveAbstentions: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    trueNegatives: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    truePositives: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
  })
  .strict();

export const chainAnalysisCoverageMatrixRowSchema = z
  .object({
    cases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    costUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    dimension: z.enum(chainAnalysisMatrixDimensions),
    insufficient: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    partial: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    success: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    value: z.string().trim().min(1).max(128),
  })
  .strict()
  .refine((row) => row.cases === row.success + row.partial + row.insufficient, {
    message: 'Coverage matrix status counts must equal total cases.',
    path: ['cases'],
  });

const totalsSchema = z
  .object({
    cases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    classifiedDetectCases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    detectCases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    expectedMatches: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    insufficient: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    partial: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    providerCostUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reviewedCases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    success: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    syntheticCases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    unsupportedCases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    unsupportedPredictions: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
  })
  .strict()
  .superRefine((totals, context) => {
    if (totals.cases !== totals.success + totals.partial + totals.insufficient) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluation status totals must equal case count.',
        path: ['cases'],
      });
    }
    if (totals.cases !== totals.reviewedCases + totals.syntheticCases) {
      context.addIssue({
        code: 'custom',
        message: 'Corpus tier totals must equal case count.',
        path: ['cases'],
      });
    }
  });

const metricsSchema = z
  .object({
    classificationCoverage: chainAnalysisRatioMetricSchema,
    determinism: chainAnalysisRatioMetricSchema,
    expectedMatch: chainAnalysisRatioMetricSchema,
    precision: chainAnalysisRatioMetricSchema,
    recall: chainAnalysisRatioMetricSchema,
    successRate: chainAnalysisRatioMetricSchema,
    unsupportedRate: chainAnalysisRatioMetricSchema,
  })
  .strict();

export const chainAnalysisEvaluationReportSchema = z
  .object({
    cases: z.array(chainAnalysisEvaluationCaseResultSchema).max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    confusion: confusionSchema,
    corpusFingerprint: fingerprintSchema,
    corpusId: stableIdSchema,
    coverageMatrix: z.array(chainAnalysisCoverageMatrixRowSchema).max(500),
    evaluatedAt: z.string().datetime({ offset: true }),
    harnessVersion: z.literal(EVM_CHAIN_ANALYSIS_HARNESS_VERSION),
    metrics: metricsSchema,
    reportFingerprint: fingerprintSchema,
    totals: totalsSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_EVALUATION_VERSION),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.cases.length !== report.totals.cases) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluation case results must match totals.',
        path: ['cases'],
      });
    }
    const caseIds = new Set<string>();
    for (const [index, item] of report.cases.entries()) {
      if (caseIds.has(item.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate evaluation case id: ${item.id}`,
          path: ['cases', index, 'id'],
        });
      }
      caseIds.add(item.id);
    }
    const matrixKeys = new Set<string>();
    for (const [index, row] of report.coverageMatrix.entries()) {
      const key = `${row.dimension}:${row.value}`;
      if (matrixKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate coverage matrix row: ${key}`,
          path: ['coverageMatrix', index],
        });
      }
      matrixKeys.add(key);
    }
    addEvaluationConsistencyIssues(report, context);
    const { reportFingerprint: _reportFingerprint, ...fingerprintPayload } = report;
    if (sha256Fingerprint(fingerprintPayload) !== report.reportFingerprint) {
      context.addIssue({
        code: 'custom',
        message: 'Report fingerprint must cover the normalized evaluation report.',
        path: ['reportFingerprint'],
      });
    }
  });

interface EvaluationConsistencyReport {
  cases: Array<z.output<typeof chainAnalysisEvaluationCaseResultSchema>>;
  confusion: z.output<typeof confusionSchema>;
  coverageMatrix: Array<z.output<typeof chainAnalysisCoverageMatrixRowSchema>>;
  metrics: z.output<typeof metricsSchema>;
  totals: z.output<typeof totalsSchema>;
}

function addEvaluationConsistencyIssues(
  report: EvaluationConsistencyReport,
  context: z.RefinementCtx,
): void {
  const detectsSandwich = (item: EvaluationConsistencyReport['cases'][number]) =>
    item.actualCapabilities.some((capability) => capability.capability === 'chain.detect_sandwich');
  const supervised = report.cases.filter(
    (item) => item.groundTruth === 'positive' || item.groundTruth === 'negative',
  );
  const derivedConfusion = {
    falseNegatives: supervised.filter(
      (item) => item.groundTruth === 'positive' && item.prediction === 'negative',
    ).length,
    falsePositives: supervised.filter(
      (item) => item.groundTruth === 'negative' && item.prediction === 'positive',
    ).length,
    negativeAbstentions: supervised.filter(
      (item) => item.groundTruth === 'negative' && item.prediction === 'abstain',
    ).length,
    positiveAbstentions: supervised.filter(
      (item) => item.groundTruth === 'positive' && item.prediction === 'abstain',
    ).length,
    trueNegatives: supervised.filter(
      (item) => item.groundTruth === 'negative' && item.prediction === 'negative',
    ).length,
    truePositives: supervised.filter(
      (item) => item.groundTruth === 'positive' && item.prediction === 'positive',
    ).length,
  };
  for (const key of Object.keys(derivedConfusion) as Array<keyof typeof derivedConfusion>) {
    if (report.confusion[key] !== derivedConfusion[key]) {
      addConsistencyIssue(context, ['confusion', key], `Confusion ${key} does not match cases.`);
    }
  }

  const classifiedDetectCases = supervised.filter(
    (item) => item.prediction === 'positive' || item.prediction === 'negative',
  ).length;
  const derivedTotals = {
    cases: report.cases.length,
    classifiedDetectCases,
    detectCases: report.cases.filter(detectsSandwich).length,
    expectedMatches: report.cases.filter((item) => item.expectedMatch).length,
    insufficient: report.cases.filter((item) => item.actualPipelineStatus === 'insufficient_data')
      .length,
    partial: report.cases.filter((item) => item.actualPipelineStatus === 'partial').length,
    reviewedCases: report.cases.filter((item) => item.tier === 'reviewed').length,
    success: report.cases.filter((item) => item.actualPipelineStatus === 'success').length,
    syntheticCases: report.cases.filter((item) => item.tier === 'synthetic').length,
    unsupportedCases: report.cases.filter((item) => item.groundTruth === 'unsupported').length,
  };
  for (const key of Object.keys(derivedTotals) as Array<keyof typeof derivedTotals>) {
    if (report.totals[key] !== derivedTotals[key]) {
      addConsistencyIssue(context, ['totals', key], `Total ${key} does not match cases.`);
    }
  }
  const providerCost = report.cases.reduce((sum, item) => sum + BigInt(item.providerCostUnits), 0n);
  if (providerCost !== BigInt(report.totals.providerCostUnits)) {
    addConsistencyIssue(
      context,
      ['totals', 'providerCostUnits'],
      'Provider cost total does not match cases.',
    );
  }
  if (report.totals.unsupportedPredictions > report.totals.detectCases) {
    addConsistencyIssue(
      context,
      ['totals', 'unsupportedPredictions'],
      'Unsupported predictions cannot exceed detection cases.',
    );
  }

  checkMetric(
    report.metrics.classificationCoverage,
    classifiedDetectCases,
    supervised.length,
    'classificationCoverage',
    context,
  );
  checkMetric(
    report.metrics.determinism,
    report.cases.filter((item) => item.deterministic).length,
    report.cases.length,
    'determinism',
    context,
  );
  checkMetric(
    report.metrics.expectedMatch,
    derivedTotals.expectedMatches,
    report.cases.length,
    'expectedMatch',
    context,
  );
  checkMetric(
    report.metrics.precision,
    derivedConfusion.truePositives,
    derivedConfusion.truePositives + derivedConfusion.falsePositives,
    'precision',
    context,
  );
  checkMetric(
    report.metrics.recall,
    derivedConfusion.truePositives,
    derivedConfusion.truePositives +
      derivedConfusion.falseNegatives +
      derivedConfusion.positiveAbstentions,
    'recall',
    context,
  );
  checkMetric(
    report.metrics.successRate,
    derivedTotals.success,
    report.cases.length,
    'successRate',
    context,
  );
  checkMetric(
    report.metrics.unsupportedRate,
    report.totals.unsupportedPredictions,
    derivedTotals.detectCases,
    'unsupportedRate',
    context,
  );

  for (const dimension of chainAnalysisMatrixDimensions) {
    const rows = report.coverageMatrix.filter((row) => row.dimension === dimension);
    const sums = rows.reduce(
      (totals, row) => ({
        cases: totals.cases + row.cases,
        costUnits: totals.costUnits + BigInt(row.costUnits),
        insufficient: totals.insufficient + row.insufficient,
        partial: totals.partial + row.partial,
        success: totals.success + row.success,
      }),
      { cases: 0, costUnits: 0n, insufficient: 0, partial: 0, success: 0 },
    );
    if (
      sums.cases !== report.totals.cases ||
      sums.costUnits !== BigInt(report.totals.providerCostUnits) ||
      sums.insufficient !== report.totals.insufficient ||
      sums.partial !== report.totals.partial ||
      sums.success !== report.totals.success
    ) {
      addConsistencyIssue(
        context,
        ['coverageMatrix'],
        `Coverage matrix dimension ${dimension} does not reconcile with report totals.`,
      );
    }
  }
}

function checkMetric(
  metric: z.output<typeof chainAnalysisRatioMetricSchema>,
  numerator: number,
  denominator: number,
  name: keyof z.output<typeof metricsSchema>,
  context: z.RefinementCtx,
): void {
  if (metric.numerator !== numerator || metric.denominator !== denominator) {
    addConsistencyIssue(
      context,
      ['metrics', name],
      `Metric ${name} does not match evaluation cases.`,
    );
  }
}

function addConsistencyIssue(context: z.RefinementCtx, path: string[], message: string): void {
  context.addIssue({ code: 'custom', message, path });
}

export const chainAnalysisQualityGateFailureCodes = [
  'average_provider_cost_exceeded',
  'dimension_coverage_missing',
  'false_negatives_exceeded',
  'false_positives_exceeded',
  'insufficient_case_count',
  'insufficient_classification_coverage',
  'insufficient_determinism',
  'insufficient_expected_match',
  'insufficient_precision',
  'insufficient_recall',
  'insufficient_reviewed_cases',
  'positive_abstentions_exceeded',
  'unsupported_rate_exceeded',
] as const;

const dimensionRequirementSchema = z
  .object({
    dimension: z.enum(chainAnalysisMatrixDimensions),
    minCases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    value: z.string().trim().min(1).max(128),
  })
  .strict();

export const chainAnalysisQualityGateSchema = z
  .object({
    dimensionRequirements: z
      .array(dimensionRequirementSchema)
      .max(100)
      .refine(
        (values) =>
          new Set(values.map((value) => `${value.dimension}:${value.value}`)).size ===
          values.length,
      ),
    maxAverageProviderCostUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    maxFalseNegatives: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    maxFalsePositives: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    maxPositiveAbstentions: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    maxUnsupportedRatePpm: ppmSchema,
    minCases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
    minClassificationCoveragePpm: ppmSchema,
    minDeterminismPpm: ppmSchema,
    minExpectedMatchPpm: ppmSchema,
    minPrecisionPpm: ppmSchema,
    minRecallPpm: ppmSchema,
    minReviewedCases: z.number().int().nonnegative().max(MAX_CHAIN_ANALYSIS_CORPUS_CASES),
  })
  .strict();

const qualityGateFailureSchema = z
  .object({
    actual: z.string().trim().min(1).max(128),
    code: z.enum(chainAnalysisQualityGateFailureCodes),
    subject: z.string().trim().min(1).max(256),
    threshold: z.string().trim().min(1).max(128),
  })
  .strict();

export const chainAnalysisQualityGateResultSchema = z
  .object({
    failures: z.array(qualityGateFailureSchema).max(200),
    gateFingerprint: fingerprintSchema,
    reportFingerprint: fingerprintSchema,
    status: z.enum(['fail', 'pass']),
  })
  .strict()
  .refine((result) => (result.status === 'pass') === (result.failures.length === 0), {
    message: 'Quality gate status must match whether failures are present.',
    path: ['status'],
  });

export const syntheticRegressionQualityGate = chainAnalysisQualityGateSchema.parse({
  dimensionRequirements: [],
  maxAverageProviderCostUnits: Number.MAX_SAFE_INTEGER,
  maxFalseNegatives: MAX_CHAIN_ANALYSIS_CORPUS_CASES,
  maxFalsePositives: MAX_CHAIN_ANALYSIS_CORPUS_CASES,
  maxPositiveAbstentions: MAX_CHAIN_ANALYSIS_CORPUS_CASES,
  maxUnsupportedRatePpm: PARTS_PER_MILLION,
  minCases: 1,
  minClassificationCoveragePpm: 0,
  minDeterminismPpm: PARTS_PER_MILLION,
  minExpectedMatchPpm: PARTS_PER_MILLION,
  minPrecisionPpm: 0,
  minRecallPpm: 0,
  minReviewedCases: 0,
});

export const internalReadinessQualityGate = chainAnalysisQualityGateSchema.parse({
  dimensionRequirements: [
    { dimension: 'protocol', minCases: 5, value: 'uniswap_v2' },
    { dimension: 'protocol', minCases: 5, value: 'uniswap_v3' },
    { dimension: 'data_state', minCases: 3, value: 'provider_conflict' },
    { dimension: 'router', minCases: 3, value: 'allowlisted_router' },
  ],
  maxAverageProviderCostUnits: 1_000,
  maxFalseNegatives: 1,
  maxFalsePositives: 0,
  maxPositiveAbstentions: 1,
  maxUnsupportedRatePpm: 100_000,
  minCases: 20,
  minClassificationCoveragePpm: 950_000,
  minDeterminismPpm: PARTS_PER_MILLION,
  minExpectedMatchPpm: PARTS_PER_MILLION,
  minPrecisionPpm: 950_000,
  minRecallPpm: 900_000,
  minReviewedCases: 10,
});

export type ChainAnalysisCorpusTier = (typeof chainAnalysisCorpusTiers)[number];
export type ChainAnalysisGroundTruthLabel = (typeof chainAnalysisGroundTruthLabels)[number];
export type ChainAnalysisPrediction = (typeof chainAnalysisPredictions)[number];
export type ChainAnalysisMatrixDimension = (typeof chainAnalysisMatrixDimensions)[number];
export type ChainAnalysisCorpusCase = z.output<typeof chainAnalysisCorpusCaseSchema>;
export type ChainAnalysisCorpus = z.output<typeof chainAnalysisCorpusSchema>;
export type ChainAnalysisRatioMetric = z.output<typeof chainAnalysisRatioMetricSchema>;
export type ChainAnalysisEvaluationCaseResult = z.output<
  typeof chainAnalysisEvaluationCaseResultSchema
>;
export type ChainAnalysisCoverageMatrixRow = z.output<typeof chainAnalysisCoverageMatrixRowSchema>;
export type ChainAnalysisEvaluationReport = z.output<typeof chainAnalysisEvaluationReportSchema>;
export type ChainAnalysisQualityGate = z.output<typeof chainAnalysisQualityGateSchema>;
export type ChainAnalysisQualityGateResult = z.output<typeof chainAnalysisQualityGateResultSchema>;
