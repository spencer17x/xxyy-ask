import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  EvmAmmMathError,
  compareRationals,
  quoteExactInput,
  reduceRational,
  validateObservationQuote,
} from './amm-math.js';
import {
  evmPriceImpactSandwichInputSchema,
  type EvmPriceImpactSandwichInput,
} from './contracts.js';

async function loadFixture(name: string): Promise<EvmPriceImpactSandwichInput> {
  return evmPriceImpactSandwichInputSchema.parse(
    JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')),
  );
}

describe('lossless AMM math', () => {
  it('matches the canonical Uniswap V2 997/1000 exact-input quote', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const front = fixture.neighborhood.observations[0]!;
    const quote = quoteExactInput(fixture.pool, front.stateBefore, '10000', 'token0_to_token1');

    expect(quote).toMatchObject({
      amountOutRaw: '9871',
      executionPrice: { denominator: '10000', numerator: '9871' },
      model: 'uniswap_v2_exact_input',
      priceImpactPpm: '12900',
      spotPriceBefore: { denominator: '1', numerator: '1' },
    });
    expect(validateObservationQuote(fixture.pool, front).amountOutRaw).toBe('9871');
  });

  it('matches the official V3 single-range exact-input rounding in both directions', async () => {
    const fixture = await loadFixture('unlikely-v3');
    const state = fixture.neighborhood.observations[0]!.stateBefore;
    if (state.protocol !== 'uniswap_v3') {
      throw new Error('Expected a V3 fixture state.');
    }
    const zeroForOne = quoteExactInput(fixture.pool, state, '1000000', 'token0_to_token1');
    const oneForZero = quoteExactInput(fixture.pool, state, '1000000', 'token1_to_token0');

    expect(zeroForOne).toMatchObject({
      amountOutRaw: '996999',
      nextSqrtPriceX96: '79228083523865064300074843162',
      priceImpactPpm: '3001',
    });
    expect(oneForZero).toMatchObject({
      amountOutRaw: '996999',
      nextSqrtPriceX96: '79228241504742364315088531099',
      priceImpactPpm: '3001',
    });
  });

  it('rejects tick crossing instead of silently applying constant-liquidity math', async () => {
    const fixture = await loadFixture('unlikely-v3');
    const state = fixture.neighborhood.observations[0]!.stateBefore;
    if (state.protocol !== 'uniswap_v3') {
      throw new Error('Expected a V3 fixture state.');
    }

    expect(() =>
      quoteExactInput(
        fixture.pool,
        {
          ...state,
          activeRangeLowerSqrtPriceX96: '79228090000000000000000000000',
        },
        '1000000',
        'token0_to_token1',
      ),
    ).toThrowError(expect.objectContaining({ code: 'unsupported_active_tick_crossing' }));
  });

  it('rejects routes, modes, token behavior, quote deviations, and state deviations', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const front = fixture.neighborhood.observations[0]!;
    if (front.swap.protocol !== 'uniswap_v2' || front.stateAfter.protocol !== 'uniswap_v2') {
      throw new Error('Expected a V2 fixture observation.');
    }
    const swap = front.swap;
    const stateAfter = front.stateAfter;
    for (const observation of [
      { ...front, routeKind: 'multi_hop' as const },
      { ...front, swapMode: 'exact_output' as const },
      { ...front, tokenBehavior: 'fee_on_transfer' as const },
    ]) {
      expect(() => validateObservationQuote(fixture.pool, observation)).toThrow(EvmAmmMathError);
    }

    expect(() =>
      validateObservationQuote(fixture.pool, {
        ...front,
        swap: {
          ...swap,
          amount1OutRaw: '9870',
          amount1PoolDeltaRaw: '-9870',
          amountOutRaw: '9870',
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'quote_mismatch' }));
    expect(() =>
      validateObservationQuote(fixture.pool, {
        ...front,
        stateAfter: { ...stateAfter, reserve0Raw: '1010001' },
      }),
    ).toThrowError(expect.objectContaining({ code: 'pool_state_transition_mismatch' }));
  });

  it('uses reduced rational comparisons without floating point', () => {
    expect(reduceRational(10n, 20n)).toEqual({ denominator: '2', numerator: '1' });
    expect(
      compareRationals({ denominator: '3', numerator: '2' }, { denominator: '2', numerator: '1' }),
    ).toBe(1);
  });
});
