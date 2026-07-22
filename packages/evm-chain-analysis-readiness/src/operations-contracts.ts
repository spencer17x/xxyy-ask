import { z } from 'zod';

import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import { evmRpcProviderIdSchema } from '@xxyy/evm-data-adapter';
import { evmChainIdSchema } from '@xxyy/transaction-analysis-core';

import {
  EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  MAX_READINESS_PROVIDERS,
  fingerprintSchema,
  ppmSchema,
  stableIdSchema,
  uniqueValues,
} from './common.js';

export const chainDataAdapterKinds = ['execution', 'mev_observation', 'snapshot'] as const;
export const productionBudgetOutcomes = ['cancelled', 'failed', 'success'] as const;
export const sharedCircuitStates = ['closed', 'half_open', 'open'] as const;
export const productionDrillKinds = [
  'audit_sink_unavailable',
  'budget_exhaustion',
  'circuit_backend_unavailable',
  'malformed_payload',
  'provider_conflict',
  'provider_rate_limit',
  'provider_timeout',
  'reorg_detected',
] as const;

export type ChainDataAdapterKind = (typeof chainDataAdapterKinds)[number];
export type ProductionDrillKind = (typeof productionDrillKinds)[number];
export type SharedCircuitState = (typeof sharedCircuitStates)[number];

export const secretReferenceSchema = z
  .string()
  .trim()
  .min(13)
  .max(160)
  .regex(/^secretref:[a-z0-9][a-z0-9._/-]+$/u, 'Expected an opaque secret reference.')
  .refine((value) => !value.includes('//') && !value.includes('..') && !value.endsWith('/'), {
    message: 'Secret references cannot contain traversal or empty path segments.',
  });

const twoApproverHashesSchema = z
  .array(fingerprintSchema)
  .min(2)
  .max(8)
  .refine(uniqueValues, 'Control approvals require distinct reviewer hashes.');

const providerDeploymentCoreShape = {
  adapter: z.enum(chainDataAdapterKinds),
  approvedAt: z.string().datetime({ offset: true }),
  approvedByHashes: twoApproverHashesSchema,
  archiveRequired: z.boolean(),
  chainId: evmChainIdSchema,
  configurationFingerprint: fingerprintSchema,
  credentialSecretRefs: z
    .array(secretReferenceSchema)
    .max(8)
    .refine(uniqueValues, 'Credential secret references must be unique.'),
  enabled: z.boolean(),
  endpointSecretRef: secretReferenceSchema,
  providerId: evmRpcProviderIdSchema,
  region: stableIdSchema,
} as const;

export const providerDeploymentDescriptorInputSchema = z
  .object(providerDeploymentCoreShape)
  .strict()
  .superRefine((provider, context) => {
    if (provider.adapter === 'mev_observation' && provider.archiveRequired !== true) {
      context.addIssue({
        code: 'custom',
        message: 'MEV observation providers must require archive state.',
        path: ['archiveRequired'],
      });
    }
  });

export const providerDeploymentDescriptorSchema = z
  .object({
    ...providerDeploymentCoreShape,
    descriptorFingerprint: fingerprintSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((provider, context) => {
    if (provider.adapter === 'mev_observation' && provider.archiveRequired !== true) {
      context.addIssue({
        code: 'custom',
        message: 'MEV observation providers must require archive state.',
        path: ['archiveRequired'],
      });
    }
    const { descriptorFingerprint, ...fingerprintPayload } = provider;
    if (descriptorFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Provider descriptor fingerprint must cover the normalized record.',
        path: ['descriptorFingerprint'],
      });
    }
  });

const boundedUsageShape = {
  costUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requests: z.number().int().nonnegative().max(1_000_000),
  responseBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  rpcCalls: z.number().int().nonnegative().max(10_000_000),
} as const;

const budgetPolicyCoreShape = {
  adapter: z.enum(chainDataAdapterKinds),
  budgetId: stableIdSchema,
  chainId: evmChainIdSchema,
  leaseTtlSeconds: z.number().int().positive().max(3_600),
  maxConcurrentLeases: z.number().int().positive().max(10_000),
  maxCostUnits: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxRequests: z.number().int().positive().max(1_000_000),
  maxResponseBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxRpcCalls: z.number().int().positive().max(10_000_000),
  providerId: evmRpcProviderIdSchema,
  windowSeconds: z.number().int().positive().max(86_400),
} as const;

