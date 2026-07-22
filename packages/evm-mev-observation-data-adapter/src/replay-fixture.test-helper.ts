import { readFile } from 'node:fs/promises';

import { UNISWAP_V2_SWAP_TOPIC, UNISWAP_V3_SWAP_TOPIC } from '@xxyy/evm-execution-enrichment-core';
import { ERC20_TRANSFER_TOPIC } from '@xxyy/transaction-analysis-core';

import {
  UNISWAP_V2_SYNC_TOPIC,
  encodeAddressTopic,
  encodeSignedWordForFixture,
  encodeUintWord,
} from './abi.js';
import type { EvmMevObservationChainConfig } from './contracts.js';
import {
  V2_GET_RESERVES_SELECTOR,
  V3_LIQUIDITY_SELECTOR,
  V3_SLOT0_SELECTOR,
  V3_TICKS_SELECTOR,
  V3_TICK_BITMAP_SELECTOR,
  V3_TICK_SPACING_SELECTOR,
} from './rpc-contracts.js';

interface FixturePool {
  feePips: number;
  poolAddress: string;
  protocol: 'uniswap_v2' | 'uniswap_v3';
  token0: string;
  token1: string;
}

interface FixtureTransactionBase {
  from: string;
  hash: string;
}

interface V2FixtureTransaction extends FixtureTransactionBase {
  swap: {
    amount0InRaw: string;
    amount0OutRaw: string;
    amount1InRaw: string;
    amount1OutRaw: string;
    reserve0AfterRaw: string;
    reserve1AfterRaw: string;
  };
}

interface V3FixtureTransaction extends FixtureTransactionBase {
  swap: {
    amount0PoolDeltaRaw: string;
    amount1PoolDeltaRaw: string;
    liquidity: string;
    sqrtPriceX96: string;
    tick: number;
  };
}

interface FixtureBase {
  blockHash: string;
  blockNumber: string;
  chainId: string;
  exactInputSelector: string;
  parentHash: string;
  pool: FixturePool;
  router: string;
  targetTransactionHash: string;
  timestamp: string;
}

export interface V2ReplayFixture extends FixtureBase {
  endState: { reserve0Raw: string; reserve1Raw: string };
  parentState: { reserve0Raw: string; reserve1Raw: string };
  pool: FixturePool & { protocol: 'uniswap_v2' };
  transactions: V2FixtureTransaction[];
}

export interface V3ReplayFixture extends FixtureBase {
  endState: { liquidity: string; sqrtPriceX96: string; tick: number };
  lowerTick: number;
  parentState: { liquidity: string; sqrtPriceX96: string; tick: number };
  pool: FixturePool & { protocol: 'uniswap_v3' };
  tickSpacing: number;
  transactions: V3FixtureTransaction[];
  upperTick: number;
}

export type MevReplayFixture = V2ReplayFixture | V3ReplayFixture;

export interface ReplayWireCall {
  id: number;
  jsonrpc: string;
  method: string;
  params: unknown[];
}

export interface CapturedReplayRequest {
  calls: ReplayWireCall[];
  host: string;
}

interface RawLog {
  address: string;
  blockHash: string;
  blockNumber: string;
  data: string;
  logIndex: string;
  removed: false;
  topics: string[];
  transactionHash: string;
  transactionIndex: string;
}

interface ReplayMaterial {
  block: Record<string, unknown>;
  parentBlock: Record<string, unknown>;
  poolLogs: RawLog[];
  receipts: Map<string, Record<string, unknown>>;
  targetTransaction: Record<string, unknown>;
}

export function loadReplayFixture(name: 'provider-v2'): Promise<V2ReplayFixture>;
export function loadReplayFixture(name: 'provider-v3'): Promise<V3ReplayFixture>;
export async function loadReplayFixture(
  name: 'provider-v2' | 'provider-v3',
): Promise<MevReplayFixture> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as MevReplayFixture;
}

export function cloneReplayFixture<T extends MevReplayFixture>(fixture: T): T {
  return JSON.parse(JSON.stringify(fixture)) as T;
}

export function replaceBlockHash<T extends MevReplayFixture>(fixture: T, blockHash: string): T {
  const clone = cloneReplayFixture(fixture);
  clone.blockHash = blockHash;
  return clone;
}

export function createReplayChainConfig(
  fixture: MevReplayFixture,
  providerIds: readonly string[] = ['primary'],
): EvmMevObservationChainConfig {
  return {
    chainId: fixture.chainId,
    pools: [
      {
        exactInputRoutes: [{ selectors: [fixture.exactInputSelector], to: fixture.router }],
        feePips: fixture.pool.feePips,
        poolAddress: fixture.pool.poolAddress,
        protocol: fixture.pool.protocol,
        token0: fixture.pool.token0,
        token1: fixture.pool.token1,
        tokenBehavior: 'standard',
      },
    ],
    providers: providerIds.map((providerId) => ({
      archive: true,
      costUnitsPerRequest: 2,
      endpoint: `https://${providerId}.example/rpc`,
      id: providerId,
    })),
  };
}

