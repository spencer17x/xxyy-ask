import { describe, expect, it } from 'vitest';

import {
  createGovernanceAuthorization,
  createPgEvmChainAnalysisProviderControlStore,
} from './index.js';
import { createProviderControlFixture, testHash } from './fixtures.test-helper.js';
import {
  authorizationRow,
  emptyBudgetWindow,
  ScriptedPgClient,
} from './scripted-pg.test-helper.js';

describe('PostgreSQL shared provider controls', () => {
  it('atomically installs policy, reserves and settles usage, and generation-fences circuit state', async () => {
    const fixture = createProviderControlFixture();
    const client = new ScriptedPgClient();
    const operatorGrant = createOperatorGrant(fixture.instanceIdHash);
    const store = createPgEvmChainAnalysisProviderControlStore({
      client,
      coordinatorInstanceIdHash: fixture.instanceIdHash,
      now: () => '2026-07-22T10:00:01.000Z',
    });
    client.enqueue(
      'authorization-read',
      [authorizationRow(operatorGrant)],
      [authorizationRow(operatorGrant)],
      [authorizationRow(operatorGrant)],
      [authorizationRow(operatorGrant)],
      [authorizationRow(operatorGrant)],
    );
    client.enqueue('active-budget-policy-read', [], [{ generation: 0, payload: fixture.policy }]);
    const emptyWindow = emptyBudgetWindow({
      budgetId: fixture.policy.budgetId,
      policyFingerprint: fixture.policy.policyFingerprint,
      windowEndsAt: '2026-07-22T10:01:01.000Z',
      windowStartedAt: '2026-07-22T10:00:01.000Z',
    });
    client.enqueue('budget-window-insert', [emptyWindow]);
    client.enqueue('active-lease-count', [{ active_count: 0 }]);
    client.enqueue('budget-window-update', [{ budget_id: fixture.policy.budgetId }]);

    expect(
      await store.installBudgetPolicy({
        actorIdHash: fixture.instanceIdHash,
        installedAt: '2026-07-22T09:59:00.000Z',
        policy: fixture.policy,
      }),
    ).toEqual(fixture.policy);
    const lease = await store.reserve(fixture.reservation);
    expect(lease).toMatchObject({
      budgetId: fixture.policy.budgetId,
      issuedAt: '2026-07-22T10:00:01.000Z',
      reserved: fixture.reservation.reserve,
    });

    const reservedWindow = {
      ...emptyWindow,
      reserved_cost_units: fixture.reservation.reserve.costUnits,
      reserved_requests: fixture.reservation.reserve.requests,
      reserved_response_bytes: fixture.reservation.reserve.responseBytes,
      reserved_rpc_calls: fixture.reservation.reserve.rpcCalls,
    };
    client.enqueue('budget-lease-read', [
      { payload: lease, window_started_at: emptyWindow.window_started_at },
    ]);
    client.enqueue('budget-window-lock', [reservedWindow]);
    client.enqueue('budget-window-update', [{ budget_id: fixture.policy.budgetId }]);
    const settlement = await store.settle({
      leaseId: lease.leaseId,
      outcome: 'success',
      settledAt: '2026-07-22T10:00:10.000Z',
      usage: { costUnits: 40, requests: 4, responseBytes: 400, rpcCalls: 8 },
    });
    expect(settlement).toMatchObject({
      leaseFingerprint: lease.leaseFingerprint,
      outcome: 'success',
    });

    expect(
      await store.initializeCircuit({
        actorIdHash: fixture.instanceIdHash,
        state: fixture.circuit,
      }),
    ).toEqual(fixture.circuit);
    const nextInput = {
      adapter: fixture.circuit.adapter,
      chainId: fixture.circuit.chainId,
      consecutiveFailures: 5,
      generation: 1,
      lastTransitionReason: 'failure_threshold',
      nextProbeAt: '2026-07-22T10:02:00.000Z',
      openedAt: '2026-07-22T10:01:00.000Z',
      providerId: fixture.circuit.providerId,
      state: 'open' as const,
      updatedAt: '2026-07-22T10:01:00.000Z',
    };
    client.enqueue('circuit-head-lock', [
      {
        generation: fixture.circuit.generation,
        payload: fixture.circuit,
        state_fingerprint: fixture.circuit.stateFingerprint,
      },
    ]);
    client.enqueue('circuit-head-cas', [{ state_fingerprint: testHash('next-state') }]);
    const next = await store.compareAndSet({
      expectedGeneration: fixture.circuit.generation,
      expectedStateFingerprint: fixture.circuit.stateFingerprint,
      next: nextInput,
    });
    expect(next).toMatchObject({ generation: 1, state: 'open' });

    expect((await store.readAudit()).map((event) => event.eventKind)).toEqual([
      'budget_policy_installed',
      'budget_reserved',
      'budget_settled',
      'circuit_initialized',
      'circuit_transition',
    ]);
    expect(
      client.queries.find((query) => query.tag === 'circuit-head-cas')?.sql.toLowerCase(),
    ).toContain('and generation = $6');
  });

  it('fails closed when aggregate window usage would exceed the active policy', async () => {
    const fixture = createProviderControlFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisProviderControlStore({
      client,
      coordinatorInstanceIdHash: fixture.instanceIdHash,
      now: () => '2026-07-22T10:00:01.000Z',
    });
    client.enqueue('authorization-read', [
      authorizationRow(createOperatorGrant(fixture.instanceIdHash)),
    ]);
    client.enqueue('active-budget-policy-read', [{ generation: 0, payload: fixture.policy }]);
    client.enqueue('budget-window-read', [
      {
        ...emptyBudgetWindow({
          budgetId: fixture.policy.budgetId,
          policyFingerprint: fixture.policy.policyFingerprint,
          windowEndsAt: '2026-07-22T10:01:00.000Z',
          windowStartedAt: '2026-07-22T10:00:00.000Z',
        }),
        used_cost_units: 60,
      },
    ]);
    client.enqueue('active-lease-count', [{ active_count: 0 }]);

    await expect(store.reserve(fixture.reservation)).rejects.toMatchObject({
      code: 'budget_exhausted',
    });
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
    expect(client.queries.some((query) => query.tag === 'budget-lease-insert')).toBe(false);
  });

  it('rejects stale circuit generations before writing history or moving the head', async () => {
    const fixture = createProviderControlFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisProviderControlStore({
      client,
      coordinatorInstanceIdHash: fixture.instanceIdHash,
    });
    client.enqueue('authorization-read', [
      authorizationRow(createOperatorGrant(fixture.instanceIdHash)),
    ]);
    client.enqueue('circuit-head-lock', [
      {
        generation: fixture.circuit.generation,
        payload: fixture.circuit,
        state_fingerprint: fixture.circuit.stateFingerprint,
      },
    ]);

    await expect(
      store.compareAndSet({
        expectedGeneration: 9,
        expectedStateFingerprint: testHash('stale'),
        next: {
          adapter: fixture.circuit.adapter,
          chainId: fixture.circuit.chainId,
          consecutiveFailures: 1,
          generation: 1,
          lastTransitionReason: 'failure_threshold',
          nextProbeAt: '2026-07-22T10:02:00.000Z',
          openedAt: '2026-07-22T10:01:00.000Z',
          providerId: fixture.circuit.providerId,
          state: 'open',
          updatedAt: '2026-07-22T10:01:00.000Z',
        },
      }),
    ).rejects.toMatchObject({ code: 'stale_generation' });
    expect(client.queries.some((query) => query.tag === 'circuit-state-insert')).toBe(false);
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('reconciles expired leases into idempotent zero-usage cancellation settlements', async () => {
    const fixture = createProviderControlFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisProviderControlStore({
      client,
      coordinatorInstanceIdHash: fixture.instanceIdHash,
      now: () => '2026-07-22T10:00:01.000Z',
    });
    client.enqueue('authorization-read', [
      authorizationRow(createOperatorGrant(fixture.instanceIdHash)),
    ]);
    client.enqueue('active-budget-policy-read', [{ generation: 0, payload: fixture.policy }]);
    const window = emptyBudgetWindow({
      budgetId: fixture.policy.budgetId,
      policyFingerprint: fixture.policy.policyFingerprint,
      windowEndsAt: '2026-07-22T10:01:01.000Z',
      windowStartedAt: '2026-07-22T10:00:01.000Z',
    });
    client.enqueue('budget-window-insert', [window]);
    client.enqueue('active-lease-count', [{ active_count: 0 }]);
    client.enqueue('budget-window-update', [{ budget_id: fixture.policy.budgetId }]);
    const lease = await store.reserve(fixture.reservation);
    const reservedWindow = {
      ...window,
      reserved_cost_units: lease.reserved.costUnits,
      reserved_requests: lease.reserved.requests,
      reserved_response_bytes: lease.reserved.responseBytes,
      reserved_rpc_calls: lease.reserved.rpcCalls,
    };
    client.enqueue('authorization-read', [
      authorizationRow(createOperatorGrant(fixture.instanceIdHash)),
    ]);
    client.enqueue('expired-leases-lock', [
      { payload: lease, window_started_at: window.window_started_at },
    ]);
    client.enqueue('budget-window-lock', [reservedWindow]);
    client.enqueue('budget-window-update', [{ budget_id: fixture.policy.budgetId }]);

    const settlements = await store.reconcileExpiredLeases({
      asOf: '2026-07-22T10:02:00.000Z',
      workerIdHash: fixture.instanceIdHash,
    });

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      outcome: 'cancelled',
      usage: { costUnits: 0, requests: 0, responseBytes: 0, rpcCalls: 0 },
    });
  });
});

function createOperatorGrant(principalIdHash: string) {
  return createGovernanceAuthorization({
    grantedAt: '2026-07-21T00:00:00.000Z',
    grantedByHash: testHash('publisher'),
    principalIdHash,
    roles: ['provider_operator'],
    validUntil: '2027-07-22T00:00:00.000Z',
  });
}
