import { z } from 'zod';

import { evmDecodedSwapSchema } from '@xxyy/evm-execution-enrichment-core';
import { createSkillResultSchema } from '@xxyy/shared';
import {
  EVM_UINT256_MAX,
  EVM_ZERO_ADDRESS,
  evmAddressSchema,
  evmChainIdSchema,
  evmHashSchema,
  evmSignedIntegerSchema,
  evmUintSchema,
} from '@xxyy/transaction-analysis-core';

export const EVM_PRICE_IMPACT_SANDWICH_SKILL = 'evm_price_impact_sandwich' as const;
export const EVM_PRICE_IMPACT_SANDWICH_VERSION = '1.0.0' as const;
export const FEE_PIPS_DENOMINATOR = 1_000_000;
export const UNISWAP_V2_FEE_PIPS = 3_000;
export const PARTS_PER_MILLION = 1_000_000n;
export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const MAX_NEIGHBORHOOD_TRANSACTIONS = 256;
export const MAX_ACTOR_ASSET_DELTAS = 16;
export const UINT160_MAX = (1n << 160n) - 1n;
export const UINT128_MAX = (1n << 128n) - 1n;
export const UINT112_MAX = (1n << 112n) - 1n;
export const UINT512_MAX = (1n << 512n) - 1n;
export const INT24_MIN = -(1n << 23n);
export const INT24_MAX = (1n << 23n) - 1n;

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'Expected a stable identifier.');

const payloadHashSchema = z
  .string()
  .trim()
  .regex(/^(?:0x[0-9a-fA-F]{64}|sha256:[0-9a-fA-F]{64})$/u)
  .transform((value) => value.toLowerCase());

export const evmMevFactSourceSchema = z
  .object({
    id: stableIdSchema,
    kind: z.enum(['rpc', 'indexer', 'explorer', 'fixture']),
    observedAt: z.string().datetime({ offset: true }),
    payloadHash: payloadHashSchema.optional(),
  })
  .strict();

const positiveUintSchema = evmUintSchema.refine((value) => BigInt(value) > 0n, {
  message: 'Expected a positive unsigned integer.',
});

const positiveWideUintSchema = z
  .string()
  .trim()
  .max(155)
  .regex(/^[1-9]\d*$/u, 'Expected a positive canonical integer.')
  .refine((value) => BigInt(value) <= UINT512_MAX, 'Value exceeds uint512.');

const uint160Schema = positiveUintSchema.refine((value) => BigInt(value) <= UINT160_MAX, {
  message: 'Value exceeds uint160.',
});

const uint128Schema = positiveUintSchema.refine((value) => BigInt(value) <= UINT128_MAX, {
  message: 'Value exceeds uint128.',
});

const uint112Schema = positiveUintSchema.refine((value) => BigInt(value) <= UINT112_MAX, {
  message: 'Value exceeds uint112.',
});

const signed256Schema = evmSignedIntegerSchema.refine((value) => {
  const parsed = BigInt(value);
  return parsed >= -EVM_UINT256_MAX && parsed <= EVM_UINT256_MAX;
}, 'Signed amount exceeds the bounded uint256 magnitude.');

const int24Schema = evmSignedIntegerSchema.refine((value) => {
  const parsed = BigInt(value);
  return parsed >= INT24_MIN && parsed <= INT24_MAX;
}, 'Value exceeds int24.');

export const evmV2PoolStateSchema = z
  .object({
    protocol: z.literal('uniswap_v2'),
    reserve0Raw: uint112Schema,
    reserve1Raw: uint112Schema,
    source: evmMevFactSourceSchema,
  })
  .strict();

export const evmV3PoolStateSchema = z
  .object({
    activeRangeLowerSqrtPriceX96: uint160Schema,
    activeRangeUpperSqrtPriceX96: uint160Schema,
    liquidity: uint128Schema,
    protocol: z.literal('uniswap_v3'),
    source: evmMevFactSourceSchema,
    sqrtPriceX96: uint160Schema,
    tick: int24Schema,
  })
  .strict()
  .superRefine((state, context) => {
    const lower = BigInt(state.activeRangeLowerSqrtPriceX96);
    const current = BigInt(state.sqrtPriceX96);
    const upper = BigInt(state.activeRangeUpperSqrtPriceX96);
    if (lower >= current || current >= upper) {
      context.addIssue({
        code: 'custom',
        message: 'V3 sqrt price must be strictly inside the supplied active range.',
        path: ['sqrtPriceX96'],
      });
    }
  });

