import {
  UNISWAP_V2_SWAP_TOPIC,
  UNISWAP_V3_SWAP_TOPIC,
  type EvmDecodedSwap,
} from '@xxyy/evm-execution-enrichment-core';
import type { EvmMevFactSource, EvmMevPoolState } from '@xxyy/evm-price-impact-sandwich-core';

import {
  decodeV2SyncLog,
  getSqrtRatioAtTick,
  type ActiveTickRange,
  type DecodedV2Reserves,
  type DecodedV3Slot0,
} from './abi.js';
import type { EvmMevObservationDiagnosticCode } from './contracts.js';
import type { NormalizedMevLog } from './normalize-rpc.js';

export interface ReplaySwap {
  log: NormalizedMevLog;
  swap: EvmDecodedSwap;
}

export interface ReplayStatePair {
  stateAfter: EvmMevPoolState;
  stateBefore: EvmMevPoolState;
}

export type StateReplayResult =
  | { code: EvmMevObservationDiagnosticCode; ok: false }
  | { ok: true; states: Map<string, ReplayStatePair> };

export function replayV2PoolStates(input: {
  end: DecodedV2Reserves;
  initial: DecodedV2Reserves;
  logs: readonly NormalizedMevLog[];
  source: EvmMevFactSource;
  swaps: readonly ReplaySwap[];
}): StateReplayResult {
  let current = input.initial;
  let pending:
    | {
        after: DecodedV2Reserves;
        before: DecodedV2Reserves;
        transactionHash: string;
      }
    | undefined;
  const states = new Map<string, ReplayStatePair>();
  const swapsByLogIndex = new Map(input.swaps.map((swap) => [swap.log.logIndex, swap]));

  for (const log of input.logs) {
    if (log.topics[0] === UNISWAP_V2_SWAP_TOPIC) {
      const swap = swapsByLogIndex.get(log.logIndex);
      if (
        swap === undefined ||
        pending === undefined ||
        pending.transactionHash !== log.transactionHash ||
        states.has(log.transactionHash)
      ) {
        return { code: 'invalid_state_payload', ok: false };
      }
      states.set(log.transactionHash, {
        stateAfter: v2State(pending.after, input.source),
        stateBefore: v2State(pending.before, input.source),
      });
      pending = undefined;
      continue;
    }

    const sync = decodeV2SyncLog(log);
    if (sync !== undefined) {
      pending = {
        after: sync,
        before: current,
        transactionHash: log.transactionHash,
      };
      current = sync;
    }
  }

  if (
    current.reserve0 !== input.end.reserve0 ||
    current.reserve1 !== input.end.reserve1 ||
    states.size !== input.swaps.length
  ) {
    return { code: 'end_state_mismatch', ok: false };
  }
  return { ok: true, states };
}

export function replayV3PoolStates(input: {
  activeRange: ActiveTickRange;
  endLiquidity: bigint;
  endSlot0: DecodedV3Slot0;
  initialLiquidity: bigint;
  initialSlot0: DecodedV3Slot0;
  logs: readonly NormalizedMevLog[];
  source: EvmMevFactSource;
  swaps: readonly ReplaySwap[];
}): StateReplayResult {
  if (input.logs.some((log) => log.topics[0] !== UNISWAP_V3_SWAP_TOPIC)) {
    return { code: 'unsupported_pool_event', ok: false };
  }

  const lowerSqrtPriceX96 = getSqrtRatioAtTick(input.activeRange.lowerTick);
  const upperSqrtPriceX96 = getSqrtRatioAtTick(input.activeRange.upperTick);
  if (
    lowerSqrtPriceX96 >= input.initialSlot0.sqrtPriceX96 ||
    input.initialSlot0.sqrtPriceX96 >= upperSqrtPriceX96
  ) {
    return { code: 'tick_range_unavailable', ok: false };
  }

  let currentSlot0 = input.initialSlot0;
  let currentLiquidity = input.initialLiquidity;
  const states = new Map<string, ReplayStatePair>();
  const swapsByLogIndex = new Map(input.swaps.map((swap) => [swap.log.logIndex, swap]));

  for (const log of input.logs) {
    const replaySwap = swapsByLogIndex.get(log.logIndex);
    if (
      replaySwap === undefined ||
      replaySwap.swap.protocol !== 'uniswap_v3' ||
      states.has(log.transactionHash)
    ) {
      return { code: 'invalid_state_payload', ok: false };
    }
    const nextSqrtPriceX96 = BigInt(replaySwap.swap.sqrtPriceX96);
    const nextLiquidity = BigInt(replaySwap.swap.liquidity);
    const nextTick = Number(replaySwap.swap.tick);
    if (
      nextSqrtPriceX96 <= lowerSqrtPriceX96 ||
      nextSqrtPriceX96 >= upperSqrtPriceX96 ||
      nextLiquidity <= 0n ||
      !Number.isSafeInteger(nextTick)
    ) {
      return { code: 'unsupported_v3_tick_crossing', ok: false };
    }
    states.set(log.transactionHash, {
      stateAfter: v3State(
        {
          sqrtPriceX96: nextSqrtPriceX96,
          tick: nextTick,
        },
        nextLiquidity,
        lowerSqrtPriceX96,
        upperSqrtPriceX96,
        input.source,
      ),
      stateBefore: v3State(
        currentSlot0,
        currentLiquidity,
        lowerSqrtPriceX96,
        upperSqrtPriceX96,
        input.source,
      ),
    });
    currentSlot0 = { sqrtPriceX96: nextSqrtPriceX96, tick: nextTick };
    currentLiquidity = nextLiquidity;
  }

  if (
    currentSlot0.sqrtPriceX96 !== input.endSlot0.sqrtPriceX96 ||
    currentSlot0.tick !== input.endSlot0.tick ||
    currentLiquidity !== input.endLiquidity ||
    states.size !== input.swaps.length
  ) {
    return { code: 'end_state_mismatch', ok: false };
  }
  return { ok: true, states };
}

function v2State(state: DecodedV2Reserves, source: EvmMevFactSource): EvmMevPoolState {
  return {
    protocol: 'uniswap_v2',
    reserve0Raw: state.reserve0.toString(),
    reserve1Raw: state.reserve1.toString(),
    source,
  };
}

function v3State(
  state: DecodedV3Slot0,
  liquidity: bigint,
  lowerSqrtPriceX96: bigint,
  upperSqrtPriceX96: bigint,
  source: EvmMevFactSource,
): EvmMevPoolState {
  return {
    activeRangeLowerSqrtPriceX96: lowerSqrtPriceX96.toString(),
    activeRangeUpperSqrtPriceX96: upperSqrtPriceX96.toString(),
    liquidity: liquidity.toString(),
    protocol: 'uniswap_v3',
    source,
    sqrtPriceX96: state.sqrtPriceX96.toString(),
    tick: state.tick.toString(),
  };
}
