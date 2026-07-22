import { z } from 'zod';

import { evmRpcProviderConfigSchema, evmRpcProviderIdSchema } from '@xxyy/evm-data-adapter';
import {
  MAX_NEIGHBORHOOD_TRANSACTIONS,
  UNISWAP_V2_FEE_PIPS,
  evmMevConflictFields,
  evmPriceImpactSandwichInputSchema,
} from '@xxyy/evm-price-impact-sandwich-core';
import {
  EVM_ZERO_ADDRESS,
  evmAddressSchema,
  evmChainIdSchema,
  evmHashSchema,
} from '@xxyy/transaction-analysis-core';

export const EVM_MEV_OBSERVATION_DATA_ADAPTER_VERSION = '0.1.0' as const;
export const MAX_MEV_OBSERVATION_PROVIDERS = 4;
export const MAX_CONFIGURED_MEV_POOLS_PER_CHAIN = 64;
export const MAX_EXACT_INPUT_ROUTE_POLICIES = 32;
export const MAX_EXACT_INPUT_SELECTORS_PER_ROUTE = 32;
export const ABSOLUTE_MAX_BLOCK_TRANSACTIONS = 1_024;
export const ABSOLUTE_MAX_POOL_LOGS = 2_048;
export const ABSOLUTE_MAX_RELEVANT_TRANSACTIONS = MAX_NEIGHBORHOOD_TRANSACTIONS;
export const ABSOLUTE_MAX_RECEIPT_LOGS = 500;
export const ABSOLUTE_MAX_TICK_BITMAP_WORDS_PER_SIDE = 32;

export const mevObservationRpcOperations = [
  'block',
  'chain_id',
  'parent_block',
  'pool_logs',
  'receipt',
  'target_transaction',
  'v2_reserves',
  'v3_liquidity',
  'v3_slot0',
  'v3_tick',
  'v3_tick_bitmap',
  'v3_tick_spacing',
] as const;

export const mevObservationRpcMethods = [
  'eth_call',
  'eth_chainId',
  'eth_getBlockByHash',
  'eth_getLogs',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
] as const;

export const evmMevObservationDiagnosticCodes = [
  'actor_delta_invalid',
  'archive_state_unavailable',
  'block_not_found',
  'block_parent_mismatch',
  'block_transaction_limit_exceeded',
  'block_transaction_mismatch',
  'chain_id_mismatch',
  'chain_id_unavailable',
  'circuit_open',
  'end_state_mismatch',
  'http_error',
  'invalid_block_payload',
  'invalid_chain_id_payload',
  'invalid_json',
  'invalid_jsonrpc',
  'invalid_pool_logs_payload',
  'invalid_receipt_payload',
  'invalid_state_payload',
  'invalid_transaction_payload',
  'local_concurrency_limit',
  'local_rate_limit',
  'multiple_pool_swaps_per_transaction',
  'pool_log_block_mismatch',
  'pool_log_transaction_mismatch',
  'pool_logs_limit_exceeded',
  'pool_logs_mismatch',
  'receipt_block_mismatch',
  'receipt_logs_limit_exceeded',
  'receipt_not_found',
  'receipt_reverted',
  'reorg_detected',
  'request_timeout',
  'response_too_large',
  'rpc_error',
  'state_call_failed',
  'swap_decode_failed',
  'target_not_found',
  'target_pool_swap_not_found',
  'tick_bitmap_limit_exceeded',
  'tick_range_unavailable',
  'transaction_count_mismatch',
  'transport_error',
  'unsupported_pool_event',
  'unsupported_v3_tick_crossing',
] as const;

export type MevObservationRpcOperation = (typeof mevObservationRpcOperations)[number];
export type MevObservationRpcMethod = (typeof mevObservationRpcMethods)[number];
export type EvmMevObservationDiagnosticCode = (typeof evmMevObservationDiagnosticCodes)[number];

const bytes4Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/u, 'Expected a four-byte selector.')
  .transform((value) => value.toLowerCase());

export const evmMevObservationProviderConfigSchema = evmRpcProviderConfigSchema.extend({
  archive: z.literal(true),
  costUnitsPerRequest: z.number().int().nonnegative().max(1_000_000).default(1),
});

export const evmExactInputRoutePolicySchema = z
  .object({
    selectors: z
      .array(bytes4Schema)
      .min(1)
      .max(MAX_EXACT_INPUT_SELECTORS_PER_ROUTE)
      .refine((selectors) => new Set(selectors).size === selectors.length, {
        message: 'Route selectors must be unique.',
      }),
    to: evmAddressSchema,
  })
  .strict()
  .refine((policy) => policy.to !== EVM_ZERO_ADDRESS, {
    message: 'Route target cannot be the zero address.',
    path: ['to'],
  });