export const evmMevPoolStateSchema = z.discriminatedUnion('protocol', [
  evmV2PoolStateSchema,
  evmV3PoolStateSchema,
]);

export const evmMevPoolSchema = z
  .object({
    chainId: evmChainIdSchema,
    feePips: z
      .number()
      .int()
      .positive()
      .max(FEE_PIPS_DENOMINATOR - 1),
    poolAddress: evmAddressSchema,
    protocol: z.enum(['uniswap_v2', 'uniswap_v3']),
    source: evmMevFactSourceSchema,
    token0: evmAddressSchema,
    token1: evmAddressSchema,
  })
  .strict()
  .superRefine((pool, context) => {
    if (pool.poolAddress === EVM_ZERO_ADDRESS) {
      context.addIssue({
        code: 'custom',
        message: 'Pool address cannot be zero.',
        path: ['poolAddress'],
      });
    }
    if (pool.token0 === EVM_ZERO_ADDRESS || pool.token1 === EVM_ZERO_ADDRESS) {
      context.addIssue({
        code: 'custom',
        message: 'Pool token addresses cannot be zero.',
        path: ['token0'],
      });
    }
    if (pool.token0 >= pool.token1) {
      context.addIssue({
        code: 'custom',
        message: 'Pool token addresses must be strictly sorted.',
        path: ['token1'],
      });
    }
    if (pool.protocol === 'uniswap_v2' && pool.feePips !== UNISWAP_V2_FEE_PIPS) {
      context.addIssue({
        code: 'custom',
        message: 'Uniswap V2 v0.1 only supports the canonical 3000 fee pips.',
        path: ['feePips'],
      });
    }
  });

export const evmActorAssetDeltaSchema = z
  .object({
    rawDelta: signed256Schema,
    tokenAddress: evmAddressSchema,
  })
  .strict()
  .refine((delta) => delta.rawDelta !== '0', {
    message: 'Zero actor asset deltas must be omitted.',
    path: ['rawDelta'],
  })
  .refine((delta) => delta.tokenAddress !== EVM_ZERO_ADDRESS, {
    message: 'Actor asset delta token cannot be zero.',
    path: ['tokenAddress'],
  });

export const evmMevSwapObservationSchema = z
  .object({
    actor: evmAddressSchema,
    actorAssetDeltas: z
      .array(evmActorAssetDeltaSchema)
      .max(MAX_ACTOR_ASSET_DELTAS)
      .refine(
        (deltas) => new Set(deltas.map((delta) => delta.tokenAddress)).size === deltas.length,
        'Actor asset delta tokens must be unique.',
      )
      .optional(),
    blockNumber: evmUintSchema,
    routeKind: z.enum(['single_pool', 'multi_hop', 'aggregator', 'unknown']),
    source: evmMevFactSourceSchema,
    stateAfter: evmMevPoolStateSchema,
    stateBefore: evmMevPoolStateSchema,
    swap: evmDecodedSwapSchema,
    swapMode: z.enum(['exact_input', 'exact_output', 'unknown']),
    tokenBehavior: z.enum(['standard', 'fee_on_transfer', 'rebase', 'unknown']),
    transactionHash: evmHashSchema,
    transactionIndex: z.number().int().nonnegative().max(1_000_000),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.actor === EVM_ZERO_ADDRESS) {
      context.addIssue({
        code: 'custom',
        message: 'Observation actor cannot be zero.',
        path: ['actor'],
      });
    }
    if (
      observation.stateBefore.protocol !== observation.swap.protocol ||
      observation.stateAfter.protocol !== observation.swap.protocol
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Swap and pool state protocols must match.',
        path: ['stateBefore', 'protocol'],
      });
    }
    for (const [field, value] of [
      ['amount0PoolDeltaRaw', observation.swap.amount0PoolDeltaRaw],
      ['amount1PoolDeltaRaw', observation.swap.amount1PoolDeltaRaw],
    ] as const) {
      if (BigInt(value) < -EVM_UINT256_MAX || BigInt(value) > EVM_UINT256_MAX) {
        context.addIssue({
          code: 'custom',
          message: 'Swap pool delta exceeds the bounded uint256 magnitude.',
          path: ['swap', field],
        });
      }
    }
  });

