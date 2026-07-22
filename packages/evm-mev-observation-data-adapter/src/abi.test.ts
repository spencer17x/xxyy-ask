import { ERC20_TRANSFER_TOPIC } from '@xxyy/transaction-analysis-core';
import { describe, expect, it } from 'vitest';

import {
  MAX_UNISWAP_V3_SQRT_RATIO,
  MAX_UNISWAP_V3_TICK,
  MIN_UNISWAP_V3_SQRT_RATIO,
  MIN_UNISWAP_V3_TICK,
  UNISWAP_V2_SYNC_TOPIC,
  decodeTransferLog,
  decodeV2Reserves,
  decodeV2SyncLog,
  decodeV3Slot0,
  decodeV3TickInfo,
  encodeAddressTopic,
  encodeSignedWordForFixture,
  encodeUintWord,
  findActiveTickRange,
  getSqrtRatioAtTick,
} from './abi.js';

const token0 = `0x${'11'.repeat(20)}`;
const token1 = `0x${'22'.repeat(20)}`;

describe('strict MEV observation ABI decoding', () => {
  it('decodes bounded V2 reserve state and rejects overflow or malformed words', () => {
    const result = `0x${encodeUintWord(1_000n)}${encodeUintWord(2_000n)}${encodeUintWord(3n)}`;
    expect(decodeV2Reserves(result)).toEqual({ reserve0: 1_000n, reserve1: 2_000n });

    const overflow = `0x${encodeUintWord(1n << 112n)}${encodeUintWord(2_000n)}${encodeUintWord(3n)}`;
    expect(decodeV2Reserves(overflow)).toBeUndefined();
    expect(decodeV2Reserves(`${result}00`)).toBeUndefined();
  });

  it('requires the canonical Sync topic and non-zero uint112 reserves', () => {
    const data = `0x${encodeUintWord(1_000n)}${encodeUintWord(2_000n)}`;
    expect(decodeV2SyncLog({ data, topics: [UNISWAP_V2_SYNC_TOPIC] })).toEqual({
      reserve0: 1_000n,
      reserve1: 2_000n,
    });
    expect(decodeV2SyncLog({ data, topics: [`0x${'0'.repeat(64)}`] })).toBeUndefined();
    expect(
      decodeV2SyncLog({
        data: `0x${encodeUintWord(0n)}${encodeUintWord(2_000n)}`,
        topics: [UNISWAP_V2_SYNC_TOPIC],
      }),
    ).toBeUndefined();
  });

  it('decodes signed V3 fields losslessly and rejects non-canonical widths', () => {
    const slot0 = `0x${[
      encodeUintWord(2n ** 96n),
      encodeSignedWordForFixture(-1n),
      encodeUintWord(1n),
      encodeUintWord(2n),
      encodeUintWord(3n),
      encodeUintWord(0n),
      encodeUintWord(1n),
    ].join('')}`;
    expect(decodeV3Slot0(slot0)).toEqual({ sqrtPriceX96: 2n ** 96n, tick: -1 });

    const invalidTick = slot0.replace(encodeSignedWordForFixture(-1n), encodeUintWord(1n << 23n));
    expect(decodeV3Slot0(invalidTick)).toBeUndefined();

    const tickInfo = `0x${[
      encodeUintWord(10n),
      encodeSignedWordForFixture(-4n),
      encodeUintWord(0n),
      encodeUintWord(0n),
      encodeUintWord(0n),
      encodeUintWord(0n),
      encodeUintWord(0n),
      encodeUintWord(1n),
    ].join('')}`;
    expect(decodeV3TickInfo(tickInfo)).toEqual({ liquidityGross: 10n, liquidityNet: -4n });
  });

  it('finds initialized ticks across negative bitmap words with a fixed search budget', () => {
    const bitmaps = new Map<number, bigint>([
      [-1, 1n << 255n],
      [0, 1n << 1n],
    ]);

    expect(findActiveTickRange(0, 60, bitmaps, 1)).toEqual({
      lowerTick: -60,
      upperTick: 60,
    });
    expect(findActiveTickRange(0, 60, new Map([[0, 1n << 1n]]), 0)).toBeUndefined();
  });

  it('matches the official TickMath domain boundaries exactly', () => {
    expect(getSqrtRatioAtTick(0)).toBe(2n ** 96n);
    expect(getSqrtRatioAtTick(MIN_UNISWAP_V3_TICK)).toBe(MIN_UNISWAP_V3_SQRT_RATIO);
    expect(getSqrtRatioAtTick(MAX_UNISWAP_V3_TICK)).toBe(MAX_UNISWAP_V3_SQRT_RATIO);
    expect(() => getSqrtRatioAtTick(MIN_UNISWAP_V3_TICK - 1)).toThrow();
    expect(() => getSqrtRatioAtTick(MAX_UNISWAP_V3_TICK + 1)).toThrow();
  });

  it('decodes only canonical indexed ERC-20 Transfer logs', () => {
    const log = {
      data: `0x${encodeUintWord(42n)}`,
      topics: [ERC20_TRANSFER_TOPIC, encodeAddressTopic(token0), encodeAddressTopic(token1)],
    };
    expect(decodeTransferLog(log, ERC20_TRANSFER_TOPIC)).toEqual({
      amount: 42n,
      from: token0,
      to: token1,
    });
    expect(
      decodeTransferLog({ ...log, topics: log.topics.slice(0, 2) }, ERC20_TRANSFER_TOPIC),
    ).toBeUndefined();
  });
});
