import { describe, expect, it } from 'vitest';

import {
  CONTRACT_FIXTURE_TIMES,
  contractHash,
  createPassingOperationsEvidence,
  createPassingReadinessPolicy,
} from './fixtures/contract-fixtures.test-helper.js';
import {
  createProductionAuditEvent,
  createProviderBudgetPolicy,
  createProviderBudgetReservation,
  createProviderDeploymentDescriptor,
  createSharedProviderCircuitState,
  fingerprintProductionOperationsEvidence,
  materializeGrantedProviderBudgetLease,
  settleProviderBudgetLease,
  transitionSharedProviderCircuitState,
} from './operations-evidence.js';
import type { ProductionEvidenceError } from './operations-evidence.js';
import {
  productionAuditEventInputSchema,
  providerBudgetLeaseSchema,
  providerDeploymentDescriptorInputSchema,
  secretReferenceSchema,
} from './operations-contracts.js';
import { evaluateProductionOperationsEvidence } from './evaluate-production-readiness.js';

describe('production data-plane evidence contracts', () => {
  it('accepts opaque secret references while rejecting endpoints, traversal, and extra secret fields', () => {
    expect(secretReferenceSchema.parse('secretref:providers/mainnet/endpoint')).toBe(
      'secretref:providers/mainnet/endpoint',
    );
    expect(secretReferenceSchema.safeParse('https://rpc.example/key').success).toBe(false);
    expect(secretReferenceSchema.safeParse('secretref:providers/../key').success).toBe(false);
    expect(
      providerDeploymentDescriptorInputSchema.safeParse({
        adapter: 'snapshot',
        approvedAt: '2026-07-21T00:00:00.000Z',
        approvedByHashes: [contractHash('a'), contractHash('b')],
        archiveRequired: false,
        chainId: '1',
        configurationFingerprint: contractHash('config'),
        credentialSecretRefs: [],
        enabled: true,
        endpointSecretRef: 'https://rpc.example/key',
        providerId: 'rpc_primary',
        region: 'global',
      }).success,
    ).toBe(false);
    expect(
      productionAuditEventInputSchema.safeParse({
        adapter: 'snapshot',
        chainId: '1',
        correlationHash: contractHash('correlation'),
        durationMs: 10,
        endpoint: 'https://rpc.example/key',
        eventAt: '2026-07-22T10:00:00.000Z',
        eventKind: 'provider_request',
        instanceIdHash: contractHash('instance'),
        providerId: 'rpc_primary',
        resultCode: 'success',
        usage: { costUnits: 1, requests: 1, responseBytes: 10, rpcCalls: 1 },
      }).success,
    ).toBe(false);
  });

  it('accepts one owner approval and content-addresses redacted audit records', () => {
    const descriptor = createProviderDeploymentDescriptor({
      adapter: 'snapshot',
      approvedAt: '2026-07-21T00:00:00.000Z',
      approvedByHashes: [contractHash('single-owner')],
      archiveRequired: false,
      chainId: '1',
      configurationFingerprint: contractHash('configuration'),
      credentialSecretRefs: [
        'secretref:providers/mainnet/token-b',
        'secretref:providers/mainnet/token-a',
      ],
      enabled: true,
      endpointSecretRef: 'secretref:providers/mainnet/endpoint',
      providerId: 'rpc_primary',
      region: 'global',
    });
    const audit = createProductionAuditEvent({
      adapter: 'snapshot',
      chainId: '1',
      correlationHash: contractHash('correlation'),
      durationMs: 10,
      eventAt: '2026-07-22T10:00:00.000Z',
      eventKind: 'provider_request',
      instanceIdHash: contractHash('instance'),
      providerId: 'rpc_primary',
      requestFingerprint: contractHash('request'),
      resultCode: 'success',
      usage: { costUnits: 1, requests: 1, responseBytes: 10, rpcCalls: 1 },
    });

    expect(descriptor.approvedByHashes).toEqual([...descriptor.approvedByHashes].sort());
    expect(descriptor.approvedByHashes).toEqual([contractHash('single-owner')]);
    expect(descriptor.credentialSecretRefs).toEqual([...descriptor.credentialSecretRefs].sort());
    expect(audit.eventId).toBe(`audit_${audit.eventFingerprint.slice(7)}`);
    expect(JSON.stringify(audit)).not.toContain('https://');
    expect(
      productionAuditEventInputSchema.safeParse({
        adapter: 'snapshot',
        chainId: '1',
        correlationHash: contractHash('missing-request-link'),
        durationMs: 10,
        eventAt: '2026-07-22T10:00:00.000Z',
        eventKind: 'provider_request',
        instanceIdHash: contractHash('instance'),
        providerId: 'rpc_primary',
        resultCode: 'success',
        usage: { costUnits: 1, requests: 1, responseBytes: 10, rpcCalls: 1 },
      }).success,
    ).toBe(false);
  });

  it('models coordinator grants and rejects reservation or settlement budget overflow', () => {
    const policy = createProviderBudgetPolicy({
      adapter: 'snapshot',
      budgetId: 'budget.mainnet.snapshot',
      chainId: '1',
      leaseTtlSeconds: 60,
      maxConcurrentLeases: 5,
      maxCostUnits: 100,
      maxRequests: 10,
      maxResponseBytes: 1_000,
      maxRpcCalls: 20,
      providerId: 'rpc_primary',
      windowSeconds: 60,
    });
    const reservation = createProviderBudgetReservation({
      budgetId: policy.budgetId,
      instanceIdHash: contractHash('instance'),
      policyFingerprint: policy.policyFingerprint,
      requestedAt: '2026-07-22T10:00:00.000Z',
      reserve: { costUnits: 50, requests: 5, responseBytes: 500, rpcCalls: 10 },
    });
    const lease = materializeGrantedProviderBudgetLease(
      policy,
      reservation,
      '2026-07-22T10:00:01.000Z',
    );
    const settlement = settleProviderBudgetLease(lease, {
      leaseId: lease.leaseId,
      outcome: 'success',
      settledAt: '2026-07-22T10:00:10.000Z',
      usage: { costUnits: 40, requests: 4, responseBytes: 400, rpcCalls: 8 },
    });

    expect(lease.expiresAt).toBe('2026-07-22T10:01:01.000Z');
    expect(settlement.leaseFingerprint).toBe(lease.leaseFingerprint);
    expect(
      providerBudgetLeaseSchema.safeParse({ ...lease, expiresAt: '2026-07-22T10:02:01.000Z' })
        .success,
    ).toBe(false);
    expect(() =>
      settleProviderBudgetLease(lease, {
        leaseId: lease.leaseId,
        outcome: 'success',
        settledAt: '2026-07-22T10:00:10.000Z',
        usage: { costUnits: 51, requests: 4, responseBytes: 400, rpcCalls: 8 },
      }),
    ).toThrowError(expectEvidenceCode('usage_exceeds_lease'));
  });

  it('content-addresses generation-checked shared circuit transitions', () => {
    const closed = createSharedProviderCircuitState({
      adapter: 'snapshot',
      chainId: '1',
      consecutiveFailures: 0,
      generation: 0,
      lastTransitionReason: 'initialized',
      providerId: 'rpc_primary',
      state: 'closed',
      updatedAt: '2026-07-22T10:00:00.000Z',
    });
    const open = transitionSharedProviderCircuitState(closed, {
      adapter: 'snapshot',
      chainId: '1',
      consecutiveFailures: 5,
      generation: 1,
      lastTransitionReason: 'failure_threshold',
      nextProbeAt: '2026-07-22T10:02:00.000Z',
      openedAt: '2026-07-22T10:01:00.000Z',
      providerId: 'rpc_primary',
      state: 'open',
      updatedAt: '2026-07-22T10:01:00.000Z',
    });

    expect(open).toMatchObject({ generation: 1, state: 'open' });
    expect(() =>
      transitionSharedProviderCircuitState(closed, {
        adapter: 'snapshot',
        chainId: '1',
        consecutiveFailures: 1,
        generation: 1,
        lastTransitionReason: 'invalid_direct_probe',
        openedAt: '2026-07-22T10:01:00.000Z',
        providerId: 'rpc_primary',
        state: 'half_open',
        updatedAt: '2026-07-22T10:01:00.000Z',
      }),
    ).toThrowError(expectEvidenceCode('invalid_circuit_transition'));
  });

  it('passes complete operations evidence and degrades on live SLO, circuit, and drill failures', () => {
    const policy = createPassingReadinessPolicy();
    const passing = createPassingOperationsEvidence();
    expect(
      evaluateProductionOperationsEvidence(passing, policy, CONTRACT_FIXTURE_TIMES.evaluatedAt),
    ).toMatchObject({
      coverage: {
        budgetPolicyCoveredProviders: 1,
        circuitStateCoveredProviders: 1,
        coveredProviderSlots: 1,
        enabledRequiredProviders: 1,
        passingDrills: 1,
        requiredDrills: 1,
        requiredProviderSlots: 1,
        sloCoveredProviders: 1,
      },
      reasons: [],
      status: 'pass',
    });
    const reordered = structuredClone(passing);
    reordered.runbook.approvedByHashes.reverse();
    reordered.security.approvedByHashes.reverse();
    expect(fingerprintProductionOperationsEvidence(reordered)).toBe(
      fingerprintProductionOperationsEvidence(passing),
    );

    const degraded = structuredClone(passing);
    degraded.circuitStates = [
      createSharedProviderCircuitState({
        adapter: 'snapshot',
        chainId: '1',
        consecutiveFailures: 5,
        generation: 8,
        lastTransitionReason: 'failure_threshold',
        nextProbeAt: '2026-07-22T11:45:00.000Z',
        openedAt: '2026-07-22T11:30:00.000Z',
        providerId: 'rpc_primary',
        state: 'open',
        updatedAt: '2026-07-22T11:30:00.000Z',
      }),
    ];
    degraded.sloReports[0]!.availabilityPpm = 900_000;
    degraded.drills[0]!.outcome = 'failed';
    const result = evaluateProductionOperationsEvidence(
      degraded,
      policy,
      CONTRACT_FIXTURE_TIMES.evaluatedAt,
    );
    expect(result.status).toBe('degraded');
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      'drill_failed',
      'provider_circuit_not_closed',
      'provider_slo_breached',
    ]);
  });

  it('fails closed when control evidence has expired', () => {
    const evidence = createPassingOperationsEvidence();
    evidence.alertingControl.validUntil = '2026-07-22T11:30:00.000Z';
    const result = evaluateProductionOperationsEvidence(
      evidence,
      createPassingReadinessPolicy(),
      CONTRACT_FIXTURE_TIMES.evaluatedAt,
    );

    expect(result.status).toBe('fail');
    expect(result.reasons).toContainEqual(
      expect.objectContaining({
        code: 'control_evidence_expired',
        subject: 'alerting control evidence',
      }),
    );
  });
});

function expectEvidenceCode(code: string): ProductionEvidenceError {
  return expect.objectContaining({ code }) as ProductionEvidenceError;
}