export const evmMevConflictFields = [
  'actor_asset_deltas',
  'actor_identity',
  'block_transactions',
  'pool_metadata',
  'pool_state',
  'swap',
] as const;

export const evmMevSourceConflictSchema = z
  .object({
    field: z.enum(evmMevConflictFields),
    sourceIds: z
      .array(stableIdSchema)
      .min(2)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length, 'Conflict source ids must be unique.'),
    subject: z.union([evmAddressSchema, evmHashSchema, stableIdSchema]),
  })
  .strict();

export const evmMevCoverageSchema = z
  .object({
    actorAssetDeltas: z.enum(['complete', 'partial']),
    blockTransactions: z.enum(['complete', 'partial']),
    poolStates: z.enum(['complete', 'partial']),
  })
  .strict();

export const evmPriceImpactSandwichInputSchema = z
  .object({
    neighborhood: z
      .object({
        blockNumber: evmUintSchema,
        conflicts: z.array(evmMevSourceConflictSchema).max(100).default([]),
        coverage: evmMevCoverageSchema,
        observations: z
          .array(evmMevSwapObservationSchema)
          .min(1)
          .max(MAX_NEIGHBORHOOD_TRANSACTIONS),
        source: evmMevFactSourceSchema,
      })
      .strict(),
    pool: evmMevPoolSchema,
    targetTransactionHash: evmHashSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const hashes = new Set<string>();
    const indexes = new Set<number>();
    let targetCount = 0;
    for (const [index, observation] of input.neighborhood.observations.entries()) {
      if (hashes.has(observation.transactionHash)) {
        context.addIssue({
          code: 'custom',
          message: 'Neighborhood transaction hashes must be unique in v0.1.',
          path: ['neighborhood', 'observations', index, 'transactionHash'],
        });
      }
      hashes.add(observation.transactionHash);
      if (indexes.has(observation.transactionIndex)) {
        context.addIssue({
          code: 'custom',
          message: 'Neighborhood transaction indexes must be unique.',
          path: ['neighborhood', 'observations', index, 'transactionIndex'],
        });
      }
      indexes.add(observation.transactionIndex);
      if (observation.transactionHash === input.targetTransactionHash) {
        targetCount += 1;
      }
      if (observation.blockNumber !== input.neighborhood.blockNumber) {
        context.addIssue({
          code: 'custom',
          message: 'Observation block must match the neighborhood block.',
          path: ['neighborhood', 'observations', index, 'blockNumber'],
        });
      }
      const swap = observation.swap;
      if (
        swap.poolAddress !== input.pool.poolAddress ||
        swap.protocol !== input.pool.protocol ||
        swap.token0 !== input.pool.token0 ||
        swap.token1 !== input.pool.token1
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Observed swap must match the configured pool identity.',
          path: ['neighborhood', 'observations', index, 'swap'],
        });
      }
      if (
        input.neighborhood.coverage.actorAssetDeltas === 'complete' &&
        observation.actorAssetDeltas === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Complete actor delta coverage requires deltas for every observation.',
          path: ['neighborhood', 'observations', index, 'actorAssetDeltas'],
        });
      }
    }
    if (targetCount !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Target transaction must appear exactly once in the neighborhood.',
        path: ['targetTransactionHash'],
      });
    }
  });

const evidenceIdsSchema = z
  .array(stableIdSchema)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'Evidence ids must be unique.');

export const evmRationalSchema = z
  .object({
    denominator: positiveWideUintSchema,
    numerator: positiveWideUintSchema,
  })
  .strict();

export const evmPriceImpactSchema = z
  .object({
    amountInRaw: positiveUintSchema,
    amountOutRaw: positiveUintSchema,
    direction: z.enum(['token0_to_token1', 'token1_to_token0']),
    evidenceIds: evidenceIdsSchema,
    executionPrice: evmRationalSchema,
    expectedAmountOutRaw: positiveUintSchema,
    model: z.enum(['uniswap_v2_exact_input', 'uniswap_v3_single_range_exact_input']),
    priceImpactPpm: evmSignedIntegerSchema,
    spotPriceBefore: evmRationalSchema,
  })
  .strict();

