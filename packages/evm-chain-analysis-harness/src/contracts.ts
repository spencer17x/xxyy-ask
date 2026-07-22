import { z } from 'zod';

import {
  evmCallTraceSchema,
  evmExecutionEnrichmentResultSchema,
  evmPoolMetadataSchema,
} from '@xxyy/evm-execution-enrichment-core';
import {
  evmMevObservationDataAdapterResultSchema,
  type EvmMevObservationDataAdapterResult,
} from '@xxyy/evm-mev-observation-data-adapter';
import {
  evmPriceImpactSandwichResultSchema,
  evmSandwichVerdicts,
} from '@xxyy/evm-price-impact-sandwich-core';
import { createSkillResultSchema, skillResultStatuses } from '@xxyy/shared';
import {
  EVM_ZERO_ADDRESS,
  evmAddressSchema,
  evmChainIdSchema,
  evmHashSchema,
  evmTransactionSnapshotSchema,
  transactionAnalysisResultSchema,
  transactionExecutionStatuses,
} from '@xxyy/transaction-analysis-core';

export const EVM_CHAIN_ANALYSIS_HARNESS_SKILL = 'evm_chain_analysis_harness' as const;
export const EVM_CHAIN_ANALYSIS_HARNESS_VERSION = '0.1.0' as const;

export const chainAnalysisCapabilityIds = [
  'chain.inspect_transaction',
  'chain.detect_sandwich',
] as const;
export const chainAnalysisStageNames = ['transaction', 'execution', 'observation', 'mev'] as const;
export const chainAnalysisStageStates = [
  'blocked',
  'completed',
  'not_provided',
  'not_requested',
] as const;
export const chainAnalysisRefusalCodes = [
  'composition_conflict',
  'execution_data_partial',
  'observation_insufficient',
  'observation_missing',
  'pool_not_observed',
  'provider_conflict',
  'transaction_data_insufficient',
  'unsupported_semantics',
] as const;
export const chainAnalysisCompositionDiagnosticCodes = [
  'execution_observation_multiple_swaps',
  'execution_observation_swap_mismatch',
  'observation_analysis_missing',
  'observation_block_mismatch',
  'observation_chain_mismatch',
  'observation_missing',
  'observation_pool_mismatch',
  'observation_provider_block_mismatch',
  'observation_provider_conflict',
  'observation_transaction_index_mismatch',
  'observation_transaction_mismatch',
  'transaction_anchor_missing',
] as const;

export type ChainAnalysisCapabilityId = (typeof chainAnalysisCapabilityIds)[number];
export type ChainAnalysisStageName = (typeof chainAnalysisStageNames)[number];
export type ChainAnalysisStageState = (typeof chainAnalysisStageStates)[number];
export type ChainAnalysisRefusalCode = (typeof chainAnalysisRefusalCodes)[number];
export type ChainAnalysisCompositionDiagnosticCode =
  (typeof chainAnalysisCompositionDiagnosticCodes)[number];

const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const inspectTransactionCapabilityRequestSchema = z
  .object({
    capability: z.literal('chain.inspect_transaction'),
    chainId: evmChainIdSchema,
    transactionHash: evmHashSchema,
  })
  .strict();

export const detectSandwichCapabilityRequestSchema = z
  .object({
    capability: z.literal('chain.detect_sandwich'),
    chainId: evmChainIdSchema,
    poolAddress: evmAddressSchema,
    transactionHash: evmHashSchema,
  })
  .strict()
  .refine((request) => request.poolAddress !== EVM_ZERO_ADDRESS, {
    message: 'Sandwich detection pool cannot be the zero address.',
    path: ['poolAddress'],
  });

export const chainAnalysisCapabilityRequestSchema = z.discriminatedUnion('capability', [
  inspectTransactionCapabilityRequestSchema,
  detectSandwichCapabilityRequestSchema,
]);

const executionInputSchema = z
  .object({
    poolMetadata: evmPoolMetadataSchema.optional(),
    trace: evmCallTraceSchema.optional(),
  })
  .strict()
  .refine((value) => value.poolMetadata !== undefined || value.trace !== undefined, {
    message: 'Execution input must explicitly provide a trace or pool metadata.',
  });

export const evmChainAnalysisPipelineInputSchema = z
  .object({
    execution: executionInputSchema.optional(),
    observation: evmMevObservationDataAdapterResultSchema.optional(),
    requests: z
      .array(chainAnalysisCapabilityRequestSchema)
      .min(1)
      .max(chainAnalysisCapabilityIds.length)
      .refine(
        (requests) =>
          new Set(requests.map((request) => request.capability)).size === requests.length,
        'Capability requests must be unique.',
      ),
    snapshot: evmTransactionSnapshotSchema,
  })
  .strict()
  .superRefine((input, context) => {
    for (const [index, request] of input.requests.entries()) {
      if (request.chainId !== input.snapshot.chainId) {
        context.addIssue({
          code: 'custom',
          message: 'Capability request chain must match the normalized snapshot.',
          path: ['requests', index, 'chainId'],
        });
      }
      if (request.transactionHash !== input.snapshot.requestedTransactionHash) {
        context.addIssue({
          code: 'custom',
          message: 'Capability request transaction must match the normalized snapshot request.',
          path: ['requests', index, 'transactionHash'],
        });
      }
    }
  });

