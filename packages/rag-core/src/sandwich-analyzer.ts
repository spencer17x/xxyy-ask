import type { TxAnalysisEvidence, TxAnalysisResult } from '@xxyy/shared';

export type SandwichTradeSide = 'buy' | 'sell' | 'unknown';

export interface SandwichTrade {
  hash: string;
  poolAddress?: string;
  traderAddress?: string;
  side: SandwichTradeSide;
  timestamp?: string;
  summary: string;
}

export interface SandwichTradeWindow {
  before: SandwichTrade[];
  after: SandwichTrade[];
}

export interface SandwichWindowAnalysis {
  backRun?: SandwichTrade;
  confidence: number;
  evidence: TxAnalysisEvidence[];
  frontRun?: SandwichTrade;
  ruleVersion: string;
  summary: string;
  verdict: TxAnalysisResult['verdict'];
}

export interface SandwichWindowAnalysisOptions {
  completeWindowSize?: number;
  maxLegGapMs?: number;
}

interface CandidatePair {
  afterDeltaMs?: number;
  backRun: SandwichTrade;
  beforeDeltaMs?: number;
  frontRun: SandwichTrade;
}

interface CandidateSearchResult {
  candidate: CandidatePair;
  candidateCount: number;
}

const DEFAULT_COMPLETE_WINDOW_SIZE = 5;
const DEFAULT_MAX_LEG_GAP_MS = 120_000;
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const EVM_TRANSACTION_HASH_PATTERN = /^0x[a-f0-9]{64}$/iu;
export const SANDWICH_ANALYZER_VERSION = 'sandwich-window-rules-v1';

export function analyzeSandwichWindow(
  targetTrade: SandwichTrade,
  tradeWindow: SandwichTradeWindow,
  options: SandwichWindowAnalysisOptions = {},
): SandwichWindowAnalysis {
  const completeWindowSize = options.completeWindowSize ?? DEFAULT_COMPLETE_WINDOW_SIZE;
  const maxLegGapMs = options.maxLegGapMs ?? DEFAULT_MAX_LEG_GAP_MS;
  const evidence = [
    createCoverageEvidence(tradeWindow, completeWindowSize),
    createAnalyzerVersionEvidence(),
  ];
  const targetSide = targetTrade.side;

  if (targetSide === 'unknown' || !hasKnownTraderAddress(targetTrade)) {
    return {
      confidence: 0.35,
      evidence: [
        ...evidence,
        {
          detail: '缺少目标交易方向或交易者地址，无法判断同一交易者前后腿。',
          label: '目标交易信息',
          severity: 'warning',
        },
      ],
      ruleVersion: SANDWICH_ANALYZER_VERSION,
      summary: '交易方向或交易者地址不足，无法确认是否被夹。',
      verdict: 'inconclusive',
    };
  }

  const candidateResult = findBestCandidatePair(targetTrade, tradeWindow, maxLegGapMs);
  if (candidateResult !== undefined) {
    const candidate = candidateResult.candidate;
    const timeKnown = candidate.beforeDeltaMs !== undefined && candidate.afterDeltaMs !== undefined;
    const completeWindow = isCompleteWindow(tradeWindow, completeWindowSize);
    const confidence = confidenceForSandwich(timeKnown, completeWindow);

    return {
      backRun: candidate.backRun,
      confidence,
      evidence: [
        ...evidence,
        {
          detail: `发现交易者 ${candidate.frontRun.traderAddress ?? '未知'} 在目标交易前同向 ${formatSide(
            targetSide,
          )}，并在目标交易后反向 ${formatSide(candidate.backRun.side)}。`,
          label: '同一交易者前后腿',
          severity: 'warning',
        },
        createReviewHashEvidence(targetTrade, candidate),
        createTimeWindowEvidence(candidate, maxLegGapMs),
        createScoreEvidence({
          candidate,
          candidateCount: candidateResult.candidateCount,
          completeWindow,
          confidence,
          timeKnown,
        }),
      ],
      frontRun: candidate.frontRun,
      ruleVersion: SANDWICH_ANALYZER_VERSION,
      summary: `目标交易前后 ${Math.round(maxLegGapMs / 1000)} 秒内出现同一交易者的同向前置交易和反向后置交易，疑似被夹。`,
      verdict: 'sandwiched',
    };
  }

  const rejectedPoolEvidence = createRejectedPoolEvidence(targetTrade, tradeWindow);
  const rejectedTimeEvidence = createRejectedTimeEvidence(targetTrade, tradeWindow, maxLegGapMs);
  const noPairEvidence: TxAnalysisEvidence = {
    detail: '未发现同一交易者同时满足同向前置交易和反向后置交易。',
    label: '同一交易者前后腿',
    severity: 'info',
  };

  if (isCompleteWindow(tradeWindow, completeWindowSize)) {
    return {
      confidence: 0.6,
      evidence: [
        ...evidence,
        noPairEvidence,
        ...(rejectedPoolEvidence === undefined ? [] : [rejectedPoolEvidence]),
        ...(rejectedTimeEvidence === undefined ? [] : [rejectedTimeEvidence]),
      ],
      ruleVersion: SANDWICH_ANALYZER_VERSION,
      summary: `目标交易前后各 ${completeWindowSize} 笔窗口内未发现符合时间约束的典型 sandwich 前后腿组合。`,
      verdict: 'not_sandwiched',
    };
  }

  return {
    confidence: 0.4,
    evidence: [
      ...evidence,
      noPairEvidence,
      ...(rejectedPoolEvidence === undefined ? [] : [rejectedPoolEvidence]),
      ...(rejectedTimeEvidence === undefined ? [] : [rejectedTimeEvidence]),
    ],
    ruleVersion: SANDWICH_ANALYZER_VERSION,
    summary: '目标交易前后交易窗口不足，无法确认是否被夹。',
    verdict: 'inconclusive',
  };
}