export const evmSandwichVerdicts = [
  'confirmed',
  'likely',
  'unlikely',
  'insufficient_data',
] as const;

export const evmSandwichReasonCodes = [
  'actor_asset_loop_verified',
  'actor_deltas_contradict_loop',
  'actor_deltas_missing',
  'actor_mismatch',
  'attacker_not_profitable',
  'bracketing_direction_mismatch',
  'counterfactual_victim_loss',
  'implied_asset_loop_profitable',
  'neighborhood_incomplete',
  'no_adjacent_bracketing_transactions',
  'pool_state_discontinuity',
  'quote_mismatch',
  'source_conflict',
  'target_not_adversely_affected',
  'unsupported_observation',
] as const;

export const evmSandwichAssessmentSchema = z
  .object({
    assetLoopVerified: z.boolean(),
    attacker: evmAddressSchema.optional(),
    attackerProfitRaw: evmUintSchema.optional(),
    backTransactionHash: evmHashSchema.optional(),
    counterfactualAmountOutRaw: evmUintSchema.optional(),
    evidenceIds: evidenceIdsSchema,
    frontTransactionHash: evmHashSchema.optional(),
    intermediateRemainderRaw: evmUintSchema.optional(),
    profitToken: evmAddressSchema.optional(),
    reasonCodes: z
      .array(z.enum(evmSandwichReasonCodes))
      .min(1)
      .max(evmSandwichReasonCodes.length)
      .refine((codes) => new Set(codes).size === codes.length, 'Reason codes must be unique.'),
    verdict: z.enum(evmSandwichVerdicts),
    victimLossPpm: evmUintSchema.optional(),
    victimLossRaw: evmUintSchema.optional(),
  })
  .strict()
  .superRefine((assessment, context) => {
    const candidateFields = [
      assessment.attacker,
      assessment.attackerProfitRaw,
      assessment.backTransactionHash,
      assessment.counterfactualAmountOutRaw,
      assessment.frontTransactionHash,
      assessment.intermediateRemainderRaw,
      assessment.profitToken,
      assessment.victimLossPpm,
      assessment.victimLossRaw,
    ];
    if (assessment.verdict === 'confirmed' || assessment.verdict === 'likely') {
      if (candidateFields.some((value) => value === undefined)) {
        context.addIssue({
          code: 'custom',
          message: 'Confirmed and likely verdicts require complete candidate metrics.',
          path: ['verdict'],
        });
      }
      if (assessment.victimLossRaw === '0' || assessment.attackerProfitRaw === '0') {
        context.addIssue({
          code: 'custom',
          message: 'Positive victim loss and attacker profit are required.',
          path: ['victimLossRaw'],
        });
      }
    }
    if (assessment.verdict === 'confirmed' && !assessment.assetLoopVerified) {
      context.addIssue({
        code: 'custom',
        message: 'Confirmed verdicts require a verified actor asset loop.',
        path: ['assetLoopVerified'],
      });
    }
    if (assessment.verdict !== 'confirmed' && assessment.assetLoopVerified) {
      context.addIssue({
        code: 'custom',
        message: 'Only confirmed verdicts may claim a verified actor asset loop.',
        path: ['assetLoopVerified'],
      });
    }
    if (
      (assessment.verdict === 'unlikely' || assessment.verdict === 'insufficient_data') &&
      candidateFields.some((value) => value !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unlikely and insufficient verdicts must omit candidate metrics.',
        path: ['verdict'],
      });
    }
  });

const resultCoverageSchema = z
  .object({
    actorAssetDeltas: z.enum(['complete', 'partial']),
    blockTransactions: z.enum(['complete', 'partial']),
    conflicts: z.number().int().nonnegative().max(100),
    observations: z.number().int().positive().max(MAX_NEIGHBORHOOD_TRANSACTIONS),
    poolStates: z.enum(['complete', 'partial']),
    quote: z.enum(['available', 'invalid', 'unsupported']),
    supportedObservations: z.number().int().nonnegative().max(MAX_NEIGHBORHOOD_TRANSACTIONS),
  })
  .strict();