export function createReplayFetch(
  fixtures: ReadonlyMap<string, MevReplayFixture>,
  options: {
    rpcErrorHosts?: ReadonlySet<string>;
    transportFailureHosts?: ReadonlySet<string>;
  } = {},
): { fetchImpl: typeof fetch; requests: CapturedReplayRequest[] } {
  const requests: CapturedReplayRequest[] = [];
  const materials = new Map(
    [...fixtures.entries()].map(([host, fixture]) => [host, buildReplayMaterial(fixture)]),
  );
  const fetchImpl: typeof fetch = (request, init) => {
    const host = new URL(fetchInputUrl(request)).host;
    const calls = parseWireCalls(init);
    requests.push({ calls, host });
    if (options.transportFailureHosts?.has(host) === true) {
      return Promise.reject(new TypeError('offline replay provider detail'));
    }
    const fixture = fixtures.get(host);
    const material = materials.get(host);
    if (fixture === undefined || material === undefined) {
      return Promise.reject(new Error(`Missing replay fixture for ${host}.`));
    }
    const responses = calls
      .map((call) =>
        options.rpcErrorHosts?.has(host) === true && call.method === 'eth_call'
          ? {
              error: { code: -32_000, message: 'archive state unavailable' },
              id: call.id,
              jsonrpc: '2.0',
            }
          : {
              id: call.id,
              jsonrpc: '2.0',
              result: replayResult(call, fixture, material),
            },
      )
      .reverse();
    return Promise.resolve(new Response(JSON.stringify(responses), { status: 200 }));
  };
  return { fetchImpl, requests };
}