function hasKnownTraderAddress(trade: SandwichTrade): boolean {
  return normalizeOptionalAddress(trade.traderAddress) !== undefined;
}

function createAnalyzerVersionEvidence(): TxAnalysisEvidence {
  return {
    detail: `当前使用 ${SANDWICH_ANALYZER_VERSION}：同一交易者前后腿、池子一致性、时间窗口和窗口覆盖度规则。`,
    label: '判断规则版本',
    severity: 'info',
  };
}

function createCoverageEvidence(
  tradeWindow: SandwichTradeWindow,
  completeWindowSize: number,
): TxAnalysisEvidence {
  const completeWindow = isCompleteWindow(tradeWindow, completeWindowSize);
  return {
    detail: `已取得目标交易前 ${tradeWindow.before.length} 笔、后 ${tradeWindow.after.length} 笔；完整窗口阈值为前后各 ${completeWindowSize} 笔。`,
    label: '交易窗口覆盖',
    severity: completeWindow ? 'info' : 'warning',
  };
}

function findBestCandidatePair(
  targetTrade: SandwichTrade,
  tradeWindow: SandwichTradeWindow,
  maxLegGapMs: number,
): CandidateSearchResult | undefined {
  const targetTime = parseTimestamp(targetTrade.timestamp);
  const candidates: CandidatePair[] = [];

  for (const frontRun of tradeWindow.before) {
    if (!isFrontRunCandidate(frontRun, targetTrade)) {
      continue;
    }

    for (const backRun of tradeWindow.after) {
      if (!isBackRunCandidate(backRun, frontRun, targetTrade)) {
        continue;
      }

      const beforeDeltaMs = timeDeltaMs(targetTime, frontRun.timestamp, 'before');
      const afterDeltaMs = timeDeltaMs(targetTime, backRun.timestamp, 'after');
      if (!isAcceptedTimeDelta(beforeDeltaMs, maxLegGapMs)) {
        continue;
      }
      if (!isAcceptedTimeDelta(afterDeltaMs, maxLegGapMs)) {
        continue;
      }

      candidates.push({
        ...(afterDeltaMs === undefined ? {} : { afterDeltaMs }),
        backRun,
        ...(beforeDeltaMs === undefined ? {} : { beforeDeltaMs }),
        frontRun,
      });
    }
  }

  const candidate = candidates.sort(compareCandidatePairs)[0];
  if (candidate === undefined) {
    return undefined;
  }

  return {
    candidate,
    candidateCount: candidates.length,
  };
}

function isFrontRunCandidate(frontRun: SandwichTrade, targetTrade: SandwichTrade): boolean {
  return (
    frontRun.traderAddress !== undefined &&
    !isSameTransactionHash(frontRun.hash, targetTrade.hash) &&
    !isSameTraderAddress(frontRun.traderAddress, targetTrade.traderAddress) &&
    isSamePoolContext(frontRun, targetTrade) &&
    frontRun.side === targetTrade.side
  );
}

function isBackRunCandidate(
  backRun: SandwichTrade,
  frontRun: SandwichTrade,
  targetTrade: SandwichTrade,
): boolean {
  return (
    backRun.traderAddress !== undefined &&
    !isSameTransactionHash(backRun.hash, targetTrade.hash) &&
    !isSameTransactionHash(backRun.hash, frontRun.hash) &&
    isSameTraderAddress(backRun.traderAddress, frontRun.traderAddress) &&
    isSamePoolContext(backRun, frontRun) &&
    isSamePoolContext(backRun, targetTrade) &&
    backRun.side === oppositeSide(targetTrade.side)
  );
}