const targetSchema = z
  .object({
    blockNumber: evmUintSchema,
    chainId: evmChainIdSchema,
    poolAddress: evmAddressSchema,
    transactionHash: evmHashSchema,
    transactionIndex: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();

export const evmPriceImpactSandwichResultSchema = createSkillResultSchema({
  coverage: resultCoverageSchema,
  priceImpact: evmPriceImpactSchema.optional(),
  sandwich: evmSandwichAssessmentSchema,
  skill: z.literal(EVM_PRICE_IMPACT_SANDWICH_SKILL),
  target: targetSchema,
  version: z.literal(EVM_PRICE_IMPACT_SANDWICH_VERSION),
}).superRefine((result, context) => {
  const evidenceIds = new Set(result.evidence.map((evidence) => evidence.id));
  const checkEvidenceIds = (ids: readonly string[], path: string[]) => {
    for (const [index, id] of ids.entries()) {
      if (!evidenceIds.has(id)) {
        context.addIssue({
          code: 'custom',
          message: `Result references unknown evidence: ${id}`,
          path: [...path, index],
        });
      }
    }
  };
  if (result.priceImpact !== undefined) {
    checkEvidenceIds(result.priceImpact.evidenceIds, ['priceImpact', 'evidenceIds']);
  }
  checkEvidenceIds(result.sandwich.evidenceIds, ['sandwich', 'evidenceIds']);

  if (
    result.sandwich.verdict === 'confirmed' &&
    result.status !== 'success' &&
    result.status !== 'partial'
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'Confirmed sandwich results must be successful or locally confirmed with partial coverage.',
      path: ['status'],
    });
  }
  if (result.sandwich.verdict === 'likely' && result.status !== 'partial') {
    context.addIssue({
      code: 'custom',
      message: 'Likely sandwich results must be partial.',
      path: ['status'],
    });
  }
  if (result.sandwich.verdict === 'unlikely' && result.status !== 'success') {
    context.addIssue({
      code: 'custom',
      message: 'Unlikely sandwich results require complete successful coverage.',
      path: ['status'],
    });
  }
  if (
    result.sandwich.verdict === 'insufficient_data' &&
    result.status !== (result.priceImpact === undefined ? 'insufficient_data' : 'partial')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Insufficient sandwich status must reflect whether price impact is available.',
      path: ['status'],
    });
  }
  if ((result.priceImpact === undefined) !== (result.coverage.quote !== 'available')) {
    context.addIssue({
      code: 'custom',
      message: 'Quote coverage must match price impact availability.',
      path: ['coverage', 'quote'],
    });
  }
});

export type EvmMevFactSource = z.output<typeof evmMevFactSourceSchema>;
export type EvmV2PoolState = z.output<typeof evmV2PoolStateSchema>;
export type EvmV3PoolState = z.output<typeof evmV3PoolStateSchema>;
export type EvmMevPoolState = z.output<typeof evmMevPoolStateSchema>;
export type EvmMevPool = z.output<typeof evmMevPoolSchema>;
export type EvmActorAssetDelta = z.output<typeof evmActorAssetDeltaSchema>;
export type EvmMevSwapObservation = z.output<typeof evmMevSwapObservationSchema>;
export type EvmMevSourceConflict = z.output<typeof evmMevSourceConflictSchema>;
export type EvmMevCoverage = z.output<typeof evmMevCoverageSchema>;
export type EvmPriceImpactSandwichInput = z.output<typeof evmPriceImpactSandwichInputSchema>;
export type EvmRational = z.output<typeof evmRationalSchema>;
export type EvmPriceImpact = z.output<typeof evmPriceImpactSchema>;
export type EvmSandwichVerdict = (typeof evmSandwichVerdicts)[number];
export type EvmSandwichReasonCode = (typeof evmSandwichReasonCodes)[number];
export type EvmSandwichAssessment = z.output<typeof evmSandwichAssessmentSchema>;
export type EvmPriceImpactSandwichResult = z.output<typeof evmPriceImpactSandwichResultSchema>;
