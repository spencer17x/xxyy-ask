import { EVM_UINT256_MAX, evmAddressSchema } from '@xxyy/transaction-analysis-core';

export const UNISWAP_V2_SYNC_TOPIC =
  '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1' as const;
export const MIN_UNISWAP_V3_TICK = -887_272;
export const MAX_UNISWAP_V3_TICK = 887_272;
export const MIN_UNISWAP_V3_SQRT_RATIO = 4_295_128_739n;
export const MAX_UNISWAP_V3_SQRT_RATIO =
  1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;

const UINT256_MODULUS = 1n << 256n;
const Q32 = 1n << 32n;
const Q128 = 1n << 128n;
const TICK_RATIO_MULTIPLIERS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
] as const;

export interface DecodedV2Reserves {
  reserve0: bigint;
  reserve1: bigint;
}

export interface DecodedV3Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
}

export interface DecodedV3TickInfo {
  liquidityGross: bigint;
  liquidityNet: bigint;
}

export interface DecodedTransferLog {
  amount: bigint;
  from: string;
  to: string;
}

export interface ActiveTickRange {
  lowerTick: number;
  upperTick: number;
}

export function decodeV2Reserves(input: unknown): DecodedV2Reserves | undefined {
  const words = parseWords(input, 3);
  if (words === undefined) {
    return undefined;
  }
  const reserve0 = decodeUnsigned(words[0], 112);
  const reserve1 = decodeUnsigned(words[1], 112);
  const timestamp = decodeUnsigned(words[2], 32);
  if (reserve0 === undefined || reserve1 === undefined || timestamp === undefined) {
    return undefined;
  }
  return { reserve0, reserve1 };
}

export function decodeV2SyncLog(log: {
  data: string;
  topics: readonly string[];
}): DecodedV2Reserves | undefined {
  if (log.topics.length !== 1 || log.topics[0] !== UNISWAP_V2_SYNC_TOPIC) {
    return undefined;
  }
  const words = parseWords(log.data, 2);
  if (words === undefined) {
    return undefined;
  }
  const reserve0 = decodeUnsigned(words[0], 112);
  const reserve1 = decodeUnsigned(words[1], 112);
  if (reserve0 === undefined || reserve1 === undefined || reserve0 === 0n || reserve1 === 0n) {
    return undefined;
  }
  return { reserve0, reserve1 };
}

export function decodeV3Slot0(input: unknown): DecodedV3Slot0 | undefined {
  const words = parseWords(input, 7);
  if (words === undefined) {
    return undefined;
  }
  const sqrtPriceX96 = decodeUnsigned(words[0], 160);
  const tick = decodeSignedNumber(words[1], 24);
  const observationIndex = decodeUnsigned(words[2], 16);
  const observationCardinality = decodeUnsigned(words[3], 16);
  const observationCardinalityNext = decodeUnsigned(words[4], 16);
  const feeProtocol = decodeUnsigned(words[5], 8);
  const unlocked = decodeUnsigned(words[6], 8);
  if (
    sqrtPriceX96 === undefined ||
    sqrtPriceX96 === 0n ||
    tick === undefined ||
    observationIndex === undefined ||
    observationCardinality === undefined ||
    observationCardinalityNext === undefined ||
    feeProtocol === undefined ||
    unlocked === undefined ||
    (unlocked !== 0n && unlocked !== 1n)
  ) {
    return undefined;
  }
  return { sqrtPriceX96, tick };
}

export function decodeV3Liquidity(input: unknown): bigint | undefined {
  const words = parseWords(input, 1);
  const liquidity = words === undefined ? undefined : decodeUnsigned(words[0], 128);
  return liquidity === undefined || liquidity === 0n ? undefined : liquidity;
}

export function decodeV3TickSpacing(input: unknown): number | undefined {
  const words = parseWords(input, 1);
  const spacing = words === undefined ? undefined : decodeSignedNumber(words[0], 24);
  return spacing === undefined || spacing <= 0 ? undefined : spacing;
}

export function decodeV3TickBitmap(input: unknown): bigint | undefined {
  const words = parseWords(input, 1);
  return words === undefined ? undefined : decodeUnsigned(words[0], 256);
}

export function decodeV3TickInfo(input: unknown): DecodedV3TickInfo | undefined {
  const words = parseWords(input, 8);
  if (words === undefined) {
    return undefined;
  }
  const liquidityGross = decodeUnsigned(words[0], 128);
  const liquidityNet = decodeSigned(words[1], 128);
  const initialized = decodeUnsigned(words[7], 8);
  if (
    liquidityGross === undefined ||
    liquidityGross === 0n ||
    liquidityNet === undefined ||
    initialized !== 1n
  ) {
    return undefined;
  }
  return { liquidityGross, liquidityNet };
}

export function decodeTransferLog(
  log: { data: string; topics: readonly string[] },
  transferTopic: string,
): DecodedTransferLog | undefined {
  if (log.topics.length !== 3 || log.topics[0] !== transferTopic) {
    return undefined;
  }
  const from = decodeAddressTopic(log.topics[1]);
  const to = decodeAddressTopic(log.topics[2]);
  const words = parseWords(log.data, 1);
  const amount = words === undefined ? undefined : decodeUnsigned(words[0], 256);
  if (from === undefined || to === undefined || amount === undefined) {
    return undefined;
  }
  return { amount, from, to };
}

