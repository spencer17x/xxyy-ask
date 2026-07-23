import { z } from 'zod';

import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import {
  providerBudgetPolicySchema,
  providerDeploymentDescriptorSchema,
} from '@xxyy/evm-chain-analysis-readiness';
import { evmExecutionFactoryAllowlistSchema } from '@xxyy/evm-execution-data-adapter';
import { evmMevPoolAllowlistEntrySchema } from '@xxyy/evm-mev-observation-data-adapter';

export const EVM_CHAIN_ANALYSIS_DATA_PLANE_VERSION = '0.1.0' as const;
export const PRODUCTION_CHAIN_ID = '1' as const;
export const REQUIRED_PROVIDERS_PER_ADAPTER = 2 as const;
const MINIMUM_SETTLEMENT_GRACE_MS = 5_000;

const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)
  .transform((value) => value.toLowerCase());
const forbiddenHeaders = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'proxy-authorization',
  'transfer-encoding',
]);

export const providerCredentialHeaderSchema = z
  .object({
    name: headerNameSchema,
    secretRef: z.string(),
  })
  .strict()
  .superRefine((header, context) => {
    if (forbiddenHeaders.has(header.name)) {
      context.addIssue({
        code: 'custom',
        message: `Header is controlled by the adapter: ${header.name}`,
        path: ['name'],
      });
    }
  });

const providerBindingCoreSchema = z
  .object({
    budgetPolicy: providerBudgetPolicySchema,
    costUnitsPerRequest: z.number().int().positive().max(1_000_000),
    credentialHeaders: z.array(providerCredentialHeaderSchema).max(8),
    descriptor: providerDeploymentDescriptorSchema,
    failureDomainHash: fingerprintSchema,
    organizationHash: fingerprintSchema,
  })
  .strict();

export const productionProviderBindingSchema = providerBindingCoreSchema.superRefine(
  (binding, context) => {
    const { budgetPolicy: policy, descriptor } = binding;
    if (
      policy.adapter !== descriptor.adapter ||
      policy.chainId !== descriptor.chainId ||
      policy.providerId !== descriptor.providerId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Provider descriptor and budget policy identities must match.',
        path: ['budgetPolicy'],
      });
    }
    if (!descriptor.enabled) {
      context.addIssue({
        code: 'custom',
        message: 'Production provider bindings must be enabled.',
        path: ['descriptor', 'enabled'],
      });
    }
    const names = binding.credentialHeaders.map((header) => header.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        message: 'Credential header names must be unique.',
        path: ['credentialHeaders'],
      });
    }
    const mappedRefs = [...binding.credentialHeaders.map((header) => header.secretRef)].sort();
    const descriptorRefs = [...descriptor.credentialSecretRefs].sort();
    if (
      mappedRefs.length !== descriptorRefs.length ||
      mappedRefs.some((value, index) => value !== descriptorRefs[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Every approved credential secret reference must map to exactly one header.',
        path: ['credentialHeaders'],
      });
    }
    if (descriptorRefs.includes(descriptor.endpointSecretRef)) {
      context.addIssue({
        code: 'custom',
        message: 'Provider endpoint and credential secret references must be disjoint.',
        path: ['descriptor', 'endpointSecretRef'],
      });
    }
    const expectedFingerprint = fingerprintProviderRuntimeConfiguration(binding);
    if (descriptor.configurationFingerprint !== expectedFingerprint) {
      context.addIssue({
        code: 'custom',
        message: 'Provider configuration fingerprint does not cover the public runtime binding.',
        path: ['descriptor', 'configurationFingerprint'],
      });
    }
  },
);

export const adapterTransportConfigurationSchema = z
  .object({
    cacheTtlMs: z.number().int().nonnegative().max(300_000),
    circuitFailureThreshold: z.number().int().positive().max(100),
    circuitOpenMs: z.number().int().positive().max(600_000),
    maxResponseBytes: z.number().int().positive().max(33_554_432),
    maxRetries: z.number().int().nonnegative().max(3),
    requestTimeoutMs: z.number().int().positive().max(120_000),
  })
  .strict();