export const chainAnalysisStageSchema = z
  .object({
    diagnosticCodes: z
      .array(z.string().trim().min(1).max(128))
      .max(100)
      .refine(
        (values) => new Set(values).size === values.length,
        'Diagnostic codes must be unique.',
      ),
    inputFingerprint: fingerprintSchema.optional(),
    name: z.enum(chainAnalysisStageNames),
    outputFingerprint: fingerprintSchema.optional(),
    state: z.enum(chainAnalysisStageStates),
    status: z.enum(skillResultStatuses).optional(),
  })
  .strict()
  .superRefine((stage, context) => {
    if (
      stage.state === 'completed' &&
      (stage.inputFingerprint === undefined ||
        stage.outputFingerprint === undefined ||
        stage.status === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Completed stages require input/output fingerprints and a status.',
        path: ['state'],
      });
    }
    if (
      stage.state !== 'completed' &&
      (stage.outputFingerprint !== undefined || stage.status !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Non-completed stages must omit output fingerprints and status.',
        path: ['state'],
      });
    }
  });

const refusalCodesSchema = z
  .array(z.enum(chainAnalysisRefusalCodes))
  .max(chainAnalysisRefusalCodes.length)
  .refine((values) => new Set(values).size === values.length, 'Refusal codes must be unique.');

export const inspectTransactionCapabilityResultSchema = z
  .object({
    capability: z.literal('chain.inspect_transaction'),
    chainId: evmChainIdSchema,
    executionEnrichmentStatus: z.enum(skillResultStatuses).optional(),
    executionStatus: z.enum(transactionExecutionStatuses),
    internalTransferCount: z.number().int().nonnegative().max(1_000),
    refusalCodes: refusalCodesSchema,
    status: z.enum(['success', 'partial', 'insufficient_data']),
    swapCount: z.number().int().nonnegative().max(1_000),
    tokenTransferCount: z.number().int().nonnegative().max(1_000),
    traceCoverage: z.enum(['available', 'invalid', 'mismatched', 'missing', 'not_provided']),
    transactionAnalysisStatus: z.enum(skillResultStatuses),
    transactionHash: evmHashSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === 'success' && result.refusalCodes.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Successful capability results cannot carry refusal codes.',
        path: ['refusalCodes'],
      });
    }
    if (result.status === 'insufficient_data' && result.refusalCodes.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Insufficient capability results require a refusal code.',
        path: ['refusalCodes'],
      });
    }
  });

const observationCoverageSchema = z
  .object({
    actorAssetDeltas: z.enum(['complete', 'partial']),
    blockTransactions: z.enum(['complete', 'partial']),
    poolStates: z.enum(['complete', 'partial']),
  })
  .strict();

export const detectSandwichCapabilityResultSchema = z
  .object({
    capability: z.literal('chain.detect_sandwich'),
    chainId: evmChainIdSchema,
    coreStatus: z.enum(skillResultStatuses).optional(),
    observationCoverage: observationCoverageSchema.optional(),
    observationStatus: z.enum(['success', 'partial', 'insufficient_data']).optional(),
    poolAddress: evmAddressSchema,
    priceImpactPpm: z
      .string()
      .regex(/^-?(?:0|[1-9]\d*)$/u)
      .optional(),
    refusalCodes: refusalCodesSchema,
    status: z.enum(['success', 'partial', 'insufficient_data']),
    transactionHash: evmHashSchema,
    verdict: z.enum(evmSandwichVerdicts).optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status !== 'insufficient_data' && result.verdict === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Usable sandwich capability results require a verdict.',
        path: ['verdict'],
      });
    }
    if (result.status === 'success' && result.refusalCodes.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Successful capability results cannot carry refusal codes.',
        path: ['refusalCodes'],
      });
    }
    if (result.status === 'insufficient_data' && result.refusalCodes.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Insufficient capability results require a refusal code.',
        path: ['refusalCodes'],
      });
    }
  });

export const chainAnalysisCapabilityResultSchema = z.discriminatedUnion('capability', [
  inspectTransactionCapabilityResultSchema,
  detectSandwichCapabilityResultSchema,
]);

const pipelineCoverageSchema = z
  .object({
    execution: z.enum(['complete', 'partial', 'not_provided']),
    mev: z.enum(['blocked', 'complete', 'not_requested', 'partial']),
    observation: z.enum(['complete', 'not_provided', 'partial']),
    providerCostUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    providerRequests: z.number().int().nonnegative().max(1_000_000),
    transaction: z.enum(['complete', 'missing', 'partial']),
  })
  .strict();

