import {
  evmPriceImpactSandwichInputSchema,
  type EvmPriceImpactSandwichInput,
} from '@xxyy/evm-price-impact-sandwich-core';

import {
  ABSOLUTE_MAX_BLOCK_TRANSACTIONS,
  ABSOLUTE_MAX_POOL_LOGS,
  ABSOLUTE_MAX_RECEIPT_LOGS,
  ABSOLUTE_MAX_RELEVANT_TRANSACTIONS,
  ABSOLUTE_MAX_TICK_BITMAP_WORDS_PER_SIDE,
  EVM_MEV_OBSERVATION_DATA_ADAPTER_VERSION,
  evmMevObservationDataAdapterConfigSchema,
  evmMevObservationDataAdapterResultSchema,
  loadEvmMevObservationInputSchema,
  type EvmMevObservationChainConfig,
  type EvmMevObservationConflict,
  type EvmMevObservationDataAdapterResult,
  type EvmMevObservationProviderConfig,
  type EvmMevObservationProviderSummary,
  type EvmMevObservationUsage,
  type EvmMevPoolAllowlistEntry,
  type LoadEvmMevObservationInput,
} from './contracts.js';
import { EvmMevObservationConfigurationError } from './errors.js';
import {
  createObservationJsonRpcClient,
  type CreateObservationJsonRpcClientOptions,
  type ObservationJsonRpcClient,
  type ObservationRpcMetricEvent,
} from './observation-json-rpc-client.js';
import {
  loadProviderObservation,
  type ProviderComponentFingerprints,
  type ProviderObservation,
  type ProviderObservationLimits,
} from './provider-observation.js';

const DEFAULT_MAX_BLOCK_TRANSACTIONS = 512;
const DEFAULT_MAX_POOL_LOGS = 512;
const DEFAULT_MAX_RECEIPT_LOGS = 500;
const DEFAULT_MAX_RELEVANT_TRANSACTIONS = 64;
const DEFAULT_MAX_TICK_BITMAP_WORDS_PER_SIDE = 8;
const DEFAULT_MAX_RPC_BATCH_SIZE = 32;

interface ConfiguredProvider {
  client: ObservationJsonRpcClient;
  config: EvmMevObservationProviderConfig;
}

interface ConfiguredChain {
  config: EvmMevObservationChainConfig;
  pools: Map<string, EvmMevPoolAllowlistEntry>;
  providers: ConfiguredProvider[];
}