export function findActiveTickRange(
  tick: number,
  tickSpacing: number,
  bitmaps: ReadonlyMap<number, bigint>,
  maxWordsPerSide: number,
): ActiveTickRange | undefined {
  if (
    !Number.isInteger(tick) ||
    !Number.isInteger(tickSpacing) ||
    tickSpacing <= 0 ||
    !Number.isInteger(maxWordsPerSide) ||
    maxWordsPerSide < 0
  ) {
    return undefined;
  }
  const compressed = floorDiv(tick, tickSpacing);
  const currentWord = floorDiv(compressed, 256);
  const currentBit = positiveModulo(compressed, 256);

  let lowerCompressed: number | undefined;
  for (let offset = 0; offset <= maxWordsPerSide; offset += 1) {
    const wordPosition = currentWord - offset;
    const word = bitmaps.get(wordPosition);
    if (word === undefined) {
      continue;
    }
    const mask = offset === 0 ? (1n << BigInt(currentBit + 1)) - 1n : EVM_UINT256_MAX;
    const masked = word & mask;
    if (masked !== 0n) {
      lowerCompressed = wordPosition * 256 + mostSignificantBit(masked);
      break;
    }
  }

  let upperCompressed: number | undefined;
  for (let offset = 0; offset <= maxWordsPerSide; offset += 1) {
    const wordPosition = currentWord + offset;
    const word = bitmaps.get(wordPosition);
    if (word === undefined) {
      continue;
    }
    const lowerMask = offset === 0 ? (1n << BigInt(currentBit + 1)) - 1n : 0n;
    const masked = word & (EVM_UINT256_MAX ^ lowerMask);
    if (masked !== 0n) {
      upperCompressed = wordPosition * 256 + leastSignificantBit(masked);
      break;
    }
  }

  if (lowerCompressed === undefined || upperCompressed === undefined) {
    return undefined;
  }
  const lowerTick = lowerCompressed * tickSpacing;
  const upperTick = upperCompressed * tickSpacing;
  if (
    lowerTick < MIN_UNISWAP_V3_TICK ||
    upperTick > MAX_UNISWAP_V3_TICK ||
    lowerTick > tick ||
    upperTick <= tick
  ) {
    return undefined;
  }
  return { lowerTick, upperTick };
}

export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_UNISWAP_V3_TICK || tick > MAX_UNISWAP_V3_TICK) {
    throw new Error('Tick is outside the Uniswap V3 TickMath domain.');
  }
  const absoluteTick = Math.abs(tick);
  let ratio = (absoluteTick & 1) === 1 ? TICK_RATIO_MULTIPLIERS[0] : Q128;
  for (let index = 1; index < TICK_RATIO_MULTIPLIERS.length; index += 1) {
    if ((absoluteTick & (2 ** index)) !== 0) {
      ratio = (ratio * TICK_RATIO_MULTIPLIERS[index]!) >> 128n;
    }
  }
  if (tick > 0) {
    ratio = EVM_UINT256_MAX / ratio;
  }
  return ratio / Q32 + (ratio % Q32 === 0n ? 0n : 1n);
}

export function encodeUintWord(value: bigint): string {
  if (value < 0n || value > EVM_UINT256_MAX) {
    throw new Error('ABI uint word exceeds uint256.');
  }
  return value.toString(16).padStart(64, '0');
}

export function encodeSignedWordForFixture(value: bigint): string {
  if (value < -(1n << 255n) || value > (1n << 255n) - 1n) {
    throw new Error('ABI signed word exceeds int256.');
  }
  const encoded = value < 0n ? UINT256_MODULUS + value : value;
  return encoded.toString(16).padStart(64, '0');
}

export function encodeAddressTopic(address: string): string {
  return `0x${evmAddressSchema.parse(address).slice(2).padStart(64, '0')}`;
}

function parseWords(input: unknown, count: number): string[] | undefined {
  if (typeof input !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`, 'u').test(input)) {
    return undefined;
  }
  const words: string[] = [];
  for (let index = 0; index < count; index += 1) {
    words.push(input.slice(2 + index * 64, 2 + (index + 1) * 64).toLowerCase());
  }
  return words;
}

function decodeUnsigned(word: string | undefined, bits: number): bigint | undefined {
  if (word === undefined) {
    return undefined;
  }
  const value = BigInt(`0x${word}`);
  return value < 1n << BigInt(bits) ? value : undefined;
}

function decodeSigned(word: string | undefined, bits: number): bigint | undefined {
  if (word === undefined) {
    return undefined;
  }
  const raw = BigInt(`0x${word}`);
  const signed = raw >= 1n << 255n ? raw - UINT256_MODULUS : raw;
  const minimum = -(1n << (BigInt(bits) - 1n));
  const maximum = (1n << (BigInt(bits) - 1n)) - 1n;
  return signed >= minimum && signed <= maximum ? signed : undefined;
}

function decodeSignedNumber(word: string | undefined, bits: number): number | undefined {
  const value = decodeSigned(word, bits);
  return value === undefined ? undefined : Number(value);
}

function decodeAddressTopic(topic: string | undefined): string | undefined {
  if (topic === undefined || !/^0x0{24}[0-9a-f]{40}$/u.test(topic)) {
    return undefined;
  }
  try {
    return evmAddressSchema.parse(`0x${topic.slice(-40)}`);
  } catch {
    return undefined;
  }
}

function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function mostSignificantBit(value: bigint): number {
  let bit = -1;
  let remaining = value;
  while (remaining > 0n) {
    remaining >>= 1n;
    bit += 1;
  }
  return bit;
}

function leastSignificantBit(value: bigint): number {
  let bit = 0;
  let remaining = value;
  while ((remaining & 1n) === 0n) {
    remaining >>= 1n;
    bit += 1;
  }
  return bit;
}