export const evmChainAnalysisPipelineResultSchema = createSkillResultSchema({
  capabilities: z.array(chainAnalysisCapabilityResultSchema).min(1).max(2),
  coverage: pipelineCoverageSchema,
  execution: evmExecutionEnrichmentResultSchema.optional(),
  inputFingerprint: fingerprintSchema,
  mev: evmPriceImpactSandwichResultSchema.optional(),
  observation: evmMevObservationDataAdapterResultSchema.optional(),
  replayFingerprint: fingerprintSchema,
  requests: z.array(chainAnalysisCapabilityRequestSchema).min(1).max(2),
  skill: z.literal(EVM_CHAIN_ANALYSIS_HARNESS_SKILL),
  stages: z.array(chainAnalysisStageSchema).length(chainAnalysisStageNames.length),
  transaction: transactionAnalysisResultSchema,
  version: z.literal(EVM_CHAIN_ANALYSIS_HARNESS_VERSION),
}).superRefine((result, context) => {
  if (
    result.stages.some((stage, index) => stage.name !== chainAnalysisStageNames[index]) ||
    new Set(result.stages.map((stage) => stage.name)).size !== chainAnalysisStageNames.length
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Pipeline stages must appear exactly once in canonical order.',
      path: ['stages'],
    });
  }
  if (
    result.capabilities.length !== result.requests.length ||
    result.capabilities.some(
      (capability, index) => capability.capability !== result.requests[index]?.capability,
    )
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Capability results must align with requested capability order.',
      path: ['capabilities'],
    });
  }
  const stageByName = new Map(result.stages.map((stage) => [stage.name, stage]));
  checkOptionalStage(result.execution, stageByName.get('execution'), 'execution', context);
  checkOptionalStage(result.observation, stageByName.get('observation'), 'observation', context);
  checkOptionalStage(result.mev, stageByName.get('mev'), 'mev', context);

  const expectedStatus = derivePipelineStatus(result.capabilities.map((item) => item.status));
  if (result.status !== expectedStatus) {
    context.addIssue({
      code: 'custom',
      message: `Pipeline status must be ${expectedStatus} for its capability results.`,
      path: ['status'],
    });
  }
  for (const [index, request] of result.requests.entries()) {
    const capability = result.capabilities[index];
    if (
      capability === undefined ||
      capability.chainId !== request.chainId ||
      capability.transactionHash !== request.transactionHash ||
      (request.capability === 'chain.detect_sandwich' &&
        capability.capability === 'chain.detect_sandwich' &&
        capability.poolAddress !== request.poolAddress)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Capability result identity must match its request.',
        path: ['capabilities', index],
      });
    }
  }
});

function checkOptionalStage(
  value: unknown,
  stage: z.output<typeof chainAnalysisStageSchema> | undefined,
  name: ChainAnalysisStageName,
  context: z.RefinementCtx,
): void {
  if (value !== undefined && stage?.state !== 'completed') {
    context.addIssue({
      code: 'custom',
      message: `${name} output requires a completed stage.`,
      path: [name],
    });
  }
  if (value === undefined && stage?.state === 'completed') {
    context.addIssue({
      code: 'custom',
      message: `Completed ${name} stage requires an output.`,
      path: [name],
    });
  }
}

function derivePipelineStatus(
  statuses: ReadonlyArray<'success' | 'partial' | 'insufficient_data'>,
): 'success' | 'partial' | 'insufficient_data' {
  if (statuses.every((status) => status === 'success')) {
    return 'success';
  }
  return statuses.some((status) => status !== 'insufficient_data')
    ? 'partial'
    : 'insufficient_data';
}

export type InspectTransactionCapabilityRequest = z.output<
  typeof inspectTransactionCapabilityRequestSchema
>;
export type DetectSandwichCapabilityRequest = z.output<
  typeof detectSandwichCapabilityRequestSchema
>;
export type ChainAnalysisCapabilityRequest = z.output<typeof chainAnalysisCapabilityRequestSchema>;
export type EvmChainAnalysisPipelineInput = z.output<typeof evmChainAnalysisPipelineInputSchema>;
export type ChainAnalysisStage = z.output<typeof chainAnalysisStageSchema>;
export type InspectTransactionCapabilityResult = z.output<
  typeof inspectTransactionCapabilityResultSchema
>;
export type DetectSandwichCapabilityResult = z.output<typeof detectSandwichCapabilityResultSchema>;
export type ChainAnalysisCapabilityResult = z.output<typeof chainAnalysisCapabilityResultSchema>;
export type EvmChainAnalysisPipelineResult = z.output<typeof evmChainAnalysisPipelineResultSchema>;

export function observationHasAnalysisInput(
  observation: EvmMevObservationDataAdapterResult | undefined,
): observation is EvmMevObservationDataAdapterResult & {
  analysisInput: NonNullable<EvmMevObservationDataAdapterResult['analysisInput']>;
} {
  return observation?.analysisInput !== undefined;
}
