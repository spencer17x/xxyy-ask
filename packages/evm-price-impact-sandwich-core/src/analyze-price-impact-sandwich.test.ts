import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { analyzeEvmPriceImpactAndSandwich } from './analyze-price-impact-sandwich.js';
import {
  evmPriceImpactSandwichInputSchema,
  evmPriceImpactSandwichResultSchema,
  type EvmPriceImpactSandwichInput,
} from './contracts.js';

async function loadFixture(name: string): Promise<EvmPriceImpactSandwichInput> {
  return evmPriceImpactSandwichInputSchema.parse(
    JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')),
  );
}

describe('offline price impact and sandwich analysis', () => {
  it('confirms only the strict V2 ordering, victim-loss, profit, and actor-loop replay', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const result = analyzeEvmPriceImpactAndSandwich(fixture);

    expect(result.status).toBe('success');
    expect(result.priceImpact).toMatchObject({
      amountInRaw: '50000',
      amountOutRaw: '46570',
      expectedAmountOutRaw: '46570',
      model: 'uniswap_v2_exact_input',
      priceImpactPpm: '49907',
    });
    expect(result.sandwich).toMatchObject({
      assetLoopVerified: true,
      attacker: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      attackerProfitRaw: '941',
      counterfactualAmountOutRaw: '47482',
      intermediateRemainderRaw: '0',
      verdict: 'confirmed',
      victimLossPpm: '19207',
      victimLossRaw: '912',
    });
    expect(result.diagnostics).toEqual([]);
    expect(evmPriceImpactSandwichResultSchema.parse(result)).toEqual(result);
  });

  it('returns likely when pool-level profit closes but actor deltas are unavailable', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const partial = structuredClone(fixture);
    partial.neighborhood.coverage.actorAssetDeltas = 'partial';
    delete partial.neighborhood.observations[0]!.actorAssetDeltas;
    delete partial.neighborhood.observations[2]!.actorAssetDeltas;

    const result = analyzeEvmPriceImpactAndSandwich(partial);
    expect(result.status).toBe('partial');
    expect(result.sandwich).toMatchObject({
      assetLoopVerified: false,
      attackerProfitRaw: '941',
      reasonCodes: [
        'counterfactual_victim_loss',
        'implied_asset_loop_profitable',
        'actor_deltas_missing',
      ],
      verdict: 'likely',
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'actor_deltas_missing' }),
    );
  });

  it('can confirm a complete local triple while marking wider neighborhood coverage partial', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const partial = structuredClone(fixture);
    partial.neighborhood.coverage.blockTransactions = 'partial';

    const result = analyzeEvmPriceImpactAndSandwich(partial);
    expect(result.status).toBe('partial');
    expect(result.sandwich.verdict).toBe('confirmed');
  });

  it('returns unlikely for a complete supported V3 neighborhood with no bracket', async () => {
    const fixture = await loadFixture('unlikely-v3');
    const result = analyzeEvmPriceImpactAndSandwich(fixture);

    expect(result.status).toBe('success');
    expect(result.coverage).toMatchObject({
      quote: 'available',
      supportedObservations: 1,
    });
    expect(result.priceImpact).toMatchObject({
      expectedAmountOutRaw: '996999',
      model: 'uniswap_v3_single_range_exact_input',
      priceImpactPpm: '3001',
    });
    expect(result.sandwich).toMatchObject({
      reasonCodes: ['no_adjacent_bracketing_transactions'],
      verdict: 'unlikely',
    });
  });

  it('does not call a structural pattern likely when complete actor deltas contradict it', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const contradicted = structuredClone(fixture);
    contradicted.neighborhood.observations[2]!.actorAssetDeltas![0]!.rawDelta = '10940';

    const result = analyzeEvmPriceImpactAndSandwich(contradicted);
    expect(result.status).toBe('success');
    expect(result.sandwich).toMatchObject({
      reasonCodes: ['actor_deltas_contradict_loop'],
      verdict: 'unlikely',
    });
  });

  it('returns insufficient data on source conflict even when a local triple looks valid', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const conflicted = structuredClone(fixture);
    conflicted.neighborhood.conflicts.push({
      field: 'pool_state',
      sourceIds: ['fixture_replay', 'fixture_secondary'],
      subject: fixture.pool.poolAddress,
    });

    const result = analyzeEvmPriceImpactAndSandwich(conflicted);
    expect(result.status).toBe('partial');
    expect(result.priceImpact).toBeDefined();
    expect(result.sandwich).toMatchObject({
      reasonCodes: ['source_conflict'],
      verdict: 'insufficient_data',
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'source_conflict' }));
  });

  it('degrades unsupported target routes and special token behavior without heuristics', async () => {
    const fixture = await loadFixture('unlikely-v3');
    for (const target of [
      { ...fixture.neighborhood.observations[0]!, routeKind: 'aggregator' as const },
      {
        ...fixture.neighborhood.observations[0]!,
        tokenBehavior: 'fee_on_transfer' as const,
      },
      { ...fixture.neighborhood.observations[0]!, swapMode: 'exact_output' as const },
    ]) {
      const input = {
        ...fixture,
        neighborhood: { ...fixture.neighborhood, observations: [target] },
      };
      const result = analyzeEvmPriceImpactAndSandwich(input);
      expect(result.status).toBe('insufficient_data');
      expect(result.coverage.quote).toBe('unsupported');
      expect(result.priceImpact).toBeUndefined();
      expect(result.sandwich.verdict).toBe('insufficient_data');
    }
  });

  it('requires complete coverage before emitting an unlikely verdict', async () => {
    const fixture = await loadFixture('unlikely-v3');
    const partial = structuredClone(fixture);
    partial.neighborhood.coverage.blockTransactions = 'partial';

    const result = analyzeEvmPriceImpactAndSandwich(partial);
    expect(result.status).toBe('partial');
    expect(result.sandwich).toMatchObject({
      reasonCodes: ['neighborhood_incomplete', 'no_adjacent_bracketing_transactions'],
      verdict: 'insufficient_data',
    });
  });

  it('is byte-deterministic across replay runs and retains only bounded evidence', async () => {
    const fixture = await loadFixture('confirmed-v2');
    const first = analyzeEvmPriceImpactAndSandwich(fixture);
    const second = analyzeEvmPriceImpactAndSandwich(structuredClone(fixture));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.evidence.length).toBeLessThan(20);
    expect(JSON.stringify(first)).not.toContain('revertReason');
  });
});
