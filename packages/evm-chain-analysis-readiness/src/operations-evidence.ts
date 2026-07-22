import { compareCanonicalStrings, sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';

import { EVM_CHAIN_ANALYSIS_READINESS_VERSION, datetimeMs } from './common.js';
import {
  productionAuditEventInputSchema,
  productionAuditEventSchema,
  productionOperationsEvidenceBundleSchema,
  productionReadinessPolicyInputSchema,
  productionReadinessPolicySchema,
  providerBudgetLeaseSchema,
  providerBudgetPolicyInputSchema,
  providerBudgetPolicySchema,
  providerBudgetReservationInputSchema,
  providerBudgetReservationRequestSchema,
  providerBudgetSettlementInputSchema,
  providerBudgetSettlementSchema,
  providerDeploymentDescriptorInputSchema,
  providerDeploymentDescriptorSchema,
  sharedProviderCircuitStateInputSchema,
  sharedProviderCircuitStateSchema,
  type ProductionAuditEvent,
  type ProductionAuditEventInput,
  type ProductionReadinessPolicy,
  type ProductionReadinessPolicyInput,
  type ProviderBudgetLease,
  type ProviderBudgetPolicy,
  type ProviderBudgetPolicyInput,
  type ProviderBudgetReservationInput,
  type ProviderBudgetReservationRequest,
  type ProviderBudgetSettlement,
  type ProviderBudgetSettlementInput,
  type ProviderDeploymentDescriptor,
  type ProviderDeploymentDescriptorInput,
  type SharedProviderCircuitState,
  type SharedProviderCircuitStateInput,
} from './operations-contracts.js';

export const productionEvidenceErrorCodes = [
  'budget_identity_mismatch',
  'budget_reservation_exceeded',
  'invalid_budget_time',
  'invalid_circuit_transition',
  'lease_identity_mismatch',
  'usage_exceeds_lease',
] as const;

export type ProductionEvidenceErrorCode = (typeof productionEvidenceErrorCodes)[number];

export class ProductionEvidenceError extends Error {
  readonly code: ProductionEvidenceErrorCode;

  constructor(code: ProductionEvidenceErrorCode, message: string) {
    super(message);
    this.name = 'ProductionEvidenceError';
    this.code = code;
  }
}

export function createProviderDeploymentDescriptor(
  input: ProviderDeploymentDescriptorInput,
): ProviderDeploymentDescriptor {
  const normalized = providerDeploymentDescriptorInputSchema.parse(input);
  const body = {
    ...normalized,
    approvedByHashes: sorted(normalized.approvedByHashes),
    credentialSecretRefs: sorted(normalized.credentialSecretRefs),
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return providerDeploymentDescriptorSchema.parse({
    ...body,
    descriptorFingerprint: sha256Fingerprint(body),
  });
}

export function createProviderBudgetPolicy(input: ProviderBudgetPolicyInput): ProviderBudgetPolicy {
  const normalized = providerBudgetPolicyInputSchema.parse(input);
  const body = {
    ...normalized,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return providerBudgetPolicySchema.parse({
    ...body,
    policyFingerprint: sha256Fingerprint(body),
  });
}

export function createProviderBudgetReservation(
  input: ProviderBudgetReservationInput,
): ProviderBudgetReservationRequest {
  const normalized = providerBudgetReservationInputSchema.parse(input);
  return providerBudgetReservationRequestSchema.parse({
    ...normalized,
    requestFingerprint: sha256Fingerprint(normalized),
  });
}

/**
 * Materializes an artifact only after an external coordinator has granted an atomic reservation.
 * This pure helper is not a concurrency backend and does not claim that a grant was serialized.
 */
export function materializeGrantedProviderBudgetLease(
  policyInput: unknown,
  requestInput: unknown,
  issuedAt: string,
): ProviderBudgetLease {
  const policy = providerBudgetPolicySchema.parse(policyInput);
  const request = providerBudgetReservationRequestSchema.parse(requestInput);
  if (
    request.budgetId !== policy.budgetId ||
    request.policyFingerprint !== policy.policyFingerprint
  ) {
    throw new ProductionEvidenceError(
      'budget_identity_mismatch',
      'Budget reservation does not reference the supplied policy.',
    );
  }
  if (datetimeMs(issuedAt) < datetimeMs(request.requestedAt)) {
    throw new ProductionEvidenceError(
      'invalid_budget_time',
      'A budget lease cannot be issued before its reservation request.',
    );
  }
  assertUsageWithinLimits(
    request.reserve,
    {
      costUnits: policy.maxCostUnits,
      requests: policy.maxRequests,
      responseBytes: policy.maxResponseBytes,
      rpcCalls: policy.maxRpcCalls,
    },
    'budget_reservation_exceeded',
  );
  const expiresAt = new Date(datetimeMs(issuedAt) + policy.leaseTtlSeconds * 1_000).toISOString();
  const body = {
    budgetId: policy.budgetId,
    expiresAt,
    instanceIdHash: request.instanceIdHash,
    issuedAt,
    policyFingerprint: policy.policyFingerprint,
    requestFingerprint: request.requestFingerprint,
    reserved: request.reserve,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const leaseFingerprint = sha256Fingerprint(body);
  return providerBudgetLeaseSchema.parse({
    ...body,
    leaseFingerprint,
    leaseId: `lease_${leaseFingerprint.slice(7)}`,
  });
}

export function settleProviderBudgetLease(
  leaseInput: unknown,
  input: ProviderBudgetSettlementInput,
): ProviderBudgetSettlement {
  const lease = providerBudgetLeaseSchema.parse(leaseInput);
  const normalized = providerBudgetSettlementInputSchema.parse(input);
  if (normalized.leaseId !== lease.leaseId) {
    throw new ProductionEvidenceError(
      'lease_identity_mismatch',
      'Budget settlement does not reference the supplied lease.',
    );
  }
  if (datetimeMs(normalized.settledAt) < datetimeMs(lease.issuedAt)) {
    throw new ProductionEvidenceError(
      'invalid_budget_time',
      'A budget lease cannot be settled before it is issued.',
    );
  }
  assertUsageWithinLimits(normalized.usage, lease.reserved, 'usage_exceeds_lease');
  const body = {
    ...normalized,
    leaseFingerprint: lease.leaseFingerprint,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return providerBudgetSettlementSchema.parse({
    ...body,
    settlementFingerprint: sha256Fingerprint(body),
  });
}

export function createProductionAuditEvent(input: ProductionAuditEventInput): ProductionAuditEvent {
  const normalized = productionAuditEventInputSchema.parse(input);
  const body = {
    ...normalized,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  const eventFingerprint = sha256Fingerprint(body);
  return productionAuditEventSchema.parse({
    ...body,
    eventFingerprint,
    eventId: `audit_${eventFingerprint.slice(7)}`,
  });
}

export function createSharedProviderCircuitState(
  input: SharedProviderCircuitStateInput,
): SharedProviderCircuitState {
  const normalized = sharedProviderCircuitStateInputSchema.parse(input);
  const body = {
    ...normalized,
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return sharedProviderCircuitStateSchema.parse({
    ...body,
    stateFingerprint: sha256Fingerprint(body),
  });
}

export function transitionSharedProviderCircuitState(
  previousInput: unknown,
  input: SharedProviderCircuitStateInput,
): SharedProviderCircuitState {
  const previous = sharedProviderCircuitStateSchema.parse(previousInput);
  const next = sharedProviderCircuitStateInputSchema.parse(input);
  if (
    next.adapter !== previous.adapter ||
    next.chainId !== previous.chainId ||
    next.providerId !== previous.providerId ||
    next.generation !== previous.generation + 1 ||
    datetimeMs(next.updatedAt) <= datetimeMs(previous.updatedAt)
  ) {
    throw new ProductionEvidenceError(
      'invalid_circuit_transition',
      'Circuit transitions must retain provider identity, advance generation once, and move time forward.',
    );
  }
  if (previous.state === 'closed' && next.state === 'half_open') {
    throw new ProductionEvidenceError(
      'invalid_circuit_transition',
      'A closed circuit must open before it can enter half-open probe mode.',
    );
  }
  return createSharedProviderCircuitState(next);
}

export function createProductionReadinessPolicy(
  input: ProductionReadinessPolicyInput,
): ProductionReadinessPolicy {
  const normalized = productionReadinessPolicyInputSchema.parse(input);
  const body = {
    ...normalized,
    requiredAdapters: sorted(normalized.requiredAdapters),
    requiredChains: [...normalized.requiredChains].sort(compareCanonicalStrings),
    requiredDrills: sorted(normalized.requiredDrills),
    version: EVM_CHAIN_ANALYSIS_READINESS_VERSION,
  };
  return productionReadinessPolicySchema.parse({
    ...body,
    policyFingerprint: sha256Fingerprint(body),
  });
}

export function fingerprintProductionOperationsEvidence(input: unknown): string {
  const evidence = productionOperationsEvidenceBundleSchema.parse(input);
  return sha256Fingerprint({
    ...evidence,
    budgetPolicies: [...evidence.budgetPolicies].sort((left, right) =>
      compareCanonicalStrings(providerIdentity(left), providerIdentity(right)),
    ),
    circuitStates: [...evidence.circuitStates].sort((left, right) =>
      compareCanonicalStrings(providerIdentity(left), providerIdentity(right)),
    ),
    drills: [...evidence.drills].sort((left, right) =>
      compareCanonicalStrings(
        `${left.drill}:${left.completedAt}:${left.evidenceHash}`,
        `${right.drill}:${right.completedAt}:${right.evidenceHash}`,
      ),
    ),
    providers: [...evidence.providers].sort((left, right) =>
      compareCanonicalStrings(providerIdentity(left), providerIdentity(right)),
    ),
    runbook: {
      ...evidence.runbook,
      approvedByHashes: sorted(evidence.runbook.approvedByHashes),
    },
    security: {
      ...evidence.security,
      approvedByHashes: sorted(evidence.security.approvedByHashes),
    },
    sloReports: [...evidence.sloReports].sort((left, right) =>
      compareCanonicalStrings(providerIdentity(left), providerIdentity(right)),
    ),
  });
}

interface Usage {
  costUnits: number;
  requests: number;
  responseBytes: number;
  rpcCalls: number;
}

function assertUsageWithinLimits(
  usage: Usage,
  limits: Usage,
  code: 'budget_reservation_exceeded' | 'usage_exceeds_lease',
): void {
  const exceeded = (Object.keys(usage) as Array<keyof Usage>).filter(
    (field) => usage[field] > limits[field],
  );
  if (exceeded.length > 0) {
    throw new ProductionEvidenceError(
      code,
      `Provider budget exceeded for: ${sorted(exceeded).join(', ')}.`,
    );
  }
}

function sorted<T extends string>(values: readonly T[]): T[] {
  return [...values].sort(compareCanonicalStrings);
}

function providerIdentity(input: { adapter: string; chainId: string; providerId: string }): string {
  return `${input.chainId}:${input.adapter}:${input.providerId}`;
}