const productionDataPlaneManifestCoreShape = {
  chainId: z.literal(PRODUCTION_CHAIN_ID),
  createdAt: z.string().datetime({ offset: true }),
  executionFactories: evmExecutionFactoryAllowlistSchema,
  mevPools: z.array(evmMevPoolAllowlistEntrySchema).min(1).max(256),
  ownerIdHash: fingerprintSchema,
  providers: z.array(productionProviderBindingSchema).length(6),
  transport: z
    .object({
      execution: adapterTransportConfigurationSchema,
      mev_observation: adapterTransportConfigurationSchema,
      snapshot: adapterTransportConfigurationSchema,
    })
    .strict(),
} as const;

export const productionDataPlaneManifestInputSchema = z
  .object(productionDataPlaneManifestCoreShape)
  .strict()
  .superRefine(addManifestIssues);

export const productionDataPlaneManifestSchema = z
  .object({
    ...productionDataPlaneManifestCoreShape,
    manifestFingerprint: fingerprintSchema,
    manifestId: z.string().regex(/^production_data_plane_manifest_[0-9a-f]{64}$/u),
    version: z.literal(EVM_CHAIN_ANALYSIS_DATA_PLANE_VERSION),
  })
  .strict()
  .superRefine((manifest, context) => {
    addManifestIssues(manifest, context);
    if (
      manifest.manifestId !==
      `production_data_plane_manifest_${manifest.manifestFingerprint.slice(7)}`
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Production data-plane manifest id must be content-addressed.',
        path: ['manifestId'],
      });
    }
    const { manifestFingerprint, manifestId: _manifestId, ...fingerprintPayload } = manifest;
    if (manifestFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Production data-plane manifest fingerprint must cover the full configuration.',
        path: ['manifestFingerprint'],
      });
    }
  });

export type ProviderCredentialHeader = z.output<typeof providerCredentialHeaderSchema>;
export type ProductionProviderBinding = z.output<typeof productionProviderBindingSchema>;
export type ProductionDataPlaneManifestInput = z.input<
  typeof productionDataPlaneManifestInputSchema
>;
export type ProductionDataPlaneManifest = z.output<typeof productionDataPlaneManifestSchema>;
export type AdapterTransportConfiguration = ProductionDataPlaneManifest['transport']['snapshot'];

export function createProductionDataPlaneManifest(
  input: ProductionDataPlaneManifestInput,
): ProductionDataPlaneManifest {
  const normalized = productionDataPlaneManifestInputSchema.parse(input);
  const body = {
    ...normalized,
    version: EVM_CHAIN_ANALYSIS_DATA_PLANE_VERSION,
  };
  const manifestFingerprint = sha256Fingerprint(body);
  return productionDataPlaneManifestSchema.parse({
    ...body,
    manifestFingerprint,
    manifestId: `production_data_plane_manifest_${manifestFingerprint.slice(7)}`,
  });
}

