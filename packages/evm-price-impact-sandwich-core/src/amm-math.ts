import type { EvmDecodedSwap } from '@xxyy/evm-execution-enrichment-core';
import { EVM_UINT256_MAX } from '@xxyy/transaction-analysis-core';

import {
  FEE_PIPS_DENOMINATOR,
  PARTS_PER_MILLION,
  Q96,
  Q192,
  UINT160_MAX,
  type EvmMevPool,
  type EvmMevPoolState,
  type EvmMevSwapObservation,
  type EvmRational,
  type EvmV2PoolState,
  type EvmV3PoolState,
} from './contracts.js';

export const evmAmmMathErrorCodes = [
  'amount_out_zero',
  'arithmetic_overflow',
  'invalid_amount',
  'pool_state_transition_mismatch',
  'quote_mismatch',
  'unsupported_active_tick_crossing',
  'unsupported_ambiguous_swap',
  'unsupported_exact_output',
  'unsupported_route',
  'unsupported_token_behavior',
] as const;

export type EvmAmmMathErrorCode = (typeof evmAmmMathErrorCodes)[number];

export class EvmAmmMathError extends Error {
  constructor(public readonly code: EvmAmmMathErrorCode) {
    super(`EVM AMM calculation failed with ${code}.`);
    this.name = 'EvmAmmMathError';
  }
}

export interface ExactInputQuote {
  amountOutRaw: string;
  direction: 'token0_to_token1' | 'token1_to_token0';
  executionPrice: EvmRational;
  model: 'uniswap_v2_exact_input' | 'uniswap_v3_single_range_exact_input';
  nextSqrtPriceX96?: string | undefined;
  priceImpactPpm: string;
  spotPriceBefore: EvmRational;
}

export interface ValidatedObservationQuote extends ExactInputQuote {
  observation: EvmMevSwapObservation;
}

interface QuoteCalculation {
  amountOut: bigint;
  nextSqrtPriceX96?: bigint | undefined;
}

export function validateObservationQuote(
  pool: EvmMevPool,
  observation: EvmMevSwapObservation,
): ValidatedObservationQuote {
  assertSupportedObservation(observation);
  const swap = observation.swap;
  if (
    swap.direction === 'ambiguous' ||
    swap.amountInRaw === undefined ||
    swap.amountOutRaw === undefined
  ) {
    throw new EvmAmmMathError('unsupported_ambiguous_swap');
  }
  const quote = quoteExactInput(pool, observation.stateBefore, swap.amountInRaw, swap.direction);
  if (quote.amountOutRaw !== swap.amountOutRaw) {
    throw new EvmAmmMathError('quote_mismatch');
  }
  validateStateTransition(observation, quote);
  return { ...quote, observation };
}

export function quoteExactInput(
  pool: EvmMevPool,
  state: EvmMevPoolState,
  amountInRaw: string,
  direction: 'token0_to_token1' | 'token1_to_token0',
): ExactInputQuote {
  const amountIn = parsePositive(amountInRaw);
  const spotPriceBefore = directionalSpotPrice(state, direction);
  const result: QuoteCalculation =
    state.protocol === 'uniswap_v2'
      ? quoteV2(pool, state, amountIn, direction)
      : quoteV3(pool, state, amountIn, direction);
  if (result.amountOut <= 0n) {
    throw new EvmAmmMathError('amount_out_zero');
  }
  const executionPrice = reduceRational(result.amountOut, amountIn);
  return {
    amountOutRaw: result.amountOut.toString(),
    direction,
    executionPrice,
    model:
      state.protocol === 'uniswap_v2'
        ? 'uniswap_v2_exact_input'
        : 'uniswap_v3_single_range_exact_input',
    ...(result.nextSqrtPriceX96 === undefined
      ? {}
      : { nextSqrtPriceX96: result.nextSqrtPriceX96.toString() }),
    priceImpactPpm: priceImpactPpm(spotPriceBefore, executionPrice).toString(),
    spotPriceBefore,
  };
}

export function directionalSpotPrice(
  state: EvmMevPoolState,
  direction: 'token0_to_token1' | 'token1_to_token0',
): EvmRational {
  if (state.protocol === 'uniswap_v2') {
    return direction === 'token0_to_token1'
      ? reduceRational(BigInt(state.reserve1Raw), BigInt(state.reserve0Raw))
      : reduceRational(BigInt(state.reserve0Raw), BigInt(state.reserve1Raw));
  }
  const square = BigInt(state.sqrtPriceX96) ** 2n;
  return direction === 'token0_to_token1'
    ? reduceRational(square, Q192)
    : reduceRational(Q192, square);
}