export const providerBudgetPolicyInputSchema = z.object(budgetPolicyCoreShape).strict();

export const providerBudgetPolicySchema = z
  .object({
    ...budgetPolicyCoreShape,
    policyFingerprint: fingerprintSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .refine(
    ({ policyFingerprint, ...fingerprintPayload }) =>
      policyFingerprint === sha256Fingerprint(fingerprintPayload),
    {
      message: 'Budget policy fingerprint must cover the normalized record.',
      path: ['policyFingerprint'],
    },
  );

const providerBudgetReservationCoreShape = {
  budgetId: stableIdSchema,
  instanceIdHash: fingerprintSchema,
  policyFingerprint: fingerprintSchema,
  reserve: z.object(boundedUsageShape).strict(),
  requestedAt: z.string().datetime({ offset: true }),
} as const;

export const providerBudgetReservationInputSchema = z
  .object(providerBudgetReservationCoreShape)
  .strict();

export const providerBudgetReservationRequestSchema = z
  .object({
    ...providerBudgetReservationCoreShape,
    requestFingerprint: fingerprintSchema,
  })
  .strict()
  .refine(
    ({ requestFingerprint, ...fingerprintPayload }) =>
      requestFingerprint === sha256Fingerprint(fingerprintPayload),
    {
      message: 'Budget reservation fingerprint must cover the normalized request.',
      path: ['requestFingerprint'],
    },
  );

export const providerBudgetLeaseSchema = z
  .object({
    budgetId: stableIdSchema,
    expiresAt: z.string().datetime({ offset: true }),
    instanceIdHash: fingerprintSchema,
    issuedAt: z.string().datetime({ offset: true }),
    leaseFingerprint: fingerprintSchema,
    leaseId: z.string().regex(/^lease_[0-9a-f]{64}$/u),
    policyFingerprint: fingerprintSchema,
    requestFingerprint: fingerprintSchema,
    reserved: z.object(boundedUsageShape).strict(),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((lease, context) => {
    if (Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Budget lease must expire after it is issued.',
        path: ['expiresAt'],
      });
    }
    if (lease.leaseId !== `lease_${lease.leaseFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Budget lease id must be content-addressed.',
        path: ['leaseId'],
      });
    }
    const { leaseFingerprint, leaseId: _leaseId, ...fingerprintPayload } = lease;
    if (leaseFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Budget lease fingerprint must cover the normalized lease.',
        path: ['leaseFingerprint'],
      });
    }
  });

export const providerBudgetSettlementInputSchema = z
  .object({
    leaseId: z.string().regex(/^lease_[0-9a-f]{64}$/u),
    outcome: z.enum(productionBudgetOutcomes),
    settledAt: z.string().datetime({ offset: true }),
    usage: z.object(boundedUsageShape).strict(),
  })
  .strict();

export const providerBudgetSettlementSchema = z
  .object({
    ...providerBudgetSettlementInputSchema.shape,
    leaseFingerprint: fingerprintSchema,
    settlementFingerprint: fingerprintSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .refine(
    ({ settlementFingerprint, ...fingerprintPayload }) =>
      settlementFingerprint === sha256Fingerprint(fingerprintPayload),
    {
      message: 'Budget settlement fingerprint must cover the normalized settlement.',
      path: ['settlementFingerprint'],
    },
  );

export interface ProviderBudgetCoordinator {
  reserve(input: ProviderBudgetReservationRequest): Promise<ProviderBudgetLease>;
  settle(input: ProviderBudgetSettlementInput): Promise<ProviderBudgetSettlement>;
}

export const productionAuditEventKinds = [
  'budget_reserved',
  'budget_settled',
  'circuit_transition',
  'drill_completed',
  'provider_request',
  'slo_window_closed',
] as const;

const auditUsageSchema = z.object(boundedUsageShape).strict();

export const productionAuditEventInputSchema = z
  .object({
    adapter: z.enum(chainDataAdapterKinds),
    budgetLeaseId: z
      .string()
      .regex(/^lease_[0-9a-f]{64}$/u)
      .optional(),
    chainId: evmChainIdSchema,
    correlationHash: fingerprintSchema,
    durationMs: z.number().int().nonnegative().max(86_400_000),
    eventAt: z.string().datetime({ offset: true }),
    eventKind: z.enum(productionAuditEventKinds),
    instanceIdHash: fingerprintSchema,
    providerId: evmRpcProviderIdSchema,
    requestFingerprint: fingerprintSchema.optional(),
    resultCode: stableIdSchema,
    usage: auditUsageSchema,
  })
  .strict()
  .superRefine(addAuditEventIssues);

export const productionAuditEventSchema = z
  .object({
    ...productionAuditEventInputSchema.shape,
    eventFingerprint: fingerprintSchema,
    eventId: z.string().regex(/^audit_[0-9a-f]{64}$/u),
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((event, context) => {
    addAuditEventIssues(event, context);
    if (event.eventId !== `audit_${event.eventFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Audit event id must be content-addressed.',
        path: ['eventId'],
      });
    }
    const { eventFingerprint, eventId: _eventId, ...fingerprintPayload } = event;
    if (eventFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Audit event fingerprint must cover the redacted event.',
        path: ['eventFingerprint'],
      });
    }
  });

