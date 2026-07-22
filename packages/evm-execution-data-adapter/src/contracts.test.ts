import { describe, expect, it } from 'vitest';

import {
  ABSOLUTE_MAX_POOL_CANDIDATES,
  POOL_FACTORY_SELECTOR,
  POOL_TOKEN0_SELECTOR,
  POOL_TOKEN1_SELECTOR,
  UNISWAP_V2_GET_PAIR_SELECTOR,
  UNISWAP_V3_FEE_SELECTOR,
  UNISWAP_V3_GET_POOL_SELECTOR,
  evmExecutionDataAdapterConfigSchema,
  evmExecutionDataAdapterResultSchema,
  loadEvmExecutionDataInputSchema,
} from './contracts.js';
import { executionRpcCallSchema } from './rpc-contracts.js';

const transactionHash = `0x${'a'.repeat(64)}`;
const poolAddress = `0x${'a'.repeat(40)}`;
const factoryAddress = `0x${'f1'.repeat(20)}`;
const token0 = `0x${'01'.repeat(20)}`;
const token1 = `0x${'02'.repeat(20)}`;

describe('EVM execution data adapter contracts', () => {
  it('pins the only ABI selectors accepted by the metadata boundary', () => {
    expect({
      factory: POOL_FACTORY_SELECTOR,
      fee: UNISWAP_V3_FEE_SELECTOR,
      getPair: UNISWAP_V2_GET_PAIR_SELECTOR,
      getPool: UNISWAP_V3_GET_POOL_SELECTOR,
      token0: POOL_TOKEN0_SELECTOR,
      token1: POOL_TOKEN1_SELECTOR,
    }).toEqual({
      factory: '0xc45a0155',
      fee: '0xddca3f43',
      getPair: '0xe6a43905',
      getPool: '0x1698ee82',
      token0: '0x0dfe1681',
      token1: '0xd21220a7',
    });
  });

  it('normalizes startup allowlists and rejects duplicate or cross-protocol factories', () => {
    const config = evmExecutionDataAdapterConfigSchema.parse([
      {
        chainId: '1',
        factories: {
          uniswapV2: [factoryAddress.toUpperCase().replace('0X', '0x')],
        },
        providers: [{ endpoint: 'https://rpc.example', id: 'rpc_primary' }],
      },
    ]);

    expect(config[0]?.factories).toEqual({
      uniswapV2: [factoryAddress],
      uniswapV3: [],
    });
    expect(() =>
      evmExecutionDataAdapterConfigSchema.parse([
        {
          chainId: '1',
          factories: { uniswapV2: [factoryAddress], uniswapV3: [factoryAddress] },
          providers: [{ endpoint: 'https://rpc.example', id: 'rpc_primary' }],
        },
      ]),
    ).toThrow();
    expect(() =>
      evmExecutionDataAdapterConfigSchema.parse([
        {
          chainId: '1',
          factories: { uniswapV2: ['0x0000000000000000000000000000000000000000'] },
          providers: [{ endpoint: 'https://rpc.example', id: 'rpc_primary' }],
        },
      ]),
    ).toThrow();
    expect(() =>
      evmExecutionDataAdapterConfigSchema.parse([
        {
          chainId: '1',
          factories: {},
          providers: [
            { endpoint: 'https://rpc-a.example', id: 'rpc_primary' },
            { endpoint: 'https://rpc-b.example', id: 'rpc_primary' },
          ],
        },
      ]),
    ).toThrow();
  });

  it('bounds and de-duplicates runtime pool candidates without accepting endpoints', () => {
    expect(
      loadEvmExecutionDataInputSchema.parse({
        blockNumber: '19000000',
        chainId: '1',
        transactionHash,
      }).pools,
    ).toEqual([]);
    expect(() =>
      loadEvmExecutionDataInputSchema.parse({
        blockNumber: '19000000',
        chainId: '1',
        endpoint: 'https://attacker.example',
        pools: [
          { poolAddress, protocol: 'uniswap_v2' },
          { poolAddress, protocol: 'uniswap_v3' },
        ],
        transactionHash,
      }),
    ).toThrow();
    expect(() =>
      loadEvmExecutionDataInputSchema.parse({
        blockNumber: '19000000',
        chainId: '1',
        pools: [
          {
            poolAddress: '0x0000000000000000000000000000000000000000',
            protocol: 'uniswap_v2',
          },
        ],
        transactionHash,
      }),
    ).toThrow();
    expect(() =>
      loadEvmExecutionDataInputSchema.parse({
        blockNumber: '19000000',
        chainId: '1',
        pools: Array.from({ length: ABSOLUTE_MAX_POOL_CANDIDATES + 1 }, (_, index) => ({
          poolAddress: `0x${index.toString(16).padStart(40, '0')}`,
          protocol: 'uniswap_v2',
        })),
        transactionHash,
      }),
    ).toThrow();
  });

  it('requires pool metadata and verification facts to remain aligned', () => {
    const source = {
      id: 'rpc_primary',
      kind: 'rpc',
      observedAt: '2026-07-22T00:00:00.000Z',
      payloadHash: `sha256:${'a'.repeat(64)}`,
    } as const;
    const metadata = {
      chainId: '1',
      poolAddress,
      protocol: 'uniswap_v2',
      source,
      token0,
      token1,
    } as const;
    const verification = {
      ...metadata,
      factoryAddress,
      factoryCodeHash: `sha256:${'b'.repeat(64)}`,
      poolCodeHash: `sha256:${'c'.repeat(64)}`,
    } as const;

    expect(
      evmExecutionDataAdapterResultSchema.parse({
        conflicts: [],
        diagnostics: [],
        poolMetadata: [metadata],
        status: 'partial',
        verifiedPools: [verification],
        version: '0.1.0',
      }),
    ).toBeDefined();
    expect(() =>
      evmExecutionDataAdapterResultSchema.parse({
        conflicts: [],
        diagnostics: [],
        poolMetadata: [{ ...metadata, token1: `0x${'03'.repeat(20)}` }],
        status: 'partial',
        verifiedPools: [verification],
        version: '0.1.0',
      }),
    ).toThrow();
  });
});

describe('specialized execution RPC allowlist', () => {
  it('accepts only the fixed callTracer configuration', () => {
    expect(
      executionRpcCallSchema.parse({
        method: 'debug_traceTransaction',
        operation: 'trace',
        params: [
          transactionHash,
          {
            timeout: '10s',
            tracer: 'callTracer',
            tracerConfig: { onlyTopCall: false, withLog: false },
          },
        ],
      }),
    ).toBeDefined();
    expect(() =>
      executionRpcCallSchema.parse({
        method: 'debug_traceTransaction',
        operation: 'trace',
        params: [transactionHash, { tracer: 'prestateTracer' }],
      }),
    ).toThrow();
  });

  it('rejects arbitrary eth_call, write methods, and mismatched targets', () => {
    expect(() =>
      executionRpcCallSchema.parse({
        method: 'eth_call',
        operation: 'pool_token0',
        params: [{ data: '0xdeadbeef', to: poolAddress }, '0x1'],
        poolAddress,
      }),
    ).toThrow();
    expect(() =>
      executionRpcCallSchema.parse({
        method: 'eth_sendRawTransaction',
        operation: 'pool_code',
        params: ['0xdeadbeef'],
        poolAddress,
      }),
    ).toThrow();
    expect(() =>
      executionRpcCallSchema.parse({
        method: 'eth_getCode',
        operation: 'pool_code',
        params: [`0x${'b'.repeat(40)}`, '0x1'],
        poolAddress,
      }),
    ).toThrow();
  });
});
