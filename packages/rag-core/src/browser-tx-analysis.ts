import type { TxAnalysisResult } from '@xxyy/shared';

import {
  TxAnalysisProviderUnavailableError,
  TxAnalysisUnsupportedChainError,
  type TxAnalysisProvider,
} from './tx-analysis.js';

export type BrowserTradeSide = 'buy' | 'sell' | 'unknown';

export interface BrowserTxTrade {
  hash: string;
  traderAddress?: string;
  side: BrowserTradeSide;
  timestamp?: string;
  summary: string;
}

export interface BrowserSolanaTxSnapshot {
  txHash?: string;
  contractAddress?: string;
  poolAddress?: string;
  program?: string;
  transactionTime?: string;
  solscanUrl: string;
  xxyyPoolUrl?: string;
  screenshotUrl?: string;
  targetTrade: BrowserTxTrade;
  tradeWindow: {
    before: BrowserTxTrade[];
    after: BrowserTxTrade[];
  };
}

export interface BrowserTxAnalysisDriver {
  analyzeSolanaTransaction(input: { txHash: string }): Promise<BrowserSolanaTxSnapshot>;
}

export interface BrowserTxAnalysisProviderOptions {
  driver: BrowserTxAnalysisDriver;
}

interface SandwichWindowSignal {
  verdict: TxAnalysisResult['verdict'];
  confidence: number;
  frontRun?: BrowserTxTrade;
  backRun?: BrowserTxTrade;
  summary: string;
}

export function createBrowserTxAnalysisProvider(
  options: BrowserTxAnalysisProviderOptions,
): TxAnalysisProvider {
  return {
    async analyze(reference) {
      if (reference.chain !== 'solana') {
        throw new TxAnalysisUnsupportedChainError(
          `Browser transaction analysis currently supports Solana only: ${reference.chain}`,
        );
      }

      try {
        const snapshot = await options.driver.analyzeSolanaTransaction({
          txHash: reference.txHash,
        });
        return createBrowserTxAnalysisResult(reference.txHash, snapshot);
      } catch (error) {
        if (error instanceof TxAnalysisUnsupportedChainError) {
          throw error;
        }
        if (error instanceof TxAnalysisProviderUnavailableError) {
          throw error;
        }

        throw new TxAnalysisProviderUnavailableError(
          error instanceof Error ? error.message : 'browser transaction analysis failed',
        );
      }
    },
  };
}

function createBrowserTxAnalysisResult(
  txHash: string,
  snapshot: BrowserSolanaTxSnapshot,
): TxAnalysisResult {
  const signal = analyzeTradeWindow(snapshot.targetTrade, snapshot.tradeWindow);
  const relatedTransactions = [
    ...(signal.frontRun === undefined
      ? []
      : [toRelatedTransaction(signal.frontRun, 'front_run' as const)]),
    toRelatedTransaction(snapshot.targetTrade, 'user'),
    ...(signal.backRun === undefined
      ? []
      : [toRelatedTransaction(signal.backRun, 'back_run' as const)]),
  ];

  return {
    analyzedAt: new Date().toISOString(),
    chain: 'solana',
    ...(snapshot.contractAddress === undefined
      ? {}
      : { contractAddress: snapshot.contractAddress }),
    dataSource: 'browser',
    evidence: [
      {
        detail: `已从 Solscan 交易页读取交易信息，并在 XXYY Discover 的池子交易窗口中检查目标交易前 ${snapshot.tradeWindow.before.length} 笔、后 ${snapshot.tradeWindow.after.length} 笔交易。`,
        label: '前后交易窗口',
        severity: signal.verdict === 'sandwiched' ? 'warning' : 'info',
      },
      ...(snapshot.program === undefined
        ? []
        : [
            {
              detail: snapshot.program,
              label: '交易程序',
              severity: 'info' as const,
            },
          ]),
      ...(snapshot.xxyyPoolUrl === undefined
        ? []
        : [
            {
              detail: snapshot.xxyyPoolUrl,
              label: 'XXYY 池子页面',
              severity: 'info' as const,
            },
          ]),
    ],
    explorerUrl: snapshot.solscanUrl,
    confidence: signal.confidence,
    ...(snapshot.poolAddress === undefined ? {} : { poolAddress: snapshot.poolAddress }),
    relatedTransactions,
    ...(snapshot.screenshotUrl === undefined ? {} : { screenshotUrl: snapshot.screenshotUrl }),
    summary: createSummary(signal, snapshot),
    txHash,
    verdict: signal.verdict,
  };
}

function analyzeTradeWindow(
  targetTrade: BrowserTxTrade,
  tradeWindow: BrowserSolanaTxSnapshot['tradeWindow'],
): SandwichWindowSignal {
  const targetSide = targetTrade.side;
  if (targetSide === 'unknown' || targetTrade.traderAddress === undefined) {
    return {
      confidence: 0.35,
      summary: '交易方向或交易者地址不足，无法确认是否被夹。',
      verdict: 'inconclusive',
    };
  }

  const beforeCandidates = tradeWindow.before.filter(
    (trade) =>
      trade.traderAddress !== undefined &&
      trade.traderAddress !== targetTrade.traderAddress &&
      trade.side === targetSide,
  );
  const frontRun = [...beforeCandidates]
    .reverse()
    .find((beforeTrade) =>
      tradeWindow.after.some(
        (afterTrade) =>
          afterTrade.traderAddress === beforeTrade.traderAddress &&
          afterTrade.side === oppositeSide(targetSide),
      ),
    );
  const backRun =
    frontRun === undefined
      ? undefined
      : tradeWindow.after.find(
          (trade) =>
            trade.traderAddress === frontRun.traderAddress &&
            trade.side === oppositeSide(targetSide),
        );

  if (frontRun !== undefined && backRun !== undefined) {
    return {
      backRun,
      confidence: 0.82,
      frontRun,
      summary: '目标交易前后存在同一交易者的同向前置交易和反向后置交易，疑似被夹。',
      verdict: 'sandwiched',
    };
  }

  if (tradeWindow.before.length >= 5 && tradeWindow.after.length >= 5) {
    return {
      confidence: 0.58,
      summary: '目标交易前后 5 笔窗口内未发现同一交易者的典型 sandwich 前后腿组合。',
      verdict: 'not_sandwiched',
    };
  }

  return {
    confidence: 0.4,
    summary: '目标交易前后交易窗口不足，无法确认是否被夹。',
    verdict: 'inconclusive',
  };
}

function createSummary(signal: SandwichWindowSignal, snapshot: BrowserSolanaTxSnapshot): string {
  const details = [
    signal.summary,
    snapshot.poolAddress === undefined ? undefined : `池子：${snapshot.poolAddress}`,
    snapshot.contractAddress === undefined ? undefined : `合约：${snapshot.contractAddress}`,
    snapshot.transactionTime === undefined ? undefined : `交易时间：${snapshot.transactionTime}`,
  ].filter((item): item is string => item !== undefined);

  return details.join(' ');
}

function oppositeSide(side: BrowserTradeSide): BrowserTradeSide {
  if (side === 'buy') {
    return 'sell';
  }
  if (side === 'sell') {
    return 'buy';
  }

  return 'unknown';
}

function toRelatedTransaction(
  trade: BrowserTxTrade,
  role: TxAnalysisResult['relatedTransactions'][number]['role'],
): TxAnalysisResult['relatedTransactions'][number] {
  return {
    hash: trade.hash,
    role,
    summary: trade.summary,
    ...(trade.timestamp === undefined ? {} : { timestamp: trade.timestamp }),
  };
}