const sharedProviderCircuitCoreShape = {
  adapter: z.enum(chainDataAdapterKinds),
  chainId: evmChainIdSchema,
  consecutiveFailures: z.number().int().nonnegative().max(1_000_000),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastTransitionReason: stableIdSchema,
  nextProbeAt: z.string().datetime({ offset: true }).optional(),
  openedAt: z.string().datetime({ offset: true }).optional(),
  providerId: evmRpcProviderIdSchema,
  state: z.enum(sharedCircuitStates),
  updatedAt: z.string().datetime({ offset: true }),
} as const;

export const sharedProviderCircuitStateInputSchema = z
  .object(sharedProviderCircuitCoreShape)
  .strict()
  .superRefine(addCircuitStateIssues);

export const sharedProviderCircuitStateSchema = z
  .object({
    ...sharedProviderCircuitCoreShape,
    stateFingerprint: fingerprintSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .superRefine((state, context) => {
    addCircuitStateIssues(state, context);
    const { stateFingerprint, ...fingerprintPayload } = state;
    if (stateFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Circuit state fingerprint must cover the normalized state.',
        path: ['stateFingerprint'],
      });
    }
  });

export const sharedCircuitTransitionRequestSchema = z
  .object({
    expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expectedStateFingerprint: fingerprintSchema,
    next: sharedProviderCircuitStateInputSchema,
  })
  .strict();

export interface SharedCircuitStateCoordinator {
  compareAndSet(input: SharedCircuitTransitionRequest): Promise<SharedProviderCircuitState>;
  read(input: {
    adapter: ChainDataAdapterKind;
    chainId: string;
    providerId: string;
  }): Promise<SharedProviderCircuitState | undefined>;
}

const timeBoundEvidenceShape = {
  evidenceHash: fingerprintSchema,
  testedAt: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
} as const;

export const distributedBudgetControlEvidenceSchema = z
  .object({
    ...timeBoundEvidenceShape,
    atomicReservation: z.boolean(),
    backendKind: z.enum(['other', 'postgresql', 'redis']),
    globalConcurrency: z.boolean(),
    idempotentSettlement: z.boolean(),
    leaseExpiry: z.boolean(),
    unavailableFailsClosed: z.boolean(),
    usageReconciliation: z.boolean(),
  })
  .strict()
  .superRefine(addTimeBoundEvidenceIssues);

export const persistentAuditControlEvidenceSchema = z
  .object({
    ...timeBoundEvidenceShape,
    accessReviewPassed: z.boolean(),
    appendOnly: z.boolean(),
    backendKind: z.enum(['object_store', 'other', 'postgresql']),
    deletionTestPassed: z.boolean(),
    encryptedAtRest: z.boolean(),
    retentionDays: z.number().int().positive().max(3_650),
    unavailableFailsClosed: z.boolean(),
  })
  .strict()
  .superRefine(addTimeBoundEvidenceIssues);