export function compareRationals(left: EvmRational, right: EvmRational): number {
  const difference =
    BigInt(left.numerator) * BigInt(right.denominator) -
    BigInt(right.numerator) * BigInt(left.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function poolStatesEqual(left: EvmMevPoolState, right: EvmMevPoolState): boolean {
  if (left.protocol !== right.protocol) {
    return false;
  }
  if (left.protocol === 'uniswap_v2' && right.protocol === 'uniswap_v2') {
    return left.reserve0Raw === right.reserve0Raw && left.reserve1Raw === right.reserve1Raw;
  }
  if (left.protocol === 'uniswap_v3' && right.protocol === 'uniswap_v3') {
    return (
      left.activeRangeLowerSqrtPriceX96 === right.activeRangeLowerSqrtPriceX96 &&
      left.activeRangeUpperSqrtPriceX96 === right.activeRangeUpperSqrtPriceX96 &&
      left.liquidity === right.liquidity &&
      left.sqrtPriceX96 === right.sqrtPriceX96 &&
      left.tick === right.tick
    );
  }
  return false;
}

export function reduceRational(numerator: bigint, denominator: bigint): EvmRational {
  if (numerator <= 0n || denominator <= 0n) {
    throw new EvmAmmMathError('invalid_amount');
  }
  const divisor = gcd(numerator, denominator);
  return {
    denominator: (denominator / divisor).toString(),
    numerator: (numerator / divisor).toString(),
  };
}

function assertSupportedObservation(observation: EvmMevSwapObservation): void {
  if (observation.routeKind !== 'single_pool') {
    throw new EvmAmmMathError('unsupported_route');
  }
  if (observation.swapMode !== 'exact_input') {
    throw new EvmAmmMathError('unsupported_exact_output');
  }
  if (observation.tokenBehavior !== 'standard') {
    throw new EvmAmmMathError('unsupported_token_behavior');
  }
}

function quoteV2(
  _pool: EvmMevPool,
  state: EvmV2PoolState,
  amountIn: bigint,
  direction: 'token0_to_token1' | 'token1_to_token0',
): QuoteCalculation {
  const reserveIn = BigInt(
    direction === 'token0_to_token1' ? state.reserve0Raw : state.reserve1Raw,
  );
  const reserveOut = BigInt(
    direction === 'token0_to_token1' ? state.reserve1Raw : state.reserve0Raw,
  );
  const amountInWithFee = checkedUint256Multiply(amountIn, 997n);
  const numerator = checkedUint256Multiply(amountInWithFee, reserveOut);
  const denominator = checkedUint256Add(checkedUint256Multiply(reserveIn, 1_000n), amountInWithFee);
  return { amountOut: numerator / denominator };
}

function quoteV3(
  pool: EvmMevPool,
  state: EvmV3PoolState,
  amountIn: bigint,
  direction: 'token0_to_token1' | 'token1_to_token0',
): QuoteCalculation {
  const sqrtPrice = BigInt(state.sqrtPriceX96);
  const liquidity = BigInt(state.liquidity);
  const amountRemainingLessFee =
    (amountIn * BigInt(FEE_PIPS_DENOMINATOR - pool.feePips)) / BigInt(FEE_PIPS_DENOMINATOR);
  if (amountRemainingLessFee <= 0n) {
    throw new EvmAmmMathError('amount_out_zero');
  }

  const nextSqrtPriceX96 =
    direction === 'token0_to_token1'
      ? nextSqrtPriceFromToken0Input(sqrtPrice, liquidity, amountRemainingLessFee)
      : nextSqrtPriceFromToken1Input(sqrtPrice, liquidity, amountRemainingLessFee);
  const lower = BigInt(state.activeRangeLowerSqrtPriceX96);
  const upper = BigInt(state.activeRangeUpperSqrtPriceX96);
  if (nextSqrtPriceX96 <= lower || nextSqrtPriceX96 >= upper) {
    throw new EvmAmmMathError('unsupported_active_tick_crossing');
  }

  const amountOut =
    direction === 'token0_to_token1'
      ? getAmount1DeltaRoundDown(nextSqrtPriceX96, sqrtPrice, liquidity)
      : getAmount0DeltaRoundDown(sqrtPrice, nextSqrtPriceX96, liquidity);
  return { amountOut, nextSqrtPriceX96 };
}

function validateStateTransition(observation: EvmMevSwapObservation, quote: ExactInputQuote): void {
  const swap = observation.swap;
  if (observation.stateBefore.protocol === 'uniswap_v2') {
    if (observation.stateAfter.protocol !== 'uniswap_v2') {
      throw new EvmAmmMathError('pool_state_transition_mismatch');
    }
    const expectedReserve0 =
      BigInt(observation.stateBefore.reserve0Raw) + BigInt(swap.amount0PoolDeltaRaw);
    const expectedReserve1 =
      BigInt(observation.stateBefore.reserve1Raw) + BigInt(swap.amount1PoolDeltaRaw);
    if (
      expectedReserve0 <= 0n ||
      expectedReserve1 <= 0n ||
      expectedReserve0 > EVM_UINT256_MAX ||
      expectedReserve1 > EVM_UINT256_MAX ||
      expectedReserve0.toString() !== observation.stateAfter.reserve0Raw ||
      expectedReserve1.toString() !== observation.stateAfter.reserve1Raw
    ) {
      throw new EvmAmmMathError('pool_state_transition_mismatch');
    }
    return;
  }

  if (
    observation.stateAfter.protocol !== 'uniswap_v3' ||
    swap.protocol !== 'uniswap_v3' ||
    quote.nextSqrtPriceX96 === undefined ||
    observation.stateBefore.activeRangeLowerSqrtPriceX96 !==
      observation.stateAfter.activeRangeLowerSqrtPriceX96 ||
    observation.stateBefore.activeRangeUpperSqrtPriceX96 !==
      observation.stateAfter.activeRangeUpperSqrtPriceX96 ||
    observation.stateBefore.liquidity !== observation.stateAfter.liquidity ||
    quote.nextSqrtPriceX96 !== observation.stateAfter.sqrtPriceX96 ||
    swap.sqrtPriceX96 !== observation.stateAfter.sqrtPriceX96 ||
    swap.liquidity !== observation.stateAfter.liquidity ||
    swap.tick !== observation.stateAfter.tick
  ) {
    throw new EvmAmmMathError('pool_state_transition_mismatch');
  }
}

function nextSqrtPriceFromToken0Input(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
): bigint {
  const numerator1 = liquidity << 96n;
  const product = amountIn * sqrtPriceX96;
  if (product <= EVM_UINT256_MAX) {
    const denominator = numerator1 + product;
    if (denominator <= EVM_UINT256_MAX && denominator >= numerator1) {
      return mulDivRoundingUp(numerator1, sqrtPriceX96, denominator);
    }
  }
  const denominator = numerator1 / sqrtPriceX96 + amountIn;
  if (denominator > EVM_UINT256_MAX) {
    throw new EvmAmmMathError('arithmetic_overflow');
  }
  return ceilDiv(numerator1, denominator);
}

function nextSqrtPriceFromToken1Input(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
): bigint {
  const quotient = (amountIn * Q96) / liquidity;
  const next = sqrtPriceX96 + quotient;
  if (next > UINT160_MAX) {
    throw new EvmAmmMathError('arithmetic_overflow');
  }
  return next;
}

function getAmount0DeltaRoundDown(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  const lower = sqrtRatioAX96 < sqrtRatioBX96 ? sqrtRatioAX96 : sqrtRatioBX96;
  const upper = sqrtRatioAX96 < sqrtRatioBX96 ? sqrtRatioBX96 : sqrtRatioAX96;
  const numerator1 = liquidity << 96n;
  const numerator2 = upper - lower;
  return (numerator1 * numerator2) / upper / lower;
}

function getAmount1DeltaRoundDown(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  const lower = sqrtRatioAX96 < sqrtRatioBX96 ? sqrtRatioAX96 : sqrtRatioBX96;
  const upper = sqrtRatioAX96 < sqrtRatioBX96 ? sqrtRatioBX96 : sqrtRatioAX96;
  return (liquidity * (upper - lower)) / Q96;
}

function priceImpactPpm(spotPrice: EvmRational, executionPrice: EvmRational): bigint {
  const spotNumerator = BigInt(spotPrice.numerator);
  const spotDenominator = BigInt(spotPrice.denominator);
  const executionNumerator = BigInt(executionPrice.numerator);
  const executionDenominator = BigInt(executionPrice.denominator);
  const baseline = spotNumerator * executionDenominator;
  const difference = baseline - executionNumerator * spotDenominator;
  return (difference * PARTS_PER_MILLION) / baseline;
}

function checkedUint256Multiply(left: bigint, right: bigint): bigint {
  const result = left * right;
  if (result > EVM_UINT256_MAX) {
    throw new EvmAmmMathError('arithmetic_overflow');
  }
  return result;
}

function checkedUint256Add(left: bigint, right: bigint): bigint {
  const result = left + right;
  if (result > EVM_UINT256_MAX) {
    throw new EvmAmmMathError('arithmetic_overflow');
  }
  return result;
}

function mulDivRoundingUp(left: bigint, right: bigint, denominator: bigint): bigint {
  return ceilDiv(left * right, denominator);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

function parsePositive(value: string): bigint {
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > EVM_UINT256_MAX) {
    throw new EvmAmmMathError('invalid_amount');
  }
  return parsed;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

export function swapDirectionIsOpposite(
  left: EvmDecodedSwap['direction'],
  right: EvmDecodedSwap['direction'],
): boolean {
  return (
    (left === 'token0_to_token1' && right === 'token1_to_token0') ||
    (left === 'token1_to_token0' && right === 'token0_to_token1')
  );
}
