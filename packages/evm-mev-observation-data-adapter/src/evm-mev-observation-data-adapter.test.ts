import { analyzeEvmPriceImpactAndSandwich } from '@xxyy/evm-price-impact-sandwich-core';
import { describe, expect, it } from 'vitest';

import { getSqrtRatioAtTick } from './abi.js';
import { evmMevObservationDataAdapterResultSchema } from './contracts.js';
import {
  createEvmMevObservationDataAdapter,
  type EvmMevObservationDataAdapter,
} from './evm-mev-observation-data-adapter.js';
import {
  cloneReplayFixture,
  createReplayChainConfig,
  createReplayFetch,
  loadReplayFixture,
  replaceBlockHash,
  type MevReplayFixture,
  type V2ReplayFixture,
} from './replay-fixture.test-helper.js';

const fixedNow = () => new Date('2026-07-22T00:00:00.000Z');

describe('allowlisted MEV observation data adapter', () => {
  it('builds a replayable V2 neighborhood that the offline core confirms', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const { adapter, requests } = createAdapter(fixture, new Map([['primary.example', fixture]]));

    const result = await loadFixtureObservation(adapter, fixture);
    expect(result.status).toBe('success');
    expect(result.coverage).toEqual({
      actorAssetDeltas: 'complete',
      blockTransactions: 'complete',
      poolStates: 'complete',
      providersRequested: 1,
      providersSucceeded: 1,
    });
    expect(result.analysisInput?.neighborhood.observations).toHaveLength(3);
    expect(result.analysisInput?.neighborhood.observations[0]).toMatchObject({
      actorAssetDeltas: [
        { rawDelta: '-10000', tokenAddress: fixture.pool.token0 },
        { rawDelta: '9871', tokenAddress: fixture.pool.token1 },
      ],
      routeKind: 'single_pool',
      swapMode: 'exact_input',
      tokenBehavior: 'standard',
    });

    const analysis = analyzeEvmPriceImpactAndSandwich(result.analysisInput);
    expect(analysis.status).toBe('success');
    expect(analysis.sandwich).toMatchObject({
      attackerProfitRaw: '941',
      verdict: 'confirmed',
      victimLossRaw: '912',
    });
    expect(
      requests
        .flatMap((request) => request.calls)
        .some((call) => call.method === 'debug_traceTransaction'),
    ).toBe(false);
    expect(
      requests
        .flatMap((request) => request.calls)
        .filter((call) => call.method === 'eth_call')
        .every(
          (call) => (call.params[1] as { requireCanonical?: unknown }).requireCanonical === true,
        ),
    ).toBe(true);
  });

  it('builds a V3 single-range state proof and preserves official TickMath boundaries', async () => {
    const fixture = await loadReplayFixture('provider-v3');
    const { adapter, requests } = createAdapter(fixture, new Map([['primary.example', fixture]]));

    const result = await loadFixtureObservation(adapter, fixture);
    expect(result.status).toBe('success');
    const observation = result.analysisInput?.neighborhood.observations[0];
    expect(observation?.stateBefore).toMatchObject({
      activeRangeLowerSqrtPriceX96: getSqrtRatioAtTick(fixture.lowerTick).toString(),
      activeRangeUpperSqrtPriceX96: getSqrtRatioAtTick(fixture.upperTick).toString(),
      liquidity: fixture.parentState.liquidity,
      protocol: 'uniswap_v3',
      sqrtPriceX96: fixture.parentState.sqrtPriceX96,
      tick: '0',
    });
    expect(
      requests
        .flatMap((request) => request.calls)
        .filter((call) => call.method === 'eth_call')
        .map((call) => (call.params[0] as { data: string }).data.slice(0, 10)),
    ).toEqual(
      expect.arrayContaining([
        '0x3850c7bd',
        '0x1a686502',
        '0xd0c93a7c',
        '0x5339c296',
        '0xf30dba93',
      ]),
    );

    const analysis = analyzeEvmPriceImpactAndSandwich(result.analysisInput);
    expect(analysis.status).toBe('success');
    expect(analysis.priceImpact?.priceImpactPpm).toBe('3001');
    expect(analysis.sandwich.verdict).toBe('unlikely');
  });

  it('requires equal provider component fingerprints for a conflict-free result', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const { fetchImpl } = createReplayFetch(
      new Map([
        ['primary.example', fixture],
        ['secondary.example', fixture],
      ]),
    );
    const adapter = createEvmMevObservationDataAdapter({
      chains: [createReplayChainConfig(fixture, ['primary', 'secondary'])],
      fetchImpl,
      now: fixedNow,
    });

    const result = await loadFixtureObservation(adapter, fixture);
    expect(result.status).toBe('success');
    expect(result.conflicts).toEqual([]);
    expect(result.coverage.providersSucceeded).toBe(2);
    expect(result.analysisInput?.neighborhood.source.id).toBe('primary');
  });

  it.each<{
    field: 'actor_asset_deltas' | 'pool_state' | 'swap';
    expectedFields: Array<'actor_asset_deltas' | 'pool_state' | 'swap'>;
    mutate: (fixture: V2ReplayFixture) => void;
  }>([
    {
      expectedFields: ['swap', 'actor_asset_deltas'],
      field: 'actor_asset_deltas',
      mutate: (fixture) => {
        fixture.transactions[0]!.from = `0x${'dd'.repeat(20)}`;
      },
    },
    {
      expectedFields: ['pool_state'],
      field: 'pool_state',
      mutate: (fixture) => {
        const shift = (value: string) => (BigInt(value) + 1_000n).toString();
        fixture.parentState.reserve0Raw = shift(fixture.parentState.reserve0Raw);
        fixture.parentState.reserve1Raw = shift(fixture.parentState.reserve1Raw);
        fixture.endState.reserve0Raw = shift(fixture.endState.reserve0Raw);
        fixture.endState.reserve1Raw = shift(fixture.endState.reserve1Raw);
        for (const transaction of fixture.transactions) {
          transaction.swap.reserve0AfterRaw = shift(transaction.swap.reserve0AfterRaw);
          transaction.swap.reserve1AfterRaw = shift(transaction.swap.reserve1AfterRaw);
        }
      },
    },
    {
      expectedFields: ['swap'],
      field: 'swap',
      mutate: (fixture) => {
        fixture.exactInputSelector = '0x22222222';
      },
    },
  ])('projects a $field provider disagreement', async ({ expectedFields, mutate }) => {
    const fixture = await loadReplayFixture('provider-v2');
    const conflicting = cloneReplayFixture(fixture);
    mutate(conflicting);
    const { fetchImpl } = createReplayFetch(
      new Map([
        ['primary.example', fixture],
        ['secondary.example', conflicting],
      ]),
    );
    const adapter = createEvmMevObservationDataAdapter({
      chains: [createReplayChainConfig(fixture, ['primary', 'secondary'])],
      fetchImpl,
      now: fixedNow,
    });

    const result = await loadFixtureObservation(adapter, fixture);
    expect(result.status).toBe('partial');
    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(expectedFields);
    expect(result.analysisInput?.neighborhood.conflicts.map((conflict) => conflict.field)).toEqual(
      expectedFields,
    );
  });

  it('projects a provider reorg disagreement into the core conflict contract', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const conflicting = replaceBlockHash(fixture, `0x${'8'.repeat(64)}`);
    const { fetchImpl } = createReplayFetch(
      new Map([
        ['primary.example', fixture],
        ['secondary.example', conflicting],
      ]),
    );
    const adapter = createEvmMevObservationDataAdapter({
      chains: [createReplayChainConfig(fixture, ['primary', 'secondary'])],
      fetchImpl,
      now: fixedNow,
    });

    const result = await loadFixtureObservation(adapter, fixture);
    expect(result.status).toBe('partial');
    expect(result.conflicts).toMatchObject([
      {
        field: 'block_transactions',
        observations: [{ providerId: 'primary' }, { providerId: 'secondary' }],
        subject: fixture.targetTransactionHash,
      },
    ]);
    expect(result.analysisInput?.neighborhood.conflicts[0]).toEqual({
      field: 'block_transactions',
      sourceIds: ['primary', 'secondary'],
      subject: fixture.targetTransactionHash,
    });
    expect(analyzeEvmPriceImpactAndSandwich(result.analysisInput).sandwich.verdict).toBe(
      'insufficient_data',
    );
  });

  it('keeps a canonical replay partial when another provider is unavailable without leaking details', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const replay = createReplayFetch(
      new Map([
        ['primary.example', fixture],
        ['secondary.example', fixture],
      ]),
      { transportFailureHosts: new Set(['secondary.example']) },
    );
    const adapter = createEvmMevObservationDataAdapter({
      chains: [createReplayChainConfig(fixture, ['primary', 'secondary'])],
      fetchImpl: replay.fetchImpl,
      maxRetries: 0,
      now: fixedNow,
    });

    const result = await loadFixtureObservation(adapter, fixture);
    expect(result.status).toBe('partial');
    expect(result.analysisInput).toBeDefined();
    expect(result.coverage.providersSucceeded).toBe(1);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'transport_error', providerId: 'secondary' }),
    );
    expect(JSON.stringify(result)).not.toContain('offline replay provider detail');
  });

  it('fails closed when canonical archive state calls are unsupported', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const replay = createReplayFetch(new Map([['primary.example', fixture]]), {
      rpcErrorHosts: new Set(['primary.example']),
    });
    const adapter = createEvmMevObservationDataAdapter({
      chains: [createReplayChainConfig(fixture)],
      fetchImpl: replay.fetchImpl,
      now: fixedNow,
    });

    const result = await loadFixtureObservation(adapter, fixture);
    expect(result.status).toBe('insufficient_data');
    expect(result.analysisInput).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'archive_state_unavailable' }),
    );
  });

  it('detects event replay and block-end state disagreement', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const mismatched = cloneReplayFixture(fixture);
    if (mismatched.pool.protocol !== 'uniswap_v2') {
      throw new Error('Expected a V2 fixture.');
    }
    mismatched.endState.reserve0Raw = '1049060';
    const { adapter } = createAdapter(mismatched, new Map([['primary.example', mismatched]]));

    const result = await loadFixtureObservation(adapter, mismatched);
    expect(result.status).toBe('insufficient_data');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'end_state_mismatch' }),
    );
  });

  it('enforces the configured relevant-transaction budget before fetching receipts', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const replay = createReplayFetch(new Map([['primary.example', fixture]]));
    const adapter = createEvmMevObservationDataAdapter({
      chains: [createReplayChainConfig(fixture)],
      fetchImpl: replay.fetchImpl,
      maxRelevantTransactions: 2,
      now: fixedNow,
    });

    const result = await loadFixtureObservation(adapter, fixture);
    expect(result.status).toBe('insufficient_data');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'pool_logs_limit_exceeded' }),
    );
    expect(
      replay.requests
        .flatMap((request) => request.calls)
        .some((call) => call.method === 'eth_getTransactionReceipt'),
    ).toBe(false);
  });

  it('uses bounded immutable-call cache entries without changing analysis bytes', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const { adapter } = createAdapter(fixture, new Map([['primary.example', fixture]]));

    const first = await loadFixtureObservation(adapter, fixture);
    const second = await loadFixtureObservation(adapter, fixture);
    expect(JSON.stringify(second.analysisInput)).toBe(JSON.stringify(first.analysisInput));
    expect(first.usage.cacheHits).toBe(0);
    expect(second.usage.cacheHits).toBeGreaterThan(0);
    expect(second.usage.requests).toBe(0);
  });

  it('marks unregistered router semantics unknown so the core cannot guess exact-input math', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const chain = createReplayChainConfig(fixture);
    chain.pools[0]!.exactInputRoutes[0]!.selectors = ['0x22222222'];
    const replay = createReplayFetch(new Map([['primary.example', fixture]]));
    const adapter = createEvmMevObservationDataAdapter({
      chains: [chain],
      fetchImpl: replay.fetchImpl,
      now: fixedNow,
    });

    const result = await loadFixtureObservation(adapter, fixture);
    expect(result.status).toBe('success');
    expect(result.analysisInput?.neighborhood.observations[1]?.swapMode).toBe('unknown');
    const analysis = analyzeEvmPriceImpactAndSandwich(result.analysisInput);
    expect(analysis.status).toBe('insufficient_data');
    expect(analysis.priceImpact).toBeUndefined();
  });

  it('is byte-deterministic across fresh fixture replays', async () => {
    const fixture = await loadReplayFixture('provider-v2');
    const firstAdapter = createAdapter(fixture, new Map([['primary.example', fixture]])).adapter;
    const secondAdapter = createAdapter(fixture, new Map([['primary.example', fixture]])).adapter;
    const first = await loadFixtureObservation(firstAdapter, fixture);
    const second = await loadFixtureObservation(secondAdapter, fixture);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(evmMevObservationDataAdapterResultSchema.parse(first)).toEqual(first);
  });
});

function createAdapter(
  fixture: MevReplayFixture,
  fixtures: ReadonlyMap<string, MevReplayFixture>,
): {
  adapter: EvmMevObservationDataAdapter;
  requests: ReturnType<typeof createReplayFetch>['requests'];
} {
  const replay = createReplayFetch(fixtures);
  return {
    adapter: createEvmMevObservationDataAdapter({
      chains: [createReplayChainConfig(fixture)],
      fetchImpl: replay.fetchImpl,
      now: fixedNow,
    }),
    requests: replay.requests,
  };
}

function loadFixtureObservation(adapter: EvmMevObservationDataAdapter, fixture: MevReplayFixture) {
  return adapter.loadObservation({
    chainId: fixture.chainId,
    poolAddress: fixture.pool.poolAddress,
    targetTransactionHash: fixture.targetTransactionHash,
  });
}
