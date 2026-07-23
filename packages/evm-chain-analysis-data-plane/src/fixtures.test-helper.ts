import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import {
  createProviderBudgetPolicy,
  createProviderDeploymentDescriptor,
  type ChainDataAdapterKind,
} from '@xxyy/evm-chain-analysis-readiness';

import {
  createProductionDataPlaneManifest,
  fingerprintProviderRuntimeConfiguration,
  type ProductionDataPlaneManifest,
  type ProductionProviderBinding,
} from './contracts.js';

export function testHash(value: string): string {
  return sha256Fingerprint({ fixture: value });
}

export function createDataPlaneManifestFixture(): ProductionDataPlaneManifest {
  const ownerIdHash = testHash('owner');
  return createProductionDataPlaneManifest({
    chainId: '1',
    createdAt: '2026-07-23T00:00:00.000Z',
    executionFactories: {
      uniswapV2: ['0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'],
      uniswapV3: ['0x1F98431c8aD98523631AE4a59f267346ea31F984'],
    },
    mevPools: [
      {
        exactInputRoutes: [],
        feePips: 3_000,
        poolAddress: '0x0000000000000000000000000000000000000003',
        protocol: 'uniswap_v2',
        token0: '0x0000000000000000000000000000000000000001',
        token1: '0x0000000000000000000000000000000000000002',
        tokenBehavior: 'standard',
      },
    ],
    ownerIdHash,
    providers: (['execution', 'mev_observation', 'snapshot'] as const).flatMap((adapter) => [
      createProviderBinding(adapter, 'primary', ownerIdHash),
      createProviderBinding(adapter, 'secondary', ownerIdHash),
    ]),
    transport: {
      execution: transportFixture(),
      mev_observation: transportFixture(),
      snapshot: transportFixture(),
    },
  });
}

export function createProviderBinding(
  adapter: ChainDataAdapterKind,
  suffix: string,
  ownerIdHash = testHash('owner'),
): ProductionProviderBinding {
  const providerId = `${adapter}_${suffix}`;
  const endpointSecretRef = `secretref:providers/${adapter}/${suffix}/endpoint`;
  const credentialHeaders = [
    {
      name: 'authorization',
      secretRef: `secretref:providers/${adapter}/${suffix}/authorization`,
    },
  ];
  const draftDescriptor = createProviderDeploymentDescriptor({
    adapter,
    approvedAt: '2026-07-22T00:00:00.000Z',
    approvedByHashes: [ownerIdHash],
    archiveRequired: adapter === 'mev_observation',
    chainId: '1',
    configurationFingerprint: testHash('placeholder'),
    credentialSecretRefs: credentialHeaders.map((header) => header.secretRef),
    enabled: true,
    endpointSecretRef,
    providerId,
    region: suffix === 'primary' ? 'region_a' : 'region_b',
  });
  const common = {
    costUnitsPerRequest: 1,
    credentialHeaders,
    failureDomainHash: testHash(`${adapter}-${suffix}-failure-domain`),
    organizationHash: testHash(`${adapter}-${suffix}-organization`),
  };
  const configurationFingerprint = fingerprintProviderRuntimeConfiguration({
    ...common,
    descriptor: draftDescriptor,
  });
  const descriptor = createProviderDeploymentDescriptor({
    adapter,
    approvedAt: draftDescriptor.approvedAt,
    approvedByHashes: draftDescriptor.approvedByHashes,
    archiveRequired: draftDescriptor.archiveRequired,
    chainId: draftDescriptor.chainId,
    configurationFingerprint,
    credentialSecretRefs: draftDescriptor.credentialSecretRefs,
    enabled: true,
    endpointSecretRef: draftDescriptor.endpointSecretRef,
    providerId: draftDescriptor.providerId,
    region: draftDescriptor.region,
  });
  return {
    budgetPolicy: createProviderBudgetPolicy({
      adapter,
      budgetId: `budget.${adapter}.${suffix}`,
      chainId: '1',
      leaseTtlSeconds: 60,
      maxConcurrentLeases: 8,
      maxCostUnits: 1_000,
      maxRequests: 1_000,
      maxResponseBytes: 100_000_000,
      maxRpcCalls: 10_000,
      providerId,
      windowSeconds: 60,
    }),
    ...common,
    descriptor,
  };
}

function transportFixture() {
  return {
    cacheTtlMs: 30_000,
    circuitFailureThreshold: 2,
    circuitOpenMs: 30_000,
    maxResponseBytes: 1_048_576,
    maxRetries: 1,
    requestTimeoutMs: 10_000,
  };
}