export const evmMevPoolAllowlistEntrySchema = z
  .object({
    exactInputRoutes: z
      .array(evmExactInputRoutePolicySchema)
      .max(MAX_EXACT_INPUT_ROUTE_POLICIES)
      .refine((routes) => new Set(routes.map((route) => route.to)).size === routes.length, {
        message: 'Exact-input route targets must be unique.',
      })
      .default([]),
    feePips: z.number().int().positive().max(999_999),
    poolAddress: evmAddressSchema,
    protocol: z.enum(['uniswap_v2', 'uniswap_v3']),
    token0: evmAddressSchema,
    token1: evmAddressSchema,
    tokenBehavior: z.literal('standard'),
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
        message: 'Pool tokens must be strictly address-sorted.',
        path: ['token1'],
      });
    }
    if (pool.protocol === 'uniswap_v2' && pool.feePips !== UNISWAP_V2_FEE_PIPS) {
      context.addIssue({
        code: 'custom',
        message: 'Uniswap V2 only supports the canonical 3000 fee pips.',
        path: ['feePips'],
      });
    }
  });

export const evmMevObservationChainConfigSchema = z
  .object({
    chainId: evmChainIdSchema,
    pools: z
      .array(evmMevPoolAllowlistEntrySchema)
      .min(1)
      .max(MAX_CONFIGURED_MEV_POOLS_PER_CHAIN)
      .refine((pools) => new Set(pools.map((pool) => pool.poolAddress)).size === pools.length, {
        message: 'Configured pool addresses must be unique.',
      }),
    providers: z
      .array(evmMevObservationProviderConfigSchema)
      .min(1)
      .max(MAX_MEV_OBSERVATION_PROVIDERS)
      .refine(
        (providers) => new Set(providers.map((provider) => provider.id)).size === providers.length,
        { message: 'Provider ids must be unique within a chain.' },
      ),
  })
  .strict();

export const evmMevObservationDataAdapterConfigSchema = z
  .array(evmMevObservationChainConfigSchema)
  .min(1)
  .max(64)
  .refine((chains) => new Set(chains.map((chain) => chain.chainId)).size === chains.length, {
    message: 'Chain ids must be unique.',
  });

export const loadEvmMevObservationInputSchema = z
  .object({
    chainId: evmChainIdSchema,
    poolAddress: evmAddressSchema,
    providerIds: z
      .array(evmRpcProviderIdSchema)
      .min(1)
      .max(MAX_MEV_OBSERVATION_PROVIDERS)
      .refine((providerIds) => new Set(providerIds).size === providerIds.length, {
        message: 'Provider ids must be unique.',
      })
      .optional(),
    targetTransactionHash: evmHashSchema,
  })
  .strict()
  .refine((input) => input.poolAddress !== EVM_ZERO_ADDRESS, {
    message: 'Pool address cannot be zero.',
    path: ['poolAddress'],
  });

const payloadHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, 'Expected a SHA-256 fingerprint.');

const usageSchema = z
  .object({
    cacheHits: z.number().int().nonnegative().max(100_000),
    costUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requests: z.number().int().nonnegative().max(100_000),
    responseBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    rpcCalls: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();

export const evmMevObservationProviderSummarySchema = z
  .object({
    blockHash: evmHashSchema.optional(),
    fingerprint: payloadHashSchema.optional(),
    providerId: evmRpcProviderIdSchema,
    status: z.enum(['success', 'insufficient_data']),
    usage: usageSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.status === 'success' &&
      (summary.blockHash === undefined || summary.fingerprint === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Successful provider summaries require block and input fingerprints.',
        path: ['status'],
      });
    }
    if (
      summary.status === 'insufficient_data' &&
      (summary.blockHash !== undefined || summary.fingerprint !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Insufficient provider summaries must omit canonical fingerprints.',
        path: ['status'],
      });
    }
  });

const conflictObservationSchema = z
  .object({
    fingerprint: payloadHashSchema,
    providerId: evmRpcProviderIdSchema,
  })
  .strict();

export const evmMevObservationConflictSchema = z
  .object({
    field: z.enum(evmMevConflictFields),
    observations: z
      .array(conflictObservationSchema)
      .min(2)
      .max(MAX_MEV_OBSERVATION_PROVIDERS)
      .refine(
        (observations) =>
          new Set(observations.map((observation) => observation.providerId)).size ===
          observations.length,
        'Conflict observations require unique providers.',
      )
      .refine(
        (observations) =>
          new Set(observations.map((observation) => observation.fingerprint)).size >= 2,
        'Conflict observations require distinct fingerprints.',
      ),
    subject: z.union([evmAddressSchema, evmHashSchema]),
  })
  .strict();

export const evmMevObservationDiagnosticSchema = z
  .object({
    attempts: z.number().int().positive().max(4).optional(),
    code: z.enum(evmMevObservationDiagnosticCodes),
    httpStatus: z.number().int().min(100).max(599).optional(),
    operation: z.enum(mevObservationRpcOperations).optional(),
    providerId: evmRpcProviderIdSchema.optional(),
    retryable: z.boolean(),
    rpcCode: z.number().int().optional(),
    transactionHash: evmHashSchema.optional(),
  })
  .strict();