export interface EvmMevObservationDataAdapter {
  listConfiguredChains(): Array<{
    chainId: string;
    pools: Array<{ poolAddress: string; protocol: 'uniswap_v2' | 'uniswap_v3' }>;
    providerIds: string[];
  }>;
  loadObservation(
    input: LoadEvmMevObservationInput,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<EvmMevObservationDataAdapterResult>;
}

export interface CreateEvmMevObservationDataAdapterOptions extends Omit<
  CreateObservationJsonRpcClientOptions,
  'onMetric' | 'provider'
> {
  chains: readonly EvmMevObservationChainConfig[];
  maxBlockTransactions?: number;
  maxPoolLogs?: number;
  maxReceiptLogs?: number;
  maxRelevantTransactions?: number;
  maxTickBitmapWordsPerSide?: number;
  now?: () => Date;
  onMetric?: (event: ObservationRpcMetricEvent) => void;
}

export function createEvmMevObservationDataAdapter(
  options: CreateEvmMevObservationDataAdapterOptions,
): EvmMevObservationDataAdapter {
  let chainConfigs: EvmMevObservationChainConfig[];
  try {
    chainConfigs = evmMevObservationDataAdapterConfigSchema.parse(options.chains);
  } catch (cause) {
    throw new EvmMevObservationConfigurationError(
      'invalid_configuration',
      'MEV observation data adapter configuration is invalid.',
      { cause },
    );
  }

  const maxRpcBatchSize = boundedInteger(
    options.maxBatchSize,
    DEFAULT_MAX_RPC_BATCH_SIZE,
    7,
    256,
    'maxBatchSize',
  );
  const limits: ProviderObservationLimits = {
    maxBlockTransactions: boundedInteger(
      options.maxBlockTransactions,
      DEFAULT_MAX_BLOCK_TRANSACTIONS,
      1,
      ABSOLUTE_MAX_BLOCK_TRANSACTIONS,
      'maxBlockTransactions',
    ),
    maxPoolLogs: boundedInteger(
      options.maxPoolLogs,
      DEFAULT_MAX_POOL_LOGS,
      1,
      ABSOLUTE_MAX_POOL_LOGS,
      'maxPoolLogs',
    ),
    maxReceiptLogs: boundedInteger(
      options.maxReceiptLogs,
      DEFAULT_MAX_RECEIPT_LOGS,
      1,
      ABSOLUTE_MAX_RECEIPT_LOGS,
      'maxReceiptLogs',
    ),
    maxRelevantTransactions: boundedInteger(
      options.maxRelevantTransactions,
      DEFAULT_MAX_RELEVANT_TRANSACTIONS,
      1,
      ABSOLUTE_MAX_RELEVANT_TRANSACTIONS,
      'maxRelevantTransactions',
    ),
    maxRpcBatchSize,
    maxTickBitmapWordsPerSide: boundedInteger(
      options.maxTickBitmapWordsPerSide,
      DEFAULT_MAX_TICK_BITMAP_WORDS_PER_SIDE,
      0,
      ABSOLUTE_MAX_TICK_BITMAP_WORDS_PER_SIDE,
      'maxTickBitmapWordsPerSide',
    ),
  };
  const now = options.now ?? (() => new Date());
  const configuredChains = new Map<string, ConfiguredChain>();

  for (const chain of chainConfigs) {
    configuredChains.set(chain.chainId, {
      config: chain,
      pools: new Map(chain.pools.map((pool) => [pool.poolAddress, pool])),
      providers: chain.providers.map((provider) => ({
        client: createObservationJsonRpcClient({
          ...(options.allowInsecureLocalhost === undefined
            ? {}
            : { allowInsecureLocalhost: options.allowInsecureLocalhost }),
          ...(options.cacheTtlMs === undefined ? {} : { cacheTtlMs: options.cacheTtlMs }),
          ...(options.circuitFailureThreshold === undefined
            ? {}
            : { circuitFailureThreshold: options.circuitFailureThreshold }),
          ...(options.circuitOpenMs === undefined ? {} : { circuitOpenMs: options.circuitOpenMs }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          maxBatchSize: maxRpcBatchSize,
          ...(options.maxCacheEntries === undefined
            ? {}
            : { maxCacheEntries: options.maxCacheEntries }),
          ...(options.maxConcurrentRequests === undefined
            ? {}
            : { maxConcurrentRequests: options.maxConcurrentRequests }),
          ...(options.maxRequestsPerWindow === undefined
            ? {}
            : { maxRequestsPerWindow: options.maxRequestsPerWindow }),
          ...(options.maxResponseBytes === undefined
            ? {}
            : { maxResponseBytes: options.maxResponseBytes }),
          ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
          ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
          ...(options.onMetric === undefined ? {} : { onMetric: options.onMetric }),
          provider,
          ...(options.rateWindowMs === undefined ? {} : { rateWindowMs: options.rateWindowMs }),
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
          ...(options.retryBaseDelayMs === undefined
            ? {}
            : { retryBaseDelayMs: options.retryBaseDelayMs }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        }),
        config: provider,
      })),
    });
  }

  return {
    listConfiguredChains() {
      return chainConfigs.map((chain) => ({
        chainId: chain.chainId,
        pools: chain.pools.map((pool) => ({
          poolAddress: pool.poolAddress,
          protocol: pool.protocol,
        })),
        providerIds: chain.providers.map((provider) => provider.id),
      }));
    },

    async loadObservation(rawInput, loadOptions = {}) {
      let input: LoadEvmMevObservationInput;
      try {
        input = loadEvmMevObservationInputSchema.parse(rawInput);
      } catch (cause) {
        throw new EvmMevObservationConfigurationError(
          'invalid_configuration',
          'MEV observation request is invalid.',
          { cause },
        );
      }
      const chain = configuredChains.get(input.chainId);
      if (chain === undefined) {
        throw new EvmMevObservationConfigurationError(
          'chain_not_configured',
          `EVM chain ${input.chainId} is not configured for MEV observations.`,
        );
      }
      const pool = chain.pools.get(input.poolAddress);
      if (pool === undefined) {
        throw new EvmMevObservationConfigurationError(
          'pool_not_configured',
          `EVM pool ${input.poolAddress} is not configured for MEV observations.`,
        );
      }
      const providers = selectProviders(chain.providers, input.providerIds);
      const observedAt = createObservedAt(now);
      const observations = await Promise.all(
        providers.map((provider) =>
          loadProviderObservation({
            chainId: input.chainId,
            client: provider.client,
            limits,
            observedAt,
            pool,
            provider: provider.config,
            signal: loadOptions.signal,
            targetTransactionHash: input.targetTransactionHash,
          }),
        ),
      );

      return coordinateObservations({
        observations,
        poolAddress: pool.poolAddress,
        targetTransactionHash: input.targetTransactionHash,
      });
    },
  };
}

function coordinateObservations(input: {
  observations: readonly ProviderObservation[];
  poolAddress: string;
  targetTransactionHash: string;
}): EvmMevObservationDataAdapterResult {
  const canonical = input.observations.find(
    (
      observation,
    ): observation is ProviderObservation & {
      analysisInput: EvmPriceImpactSandwichInput;
      blockHash: string;
      components: ProviderComponentFingerprints;
      fingerprint: string;
    } =>
      observation.analysisInput !== undefined &&
      observation.blockHash !== undefined &&
      observation.components !== undefined &&
      observation.fingerprint !== undefined,
  );
  const conflicts = collectConflicts(input);
  const analysisInput =
    canonical === undefined ? undefined : projectConflicts(canonical.analysisInput, conflicts);
  const diagnostics = input.observations.flatMap((observation) => observation.diagnostics);
  const providers = input.observations.map(providerSummary);
  const usage = sumUsage(input.observations.map((observation) => observation.usage));
  const providersSucceeded = providers.filter((provider) => provider.status === 'success').length;
  const coverage = {
    actorAssetDeltas: analysisInput?.neighborhood.coverage.actorAssetDeltas ?? ('partial' as const),
    blockTransactions:
      analysisInput?.neighborhood.coverage.blockTransactions ?? ('partial' as const),
    poolStates: analysisInput?.neighborhood.coverage.poolStates ?? ('partial' as const),
    providersRequested: providers.length,
    providersSucceeded,
  };
  const complete =
    analysisInput !== undefined &&
    diagnostics.length === 0 &&
    conflicts.length === 0 &&
    providersSucceeded === providers.length &&
    coverage.actorAssetDeltas === 'complete' &&
    coverage.blockTransactions === 'complete' &&
    coverage.poolStates === 'complete';

  return evmMevObservationDataAdapterResultSchema.parse({
    ...(analysisInput === undefined ? {} : { analysisInput }),
    conflicts,
    coverage,
    diagnostics,
    providers,
    status: complete ? 'success' : analysisInput === undefined ? 'insufficient_data' : 'partial',
    usage,
    version: EVM_MEV_OBSERVATION_DATA_ADAPTER_VERSION,
  });
}

function collectConflicts(input: {
  observations: readonly ProviderObservation[];
  poolAddress: string;
  targetTransactionHash: string;
}): EvmMevObservationConflict[] {
  const successful = input.observations.filter(
    (
      observation,
    ): observation is ProviderObservation & {
      components: ProviderComponentFingerprints;
    } => observation.components !== undefined,
  );
  const definitions = [
    ['block_transactions', 'blockTransactions', input.targetTransactionHash],
    ['swap', 'swap', input.targetTransactionHash],
    ['pool_state', 'poolState', input.poolAddress],
    ['actor_asset_deltas', 'actorAssetDeltas', input.targetTransactionHash],
  ] as const;
  const conflicts: EvmMevObservationConflict[] = [];
  for (const [field, component, subject] of definitions) {
    const values = successful.map((observation) => ({
      fingerprint: observation.components[component],
      providerId: observation.providerId,
    }));
    if (new Set(values.map((value) => value.fingerprint)).size >= 2) {
      conflicts.push({ field, observations: values, subject });
    }
  }
  return conflicts;
}

function projectConflicts(
  analysisInput: EvmPriceImpactSandwichInput,
  conflicts: readonly EvmMevObservationConflict[],
): EvmPriceImpactSandwichInput {
  return evmPriceImpactSandwichInputSchema.parse({
    ...analysisInput,
    neighborhood: {
      ...analysisInput.neighborhood,
      conflicts: conflicts.map((conflict) => ({
        field: conflict.field,
        sourceIds: conflict.observations.map((observation) => observation.providerId),
        subject: conflict.subject,
      })),
    },
  });
}

function providerSummary(observation: ProviderObservation): EvmMevObservationProviderSummary {
  return observation.analysisInput === undefined ||
    observation.blockHash === undefined ||
    observation.fingerprint === undefined
    ? {
        providerId: observation.providerId,
        status: 'insufficient_data',
        usage: observation.usage,
      }
    : {
        blockHash: observation.blockHash,
        fingerprint: observation.fingerprint,
        providerId: observation.providerId,
        status: 'success',
        usage: observation.usage,
      };
}

function selectProviders(
  providers: readonly ConfiguredProvider[],
  providerIds: readonly string[] | undefined,
): ConfiguredProvider[] {
  if (providerIds === undefined) {
    return [...providers];
  }
  const selected = new Set(providerIds);
  for (const providerId of selected) {
    if (!providers.some((provider) => provider.config.id === providerId)) {
      throw new EvmMevObservationConfigurationError(
        'provider_not_configured',
        `MEV observation provider ${providerId} is not configured for the selected chain.`,
      );
    }
  }
  return providers.filter((provider) => selected.has(provider.config.id));
}

function sumUsage(values: readonly EvmMevObservationUsage[]): EvmMevObservationUsage {
  return values.reduce(
    (total, value) => ({
      cacheHits: total.cacheHits + value.cacheHits,
      costUnits: total.costUnits + value.costUnits,
      requests: total.requests + value.requests,
      responseBytes: total.responseBytes + value.responseBytes,
      rpcCalls: total.rpcCalls + value.rpcCalls,
    }),
    { cacheHits: 0, costUnits: 0, requests: 0, responseBytes: 0, rpcCalls: 0 },
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new EvmMevObservationConfigurationError(
      'invalid_limits',
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return normalized;
}

function createObservedAt(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new EvmMevObservationConfigurationError(
      'invalid_configuration',
      'MEV observation adapter clock returned an invalid date.',
    );
  }
  return value.toISOString();
}