export const sharedCircuitControlEvidenceSchema = z
  .object({
    ...timeBoundEvidenceShape,
    atomicTransitions: z.boolean(),
    backendKind: z.enum(['other', 'postgresql', 'redis']),
    halfOpenProbeControlled: z.boolean(),
    providerIsolation: z.boolean(),
    staleStateRecovery: z.boolean(),
    unavailableFailsClosed: z.boolean(),
  })
  .strict()
  .superRefine(addTimeBoundEvidenceIssues);

export const productionAlertingControlEvidenceSchema = z
  .object({
    ...timeBoundEvidenceShape,
    auditSinkAlertsConfigured: z.boolean(),
    budgetAlertsConfigured: z.boolean(),
    circuitAlertsConfigured: z.boolean(),
    notificationTestPassed: z.boolean(),
    onCallRouteHash: fingerprintSchema,
    providerSloAlertsConfigured: z.boolean(),
  })
  .strict()
  .superRefine(addTimeBoundEvidenceIssues);

export const incidentRunbookEvidenceSchema = z
  .object({
    approvedByHashes: twoApproverHashesSchema,
    escalationTestPassed: z.boolean(),
    evidenceHash: fingerprintSchema,
    reviewedAt: z.string().datetime({ offset: true }),
    rollbackTestPassed: z.boolean(),
    runbookHash: fingerprintSchema,
    validUntil: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((evidence) => Date.parse(evidence.validUntil) > Date.parse(evidence.reviewedAt), {
    message: 'Runbook evidence must remain valid after its review.',
    path: ['validUntil'],
  });

export const productionSecurityEvidenceSchema = z
  .object({
    approvedByHashes: twoApproverHashesSchema,
    credentialRotationTestPassed: z.boolean(),
    dataRetentionPolicyHash: fingerprintSchema,
    evidenceHash: fingerprintSchema,
    noLlmSecretExposureTestPassed: z.boolean(),
    providerRiskReviewHash: fingerprintSchema,
    reviewedAt: z.string().datetime({ offset: true }),
    threatModelHash: fingerprintSchema,
    validUntil: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((evidence) => Date.parse(evidence.validUntil) > Date.parse(evidence.reviewedAt), {
    message: 'Security evidence must remain valid after its review.',
    path: ['validUntil'],
  });

export const providerSloReportSchema = z
  .object({
    adapter: z.enum(chainDataAdapterKinds),
    availabilityPpm: ppmSchema,
    averageCostUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    chainId: evmChainIdSchema,
    errorRatePpm: ppmSchema,
    evidenceHash: fingerprintSchema,
    openIncidentCount: z.number().int().nonnegative().max(1_000),
    p95LatencyMs: z.number().int().nonnegative().max(120_000),
    providerId: evmRpcProviderIdSchema,
    sampleCount: z.number().int().nonnegative().max(100_000_000),
    windowEndedAt: z.string().datetime({ offset: true }),
    windowStartedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((report) => Date.parse(report.windowEndedAt) > Date.parse(report.windowStartedAt), {
    message: 'SLO report window must have positive duration.',
    path: ['windowEndedAt'],
  });

export const productionDrillEvidenceSchema = z
  .object({
    completedAt: z.string().datetime({ offset: true }),
    drill: z.enum(productionDrillKinds),
    evidenceHash: fingerprintSchema,
    outcome: z.enum(['failed', 'passed']),
    recoveryTimeMs: z.number().int().nonnegative().max(86_400_000),
    runbookHash: fingerprintSchema,
  })
  .strict();

export const productionOperationsEvidenceBundleSchema = z
  .object({
    alertingControl: productionAlertingControlEvidenceSchema,
    auditControl: persistentAuditControlEvidenceSchema,
    budgetControl: distributedBudgetControlEvidenceSchema,
    budgetPolicies: z
      .array(providerBudgetPolicySchema)
      .max(MAX_READINESS_PROVIDERS)
      .refine(
        (policies) =>
          uniqueValues(
            policies.map((policy) => `${policy.chainId}:${policy.adapter}:${policy.providerId}`),
          ),
        'Budget policies must be unique per provider and adapter.',
      ),
    circuitControl: sharedCircuitControlEvidenceSchema,
    circuitStates: z
      .array(sharedProviderCircuitStateSchema)
      .max(MAX_READINESS_PROVIDERS)
      .refine(
        (states) =>
          uniqueValues(
            states.map((state) => `${state.chainId}:${state.adapter}:${state.providerId}`),
          ),
        'Circuit states must be unique per provider and adapter.',
      ),
    drills: z.array(productionDrillEvidenceSchema).max(productionDrillKinds.length * 4),
    providers: z
      .array(providerDeploymentDescriptorSchema)
      .min(1)
      .max(MAX_READINESS_PROVIDERS)
      .refine(
        (providers) =>
          uniqueValues(
            providers.map(
              (provider) => `${provider.chainId}:${provider.adapter}:${provider.providerId}`,
            ),
          ),
        'Provider deployments must be unique per chain, adapter, and provider id.',
      ),
    runbook: incidentRunbookEvidenceSchema,
    security: productionSecurityEvidenceSchema,
    sloReports: z
      .array(providerSloReportSchema)
      .max(MAX_READINESS_PROVIDERS)
      .refine(
        (reports) =>
          uniqueValues(
            reports.map((report) => `${report.chainId}:${report.adapter}:${report.providerId}`),
          ),
        'SLO reports must be unique per provider and adapter.',
      ),
  })
  .strict();

const readinessPolicyCoreShape = {
  maxAverageCostUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxCircuitStateAgeSeconds: z.number().int().positive().max(86_400),
  maxCorpusAgeSeconds: z.number().int().positive().max(31_536_000),
  maxDrillAgeSeconds: z.number().int().positive().max(31_536_000),
  maxDrillRecoveryTimeMs: z.number().int().positive().max(86_400_000),
  maxErrorRatePpm: ppmSchema,
  maxOpenIncidents: z.number().int().nonnegative().max(100),
  maxP95LatencyMs: z.number().int().positive().max(120_000),
  maxSloAgeSeconds: z.number().int().positive().max(31_536_000),
  minAvailabilityPpm: ppmSchema,
  minAuditRetentionDays: z.number().int().positive().max(3_650),
  minProvidersPerAdapterChain: z.number().int().positive().max(8),
  minSloSamples: z.number().int().positive().max(100_000_000),
  policyId: stableIdSchema,
  requiredAdapters: z
    .array(z.enum(chainDataAdapterKinds))
    .min(1)
    .max(chainDataAdapterKinds.length)
    .refine(uniqueValues, 'Required adapters must be unique.'),
  requiredChains: z
    .array(evmChainIdSchema)
    .min(1)
    .max(64)
    .refine(uniqueValues, 'Required chains must be unique.'),
  requiredDrills: z
    .array(z.enum(productionDrillKinds))
    .min(1)
    .max(productionDrillKinds.length)
    .refine(uniqueValues, 'Required drills must be unique.'),
} as const;

export const productionReadinessPolicyInputSchema = z.object(readinessPolicyCoreShape).strict();

export const productionReadinessPolicySchema = z
  .object({
    ...readinessPolicyCoreShape,
    policyFingerprint: fingerprintSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_READINESS_VERSION),
  })
  .strict()
  .refine(
    ({ policyFingerprint, ...fingerprintPayload }) =>
      policyFingerprint === sha256Fingerprint(fingerprintPayload),
    {
      message: 'Readiness policy fingerprint must cover the normalized policy.',
      path: ['policyFingerprint'],
    },
  );

export type ProviderDeploymentDescriptorInput = z.input<
  typeof providerDeploymentDescriptorInputSchema
>;
export type ProviderDeploymentDescriptor = z.output<typeof providerDeploymentDescriptorSchema>;
export type ProviderBudgetPolicyInput = z.input<typeof providerBudgetPolicyInputSchema>;
export type ProviderBudgetPolicy = z.output<typeof providerBudgetPolicySchema>;
export type ProviderBudgetReservationInput = z.input<typeof providerBudgetReservationInputSchema>;
export type ProviderBudgetReservationRequest = z.input<
  typeof providerBudgetReservationRequestSchema
>;
export type ProviderBudgetLease = z.output<typeof providerBudgetLeaseSchema>;
export type ProviderBudgetSettlementInput = z.input<typeof providerBudgetSettlementInputSchema>;
export type ProviderBudgetSettlement = z.output<typeof providerBudgetSettlementSchema>;
export type ProductionAuditEventInput = z.input<typeof productionAuditEventInputSchema>;
export type ProductionAuditEvent = z.output<typeof productionAuditEventSchema>;
export type SharedProviderCircuitStateInput = z.input<typeof sharedProviderCircuitStateInputSchema>;
export type SharedProviderCircuitState = z.output<typeof sharedProviderCircuitStateSchema>;
export type SharedCircuitTransitionRequest = z.input<typeof sharedCircuitTransitionRequestSchema>;
export type DistributedBudgetControlEvidence = z.output<
  typeof distributedBudgetControlEvidenceSchema
>;
export type PersistentAuditControlEvidence = z.output<typeof persistentAuditControlEvidenceSchema>;
export type SharedCircuitControlEvidence = z.output<typeof sharedCircuitControlEvidenceSchema>;
export type ProductionAlertingControlEvidence = z.output<
  typeof productionAlertingControlEvidenceSchema
>;
export type IncidentRunbookEvidence = z.output<typeof incidentRunbookEvidenceSchema>;
export type ProductionSecurityEvidence = z.output<typeof productionSecurityEvidenceSchema>;
export type ProviderSloReport = z.output<typeof providerSloReportSchema>;
export type ProductionDrillEvidence = z.output<typeof productionDrillEvidenceSchema>;
export type ProductionOperationsEvidenceBundle = z.output<
  typeof productionOperationsEvidenceBundleSchema
>;
export type ProductionReadinessPolicyInput = z.input<typeof productionReadinessPolicyInputSchema>;
export type ProductionReadinessPolicy = z.output<typeof productionReadinessPolicySchema>;

function addAuditEventIssues(
  event: {
    budgetLeaseId?: string | undefined;
    eventKind: (typeof productionAuditEventKinds)[number];
    requestFingerprint?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (
    (event.eventKind === 'budget_reserved' || event.eventKind === 'budget_settled') &&
    event.budgetLeaseId === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Budget audit events require the redacted lease id.',
      path: ['budgetLeaseId'],
    });
  }
  if (event.eventKind === 'provider_request' && event.requestFingerprint === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Provider request audit events require a request fingerprint.',
      path: ['requestFingerprint'],
    });
  }
}

function addTimeBoundEvidenceIssues(
  evidence: { testedAt: string; validUntil: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(evidence.validUntil) <= Date.parse(evidence.testedAt)) {
    context.addIssue({
      code: 'custom',
      message: 'Control evidence must remain valid after it was tested.',
      path: ['validUntil'],
    });
  }
}

function addCircuitStateIssues(
  state: {
    nextProbeAt?: string | undefined;
    openedAt?: string | undefined;
    state: SharedCircuitState;
    updatedAt: string;
  },
  context: z.RefinementCtx,
): void {
  if (state.state === 'closed') {
    if (state.openedAt !== undefined || state.nextProbeAt !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Closed circuits cannot retain open or probe timestamps.',
        path: ['state'],
      });
    }
    return;
  }
  if (state.openedAt === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Open and half-open circuits require the original open timestamp.',
      path: ['openedAt'],
    });
  } else if (Date.parse(state.openedAt) > Date.parse(state.updatedAt)) {
    context.addIssue({
      code: 'custom',
      message: 'Circuit open time cannot follow its latest transition.',
      path: ['openedAt'],
    });
  }
  if (state.state === 'open' && state.nextProbeAt === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Open circuits require a scheduled probe timestamp.',
      path: ['nextProbeAt'],
    });
  } else if (
    state.state === 'open' &&
    state.nextProbeAt !== undefined &&
    Date.parse(state.nextProbeAt) <= Date.parse(state.updatedAt)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'An open circuit probe must be scheduled after its latest transition.',
      path: ['nextProbeAt'],
    });
  }
}