function addManifestIssues(
  manifest: z.output<z.ZodObject<typeof productionDataPlaneManifestCoreShape>>,
  context: z.RefinementCtx,
): void {
  if (manifest.transport.snapshot.maxResponseBytes > 5_242_880) {
    context.addIssue({
      code: 'custom',
      message: 'Snapshot response limit exceeds the underlying adapter maximum.',
      path: ['transport', 'snapshot', 'maxResponseBytes'],
    });
  }
  if (
    new Set(manifest.providers.map((provider) => provider.budgetPolicy.budgetId)).size !==
    manifest.providers.length
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Every production provider requires an independent budget id.',
      path: ['providers'],
    });
  }
  for (const adapter of ['execution', 'mev_observation', 'snapshot'] as const) {
    const providers = manifest.providers.filter(
      (provider) => provider.descriptor.adapter === adapter,
    );
    if (providers.length !== REQUIRED_PROVIDERS_PER_ADAPTER) {
      context.addIssue({
        code: 'custom',
        message: `Adapter ${adapter} requires exactly two providers.`,
        path: ['providers'],
      });
      continue;
    }
    if (
      new Set(providers.map((provider) => provider.descriptor.providerId)).size !==
        REQUIRED_PROVIDERS_PER_ADAPTER ||
      new Set(providers.map((provider) => provider.organizationHash)).size !==
        REQUIRED_PROVIDERS_PER_ADAPTER ||
      new Set(providers.map((provider) => provider.failureDomainHash)).size !==
        REQUIRED_PROVIDERS_PER_ADAPTER ||
      new Set(providers.map((provider) => provider.descriptor.endpointSecretRef)).size !==
        REQUIRED_PROVIDERS_PER_ADAPTER
    ) {
      context.addIssue({
        code: 'custom',
        message: `Adapter ${adapter} providers must have distinct ids, organizations, failure domains, and endpoint references.`,
        path: ['providers'],
      });
    }
    for (const provider of providers) {
      if (
        provider.descriptor.chainId !== manifest.chainId ||
        provider.descriptor.approvedByHashes.length !== 1 ||
        provider.descriptor.approvedByHashes[0] !== manifest.ownerIdHash ||
        Date.parse(provider.descriptor.approvedAt) > Date.parse(manifest.createdAt)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Provider approval must match and precede the single-owner manifest.',
          path: ['providers'],
        });
      }
      if (
        adapter === 'mev_observation'
          ? provider.descriptor.archiveRequired !== true
          : provider.descriptor.archiveRequired !== false
      ) {
        context.addIssue({
          code: 'custom',
          message: `Provider archive requirement is invalid for adapter ${adapter}.`,
          path: ['providers'],
        });
      }
      if (
        provider.budgetPolicy.maxCostUnits < provider.costUnitsPerRequest ||
        provider.budgetPolicy.maxResponseBytes < manifest.transport[adapter].maxResponseBytes
      ) {
        context.addIssue({
          code: 'custom',
          message: `Provider budget cannot admit one approved ${adapter} request.`,
          path: ['providers'],
        });
      }
      if (
        provider.budgetPolicy.leaseTtlSeconds * 1_000 <
        manifest.transport[adapter].requestTimeoutMs + MINIMUM_SETTLEMENT_GRACE_MS
      ) {
        context.addIssue({
          code: 'custom',
          message: `Provider budget lease is too short for one ${adapter} attempt and settlement.`,
          path: ['providers'],
        });
      }
    }
  }
  if (
    new Set(manifest.mevPools.map((pool) => pool.poolAddress)).size !== manifest.mevPools.length
  ) {
    context.addIssue({
      code: 'custom',
      message: 'MEV pool addresses must be unique.',
      path: ['mevPools'],
    });
  }
}

export function fingerprintProviderRuntimeConfiguration(
  binding: Pick<
    z.input<typeof providerBindingCoreSchema>,
    | 'costUnitsPerRequest'
    | 'credentialHeaders'
    | 'descriptor'
    | 'failureDomainHash'
    | 'organizationHash'
  >,
): string {
  return sha256Fingerprint({
    adapter: binding.descriptor.adapter,
    archiveRequired: binding.descriptor.archiveRequired,
    chainId: binding.descriptor.chainId,
    credentialHeaders: [...binding.credentialHeaders]
      .map((header) => ({ name: header.name.toLowerCase(), secretRef: header.secretRef }))
      .sort((left, right) =>
        left.name === right.name
          ? left.secretRef.localeCompare(right.secretRef)
          : left.name.localeCompare(right.name),
      ),
    costUnitsPerRequest: binding.costUnitsPerRequest,
    endpointSecretRef: binding.descriptor.endpointSecretRef,
    failureDomainHash: binding.failureDomainHash,
    organizationHash: binding.organizationHash,
    providerId: binding.descriptor.providerId,
    region: binding.descriptor.region,
  });
}
