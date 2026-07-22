import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  MAX_NEIGHBORHOOD_TRANSACTIONS,
  evmMevPoolSchema,
  evmPriceImpactSandwichInputSchema,
  evmRationalSchema,
  evmSandwichAssessmentSchema,
  evmV3PoolStateSchema,
  type EvmPriceImpactSandwichInput,
} from './contracts.js';

async function loadFixture(name: string): Promise<EvmPriceImpactSandwichInput> {
  return evmPriceImpactSandwichInputSchema.parse(
    JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')),
  );
}

describe('price impact and sandwich contracts', () => {
  it('parses the V2 and V3 replay envelopes', async () => {
    const confirmed = await loadFixture('confirmed-v2');
    const unlikely = await loadFixture('unlikely-v3');

    expect(confirmed.neighborhood.observations).toHaveLength(3);
    expect(confirmed.pool).toMatchObject({ feePips: 3000, protocol: 'uniswap_v2' });
    expect(unlikely.pool.protocol).toBe('uniswap_v3');
  });

  it('requires one unique target, transaction hash, and transaction index', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const duplicate = structuredClone(fixture);
    duplicate.neighborhood.observations[1] = {
      ...duplicate.neighborhood.observations[1]!,
      transactionHash: duplicate.neighborhood.observations[0]!.transactionHash,
      transactionIndex: duplicate.neighborhood.observations[0]!.transactionIndex,
    };

    expect(() => evmPriceImpactSandwichInputSchema.parse(duplicate)).toThrow();
    expect(() =>
      evmPriceImpactSandwichInputSchema.parse({
        ...fixture,
        targetTransactionHash: `0x${'1'.repeat(64)}`,
      }),
    ).toThrow();
  });

  it('reconciles every observation to the one configured pool and block', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const mismatchedPool = structuredClone(fixture);
    mismatchedPool.neighborhood.observations[0]!.swap.poolAddress =
      '0x4444444444444444444444444444444444444444';
    const mismatchedBlock = structuredClone(fixture);
    mismatchedBlock.neighborhood.observations[0]!.blockNumber = '101';

    expect(() => evmPriceImpactSandwichInputSchema.parse(mismatchedPool)).toThrow();
    expect(() => evmPriceImpactSandwichInputSchema.parse(mismatchedBlock)).toThrow();
  });

  it('does not allow complete actor coverage to omit per-transaction deltas', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const missing = structuredClone(fixture);
    delete missing.neighborhood.observations[0]!.actorAssetDeltas;

    expect(() => evmPriceImpactSandwichInputSchema.parse(missing)).toThrow();

    missing.neighborhood.coverage.actorAssetDeltas = 'partial';
    expect(evmPriceImpactSandwichInputSchema.parse(missing)).toBeDefined();
  });

  it('enforces canonical V2 fees, sorted nonzero tokens, and bounded V3 active ranges', async () => {
    const fixture = await loadFixture('confirmed-v2');
    expect(() => evmMevPoolSchema.parse({ ...fixture.pool, feePips: 500 })).toThrow();
    expect(() =>
      evmMevPoolSchema.parse({ ...fixture.pool, token1: fixture.pool.token0 }),
    ).toThrow();

    const v3 = await loadFixture('unlikely-v3');
    const state = v3.neighborhood.observations[0]!.stateBefore;
    if (state.protocol !== 'uniswap_v3') {
      throw new Error('Expected a V3 fixture state.');
    }
    expect(() =>
      evmV3PoolStateSchema.parse({
        ...state,
        activeRangeLowerSqrtPriceX96: state.sqrtPriceX96,
      }),
    ).toThrow();
  });

  it('caps the neighborhood before analysis', async () => {
    const fixture = await loadFixture('unlikely-v3');
    const observation = fixture.neighborhood.observations[0]!;
    const oversized = {
      ...fixture,
      neighborhood: {
        ...fixture.neighborhood,
        observations: Array.from({ length: MAX_NEIGHBORHOOD_TRANSACTIONS + 1 }, (_, index) => ({
          ...observation,
          transactionHash: `0x${index.toString(16).padStart(64, '0')}`,
          transactionIndex: index,
        })),
      },
    };

    expect(() => evmPriceImpactSandwichInputSchema.parse(oversized)).toThrow();
  });

  it('keeps confirmed and likely candidate fields explicit', () => {
    const base = {
      assetLoopVerified: false,
      evidenceIds: ['transaction:target'],
      reasonCodes: ['actor_deltas_missing'] as const,
      verdict: 'likely' as const,
    };
    expect(() => evmSandwichAssessmentSchema.parse(base)).toThrow();
    expect(() =>
      evmSandwichAssessmentSchema.parse({
        ...base,
        assetLoopVerified: true,
        verdict: 'likely',
      }),
    ).toThrow();
  });

  it('keeps V3 spot-price rationals lossless beyond uint256', () => {
    expect(
      evmRationalSchema.parse({ denominator: '1', numerator: (1n << 300n).toString() }),
    ).toBeDefined();
    expect(() =>
      evmRationalSchema.parse({ denominator: '1', numerator: (1n << 513n).toString() }),
    ).toThrow();
  });
});