function buildReplayMaterial(fixture: MevReplayFixture): ReplayMaterial {
  const blockNumber = quantity(fixture.blockNumber);
  const transactions = fixture.transactions.map((transaction, index) => ({
    blockHash: fixture.blockHash,
    blockNumber,
    from: transaction.from,
    hash: transaction.hash,
    input: fixture.exactInputSelector,
    nonce: quantity(String(index)),
    to: fixture.router,
    transactionIndex: quantity(String(index)),
    value: '0x0',
  }));
  const allLogs: RawLog[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  let logIndex = 0;
  for (const [transactionIndex, transaction] of fixture.transactions.entries()) {
    const transactionLogs = isV2Fixture(fixture)
      ? createV2TransactionLogs(
          fixture,
          transaction as V2FixtureTransaction,
          transactionIndex,
          logIndex,
        )
      : createV3TransactionLogs(
          fixture,
          transaction as V3FixtureTransaction,
          transactionIndex,
          logIndex,
        );
    logIndex += transactionLogs.length;
    allLogs.push(...transactionLogs);
    receipts.set(transaction.hash, {
      blockHash: fixture.blockHash,
      blockNumber,
      contractAddress: null,
      effectiveGasPrice: '0x1',
      gasUsed: '0x5208',
      logs: transactionLogs,
      status: '0x1',
      transactionHash: transaction.hash,
      transactionIndex: quantity(String(transactionIndex)),
    });
  }

  const block = {
    hash: fixture.blockHash,
    number: blockNumber,
    parentHash: fixture.parentHash,
    timestamp: quantity(fixture.timestamp),
    transactions,
  };
  const parentBlock = {
    hash: fixture.parentHash,
    number: quantity((BigInt(fixture.blockNumber) - 1n).toString()),
    parentHash: `0x${'9'.repeat(64)}`,
    timestamp: quantity((BigInt(fixture.timestamp) - 12n).toString()),
    transactions: [],
  };
  const targetTransaction = transactions.find(
    (transaction) => transaction.hash === fixture.targetTransactionHash,
  );
  if (targetTransaction === undefined) {
    throw new Error('Replay target transaction is missing.');
  }
  return {
    block,
    parentBlock,
    poolLogs: allLogs.filter((log) => log.address === fixture.pool.poolAddress),
    receipts,
    targetTransaction,
  };
}

function createV2TransactionLogs(
  fixture: V2ReplayFixture,
  transaction: V2FixtureTransaction,
  transactionIndex: number,
  firstLogIndex: number,
): RawLog[] {
  const logs: RawLog[] = [];
  const swap = transaction.swap;
  const transfers = [
    [fixture.pool.token0, transaction.from, fixture.pool.poolAddress, swap.amount0InRaw],
    [fixture.pool.token1, transaction.from, fixture.pool.poolAddress, swap.amount1InRaw],
    [fixture.pool.token0, fixture.pool.poolAddress, transaction.from, swap.amount0OutRaw],
    [fixture.pool.token1, fixture.pool.poolAddress, transaction.from, swap.amount1OutRaw],
  ] as const;
  for (const [token, from, to, amount] of transfers) {
    if (amount !== '0') {
      logs.push(
        rawLog(fixture, transaction, transactionIndex, firstLogIndex + logs.length, {
          address: token,
          data: `0x${encodeUintWord(BigInt(amount))}`,
          topics: [ERC20_TRANSFER_TOPIC, encodeAddressTopic(from), encodeAddressTopic(to)],
        }),
      );
    }
  }
  logs.push(
    rawLog(fixture, transaction, transactionIndex, firstLogIndex + logs.length, {
      address: fixture.pool.poolAddress,
      data: `0x${encodeUintWord(BigInt(swap.reserve0AfterRaw))}${encodeUintWord(
        BigInt(swap.reserve1AfterRaw),
      )}`,
      topics: [UNISWAP_V2_SYNC_TOPIC],
    }),
  );
  logs.push(
    rawLog(fixture, transaction, transactionIndex, firstLogIndex + logs.length, {
      address: fixture.pool.poolAddress,
      data: `0x${[swap.amount0InRaw, swap.amount1InRaw, swap.amount0OutRaw, swap.amount1OutRaw]
        .map((value) => encodeUintWord(BigInt(value)))
        .join('')}`,
      topics: [
        UNISWAP_V2_SWAP_TOPIC,
        encodeAddressTopic(transaction.from),
        encodeAddressTopic(transaction.from),
      ],
    }),
  );
  return logs;
}

function createV3TransactionLogs(
  fixture: V3ReplayFixture,
  transaction: V3FixtureTransaction,
  transactionIndex: number,
  firstLogIndex: number,
): RawLog[] {
  const logs: RawLog[] = [];
  const swap = transaction.swap;
  const token0Delta = BigInt(swap.amount0PoolDeltaRaw);
  const token1Delta = BigInt(swap.amount1PoolDeltaRaw);
  for (const [token, delta] of [
    [fixture.pool.token0, token0Delta],
    [fixture.pool.token1, token1Delta],
  ] as const) {
    if (delta === 0n) {
      continue;
    }
    const from = delta > 0n ? transaction.from : fixture.pool.poolAddress;
    const to = delta > 0n ? fixture.pool.poolAddress : transaction.from;
    logs.push(
      rawLog(fixture, transaction, transactionIndex, firstLogIndex + logs.length, {
        address: token,
        data: `0x${encodeUintWord(delta < 0n ? -delta : delta)}`,
        topics: [ERC20_TRANSFER_TOPIC, encodeAddressTopic(from), encodeAddressTopic(to)],
      }),
    );
  }
  logs.push(
    rawLog(fixture, transaction, transactionIndex, firstLogIndex + logs.length, {
      address: fixture.pool.poolAddress,
      data: `0x${[
        encodeSignedWordForFixture(token0Delta),
        encodeSignedWordForFixture(token1Delta),
        encodeUintWord(BigInt(swap.sqrtPriceX96)),
        encodeUintWord(BigInt(swap.liquidity)),
        encodeSignedWordForFixture(BigInt(swap.tick)),
      ].join('')}`,
      topics: [
        UNISWAP_V3_SWAP_TOPIC,
        encodeAddressTopic(transaction.from),
        encodeAddressTopic(transaction.from),
      ],
    }),
  );
  return logs;
}

function rawLog(
  fixture: MevReplayFixture,
  transaction: FixtureTransactionBase,
  transactionIndex: number,
  logIndex: number,
  event: { address: string; data: string; topics: string[] },
): RawLog {
  return {
    address: event.address,
    blockHash: fixture.blockHash,
    blockNumber: quantity(fixture.blockNumber),
    data: event.data,
    logIndex: quantity(String(logIndex)),
    removed: false,
    topics: event.topics,
    transactionHash: transaction.hash,
    transactionIndex: quantity(String(transactionIndex)),
  };
}

function replayResult(
  call: ReplayWireCall,
  fixture: MevReplayFixture,
  material: ReplayMaterial,
): unknown {
  if (call.method === 'eth_chainId') {
    return quantity(fixture.chainId);
  }
  if (call.method === 'eth_getTransactionByHash') {
    return call.params[0] === fixture.targetTransactionHash ? material.targetTransaction : null;
  }
  if (call.method === 'eth_getBlockByHash') {
    return call.params[0] === fixture.blockHash
      ? material.block
      : call.params[0] === fixture.parentHash
        ? material.parentBlock
        : null;
  }
  if (call.method === 'eth_getLogs') {
    return material.poolLogs;
  }
  if (call.method === 'eth_getTransactionReceipt') {
    const transactionHash = call.params[0];
    return typeof transactionHash === 'string'
      ? (material.receipts.get(transactionHash) ?? null)
      : null;
  }
  if (call.method !== 'eth_call') {
    throw new Error(`Unexpected replay method: ${call.method}`);
  }
  const request = call.params[0] as { data?: unknown; to?: unknown };
  const blockReference = call.params[1] as { blockHash?: unknown };
  if (
    request.to !== fixture.pool.poolAddress ||
    typeof request.data !== 'string' ||
    typeof blockReference.blockHash !== 'string'
  ) {
    throw new Error('Unexpected replay eth_call target or block reference.');
  }
  return replayStateCall(fixture, request.data, blockReference.blockHash);
}

function replayStateCall(fixture: MevReplayFixture, data: string, blockHash: string): string {
  const parent = blockHash === fixture.parentHash;
  if (!parent && blockHash !== fixture.blockHash) {
    throw new Error('Unexpected replay state block hash.');
  }
  if (isV2Fixture(fixture)) {
    if (data !== V2_GET_RESERVES_SELECTOR) {
      throw new Error(`Unexpected V2 state selector: ${data}`);
    }
    const state = parent ? fixture.parentState : fixture.endState;
    return `0x${encodeUintWord(BigInt(state.reserve0Raw))}${encodeUintWord(
      BigInt(state.reserve1Raw),
    )}${encodeUintWord(0n)}`;
  }

  const state = parent ? fixture.parentState : fixture.endState;
  if (data === V3_SLOT0_SELECTOR) {
    return `0x${[
      encodeUintWord(BigInt(state.sqrtPriceX96)),
      encodeSignedWordForFixture(BigInt(state.tick)),
      encodeUintWord(0n),
      encodeUintWord(1n),
      encodeUintWord(1n),
      encodeUintWord(0n),
      encodeUintWord(1n),
    ].join('')}`;
  }
  if (data === V3_LIQUIDITY_SELECTOR) {
    return `0x${encodeUintWord(BigInt(state.liquidity))}`;
  }
  if (data === V3_TICK_SPACING_SELECTOR) {
    return `0x${encodeSignedWordForFixture(BigInt(fixture.tickSpacing))}`;
  }
  if (data.startsWith(V3_TICK_BITMAP_SELECTOR)) {
    const wordPosition = Number(decodeSignedWord(data.slice(10), 16));
    const lowerCompressed = Math.floor(fixture.lowerTick / fixture.tickSpacing);
    const upperCompressed = Math.floor(fixture.upperTick / fixture.tickSpacing);
    let bitmap = 0n;
    for (const compressed of [lowerCompressed, upperCompressed]) {
      const position = Math.floor(compressed / 256);
      const bit = ((compressed % 256) + 256) % 256;
      if (position === wordPosition) {
        bitmap |= 1n << BigInt(bit);
      }
    }
    return `0x${encodeUintWord(bitmap)}`;
  }
  if (data.startsWith(V3_TICKS_SELECTOR)) {
    const tick = Number(decodeSignedWord(data.slice(10), 24));
    const initialized = tick === fixture.lowerTick || tick === fixture.upperTick;
    return `0x${[
      encodeUintWord(initialized ? 1_000_000n : 0n),
      encodeSignedWordForFixture(0n),
      encodeUintWord(0n),
      encodeUintWord(0n),
      encodeSignedWordForFixture(0n),
      encodeUintWord(0n),
      encodeUintWord(0n),
      encodeUintWord(initialized ? 1n : 0n),
    ].join('')}`;
  }
  throw new Error(`Unexpected V3 state selector: ${data}`);
}

function decodeSignedWord(word: string, bits: 16 | 24): bigint {
  const raw = BigInt(`0x${word}`);
  const signed = raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  const minimum = -(1n << (BigInt(bits) - 1n));
  const maximum = (1n << (BigInt(bits) - 1n)) - 1n;
  if (signed < minimum || signed > maximum) {
    throw new Error(`Replay ABI value exceeds int${bits}.`);
  }
  return signed;
}

function quantity(decimal: string): string {
  const value = BigInt(decimal);
  return value === 0n ? '0x0' : `0x${value.toString(16)}`;
}

function isV2Fixture(fixture: MevReplayFixture): fixture is V2ReplayFixture {
  return fixture.pool.protocol === 'uniswap_v2';
}

function parseWireCalls(init: RequestInit | undefined): ReplayWireCall[] {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected JSON-RPC string body.');
  }
  const payload = JSON.parse(init.body) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Expected JSON-RPC batch body.');
  }
  return payload as ReplayWireCall[];
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}
