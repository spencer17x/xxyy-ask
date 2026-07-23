import {
  createSharedProviderCircuitState,
  type ChainDataAdapterKind,
} from '@xxyy/evm-chain-analysis-readiness';
import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import {
  createEvmDataAdapter,
  type EvmDataAdapter,
  type EvmRpcProviderConfig,
} from '@xxyy/evm-data-adapter';
import {
  createEvmExecutionDataAdapter,
  type EvmExecutionDataAdapter,
} from '@xxyy/evm-execution-data-adapter';
import {
  createEvmMevObservationDataAdapter,
  type EvmMevObservationDataAdapter,
} from '@xxyy/evm-mev-observation-data-adapter';

import type { ProviderResponseCache } from './cache.js';
import {
  productionDataPlaneManifestSchema,
  type ProductionDataPlaneManifest,
  type ProductionProviderBinding,
} from './contracts.js';
import { ProductionDataPlaneError } from './errors.js';
import {
  createManagedProviderFetch,
  type ProductionDataPlaneAlert,
  type ProductionDataPlaneMetric,
  type ProductionProviderControls,
} from './managed-fetch.js';
import type { ResolvedProductionProvider } from './secret-resolver.js';

export interface ProductionChainDataPlane {
  execution: EvmExecutionDataAdapter;
  manifest: ProductionDataPlaneManifest;
  mevObservation: EvmMevObservationDataAdapter;
  snapshot: EvmDataAdapter;
}

export function createProductionChainDataPlane(options: {
  alertSink?: ((alert: ProductionDataPlaneAlert) => void | Promise<void>) | undefined;
  allowInsecureLocalhost?: boolean | undefined;
  cache?: ProviderResponseCache | undefined;
  controls: ProductionProviderControls;
  fetchImpl?: typeof fetch | undefined;
  instanceIdHash: string;
  manifest: unknown;
  metricSink?: ((metric: ProductionDataPlaneMetric) => void | Promise<void>) | undefined;
  now?: (() => string) | undefined;
  nowMs?: (() => number) | undefined;
  providers: readonly ResolvedProductionProvider[];
}): ProductionChainDataPlane {
  const manifest = productionDataPlaneManifestSchema.parse(options.manifest);
  assertResolvedProviderSet(manifest, options.providers);
  const providersByAdapter = new Map<ChainDataAdapterKind, ResolvedProductionProvider[]>();
  for (const adapter of ['execution', 'mev_observation', 'snapshot'] as const) {
    const providers = options.providers.filter(
      (provider) =>
        provider.adapter === adapter && provider.binding.descriptor.chainId === manifest.chainId,
    );
    if (providers.length !== 2) {
      throw new ProductionDataPlaneError(
        'invalid_configuration',
        `Resolved ${adapter} production providers are incomplete.`,
      );
    }
    providersByAdapter.set(adapter, providers);
  }
  const managedFetch = (adapter: ChainDataAdapterKind) =>
    createManagedProviderFetch({
      adapter,
      ...(options.alertSink === undefined ? {} : { alertSink: options.alertSink }),
      ...(options.allowInsecureLocalhost === undefined
        ? {}
        : { allowInsecureLocalhost: options.allowInsecureLocalhost }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      chainId: manifest.chainId,
      controls: options.controls,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      instanceIdHash: options.instanceIdHash,
      ...(options.metricSink === undefined ? {} : { metricSink: options.metricSink }),
      manifestFingerprint: manifest.manifestFingerprint,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      providers: providersByAdapter.get(adapter) ?? [],
      transport: manifest.transport[adapter],
    });
  const snapshotProviders = adapterProviderConfigs(providersByAdapter.get('snapshot') ?? []);
  const executionProviders = adapterProviderConfigs(providersByAdapter.get('execution') ?? []);
  const mevProviders = (providersByAdapter.get('mev_observation') ?? []).map((provider) => ({
    archive: true as const,
    costUnitsPerRequest: provider.binding.costUnitsPerRequest,
    endpoint: provider.endpoint,
    headers: provider.headers,
    id: provider.binding.descriptor.providerId,
  }));

  return {
    execution: createEvmExecutionDataAdapter({
      ...(options.allowInsecureLocalhost === undefined
        ? {}
        : { allowInsecureLocalhost: options.allowInsecureLocalhost }),
      chains: [
        {
          chainId: manifest.chainId,
          factories: manifest.executionFactories,
          providers: executionProviders,
        },
      ],
      fetchImpl: managedFetch('execution'),
      maxResponseBytes: manifest.transport.execution.maxResponseBytes,
      maxRetries: manifest.transport.execution.maxRetries,
      requestTimeoutMs: manifest.transport.execution.requestTimeoutMs,
    }),
    manifest,
    mevObservation: createEvmMevObservationDataAdapter({
      ...(options.allowInsecureLocalhost === undefined
        ? {}
        : { allowInsecureLocalhost: options.allowInsecureLocalhost }),
      cacheTtlMs: 0,
      chains: [
        {
          chainId: manifest.chainId,
          pools: manifest.mevPools,
          providers: mevProviders,
        },
      ],
      circuitFailureThreshold: 100,
      fetchImpl: managedFetch('mev_observation'),
      maxCacheEntries: 0,
      maxResponseBytes: manifest.transport.mev_observation.maxResponseBytes,
      maxRetries: manifest.transport.mev_observation.maxRetries,
      requestTimeoutMs: manifest.transport.mev_observation.requestTimeoutMs,
    }),
    snapshot: createEvmDataAdapter({
      ...(options.allowInsecureLocalhost === undefined
        ? {}
        : { allowInsecureLocalhost: options.allowInsecureLocalhost }),
      chains: [{ chainId: manifest.chainId, providers: snapshotProviders }],
      fetchImpl: managedFetch('snapshot'),
      maxResponseBytes: manifest.transport.snapshot.maxResponseBytes,
      maxRetries: manifest.transport.snapshot.maxRetries,
      requestTimeoutMs: manifest.transport.snapshot.requestTimeoutMs,
    }),
  };
}

function assertResolvedProviderSet(
  manifest: ProductionDataPlaneManifest,
  providers: readonly ResolvedProductionProvider[],
): void {
  if (providers.length !== manifest.providers.length) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Resolved production providers do not cover the approved manifest.',
    );
  }
  const approved = new Map(
    manifest.providers.map((binding) => [
      providerBindingIdentity(binding),
      sha256Fingerprint(binding),
    ]),
  );
  const seen = new Set<string>();
  for (const provider of providers) {
    const identity = providerBindingIdentity(provider.binding);
    const expectedHeaderNames = provider.binding.credentialHeaders
      .map((header) => header.name)
      .sort();
    const actualHeaderNames = Object.keys(provider.headers)
      .map((name) => name.toLowerCase())
      .sort();
    if (
      seen.has(identity) ||
      provider.adapter !== provider.binding.descriptor.adapter ||
      provider.binding.descriptor.chainId !== manifest.chainId ||
      approved.get(identity) !== sha256Fingerprint(provider.binding) ||
      actualHeaderNames.length !== expectedHeaderNames.length ||
      actualHeaderNames.some((name, index) => name !== expectedHeaderNames[index])
    ) {
      throw new ProductionDataPlaneError(
        'invalid_configuration',
        'Resolved production provider lineage does not match the approved manifest.',
      );
    }
    seen.add(identity);
  }
}

