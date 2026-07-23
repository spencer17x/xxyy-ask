import { describe, expect, it } from 'vitest';

import type { ProductionProviderControls } from './managed-fetch.js';
import { createProductionChainDataPlane } from './data-plane.js';
import {
  createDataPlaneManifestFixture,
  createProviderBinding,
  testHash,
} from './fixtures.test-helper.js';
import type { ResolvedProductionProvider } from './secret-resolver.js';

describe('production chain data-plane composition', () => {
  it('requires every resolved binding and header set to match the approved manifest', () => {
    const manifest = createDataPlaneManifestFixture();
    const providers = resolvedProviders(manifest.providers);
    const controls = unavailableControls();

    expect(
      createProductionChainDataPlane({
        controls,
        instanceIdHash: testHash('runtime'),
        manifest,
        providers,
      }).manifest,
    ).toEqual(manifest);

    expect(() =>
      createProductionChainDataPlane({
        controls,
        instanceIdHash: testHash('runtime'),
        manifest,
        providers: providers.map((provider, index) =>
          index === 0
            ? {
                ...provider,
                binding: createProviderBinding(
                  provider.adapter,
                  'primary',
                  testHash('different-owner'),
                ),
              }
            : provider,
        ),
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));

    expect(() =>
      createProductionChainDataPlane({
        controls,
        instanceIdHash: testHash('runtime'),
        manifest,
        providers: providers.map((provider, index) =>
          index === 0
            ? { ...provider, headers: { ...provider.headers, 'x-unapproved': 'secret' } }
            : provider,
        ),
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
  });
});

function resolvedProviders(
  bindings: ReturnType<typeof createDataPlaneManifestFixture>['providers'],
): ResolvedProductionProvider[] {
  return bindings.map((binding) => ({
    adapter: binding.descriptor.adapter,
    binding,
    endpoint: `https://${binding.descriptor.providerId}.rpc.invalid/v1`,
    headers: Object.fromEntries(
      binding.credentialHeaders.map((header) => [header.name, 'Bearer secret']),
    ),
  }));
}

function unavailableControls(): ProductionProviderControls {
  const unavailable = () => Promise.reject(new Error('not invoked'));
  return {
    compareAndSet: unavailable,
    completeProviderRequest: unavailable,
    read: unavailable,
    recordProviderRequest: unavailable,
    reserve: unavailable,
    settle: unavailable,
  };
}
