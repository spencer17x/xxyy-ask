import type { ChainDataAdapterKind } from '@xxyy/evm-chain-analysis-readiness';

import {
  productionDataPlaneManifestSchema,
  type ProductionDataPlaneManifest,
  type ProductionProviderBinding,
} from './contracts.js';
import { ProductionDataPlaneError } from './errors.js';

export interface ProductionSecretResolver {
  resolve(secretRef: string): Promise<string>;
}

export interface ResolvedProductionProvider {
  adapter: ChainDataAdapterKind;
  binding: ProductionProviderBinding;
  endpoint: string;
  headers: Record<string, string>;
}

export async function resolveProductionProviders(
  manifestInput: unknown,
  secretResolver: ProductionSecretResolver,
  options: { allowInsecureLocalhost?: boolean } = {},
): Promise<{
  manifest: ProductionDataPlaneManifest;
  providers: ResolvedProductionProvider[];
}> {
  const manifest = productionDataPlaneManifestSchema.parse(manifestInput);
  const providers = await Promise.all(
    manifest.providers.map(async (binding): Promise<ResolvedProductionProvider> => {
      try {
        const endpointValue = await secretResolver.resolve(binding.descriptor.endpointSecretRef);
        const endpoint = parseEndpoint(
          endpointValue,
          options.allowInsecureLocalhost ?? false,
        ).toString();
        const headerEntries: Array<readonly [string, string]> = await Promise.all(
          binding.credentialHeaders.map(async (header) => {
            const value = parseHeaderValue(await secretResolver.resolve(header.secretRef));
            return [header.name, value] as const;
          }),
        );
        const headers: Record<string, string> = Object.fromEntries(headerEntries);
        return {
          adapter: binding.descriptor.adapter,
          binding,
          endpoint,
          headers,
        };
      } catch (cause) {
        if (cause instanceof ProductionDataPlaneError) {
          throw cause;
        }
        throw new ProductionDataPlaneError(
          'secret_unavailable',
          `Secret resolution failed for ${binding.descriptor.adapter}/${binding.descriptor.providerId}.`,
          { cause },
        );
      }
    }),
  );
  for (const adapter of ['execution', 'mev_observation', 'snapshot'] as const) {
    const endpoints = providers
      .filter((provider) => provider.adapter === adapter)
      .map((provider) => provider.endpoint);
    if (new Set(endpoints).size !== endpoints.length) {
      throw new ProductionDataPlaneError(
        'invalid_configuration',
        `Resolved ${adapter} providers cannot share an endpoint.`,
      );
    }
  }
  return { manifest, providers };
}

function parseEndpoint(value: string, allowInsecureLocalhost: boolean): URL {
  if (value !== value.trim() || value.length === 0 || value.length > 2_048) {
    throw new ProductionDataPlaneError(
      'secret_unavailable',
      'Resolved provider endpoint has an invalid shape.',
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause) {
    throw new ProductionDataPlaneError(
      'secret_unavailable',
      'Resolved provider endpoint is not an absolute URL.',
      { cause },
    );
  }
  const isAllowedLocalhost =
    allowInsecureLocalhost &&
    endpoint.protocol === 'http:' &&
    (endpoint.hostname === '127.0.0.1' ||
      endpoint.hostname === '::1' ||
      endpoint.hostname === '[::1]' ||
      endpoint.hostname === 'localhost');
  if (endpoint.protocol !== 'https:' && !isAllowedLocalhost) {
    throw new ProductionDataPlaneError(
      'secret_unavailable',
      'Production provider endpoints must use HTTPS.',
    );
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0 || endpoint.hash.length > 0) {
    throw new ProductionDataPlaneError(
      'secret_unavailable',
      'Provider endpoints cannot contain URL credentials or fragments.',
    );
  }
  return endpoint;
}

function parseHeaderValue(value: string): string {
  if (
    value.length === 0 ||
    value.length > 8_192 ||
    value !== value.trim() ||
    /[\r\n]/u.test(value)
  ) {
    throw new ProductionDataPlaneError(
      'secret_unavailable',
      'Resolved provider credential has an invalid shape.',
    );
  }
  return value;
}