const coverageSchema = z
  .object({
    actorAssetDeltas: z.enum(['complete', 'partial']),
    blockTransactions: z.enum(['complete', 'partial']),
    poolStates: z.enum(['complete', 'partial']),
    providersRequested: z.number().int().positive().max(MAX_MEV_OBSERVATION_PROVIDERS),
    providersSucceeded: z.number().int().nonnegative().max(MAX_MEV_OBSERVATION_PROVIDERS),
  })
  .strict()
  .refine((coverage) => coverage.providersSucceeded <= coverage.providersRequested, {
    message: 'Succeeded provider count cannot exceed requested providers.',
    path: ['providersSucceeded'],
  });

export const evmMevObservationDataAdapterResultSchema = z
  .object({
    analysisInput: evmPriceImpactSandwichInputSchema.optional(),
    conflicts: z.array(evmMevObservationConflictSchema).max(evmMevConflictFields.length),
    coverage: coverageSchema,
    diagnostics: z.array(evmMevObservationDiagnosticSchema).max(5_000),
    providers: z
      .array(evmMevObservationProviderSummarySchema)
      .min(1)
      .max(MAX_MEV_OBSERVATION_PROVIDERS),
    status: z.enum(['success', 'partial', 'insufficient_data']),
    usage: usageSchema,
    version: z.literal(EVM_MEV_OBSERVATION_DATA_ADAPTER_VERSION),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.providers.length !== result.coverage.providersRequested) {
      context.addIssue({
        code: 'custom',
        message: 'Provider summaries must match requested provider coverage.',
        path: ['providers'],
      });
    }
    const successfulProviders = result.providers.filter(
      (provider) => provider.status === 'success',
    ).length;
    if (successfulProviders !== result.coverage.providersSucceeded) {
      context.addIssue({
        code: 'custom',
        message: 'Provider summaries must match succeeded provider coverage.',
        path: ['coverage', 'providersSucceeded'],
      });
    }
    if (result.analysisInput !== undefined) {
      const inputCoverage = result.analysisInput.neighborhood.coverage;
      if (
        inputCoverage.actorAssetDeltas !== result.coverage.actorAssetDeltas ||
        inputCoverage.blockTransactions !== result.coverage.blockTransactions ||
        inputCoverage.poolStates !== result.coverage.poolStates
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Adapter coverage must match the emitted analysis input.',
          path: ['coverage'],
        });
      }
      const inputConflicts = result.analysisInput.neighborhood.conflicts;
      if (
        inputConflicts.length !== result.conflicts.length ||
        result.conflicts.some((conflict, index) => {
          const inputConflict = inputConflicts[index];
          return (
            inputConflict === undefined ||
            inputConflict.field !== conflict.field ||
            inputConflict.subject !== conflict.subject ||
            inputConflict.sourceIds.join('\n') !==
              conflict.observations.map((observation) => observation.providerId).join('\n')
          );
        })
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Adapter conflicts must be projected into the analysis input.',
          path: ['analysisInput', 'neighborhood', 'conflicts'],
        });
      }
    }
    if (result.status === 'success') {
      if (
        result.analysisInput === undefined ||
        result.diagnostics.length > 0 ||
        result.conflicts.length > 0 ||
        result.coverage.providersSucceeded !== result.coverage.providersRequested ||
        result.coverage.actorAssetDeltas !== 'complete' ||
        result.coverage.blockTransactions !== 'complete' ||
        result.coverage.poolStates !== 'complete'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Successful results require complete conflict-free observations.',
          path: ['status'],
        });
      }
    }
    if (result.status === 'insufficient_data' && result.analysisInput !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Insufficient results cannot expose an analysis input.',
        path: ['status'],
      });
    }
    if (result.status !== 'insufficient_data' && result.analysisInput === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Usable results require an analysis input.',
        path: ['analysisInput'],
      });
    }
  });

export type EvmMevObservationProviderConfig = z.output<
  typeof evmMevObservationProviderConfigSchema
>;
export type EvmExactInputRoutePolicy = z.output<typeof evmExactInputRoutePolicySchema>;
export type EvmMevPoolAllowlistEntry = z.output<typeof evmMevPoolAllowlistEntrySchema>;
export type EvmMevObservationChainConfig = z.output<typeof evmMevObservationChainConfigSchema>;
export type LoadEvmMevObservationInput = z.output<typeof loadEvmMevObservationInputSchema>;
export type EvmMevObservationProviderSummary = z.output<
  typeof evmMevObservationProviderSummarySchema
>;
export type EvmMevObservationConflict = z.output<typeof evmMevObservationConflictSchema>;
export type EvmMevObservationDiagnostic = z.output<typeof evmMevObservationDiagnosticSchema>;
export type EvmMevObservationDataAdapterResult = z.output<
  typeof evmMevObservationDataAdapterResultSchema
>;
export type EvmMevObservationUsage = z.output<typeof usageSchema>;