function isSameTraderAddress(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }

  const normalizedLeft = left.trim();
  const normalizedRight = right.trim();
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return false;
  }

  if (EVM_ADDRESS_PATTERN.test(normalizedLeft) && EVM_ADDRESS_PATTERN.test(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

function isSameTransactionHash(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = left?.trim();
  const normalizedRight = right?.trim();
  if (
    normalizedLeft === undefined ||
    normalizedRight === undefined ||
    normalizedLeft.length === 0 ||
    normalizedRight.length === 0
  ) {
    return false;
  }

  if (
    EVM_TRANSACTION_HASH_PATTERN.test(normalizedLeft) &&
    EVM_TRANSACTION_HASH_PATTERN.test(normalizedRight)
  ) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

function isSamePoolContext(left: SandwichTrade, right: SandwichTrade): boolean {
  const leftPoolAddress = normalizeOptionalAddress(left.poolAddress);
  const rightPoolAddress = normalizeOptionalAddress(right.poolAddress);
  if (leftPoolAddress === undefined || rightPoolAddress === undefined) {
    return true;
  }

  return isSameTraderAddress(leftPoolAddress, rightPoolAddress);
}

function normalizeOptionalAddress(address: string | undefined): string | undefined {
  const normalized = address?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function compareCandidatePairs(left: CandidatePair, right: CandidatePair): number {
  const knownTimeDifference = candidateKnownTimeCount(right) - candidateKnownTimeCount(left);
  if (knownTimeDifference !== 0) {
    return knownTimeDifference;
  }

  return candidateDistanceMs(left) - candidateDistanceMs(right);
}

function candidateDistanceMs(candidate: CandidatePair): number {
  return (candidate.beforeDeltaMs ?? 0) + (candidate.afterDeltaMs ?? 0);
}

function candidateKnownTimeCount(candidate: CandidatePair): number {
  return (
    Number(candidate.beforeDeltaMs !== undefined) + Number(candidate.afterDeltaMs !== undefined)
  );
}

function createTimeWindowEvidence(
  candidate: CandidatePair,
  maxLegGapMs: number,
): TxAnalysisEvidence {
  if (candidate.beforeDeltaMs === undefined || candidate.afterDeltaMs === undefined) {
    return {
      detail: `部分交易缺少可解析时间戳，已按 XXYY 成交列表前后顺序辅助判断；标准时间阈值为 ${Math.round(
        maxLegGapMs / 1000,
      )} 秒。`,
      label: '时间窗口',
      severity: 'warning',
    };
  }

  return {
    detail: `前置交易距离目标 ${formatSeconds(candidate.beforeDeltaMs)} 秒，后置交易距离目标 ${formatSeconds(
      candidate.afterDeltaMs,
    )} 秒，均在 ${Math.round(maxLegGapMs / 1000)} 秒阈值内。`,
    label: '时间窗口',
    severity: 'warning',
  };
}

function createReviewHashEvidence(
  targetTrade: SandwichTrade,
  candidate: CandidatePair,
): TxAnalysisEvidence {
  return {
    detail: `目标交易 ${targetTrade.hash}；前置交易 ${candidate.frontRun.hash}；后置交易 ${candidate.backRun.hash}。请结合 XXYY 原页面截图中被标记的目标成交行复核。`,
    label: '复核交易哈希',
    severity: 'warning',
  };
}

function createScoreEvidence(input: {
  candidate: CandidatePair;
  candidateCount: number;
  completeWindow: boolean;
  confidence: number;
  timeKnown: boolean;
}): TxAnalysisEvidence {
  const totalDistanceMs = candidateDistanceMs(input.candidate);
  const windowLabel = input.completeWindow ? '完整窗口' : '窗口不足';
  const timeLabel = input.timeKnown ? '时间戳完整' : '部分时间戳缺失';
  const distanceLabel = input.timeKnown
    ? `总时间间隔 ${formatSeconds(totalDistanceMs)} 秒`
    : '总时间间隔无法计算';

  return {
    detail: `判断模型命中候选组合 ${input.candidateCount} 组，选择${distanceLabel}的组合；${windowLabel}，${timeLabel}，置信度 ${Math.round(
      input.confidence * 100,
    )}%。`,
    label: '判断评分',
    severity: 'info',
  };
}

function createRejectedTimeEvidence(
  targetTrade: SandwichTrade,
  tradeWindow: SandwichTradeWindow,
  maxLegGapMs: number,
): TxAnalysisEvidence | undefined {
  const targetTime = parseTimestamp(targetTrade.timestamp);
  if (targetTime === undefined) {
    return undefined;
  }

  for (const frontRun of tradeWindow.before) {
    if (!isFrontRunCandidate(frontRun, targetTrade)) {
      continue;
    }
    for (const backRun of tradeWindow.after) {
      if (!isBackRunCandidate(backRun, frontRun, targetTrade)) {
        continue;
      }

      const beforeDeltaMs = timeDeltaMs(targetTime, frontRun.timestamp, 'before');
      const afterDeltaMs = timeDeltaMs(targetTime, backRun.timestamp, 'after');
      if (beforeDeltaMs !== undefined || afterDeltaMs !== undefined) {
        return {
          detail: `发现同一交易者前后腿候选，但至少一侧距离目标交易超过 ${Math.round(
            maxLegGapMs / 1000,
          )} 秒，不计为典型 sandwich。`,
          label: '时间窗口',
          severity: 'info',
        };
      }
    }
  }

  return undefined;
}

function createRejectedPoolEvidence(
  targetTrade: SandwichTrade,
  tradeWindow: SandwichTradeWindow,
): TxAnalysisEvidence | undefined {
  for (const frontRun of tradeWindow.before) {
    if (!isFrontRunCandidateIgnoringPool(frontRun, targetTrade)) {
      continue;
    }
    for (const backRun of tradeWindow.after) {
      if (!isBackRunCandidateIgnoringPool(backRun, frontRun, targetTrade)) {
        continue;
      }

      if (
        !isSamePoolContext(frontRun, targetTrade) ||
        !isSamePoolContext(backRun, frontRun) ||
        !isSamePoolContext(backRun, targetTrade)
      ) {
        return {
          detail:
            '发现同一交易者前后腿候选，但候选交易不在目标交易同一池子/交易对内，不计为典型 sandwich。',
          label: '池子一致性',
          severity: 'info',
        };
      }
    }
  }

  return undefined;
}

function isFrontRunCandidateIgnoringPool(
  frontRun: SandwichTrade,
  targetTrade: SandwichTrade,
): boolean {
  return (
    frontRun.traderAddress !== undefined &&
    !isSameTransactionHash(frontRun.hash, targetTrade.hash) &&
    !isSameTraderAddress(frontRun.traderAddress, targetTrade.traderAddress) &&
    frontRun.side === targetTrade.side
  );
}

function isBackRunCandidateIgnoringPool(
  backRun: SandwichTrade,
  frontRun: SandwichTrade,
  targetTrade: SandwichTrade,
): boolean {
  return (
    backRun.traderAddress !== undefined &&
    !isSameTransactionHash(backRun.hash, targetTrade.hash) &&
    !isSameTransactionHash(backRun.hash, frontRun.hash) &&
    isSameTraderAddress(backRun.traderAddress, frontRun.traderAddress) &&
    backRun.side === oppositeSide(targetTrade.side)
  );
}

function timeDeltaMs(
  targetTime: number | undefined,
  tradeTimestamp: string | undefined,
  direction: 'before' | 'after',
): number | undefined {
  if (targetTime === undefined || tradeTimestamp === undefined) {
    return undefined;
  }

  const tradeTime = parseTimestamp(tradeTimestamp);
  if (tradeTime === undefined) {
    return undefined;
  }

  return direction === 'before' ? targetTime - tradeTime : tradeTime - targetTime;
}

function isAcceptedTimeDelta(deltaMs: number | undefined, maxLegGapMs: number): boolean {
  return deltaMs === undefined || (deltaMs >= 0 && deltaMs <= maxLegGapMs);
}

function parseTimestamp(timestamp: string | undefined): number | undefined {
  if (timestamp === undefined) {
    return undefined;
  }

  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isCompleteWindow(tradeWindow: SandwichTradeWindow, completeWindowSize: number): boolean {
  return (
    tradeWindow.before.length >= completeWindowSize &&
    tradeWindow.after.length >= completeWindowSize
  );
}

function confidenceForSandwich(timeKnown: boolean, completeWindow: boolean): number {
  if (timeKnown && completeWindow) {
    return 0.9;
  }
  if (completeWindow) {
    return 0.82;
  }

  return timeKnown ? 0.78 : 0.72;
}

function oppositeSide(side: SandwichTradeSide): SandwichTradeSide {
  if (side === 'buy') {
    return 'sell';
  }
  if (side === 'sell') {
    return 'buy';
  }

  return 'unknown';
}

function formatSide(side: SandwichTradeSide): string {
  if (side === 'buy') {
    return '买入';
  }
  if (side === 'sell') {
    return '卖出';
  }

  return '未知方向';
}

function formatSeconds(deltaMs: number): number {
  return Math.round(deltaMs / 1000);
}
