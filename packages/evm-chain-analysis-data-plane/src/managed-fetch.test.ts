import { describe, expect, it, vi } from 'vitest';

import {
  createSharedProviderCircuitState,
  materializeGrantedProviderBudgetLease,
  settleProviderBudgetLease,
  transitionSharedProviderCircuitState,
  type ProductionAuditEvent,
  type ProviderBudgetLease,
  type SharedProviderCircuitState,
} from '@xxyy/evm-chain-analysis-readiness';

import { createMemoryProviderResponseCache } from './cache.js';
import { createProviderBinding, testHash } from './fixtures.test-helper.js';
import { createManagedProviderFetch, type ProductionProviderControls } from './managed-fetch.js';
import type { ResolvedProductionProvider } from './secret-resolver.js';

describe('managed production provider transport', () => {
  it('reserves and settles shared budget, persists redacted audit, and serves bounded cache hits', async () => {
    const provider = resolvedProvider();
    const controls = createControls(provider);
    const transportFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ id: 1, jsonrpc: '2.0', result: '0x1' }]), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      ),
    );
    const managedFetch = createManagedProviderFetch({
      adapter: 'snapshot',
      cache: createMemoryProviderResponseCache({ maxEntries: 4, maxTotalBytes: 4_096 }),
      chainId: '1',
      controls,
      fetchImpl: transportFetch,
      instanceIdHash: testHash('runtime'),
      manifestFingerprint: testHash('manifest'),
      now: () => '2026-07-23T00:01:00.000Z',
      nowMs: () => 1_000,
      providers: [provider],
      transport: {
        cacheTtlMs: 30_000,
        circuitFailureThreshold: 2,
        circuitOpenMs: 30_000,
        maxResponseBytes: 1_024,
        maxRetries: 0,
        requestTimeoutMs: 10_000,
      },
    });
    const init = {
      body: JSON.stringify([{ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }]),
      headers: approvedHeaders(),
      method: 'POST',
      redirect: 'error' as const,
    };

    expect(await (await managedFetch(provider.endpoint, init)).json()).toEqual([
      { id: 1, jsonrpc: '2.0', result: '0x1' },
    ]);
    expect(await (await managedFetch(provider.endpoint, init)).json()).toEqual([
      { id: 1, jsonrpc: '2.0', result: '0x1' },
    ]);

    expect(transportFetch).toHaveBeenCalledTimes(1);
    expect(controls.leases).toHaveLength(1);
    expect(controls.settlements).toHaveLength(1);
    expect(controls.events.map((event) => event.resultCode)).toEqual(['success', 'cache_hit']);
    expect(JSON.stringify(controls.events)).not.toContain(provider.endpoint);
  });

  it('fails closed before network I/O when budget or circuit control is unavailable', async () => {
    const provider = resolvedProvider();
    const fetchImpl = vi.fn<typeof fetch>();
    const budgetFailure = createControls(provider);
    budgetFailure.reserve = () => Promise.reject(new Error('database unavailable'));
    const budgetManagedFetch = managed(provider, budgetFailure, fetchImpl);
    await expect(budgetManagedFetch(provider.endpoint, rpcInit())).rejects.toMatchObject({
      code: 'budget_unavailable',
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const circuitFailure = createControls(provider);
    circuitFailure.read = () => Promise.reject(new Error('database unavailable'));
    const circuitManagedFetch = managed(provider, circuitFailure, fetchImpl);
    await expect(circuitManagedFetch(provider.endpoint, rpcInit())).rejects.toMatchObject({
      code: 'circuit_unavailable',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks a fetched response when atomic budget and audit completion is unavailable', async () => {
    const provider = resolvedProvider();
    const controls = createControls(provider);
    const completion = vi.fn(() => Promise.reject(new Error('database unavailable')));
    controls.completeProviderRequest = completion;
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('[]', { status: 200 })),
    );
    const managedFetch = managed(provider, controls, fetchImpl);

    await expect(managedFetch(provider.endpoint, rpcInit())).rejects.toMatchObject({
      code: 'audit_unavailable',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(completion).toHaveBeenCalledTimes(2);
    expect(controls.events).toHaveLength(0);
  });

  it('opens the shared circuit after retryable provider failures and blocks later attempts', async () => {
    const provider = resolvedProvider();
    const controls = createControls(provider);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('busy', { status: 503 })),
    );
    const managedFetch = managed(provider, controls, fetchImpl);

    expect((await managedFetch(provider.endpoint, rpcInit())).status).toBe(503);
    expect((await managedFetch(provider.endpoint, rpcInit())).status).toBe(503);
    await expect(managedFetch(provider.endpoint, rpcInit())).rejects.toMatchObject({
      code: 'circuit_open',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(controls.state.state).toBe('open');
    expect(controls.events.map((event) => event.resultCode)).toEqual(['http_503', 'http_503']);
  });

  it('uses unique budget reservations for concurrent attempts even when the wall clock is equal', async () => {
    const provider = resolvedProvider();
    const controls = createControls(provider);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('[]', { status: 200 })),
    );
    const managedFetch = managed(provider, controls, fetchImpl);

    await Promise.all([
      managedFetch(provider.endpoint, rpcInit()),
      managedFetch(provider.endpoint, rpcInit()),
    ]);

    expect(controls.leases).toHaveLength(2);
    expect(new Set(controls.leases.map((lease) => lease.leaseId)).size).toBe(2);
    expect(controls.events).toHaveLength(2);
  });

  it('forces an eligible half-open probe past cache and closes the circuit on a response', async () => {
    const provider = resolvedProvider();
    const controls = createControls(provider);
    const cache = createMemoryProviderResponseCache({
      maxEntries: 4,
      maxTotalBytes: 4_096,
    });
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('[]', { status: 200 })),
    );
    const managedFetch = createManagedProviderFetch({
      adapter: 'snapshot',
      cache,
      chainId: '1',
      controls,
      fetchImpl,
      instanceIdHash: testHash('runtime'),
      manifestFingerprint: testHash('manifest'),
      now: () => '2026-07-23T00:01:00.000Z',
      nowMs: () => 1_000,
      providers: [provider],
      transport: transport(),
    });

    await managedFetch(provider.endpoint, rpcInit());
    openCircuitForProbe(controls);
    await managedFetch(provider.endpoint, rpcInit());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(controls.state.state).toBe('closed');
    expect(controls.state.lastTransitionReason).toBe('probe_succeeded');
  });

  it('returns a claimed probe to open state when shared budget rejects before network I/O', async () => {
    const provider = resolvedProvider();
    const controls = createControls(provider);
    const fetchImpl = vi.fn<typeof fetch>();
    openCircuitForProbe(controls);
    controls.reserve = () =>
      Promise.reject(Object.assign(new Error('exhausted'), { code: 'budget_exhausted' }));
    const managedFetch = managed(provider, controls, fetchImpl);

    await expect(managedFetch(provider.endpoint, rpcInit())).rejects.toMatchObject({
      code: 'budget_unavailable',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(controls.state.state).toBe('open');
    expect(controls.state.lastTransitionReason).toBe('probe_deferred');
  });

  it('stops reading a streaming response at the approved byte limit', async () => {
    const provider = resolvedProvider();
    const controls = createControls(provider);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
        controller.close();
      },
    });
    const managedFetch = managed(
      provider,
      controls,
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, { status: 200 }))),
    );

    await expect(managedFetch(provider.endpoint, rpcInit())).rejects.toMatchObject({
      code: 'provider_response_too_large',
    });
    expect(controls.events).toHaveLength(1);
    expect(controls.events[0]).toMatchObject({
      resultCode: 'response_too_large',
      usage: { responseBytes: 1_024 },
    });
  });

  it('rejects oversized request bodies and insecure remote endpoints before control or network I/O', async () => {
    const provider = resolvedProvider();
    const controls = createControls(provider);
    const fetchImpl = vi.fn<typeof fetch>();
    const managedFetch = managed(provider, controls, fetchImpl);

    await expect(
      managedFetch(provider.endpoint, {
        ...rpcInit(),
        body: 'x'.repeat(4 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(controls.leases).toHaveLength(0);

    await expect(
      managedFetch(provider.endpoint, {
        ...rpcInit(),
        body: `${'['.repeat(66)}0${']'.repeat(66)}`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });

    expect(() =>
      managed({ ...provider, endpoint: 'http://rpc.example/v1' }, controls, fetchImpl),
    ).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
  });
});

interface TestControls extends ProductionProviderControls {
  events: ProductionAuditEvent[];
  leases: ProviderBudgetLease[];
  settlements: unknown[];
  state: SharedProviderCircuitState;
}

function createControls(provider: ResolvedProductionProvider): TestControls {
  const events: ProductionAuditEvent[] = [];
  const leases: ProviderBudgetLease[] = [];
  const settlements: unknown[] = [];
  const controls: TestControls = {
    events,
    leases,
    settlements,
    state: createSharedProviderCircuitState({
      adapter: provider.adapter,
      chainId: provider.binding.descriptor.chainId,
      consecutiveFailures: 0,
      generation: 0,
      lastTransitionReason: 'production_bootstrap',
      providerId: provider.binding.descriptor.providerId,
      state: 'closed',
      updatedAt: '2026-07-23T00:00:00.000Z',
    }),
    completeProviderRequest(input) {
      return controls.settle(input.settlement).then((settlement) =>
        controls
          .recordProviderRequest({
            actorIdHash: input.actorIdHash,
            event: input.event,
          })
          .then((event) => ({ event, settlement })),
      );
    },
    compareAndSet(input) {
      if (
        input.expectedGeneration !== controls.state.generation ||
        input.expectedStateFingerprint !== controls.state.stateFingerprint
      ) {
        return Promise.reject(Object.assign(new Error('stale'), { code: 'stale_generation' }));
      }
      controls.state = transitionSharedProviderCircuitState(controls.state, input.next);
      return Promise.resolve(controls.state);
    },
    read() {
      return Promise.resolve(controls.state);
    },
    recordProviderRequest(input) {
      const event = input.event as ProductionAuditEvent;
      events.push(event);
      return Promise.resolve(event);
    },
    reserve(input) {
      const lease = materializeGrantedProviderBudgetLease(
        provider.binding.budgetPolicy,
        input,
        input.requestedAt,
      );
      leases.push(lease);
      return Promise.resolve(lease);
    },
    settle(input) {
      const lease = leases.find((candidate) => candidate.leaseId === input.leaseId);
      if (lease === undefined) {
        return Promise.reject(new Error('missing lease'));
      }
      const settlement = settleProviderBudgetLease(lease, input);
      settlements.push(settlement);
      return Promise.resolve(settlement);
    },
  };
  return controls;
}

function resolvedProvider(): ResolvedProductionProvider {
  const binding = createProviderBinding('snapshot', 'primary');
  return {
    adapter: 'snapshot',
    binding,
    endpoint: 'https://snapshot-primary.rpc.invalid/v1',
    headers: { authorization: 'Bearer secret' },
  };
}

function managed(
  provider: ResolvedProductionProvider,
  controls: ProductionProviderControls,
  fetchImpl: typeof fetch,
): typeof fetch {
  return createManagedProviderFetch({
    adapter: 'snapshot',
    chainId: '1',
    controls,
    fetchImpl,
    instanceIdHash: testHash('runtime'),
    manifestFingerprint: testHash('manifest'),
    now: () => '2026-07-23T00:01:00.000Z',
    nowMs: () => 1_000,
    providers: [provider],
    transport: transport(0),
  });
}

function transport(cacheTtlMs = 30_000) {
  return {
    cacheTtlMs,
    circuitFailureThreshold: 2,
    circuitOpenMs: 30_000,
    maxResponseBytes: 1_024,
    maxRetries: 0,
    requestTimeoutMs: 10_000,
  };
}

function openCircuitForProbe(controls: TestControls): void {
  controls.state = transitionSharedProviderCircuitState(controls.state, {
    adapter: controls.state.adapter,
    chainId: controls.state.chainId,
    consecutiveFailures: 2,
    generation: controls.state.generation + 1,
    lastTransitionReason: 'failure_threshold',
    nextProbeAt: '2026-07-23T00:00:30.000Z',
    openedAt: '2026-07-23T00:00:10.000Z',
    providerId: controls.state.providerId,
    state: 'open',
    updatedAt: '2026-07-23T00:00:10.000Z',
  });
}

function rpcInit(): RequestInit {
  return {
    body: JSON.stringify([{ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }]),
    headers: approvedHeaders(),
    method: 'POST',
    redirect: 'error',
  };
}

function approvedHeaders(): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: 'Bearer secret',
    'content-type': 'application/json',
  };
}