function providerBindingIdentity(binding: ProductionProviderBinding): string {
  return `${binding.descriptor.adapter}:${binding.descriptor.providerId}`;
}

export async function bootstrapProductionProviderControls(options: {
  actorIdHash: string;
  bootstrappedAt: string;
  controls: ProductionProviderControls & {
    initializeCircuit(input: { actorIdHash: string; state: unknown }): Promise<unknown>;
    installBudgetPolicy(input: {
      actorIdHash: string;
      expectedPolicyFingerprint?: string;
      installedAt: string;
      policy: unknown;
    }): Promise<unknown>;
  };
  manifest: unknown;
}): Promise<void> {
  const manifest = productionDataPlaneManifestSchema.parse(options.manifest);
  for (const provider of manifest.providers) {
    await options.controls.installBudgetPolicy({
      actorIdHash: options.actorIdHash,
      installedAt: options.bootstrappedAt,
      policy: provider.budgetPolicy,
    });
    await options.controls.initializeCircuit({
      actorIdHash: options.actorIdHash,
      state: createSharedProviderCircuitState({
        adapter: provider.descriptor.adapter,
        chainId: provider.descriptor.chainId,
        consecutiveFailures: 0,
        generation: 0,
        lastTransitionReason: 'production_bootstrap',
        providerId: provider.descriptor.providerId,
        state: 'closed',
        updatedAt: options.bootstrappedAt,
      }),
    });
  }
}

function adapterProviderConfigs(
  providers: readonly ResolvedProductionProvider[],
): EvmRpcProviderConfig[] {
  return providers.map((provider) => ({
    endpoint: provider.endpoint,
    headers: provider.headers,
    id: provider.binding.descriptor.providerId,
  }));
}
