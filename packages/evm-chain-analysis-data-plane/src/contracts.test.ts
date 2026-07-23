import { describe, expect, it } from 'vitest';

import { createProviderBudgetPolicy } from '@xxyy/evm-chain-analysis-readiness';

import {
  createDataPlaneManifestFixture,
  createProviderBinding,
  testHash,
} from './fixtures.test-helper.js';
import {
  productionDataPlaneManifestInputSchema,
  productionDataPlaneManifestSchema,
} from './contracts.js';
import { resolveProductionProviders } from './secret-resolver.js';

describe('production data-plane configuration', () => {
  it('requires two independent approved providers for every adapter', () => {
    const manifest = createDataPlaneManifestFixture();
    expect(productionDataPlaneManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.manifestId).toBe(
      `production_data_plane_manifest_${manifest.manifestFingerprint.slice(7)}`,
    );
    expect(
      productionDataPlaneManifestSchema.safeParse({
        ...manifest,
        transport: {
          ...manifest.transport,
          snapshot: { ...manifest.transport.snapshot, cacheTtlMs: 1 },
        },
      }).success,
    ).toBe(false);
    expect(
      productionDataPlaneManifestSchema.safeParse({
        ...manifest,
        providers: manifest.providers.slice(1),
      }).success,
    ).toBe(false);

    const duplicateDomain = createProviderBinding('snapshot', 'secondary', manifest.ownerIdHash);
    expect(
      productionDataPlaneManifestSchema.safeParse({
        ...manifest,
        providers: manifest.providers.map((provider) =>
          provider.descriptor.adapter === 'snapshot' &&
          provider.descriptor.providerId.endsWith('secondary')
            ? {
                ...duplicateDomain,
                failureDomainHash:
                  manifest.providers.find(
                    (candidate) =>
                      candidate.descriptor.adapter === 'snapshot' &&
                      candidate.descriptor.providerId.endsWith('primary'),
                  )?.failureDomainHash ?? testHash('missing'),
              }
            : provider,
        ),
      }).success,
    ).toBe(false);
  });

  it('resolves only opaque secrets and rejects converged provider endpoints', async () => {
    const manifest = createDataPlaneManifestFixture();
    const secrets = new Map<string, string>();
    for (const provider of manifest.providers) {
      secrets.set(
        provider.descriptor.endpointSecretRef,
        `https://${provider.descriptor.providerId}.rpc.invalid/v1`,
      );
      for (const header of provider.credentialHeaders) {
        secrets.set(header.secretRef, `Bearer ${provider.descriptor.providerId}`);
      }
    }
    const resolved = await resolveProductionProviders(manifest, {
      resolve(secretRef) {
        const value = secrets.get(secretRef);
        if (value === undefined) {
          return Promise.reject(new Error('missing'));
        }
        return Promise.resolve(value);
      },
    });
    expect(resolved.providers).toHaveLength(6);
    expect(JSON.stringify(manifest)).not.toContain('https://');

    const snapshotProviders = manifest.providers.filter(
      (provider) => provider.descriptor.adapter === 'snapshot',
    );
    for (const provider of snapshotProviders) {
      secrets.set(provider.descriptor.endpointSecretRef, 'https://same.rpc.invalid/v1');
    }
    await expect(
      resolveProductionProviders(manifest, {
        resolve(secretRef) {
          return Promise.resolve(secrets.get(secretRef) ?? '');
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
  });

  it('requires every budget lease to outlive one request and settlement grace period', () => {
    const manifest = createDataPlaneManifestFixture();
    const snapshotProvider = manifest.providers.find(
      (provider) => provider.descriptor.adapter === 'snapshot',
    );
    expect(snapshotProvider).toBeDefined();
    const shortPolicy = createProviderBudgetPolicy({
      adapter: 'snapshot',
      budgetId: snapshotProvider?.budgetPolicy.budgetId ?? 'missing',
      chainId: '1',
      leaseTtlSeconds: 10,
      maxConcurrentLeases: 8,
      maxCostUnits: 1_000,
      maxRequests: 1_000,
      maxResponseBytes: 100_000_000,
      maxRpcCalls: 10_000,
      providerId: snapshotProvider?.descriptor.providerId ?? 'missing',
      windowSeconds: 60,
    });
    const parsed = productionDataPlaneManifestInputSchema.safeParse({
      chainId: manifest.chainId,
      createdAt: manifest.createdAt,
      executionFactories: manifest.executionFactories,
      mevPools: manifest.mevPools,
      ownerIdHash: manifest.ownerIdHash,
      providers: manifest.providers.map((provider) =>
        provider === snapshotProvider ? { ...provider, budgetPolicy: shortPolicy } : provider,
      ),
      transport: manifest.transport,
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.success
        ? []
        : parsed.error.issues
            .map((issue) => issue.message)
            .filter((message) => /lease/u.test(message)),
    ).not.toHaveLength(0);
  });
});
