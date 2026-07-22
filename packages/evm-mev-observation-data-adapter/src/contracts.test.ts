import { describe, expect, it } from 'vitest';

import {
  evmMevObservationDataAdapterConfigSchema,
  evmMevObservationProviderSummarySchema,
  loadEvmMevObservationInputSchema,
} from './contracts.js';
import {
  V2_GET_RESERVES_SELECTOR,
  V3_TICKS_SELECTOR,
  createCanonicalBlockReference,
  encodeSignedWord,
  mevObservationRpcCallSchema,
} from './rpc-contracts.js';

const transactionHash = `0x${'aa'.repeat(32)}`;
const blockHash = `0x${'bb'.repeat(32)}`;
const poolAddress = `0x${'33'.repeat(20)}`;
const token0 = `0x${'11'.repeat(20)}`;
const token1 = `0x${'22'.repeat(20)}`;
const routerAddress = `0x${'44'.repeat(20)}`;

function validChainConfig() {
  return {
    chainId: '1',
    pools: [
      {
        exactInputRoutes: [{ selectors: ['0x12345678'], to: routerAddress }],
        feePips: 3_000,
        poolAddress,
        protocol: 'uniswap_v2' as const,
        token0,
        token1,
        tokenBehavior: 'standard' as const,
      },
    ],
    providers: [
      {
        archive: true as const,
        endpoint: 'https://rpc.example/private',
        id: 'rpc_primary',
      },
    ],
  };
}

describe('MEV observation startup and runtime contracts', () => {
  it('normalizes only startup-frozen archive providers, pools, and exact-input routes', () => {
    const config = evmMevObservationDataAdapterConfigSchema.parse([validChainConfig()]);

    expect(config[0]).toMatchObject({
      chainId: '1',
      pools: [
        {
          exactInputRoutes: [{ selectors: ['0x12345678'], to: routerAddress }],
          feePips: 3_000,
          poolAddress,
          protocol: 'uniswap_v2',
          token0,
          token1,
          tokenBehavior: 'standard',
        },
      ],
      providers: [{ archive: true, costUnitsPerRequest: 1, id: 'rpc_primary' }],
    });
  });

  it('rejects non-archive providers, non-canonical V2 fees, and ambiguous pool identity', () => {
    const nonArchive = validChainConfig();
    nonArchive.providers[0] = {
      ...nonArchive.providers[0]!,
      archive: false as never,
    };
    expect(() => evmMevObservationDataAdapterConfigSchema.parse([nonArchive])).toThrow();

    const badFee = validChainConfig();
    badFee.pools[0]!.feePips = 500;
    expect(() => evmMevObservationDataAdapterConfigSchema.parse([badFee])).toThrow();

    const unsorted = validChainConfig();
    unsorted.pools[0]!.token0 = token1;
    unsorted.pools[0]!.token1 = token0;
    expect(() => evmMevObservationDataAdapterConfigSchema.parse([unsorted])).toThrow();

    const duplicateRoute = validChainConfig();
    duplicateRoute.pools[0]!.exactInputRoutes.push({
      selectors: ['0x87654321'],
      to: routerAddress,
    });
    expect(() => evmMevObservationDataAdapterConfigSchema.parse([duplicateRoute])).toThrow();
  });

  it('keeps runtime input capability-free and rejects endpoints or duplicate providers', () => {
    expect(
      loadEvmMevObservationInputSchema.parse({
        chainId: '1',
        poolAddress,
        providerIds: ['rpc_primary'],
        targetTransactionHash: transactionHash,
      }),
    ).toBeDefined();
    expect(() =>
      loadEvmMevObservationInputSchema.parse({
        chainId: '1',
        endpoint: 'https://attacker.example',
        poolAddress,
        targetTransactionHash: transactionHash,
      }),
    ).toThrow();
    expect(() =>
      loadEvmMevObservationInputSchema.parse({
        chainId: '1',
        poolAddress,
        providerIds: ['rpc_primary', 'rpc_primary'],
        targetTransactionHash: transactionHash,
      }),
    ).toThrow();
  });

  it('requires successful provider summaries to carry immutable block and payload fingerprints', () => {
    expect(() =>
      evmMevObservationProviderSummarySchema.parse({
        providerId: 'rpc_primary',
        status: 'success',
        usage: { cacheHits: 0, costUnits: 0, requests: 0, responseBytes: 0, rpcCalls: 0 },
      }),
    ).toThrow();
    expect(() =>
      evmMevObservationProviderSummarySchema.parse({
        blockHash,
        fingerprint: `sha256:${'cc'.repeat(32)}`,
        providerId: 'rpc_primary',
        status: 'insufficient_data',
        usage: { cacheHits: 0, costUnits: 0, requests: 0, responseBytes: 0, rpcCalls: 0 },
      }),
    ).toThrow();
  });
});

describe('specialized MEV observation RPC allowlist', () => {
  it('accepts fixed state selectors only with an EIP-1898 canonical block reference', () => {
    expect(
      mevObservationRpcCallSchema.parse({
        blockHash,
        method: 'eth_call',
        operation: 'v2_reserves',
        params: [
          { data: V2_GET_RESERVES_SELECTOR, to: poolAddress },
          createCanonicalBlockReference(blockHash),
        ],
        poolAddress,
      }),
    ).toBeDefined();

    const tick = -60;
    expect(
      mevObservationRpcCallSchema.parse({
        blockHash,
        method: 'eth_call',
        operation: 'v3_tick',
        params: [
          { data: `${V3_TICKS_SELECTOR}${encodeSignedWord(tick, 24)}`, to: poolAddress },
          createCanonicalBlockReference(blockHash),
        ],
        poolAddress,
        tick,
      }),
    ).toBeDefined();
  });

  it('rejects arbitrary methods, calldata, log ranges, and non-canonical state references', () => {
    for (const call of [
      { method: 'eth_sendRawTransaction', operation: 'receipt', params: ['0x'] },
      {
        blockHash,
        method: 'eth_call',
        operation: 'v2_reserves',
        params: [
          { data: '0xdeadbeef', to: poolAddress },
          { blockHash, requireCanonical: true },
        ],
        poolAddress,
      },
      {
        blockHash,
        method: 'eth_call',
        operation: 'v2_reserves',
        params: [
          { data: V2_GET_RESERVES_SELECTOR, to: poolAddress },
          { blockHash, requireCanonical: false },
        ],
        poolAddress,
      },
      {
        blockHash,
        method: 'eth_getLogs',
        operation: 'pool_logs',
        params: [{ address: poolAddress, fromBlock: '0x1', toBlock: 'latest' }],
        poolAddress,
      },
    ]) {
      expect(() => mevObservationRpcCallSchema.parse(call)).toThrow();
    }
  });
});
