import type {
  TxAnalysisChain,
  TxAnalysisEvidence,
  TxAnalysisResult,
  TxAnalysisTradeSide,
} from '@xxyy/shared';

import { isBrowserTimeoutError, isTransientBrowserProviderMessage } from './browser-errors.js';
import { isBrowserVerificationText } from './browser-verification.js';
import { analyzeSandwichWindow, type SandwichWindowAnalysis } from './sandwich-analyzer.js';
import {
  TxAnalysisProviderUnavailableError,
  TxAnalysisUnsupportedChainError,
  type TxAnalysisFailureMetadata,
  type TxAnalysisProbeAttempt,
  type TxAnalysisProvider,
  type TxAnalysisUnavailableReason,
} from './tx-analysis.js';
import { parseTransactionReference, type TransactionReference } from './tx-hash.js';

export type BrowserTradeSide = 'buy' | 'sell' | 'unknown';
export type BrowserEvmChain = Extract<TxAnalysisChain, 'base' | 'ethereum' | 'bsc'>;

const BROWSER_EVM_CHAINS: BrowserEvmChain[] = ['base', 'ethereum', 'bsc'];
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const EVM_TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/iu;
const MISSING_REPORT_URL_MESSAGE = '报告写入器未返回可用报告链接。';
const FAILURE_METADATA_SCALAR_STRING_KEYS = [
  'contractAddress',
  'poolAddress',
  'reportWriteError',
  'routerAddress',
  'screenshotUrl',
  'targetTraderAddress',
  'transactionTime',
  'unsupportedChainHint',
  'unsupportedExplorerHost',
] satisfies readonly (keyof TxAnalysisFailureMetadata)[];

export interface BrowserTxTrade {
  explorerUrl?: string;
  hash: string;
  poolAddress?: string;
  traderAddress?: string;
  side: BrowserTradeSide;
  timestamp?: string;
  summary: string;
}

interface BrowserTxSnapshotBase {
  txHash?: string;
  contractAddress?: string;
  poolAddress?: string;
  program?: string;
  routerAddress?: string;
  transactionTime?: string;
  xxyyPoolUrl?: string;
  screenshotUrl?: string;
  screenshotTargetRowMarked?: boolean;
  targetTrade: BrowserTxTrade;
  tradeWindow: {
    before: BrowserTxTrade[];
    after: BrowserTxTrade[];
  };
}

export interface BrowserSolanaTxSnapshot extends BrowserTxSnapshotBase {
  solscanUrl: string;
}

export interface BrowserEvmTxSnapshot extends BrowserTxSnapshotBase {
  explorerUrl: string;
}

export interface BrowserTxAnalysisReviewInput {
  chain: TxAnalysisChain;
  contractAddress?: string;
  poolAddress?: string;
  requestedTxHash: string;
  ruleAnalysis: SandwichWindowAnalysis;
  targetTrade: BrowserTxTrade;
  tradeWindow: BrowserTxSnapshotBase['tradeWindow'];
}

export interface BrowserTxAnalysisReview {
  confidence?: number;
  evidence?: TxAnalysisEvidence[];
  summary?: string;
  verdict?: TxAnalysisResult['verdict'];
}

export interface BrowserTxAnalysisReviewer {
  review(
    input: BrowserTxAnalysisReviewInput,
  ): BrowserTxAnalysisReview | undefined | Promise<BrowserTxAnalysisReview | undefined>;
}

export interface BrowserEvmTxAnalysisDriver {
  analyzeEvmTransaction(input: {
    chain: BrowserEvmChain;
    txHash: string;
  }): Promise<BrowserEvmTxSnapshot>;
}

export interface BrowserTxAnalysisDriver {
  analyzeEvmTransaction?: BrowserEvmTxAnalysisDriver['analyzeEvmTransaction'];
  analyzeSolanaTransaction(input: { txHash: string }): Promise<BrowserSolanaTxSnapshot>;
}

export interface BrowserTxChainAdapter {
  analyze(reference: TransactionReference): Promise<TxAnalysisResult>;
  supports(reference: TransactionReference): boolean;
}

export interface BrowserTxAnalysisReportWriter {
  writeFailureReport?(input: {
    metadata?: TxAnalysisFailureMetadata;
    message: string;
    reason: TxAnalysisUnavailableReason;
    reference: TransactionReference;
  }): Promise<{ reportUrl: string }>;
  writeReport(input: {
    reference: TransactionReference;
    result: TxAnalysisResult;
  }): Promise<{ reportUrl: string }>;
}

export interface BrowserTxAnalysisProviderOptions {
  adapters?: BrowserTxChainAdapter[];
  analysisReviewer?: BrowserTxAnalysisReviewer;
  driver?: BrowserTxAnalysisDriver;
  maxConcurrentAnalyses?: number;
  maxRetries?: number;
  reportWriter?: BrowserTxAnalysisReportWriter;
}

export function createBrowserTxAnalysisProvider(
  options: BrowserTxAnalysisProviderOptions,
): TxAnalysisProvider {
  const adapters =
    options.adapters ??
    createDefaultBrowserTxChainAdapters(options.driver, options.analysisReviewer);
  const limiter = createConcurrencyLimiter(options.maxConcurrentAnalyses);
  const maxRetries = normalizeRetryCount(options.maxRetries);

  return {
    async analyze(reference) {
      const adapter = adapters.find((candidate) => candidate.supports(reference));
      if (adapter === undefined) {
        throw await attachFailureReport(
          new TxAnalysisUnsupportedChainError(
            `Browser transaction analysis does not support ${reference.chain}`,
          ),
          reference,
          options.reportWriter,
          'unsupported_chain',
        );
      }

      return limiter(async () => {
        try {
          const result = await analyzeWithRetry(adapter, reference, maxRetries);
          if (options.reportWriter === undefined) {
            return result;
          }

          return attachPersistedReport(result, reference, options.reportWriter);
        } catch (error) {
          throw await attachFailureReport(
            normalizeBrowserAnalysisError(error),
            reference,
            options.reportWriter,
          );
        }
      });
    },
  };
}

function createDefaultBrowserTxChainAdapters(
  driver: BrowserTxAnalysisDriver | undefined,
  analysisReviewer: BrowserTxAnalysisReviewer | undefined,
): BrowserTxChainAdapter[] {
  if (driver === undefined) {
    return [];
  }

  return [
    createSolanaBrowserTxChainAdapter(driver, analysisReviewer),
    ...(driver.analyzeEvmTransaction === undefined
      ? []
      : [
          createEvmBrowserTxChainAdapter(driver as BrowserEvmTxAnalysisDriver, analysisReviewer),
          createUnknownEvmBrowserTxChainAdapter(
            driver as BrowserEvmTxAnalysisDriver,
            analysisReviewer,
          ),
        ]),
  ];
}

async function attachPersistedReport(
  result: TxAnalysisResult,
  reference: TransactionReference,
  reportWriter: BrowserTxAnalysisReportWriter,
): Promise<TxAnalysisResult> {
  try {
    const report = await reportWriter.writeReport({
      reference: reportReferenceForResult(reference, result),
      result,
    });
    const reportUrl = nonBlankOptionalString(report.reportUrl);
    if (reportUrl === undefined) {
      throw new Error(MISSING_REPORT_URL_MESSAGE);
    }

    return {
      ...result,
      reportUrl,
    };
  } catch (error) {
    return {
      ...result,
      evidence: [
        ...result.evidence,
        {
          detail: `报告保存失败：${error instanceof Error ? error.message : String(error)}`,
          label: '交易分析报告',
          severity: 'warning',
        },
      ],
    };
  }
}

function reportReferenceForResult(
  reference: TransactionReference,
  result: TxAnalysisResult,
): TransactionReference {
  if (reference.chain === result.chain && reference.txHash === result.txHash) {
    return reference;
  }

  return {
    chain: result.chain,
    txHash: result.txHash,
  };
}

async function attachFailureReport(
  error: Error,
  reference: TransactionReference,
  reportWriter: BrowserTxAnalysisReportWriter | undefined,
  fallbackReason: TxAnalysisUnavailableReason = 'provider_unavailable',
): Promise<Error> {
  const reportReference = txAnalysisFailureReference(error, reference);
  const metadata = sanitizeBrowserFailureMetadata(
    reportReference,
    txAnalysisFailureMetadata(error),
  );
  const sanitizedError = withFailureMetadata(error, metadata);
  if (reportWriter?.writeFailureReport === undefined) {
    return sanitizedError;
  }

  const reason = txAnalysisFailureReason(sanitizedError, fallbackReason);
  try {
    const report = await reportWriter.writeFailureReport({
      message: sanitizedError.message,
      ...(metadata === undefined ? {} : { metadata }),
      reason,
      reference: reportReference,
    });
    const reportUrl = nonBlankOptionalString(report.reportUrl);
    if (reportUrl === undefined) {
      return withFailureReportWriteError(sanitizedError, new Error(MISSING_REPORT_URL_MESSAGE));
    }

    return withFailureReportUrl(sanitizedError, reportUrl);
  } catch (reportError) {
    return withFailureReportWriteError(sanitizedError, reportError);
  }
}

function sanitizeBrowserFailureMetadata(
  reference: TransactionReference,
  metadata: TxAnalysisFailureMetadata | undefined,
): TxAnalysisFailureMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const scalarMetadata = trimFailureMetadataScalarStrings(metadata);
  if (scalarMetadata === undefined) {
    return undefined;
  }

  const targetTradeSide = normalizeTxAnalysisTradeSide(scalarMetadata.targetTradeSide);
  const tradeSideMetadata =
    targetTradeSide === undefined
      ? scalarMetadata.targetTradeSide === undefined
        ? scalarMetadata
        : withoutMetadataKey(scalarMetadata, 'targetTradeSide')
      : { ...scalarMetadata, targetTradeSide };
  if (tradeSideMetadata === undefined) {
    return undefined;
  }

  const probeAttempts = sanitizeFailureProbeAttempts(tradeSideMetadata.probeAttempts);
  const probeMetadata =
    probeAttempts === undefined
      ? tradeSideMetadata.probeAttempts === undefined
        ? tradeSideMetadata
        : withoutMetadataKey(tradeSideMetadata, 'probeAttempts')
      : { ...tradeSideMetadata, probeAttempts };
  if (probeMetadata === undefined) {
    return undefined;
  }

  const explorerUrl = nonBlankOptionalString(probeMetadata.explorerUrl);
  const explorerMetadata =
    explorerUrl === undefined
      ? probeMetadata.explorerUrl === undefined
        ? probeMetadata
        : withoutMetadataKey(probeMetadata, 'explorerUrl')
      : browserExplorerUrlMatchesTransaction(reference.chain, explorerUrl, reference.txHash)
        ? explorerUrl === probeMetadata.explorerUrl
          ? probeMetadata
          : { ...probeMetadata, explorerUrl }
        : withoutMetadataKey(probeMetadata, 'explorerUrl');
  if (explorerMetadata === undefined) {
    return undefined;
  }

  const sourceExplorerUrl = nonBlankOptionalString(explorerMetadata.explorerUrl);
  const relatedTransactions = sanitizeFailureRelatedTransactions(
    reference,
    explorerMetadata.relatedTransactions,
    sourceExplorerUrl,
  );
  const relatedMetadata =
    relatedTransactions === undefined
      ? explorerMetadata.relatedTransactions === undefined
        ? explorerMetadata
        : withoutMetadataKey(explorerMetadata, 'relatedTransactions')
      : { ...explorerMetadata, relatedTransactions };
  if (relatedMetadata === undefined) {
    return undefined;
  }

  const xxyyPoolUrl = nonBlankOptionalString(relatedMetadata.xxyyPoolUrl);
  if (xxyyPoolUrl === undefined) {
    return relatedMetadata.xxyyPoolUrl === undefined
      ? relatedMetadata
      : withoutMetadataKey(relatedMetadata, 'xxyyPoolUrl');
  }

  const poolAddress = nonBlankOptionalString(relatedMetadata.poolAddress);
  const reviewablePoolAddress = nonBlankOptionalString(
    reviewableXxyyPoolUrlAddress(reference.chain, xxyyPoolUrl),
  );
  if (reviewablePoolAddress === undefined && poolAddress === undefined) {
    return withoutMetadataKey(relatedMetadata, 'xxyyPoolUrl');
  }
  if (!browserXxyyPoolUrlMatchesPoolAddress(reference.chain, xxyyPoolUrl, poolAddress)) {
    return withoutMetadataKey(relatedMetadata, 'xxyyPoolUrl');
  }

  return xxyyPoolUrl === relatedMetadata.xxyyPoolUrl
    ? relatedMetadata
    : { ...relatedMetadata, xxyyPoolUrl };
}

function trimFailureMetadataScalarStrings(
  metadata: TxAnalysisFailureMetadata,
): TxAnalysisFailureMetadata | undefined {
  let sanitized = metadata;
  for (const key of FAILURE_METADATA_SCALAR_STRING_KEYS) {
    const value = metadata[key];
    const trimmed = nonBlankOptionalString(value);
    if (trimmed === undefined) {
      if (value !== undefined) {
        const next = { ...sanitized };
        delete next[key];
        sanitized = next;
      }
      continue;
    }

    if (trimmed !== value) {
      sanitized = { ...sanitized, [key]: trimmed };
    }
  }

  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function sanitizeFailureProbeAttempts(
  probeAttempts: TxAnalysisProbeAttempt[] | undefined,
): TxAnalysisProbeAttempt[] | undefined {
  const sanitized = (probeAttempts ?? [])
    .map((attempt) => {
      const message = nonBlankOptionalString(attempt.message);
      return message === undefined ? undefined : { ...attempt, message };
    })
    .filter((attempt): attempt is TxAnalysisProbeAttempt => attempt !== undefined);

  return sanitized.length === 0 ? undefined : sanitized;
}

function sanitizeFailureRelatedTransactions(
  reference: TransactionReference,
  relatedTransactions: TxAnalysisResult['relatedTransactions'] | undefined,
  sourceExplorerUrl: string | undefined,
): TxAnalysisResult['relatedTransactions'] | undefined {
  const chain = reference.chain;
  const requestedTxHash = normalizeReviewableTransactionHash(
    chain,
    normalizeBrowserTransactionHash(reference.txHash),
  );
  const sanitized = (relatedTransactions ?? [])
    .map((transaction) => {
      const hash = normalizeReviewableTransactionHash(
        chain,
        normalizeBrowserTransactionHash(transaction.hash),
      );
      if (!isValidTransactionHashForChain(chain, hash)) {
        return undefined;
      }

      const collectedExplorerUrl = nonBlankOptionalString(transaction.explorerUrl);
      const explorerUrl =
        collectedExplorerUrl !== undefined &&
        browserExplorerUrlMatchesTransaction(chain, collectedExplorerUrl, hash)
          ? collectedExplorerUrl
          : sourceExplorerUrl === undefined
            ? undefined
            : buildRelatedTransactionExplorerUrl({ chain, sourceExplorerUrl }, hash);
      const timestamp = nonBlankOptionalString(transaction.timestamp);
      const traderAddress = nonBlankOptionalString(transaction.traderAddress);
      const normalizedRole = normalizeRelatedTransactionRole(transaction.role);
      const isRequestedTransaction =
        isValidTransactionHashForChain(chain, requestedTxHash) &&
        browserTargetHashMatches(chain, hash, requestedTxHash);
      const role = isRequestedTransaction ? 'user' : normalizedRole;
      const side = normalizeTxAnalysisTradeSide(transaction.side);
      const summary = sanitizedRelatedTransactionSummary(
        isRequestedTransaction && normalizedRole !== 'user' ? undefined : transaction.summary,
        role,
      );
      return {
        hash,
        role,
        summary,
        ...(explorerUrl === undefined ? {} : { explorerUrl }),
        ...(side === undefined ? {} : { side }),
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(traderAddress === undefined ? {} : { traderAddress }),
      };
    })
    .filter(
      (transaction): transaction is TxAnalysisResult['relatedTransactions'][number] =>
        transaction !== undefined,
    );

  if (
    sanitized.length > 0 &&
    isValidTransactionHashForChain(chain, requestedTxHash) &&
    !sanitized.some(
      (transaction) =>
        transaction.role === 'user' &&
        browserTargetHashMatches(chain, transaction.hash, requestedTxHash),
    )
  ) {
    const explorerUrl =
      sourceExplorerUrl === undefined
        ? undefined
        : buildRelatedTransactionExplorerUrl({ chain, sourceExplorerUrl }, requestedTxHash);
    const userTransaction: TxAnalysisResult['relatedTransactions'][number] = {
      hash: requestedTxHash,
      role: 'user',
      summary: '用户交易',
      ...(explorerUrl === undefined ? {} : { explorerUrl }),
    };
    const firstBackRunIndex = sanitized.findIndex((transaction) => transaction.role === 'back_run');
    if (firstBackRunIndex < 0) {
      sanitized.push(userTransaction);
    } else {
      sanitized.splice(firstBackRunIndex, 0, userTransaction);
    }
  }

  const deduplicated = deduplicateBrowserRelatedTransactions(chain, sanitized);

  return deduplicated.length === 0 ? undefined : deduplicated;
}

function deduplicateBrowserRelatedTransactions(
  chain: TxAnalysisChain,
  transactions: TxAnalysisResult['relatedTransactions'],
): TxAnalysisResult['relatedTransactions'] {
  const deduplicated: TxAnalysisResult['relatedTransactions'] = [];

  for (const transaction of transactions) {
    const duplicateIndex = deduplicated.findIndex((existing) =>
      browserTargetHashMatches(chain, existing.hash, transaction.hash),
    );
    if (duplicateIndex < 0) {
      deduplicated.push(transaction);
      continue;
    }

    const existing = deduplicated[duplicateIndex];
    if (
      existing !== undefined &&
      relatedTransactionRolePriority(transaction.role) >
        relatedTransactionRolePriority(existing.role)
    ) {
      deduplicated[duplicateIndex] = transaction;
    }
  }

  return deduplicated;
}

function relatedTransactionRolePriority(
  role: TxAnalysisResult['relatedTransactions'][number]['role'],
): number {
  switch (role) {
    case 'user':
      return 3;
    case 'front_run':
    case 'back_run':
      return 2;
    case 'related':
      return 1;
  }
}

function withoutMetadataKey<K extends keyof TxAnalysisFailureMetadata>(
  metadata: TxAnalysisFailureMetadata,
  key: K,
): TxAnalysisFailureMetadata | undefined {
  const sanitized = { ...metadata };
  delete sanitized[key];
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function withFailureMetadata(error: Error, metadata: TxAnalysisFailureMetadata | undefined): Error {
  const message = cleanFailureMessage(error);
  if (error instanceof TxAnalysisProviderUnavailableError) {
    return new TxAnalysisProviderUnavailableError(message, error.reason, {
      ...(metadata === undefined ? {} : { metadata }),
      ...(error.reference === undefined ? {} : { reference: error.reference }),
      ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
    });
  }
  if (error instanceof TxAnalysisUnsupportedChainError) {
    return new TxAnalysisUnsupportedChainError(message, {
      ...(metadata === undefined ? {} : { metadata }),
      ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
    });
  }

  return error;
}

function withFailureReportWriteError(error: Error, reportError: unknown): Error {
  const reportWriteError = reportError instanceof Error ? reportError.message : String(reportError);
  const message = cleanFailureMessage(error);
  if (error instanceof TxAnalysisProviderUnavailableError) {
    return new TxAnalysisProviderUnavailableError(message, error.reason, {
      metadata: {
        ...(error.metadata ?? {}),
        reportWriteError,
      },
      ...(error.reference === undefined ? {} : { reference: error.reference }),
      ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
    });
  }
  if (error instanceof TxAnalysisUnsupportedChainError) {
    return new TxAnalysisUnsupportedChainError(message, {
      metadata: {
        ...(error.metadata ?? {}),
        reportWriteError,
      },
      ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
    });
  }

  return error;
}

function txAnalysisFailureReason(
  error: Error,
  fallbackReason: TxAnalysisUnavailableReason,
): TxAnalysisUnavailableReason {
  if (error instanceof TxAnalysisProviderUnavailableError) {
    return error.reason;
  }
  if (error instanceof TxAnalysisUnsupportedChainError) {
    return 'unsupported_chain';
  }

  return fallbackReason;
}

function txAnalysisFailureReference(
  error: Error,
  fallbackReference: TransactionReference,
): TransactionReference {
  if (error instanceof TxAnalysisProviderUnavailableError && error.reference !== undefined) {
    return error.reference;
  }

  return fallbackReference;
}

function txAnalysisFailureMetadata(error: Error): TxAnalysisFailureMetadata | undefined {
  if (error instanceof TxAnalysisProviderUnavailableError) {
    return error.metadata;
  }
  if (error instanceof TxAnalysisUnsupportedChainError) {
    return error.metadata;
  }

  return undefined;
}

function withFailureReportUrl(error: Error, reportUrl: string): Error {
  const message = cleanFailureMessage(error);
  if (error instanceof TxAnalysisProviderUnavailableError) {
    return new TxAnalysisProviderUnavailableError(message, error.reason, {
      ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
      ...(error.reference === undefined ? {} : { reference: error.reference }),
      reportUrl,
    });
  }
  if (error instanceof TxAnalysisUnsupportedChainError) {
    return new TxAnalysisUnsupportedChainError(message, {
      ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
      reportUrl,
    });
  }

  return new TxAnalysisProviderUnavailableError(message, 'provider_unavailable', {
    reportUrl,
  });
}

function cleanFailureMessage(error: Error): string {
  return nonBlankOptionalString(error.message) ?? '交易分析失败。';
}

async function analyzeWithRetry(
  adapter: BrowserTxChainAdapter,
  reference: TransactionReference,
  maxRetries: number,
): Promise<TxAnalysisResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await adapter.analyze(reference);
    } catch (error) {
      const normalized = normalizeBrowserAnalysisError(error);
      if (!shouldRetryBrowserAnalysis(normalized, attempt, maxRetries)) {
        throw normalized;
      }
    }
  }
}

function normalizeBrowserAnalysisError(error: unknown): Error {
  if (error instanceof TxAnalysisUnsupportedChainError) {
    return error;
  }
  if (error instanceof TxAnalysisProviderUnavailableError) {
    return error;
  }

  return new TxAnalysisProviderUnavailableError(
    error instanceof Error ? error.message : 'browser transaction analysis failed',
    inferBrowserUnavailableReason(error),
  );
}

function shouldRetryBrowserAnalysis(error: Error, attempt: number, maxRetries: number): boolean {
  return (
    error instanceof TxAnalysisProviderUnavailableError &&
    (error.reason === 'timeout' || isTransientBrowserProviderError(error)) &&
    attempt < maxRetries
  );
}

function isTransientBrowserProviderError(error: TxAnalysisProviderUnavailableError): boolean {
  if (error.reason !== 'provider_unavailable') {
    return false;
  }

  return isTransientBrowserProviderMessage(error.message);
}

function createConcurrencyLimiter(
  maxConcurrentAnalyses: number | undefined,
): <T>(task: () => Promise<T>) => Promise<T> {
  const maxConcurrent =
    maxConcurrentAnalyses === undefined || maxConcurrentAnalyses < 1
      ? Number.POSITIVE_INFINITY
      : Math.floor(maxConcurrentAnalyses);
  let active = 0;
  const queue: Array<() => void> = [];

  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }

    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function normalizeRetryCount(maxRetries: number | undefined): number {
  if (maxRetries === undefined || !Number.isFinite(maxRetries) || maxRetries < 0) {
    return 0;
  }

  return Math.floor(maxRetries);
}

function inferBrowserUnavailableReason(error: unknown): TxAnalysisUnavailableReason {
  const message = error instanceof Error ? error.message : String(error);
  if (isBrowserVerificationText(message)) {
    return 'browser_verification_required';
  }
  if (isBrowserTimeoutError(error)) {
    return 'timeout';
  }
  if (
    /(?:transaction|tx|signature).{0,80}(?:pending|unconfirmed|not\s+confirmed|not\s+finalized|not\s+yet\s+(?:mined|included|confirmed)|awaiting\s+confirmation|awaiting\s+mining|awaiting\s+inclusion|confirming|processing|mempool|queued|dropped(?:\s*&\s*replaced)?|replaced)|(?:pending|unconfirmed|confirming|processing|mempool|queued).{0,30}(?:transaction|tx|signature)|(?:status|receipt|result).{0,40}(?:pending|unconfirmed|not\s+confirmed|not\s+finalized|not\s+yet\s+(?:mined|included|confirmed)|awaiting\s+confirmation|awaiting\s+mining|awaiting\s+inclusion|confirming|processing|mempool|queued|dropped(?:\s*&\s*replaced)?|replaced)|待确认|未确认|尚未确认|仍在处理|被丢弃|已替换/iu.test(
      message,
    )
  ) {
    return 'tx_pending';
  }
  if (
    /(?:transaction|tx).{0,80}(?:failed|reverted|fail(?:ed)?\s+with\s+error|has\s+been\s+reverted|执行失败)|instruction\s*(?:#\s*\d+\s*)?(?:error|failed)|program\s+error|program\s+failed|error\s+processing\s+instruction|(?:status|receipt|result).{0,40}(?:fail|failed|reverted|err|error|unsuccessful|0x0|false)|(?:receipt\s+status|status)\s*:?\s*0\b|success\s*:?\s*(?:false|0|0x0|no)\b|is\s*error\s*:?\s*(?:true|1|0x1|yes)\b|error\s+encountered\s+during\s+contract\s+execution|execution\s+reverted|error\s*:?\s*out\s+of\s+gas|执行失败/iu.test(
      message,
    )
  ) {
    return 'tx_failed';
  }
  if (
    /target\s+(?:trade|transaction|tx).{0,80}not found|not found.{0,80}target\s+(?:trade|transaction|tx)|目标交易/iu.test(
      message,
    )
  ) {
    return 'target_trade_not_found';
  }
  if (
    /(?:pool|pair|池子|交易对).{0,80}(?:not found|未找到|找不到|无法确认)|(?:not found|未找到|找不到|无法确认).{0,80}(?:pool|pair|池子|交易对)/iu.test(
      message,
    )
  ) {
    return 'pool_not_found';
  }
  if (
    /screenshot|capture|mark.{0,40}(?:row|trade|transaction)|(?:row|trade|transaction).{0,40}mark|原页面截图|截图|标记/iu.test(
      message,
    )
  ) {
    return 'screenshot_unavailable';
  }
  if (
    /(?:transaction|tx|signature).{0,40}(?:not\s+found|could\s+not\s+be\s+found|cannot\s+be\s+found)|(?:not\s+found|could\s+not\s+be\s+found|cannot\s+be\s+found).{0,40}(?:transaction|tx|signature)|no\s+(?:transaction|tx|signature)\s+found|(?:unable\s+to|could\s+not)\s+locate\s+(?:this\s+)?(?:txn\s*hash|tx\s*hash|transaction\s+hash|signature)|(?:txn\s*hash|tx\s*hash|transaction\s+hash|signature).{0,40}(?:does\s+not\s+exist|not\s+found|could\s+not\s+be\s+found|cannot\s+be\s+found)|找不到这笔交易/iu.test(
      message,
    )
  ) {
    return 'tx_not_found';
  }
  if (isTransientBrowserProviderMessage(message)) {
    return 'provider_unavailable';
  }

  return 'provider_unavailable';
}

export function createSolanaBrowserTxChainAdapter(
  driver: BrowserTxAnalysisDriver,
  analysisReviewer?: BrowserTxAnalysisReviewer,
): BrowserTxChainAdapter {
  return {
    async analyze(reference) {
      const snapshot = await driver.analyzeSolanaTransaction({
        txHash: reference.txHash,
      });
      return createBrowserTxAnalysisResult(
        'solana',
        reference.txHash,
        snapshot,
        {
          explorerUrl: snapshot.solscanUrl,
          sourceLabel: 'Solscan 交易页',
        },
        analysisReviewer,
      );
    },
    supports(reference) {
      return reference.chain === 'solana';
    },
  };
}

export function createEvmBrowserTxChainAdapter(
  driver: BrowserEvmTxAnalysisDriver,
  analysisReviewer?: BrowserTxAnalysisReviewer,
): BrowserTxChainAdapter {
  return {
    async analyze(reference) {
      if (!isBrowserEvmChain(reference.chain)) {
        throw new TxAnalysisUnsupportedChainError(
          `EVM browser transaction analysis does not support ${reference.chain}`,
        );
      }

      const snapshot = await driver.analyzeEvmTransaction({
        chain: reference.chain,
        txHash: reference.txHash,
      });
      return createBrowserTxAnalysisResult(
        reference.chain,
        reference.txHash,
        snapshot,
        {
          explorerUrl: snapshot.explorerUrl,
          extraEvidence: [
            {
              detail: snapshot.explorerUrl,
              label: 'EVM 交易浏览器',
              severity: 'info',
            },
            ...(snapshot.routerAddress === undefined
              ? []
              : [
                  {
                    detail: snapshot.routerAddress,
                    label: 'EVM Router',
                    severity: 'info' as const,
                  },
                ]),
          ],
          sourceLabel: 'EVM 交易浏览器',
        },
        analysisReviewer,
      );
    },
    supports(reference) {
      return isBrowserEvmChain(reference.chain);
    },
  };
}

function isBrowserEvmChain(chain: TxAnalysisChain): chain is BrowserEvmChain {
  return BROWSER_EVM_CHAINS.includes(chain as BrowserEvmChain);
}

function createUnknownEvmBrowserTxChainAdapter(
  driver: BrowserEvmTxAnalysisDriver,
  analysisReviewer?: BrowserTxAnalysisReviewer,
): BrowserTxChainAdapter {
  return {
    async analyze(reference) {
      let firstDeferredProbeFailure: TxAnalysisProviderUnavailableError | undefined;
      const probeAttempts: TxAnalysisProbeAttempt[] = [];

      for (const chain of BROWSER_EVM_CHAINS) {
        let snapshot: BrowserEvmTxSnapshot;
        try {
          snapshot = await driver.analyzeEvmTransaction({
            chain,
            txHash: reference.txHash,
          });
        } catch (error) {
          const normalized = normalizeBrowserAnalysisError(error);
          if (shouldContinueUnknownEvmProbe(normalized)) {
            probeAttempts.push({
              chain,
              message: normalized.message,
              reason: normalized.reason,
            });
            firstDeferredProbeFailure = preferredUnknownEvmProbeFailure(
              firstDeferredProbeFailure,
              deferredUnknownEvmProbeFailure(normalized, chain, reference.txHash),
            );
            continue;
          }

          if (normalized instanceof TxAnalysisProviderUnavailableError) {
            throw withUnknownEvmConcreteReference(normalized, chain, reference.txHash);
          }

          throw normalized;
        }

        try {
          return await createBrowserTxAnalysisResult(
            chain,
            reference.txHash,
            snapshot,
            {
              explorerUrl: snapshot.explorerUrl,
              extraEvidence: [
                {
                  detail: `裸 EVM 交易哈希已通过 ${chain} 交易浏览器命中。`,
                  label: '自动链识别',
                  severity: 'info',
                },
                {
                  detail: snapshot.explorerUrl,
                  label: 'EVM 交易浏览器',
                  severity: 'info',
                },
                ...(snapshot.routerAddress === undefined
                  ? []
                  : [
                      {
                        detail: snapshot.routerAddress,
                        label: 'EVM Router',
                        severity: 'info' as const,
                      },
                    ]),
              ],
              sourceLabel: 'EVM 交易浏览器',
            },
            analysisReviewer,
          );
        } catch (error) {
          const normalized = normalizeBrowserAnalysisError(error);
          if (normalized instanceof TxAnalysisProviderUnavailableError) {
            throw withUnknownEvmConcreteReference(normalized, chain, reference.txHash);
          }

          throw normalized;
        }
      }

      if (firstDeferredProbeFailure !== undefined) {
        throw withUnknownEvmProbeAttempts(firstDeferredProbeFailure, probeAttempts);
      }

      throw new TxAnalysisProviderUnavailableError(
        'Base、Ethereum、BSC 公开交易浏览器均未找到这笔 EVM 交易。',
        'tx_not_found',
        {
          metadata: { probeAttempts },
        },
      );
    },
    supports(reference) {
      return reference.chain === 'unknown' && EVM_TX_HASH_PATTERN.test(reference.txHash);
    },
  };
}

function shouldContinueUnknownEvmProbe(error: Error): error is TxAnalysisProviderUnavailableError {
  return (
    error instanceof TxAnalysisProviderUnavailableError &&
    (error.reason === 'tx_not_found' ||
      error.reason === 'browser_verification_required' ||
      error.reason === 'timeout' ||
      error.reason === 'provider_unavailable')
  );
}

function deferredUnknownEvmProbeFailure(
  error: TxAnalysisProviderUnavailableError,
  chain: BrowserEvmChain,
  txHash: string,
): TxAnalysisProviderUnavailableError | undefined {
  if (error.reason === 'tx_not_found') {
    return undefined;
  }

  return withUnknownEvmConcreteReference(error, chain, txHash);
}

function preferredUnknownEvmProbeFailure(
  current: TxAnalysisProviderUnavailableError | undefined,
  candidate: TxAnalysisProviderUnavailableError | undefined,
): TxAnalysisProviderUnavailableError | undefined {
  if (candidate === undefined) {
    return current;
  }
  if (current === undefined) {
    return candidate;
  }

  return unknownEvmProbeFailurePriority(candidate) > unknownEvmProbeFailurePriority(current)
    ? candidate
    : current;
}

function unknownEvmProbeFailurePriority(error: TxAnalysisProviderUnavailableError): number {
  switch (error.reason) {
    case 'browser_verification_required':
      return 4;
    case 'timeout':
      return 3;
    case 'provider_unavailable':
      return 2;
    case 'tx_not_found':
      return 1;
    default:
      return 0;
  }
}

function withUnknownEvmConcreteReference(
  error: TxAnalysisProviderUnavailableError,
  chain: BrowserEvmChain,
  txHash: string,
): TxAnalysisProviderUnavailableError {
  return new TxAnalysisProviderUnavailableError(error.message, error.reason, {
    ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
    reference: { chain, txHash },
  });
}

function withUnknownEvmProbeAttempts(
  error: TxAnalysisProviderUnavailableError,
  probeAttempts: TxAnalysisProbeAttempt[],
): TxAnalysisProviderUnavailableError {
  if (probeAttempts.length === 0) {
    return error;
  }

  return new TxAnalysisProviderUnavailableError(error.message, error.reason, {
    metadata: {
      ...(error.metadata ?? {}),
      probeAttempts,
    },
    ...(error.reference === undefined ? {} : { reference: error.reference }),
    ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
  });
}

interface BrowserTxAnalysisResultSource {
  explorerUrl: string;
  extraEvidence?: TxAnalysisResult['evidence'];
  sourceLabel: string;
}

async function createBrowserTxAnalysisResult(
  chain: TxAnalysisChain,
  txHash: string,
  snapshot: BrowserTxSnapshotBase,
  source: BrowserTxAnalysisResultSource,
  analysisReviewer?: BrowserTxAnalysisReviewer,
): Promise<TxAnalysisResult> {
  const contractAddress = nonBlankOptionalString(snapshot.contractAddress);
  const snapshotPoolAddress = nonBlankOptionalString(snapshot.poolAddress);
  const routerAddress = nonBlankOptionalString(snapshot.routerAddress);
  const screenshotUrl = nonBlankOptionalString(snapshot.screenshotUrl);
  const screenshotTargetRowMarked = snapshot.screenshotTargetRowMarked === true;
  const targetTradeSide = normalizeTxAnalysisTradeSide(snapshot.targetTrade.side);
  const targetTraderAddress = nonBlankOptionalString(snapshot.targetTrade.traderAddress);
  const explorerUrl = nonBlankOptionalString(source.explorerUrl);
  if (explorerUrl === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      '浏览器取证未返回可复查的交易浏览器链接。',
      'provider_unavailable',
      { metadata: createBrowserFailureMetadata(chain, snapshot, source) },
    );
  }

  const normalizedSource = { ...source, explorerUrl };
  if (!browserExplorerUrlMatchesTransaction(chain, normalizedSource.explorerUrl, txHash)) {
    const metadata = createBrowserFailureMetadata(chain, snapshot, normalizedSource);
    delete metadata.explorerUrl;
    throw new TxAnalysisProviderUnavailableError(
      '浏览器取证返回的交易浏览器链接与用户提交的交易不一致。',
      'tx_not_found',
      { metadata },
    );
  }

  if (!browserTargetHashMatches(chain, snapshot.targetTrade.hash, txHash)) {
    throw new TxAnalysisProviderUnavailableError(
      `浏览器取证定位到的目标成交不是用户提交的交易：${snapshot.targetTrade.hash}`,
      'target_trade_not_found',
      { metadata: createBrowserFailureMetadata(chain, snapshot, normalizedSource) },
    );
  }

  if (snapshotPoolAddress === undefined && contractAddress === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      '浏览器取证未能确认 XXYY 对应池子或合约。',
      'pool_not_found',
      { metadata: createBrowserFailureMetadata(chain, snapshot, normalizedSource) },
    );
  }

  if (screenshotUrl === undefined && contractAddress === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      '浏览器取证只发现疑似池子地址，但未能确认可截图的 XXYY 池子页面。',
      'pool_not_found',
      { metadata: createBrowserFailureMetadata(chain, snapshot, normalizedSource) },
    );
  }

  const xxyyPoolUrl = browserXxyyPoolUrl(chain, snapshot, snapshotPoolAddress);
  if (xxyyPoolUrl === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      '浏览器取证未能确认可复查的 XXYY 池子页面。',
      'pool_not_found',
      { metadata: createBrowserFailureMetadata(chain, snapshot, normalizedSource) },
    );
  }
  const poolAddress =
    snapshotPoolAddress ?? reviewableXxyyPoolUrlAddressForBackfill(chain, xxyyPoolUrl);
  const normalizedSnapshot: BrowserTxSnapshotBase =
    snapshotPoolAddress === undefined && poolAddress !== undefined
      ? { ...snapshot, poolAddress }
      : snapshot;
  if (poolAddress === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      '浏览器取证未能确认可复查的 XXYY 池子地址。',
      'pool_not_found',
      { metadata: createBrowserFailureMetadata(chain, normalizedSnapshot, normalizedSource) },
    );
  }
  if (!browserXxyyPoolUrlMatchesPoolAddress(chain, xxyyPoolUrl, poolAddress)) {
    const metadata = createBrowserFailureMetadata(chain, normalizedSnapshot, normalizedSource);
    delete metadata.xxyyPoolUrl;
    throw new TxAnalysisProviderUnavailableError(
      '浏览器取证打开的 XXYY 池子页面与交易浏览器解析到的池子不一致。',
      'pool_not_found',
      { metadata },
    );
  }

  const ruleAnalysis = analyzeTradeWindow(
    normalizedSnapshot.targetTrade,
    normalizedSnapshot.tradeWindow,
    poolAddress,
  );
  const relatedExplorerContext = { chain, sourceExplorerUrl: normalizedSource.explorerUrl };
  const relatedTransactions = createBrowserWindowRelatedTransactions(
    ruleAnalysis,
    normalizedSnapshot,
    relatedExplorerContext,
  );

  if (screenshotUrl === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      '浏览器取证未生成 XXYY 原页面截图。',
      'screenshot_unavailable',
      {
        metadata: createBrowserFailureMetadata(
          chain,
          normalizedSnapshot,
          normalizedSource,
          createBrowserWindowRelatedTransactions(
            ruleAnalysis,
            normalizedSnapshot,
            relatedExplorerContext,
          ),
        ),
      },
    );
  }

  if (!screenshotTargetRowMarked) {
    throw new TxAnalysisProviderUnavailableError(
      '浏览器取证未能在 XXYY 原页面截图中标记目标交易行。',
      'screenshot_unavailable',
      {
        metadata: createBrowserFailureMetadata(
          chain,
          normalizedSnapshot,
          normalizedSource,
          createBrowserWindowRelatedTransactions(
            ruleAnalysis,
            normalizedSnapshot,
            relatedExplorerContext,
          ),
        ),
      },
    );
  }

  const signal = await applyBrowserAnalysisReview(
    analysisReviewer,
    chain,
    txHash,
    normalizedSnapshot,
    ruleAnalysis,
  );
  const transactionTime = nonBlankOptionalString(snapshotTransactionTime(normalizedSnapshot));
  const program = nonBlankOptionalString(normalizedSnapshot.program);
  const extraEvidence = normalizeBrowserEvidence(normalizedSource.extraEvidence);

  return {
    analyzedAt: new Date().toISOString(),
    analysisRuleVersion: signal.ruleVersion,
    chain,
    ...(contractAddress === undefined ? {} : { contractAddress }),
    dataSource: 'browser',
    evidence: [
      {
        detail: `已从${normalizedSource.sourceLabel}读取交易信息，并在 XXYY 池子交易窗口中检查目标交易前 ${snapshot.tradeWindow.before.length} 笔、后 ${snapshot.tradeWindow.after.length} 笔交易。`,
        label: '前后交易窗口',
        severity: signal.verdict === 'sandwiched' ? 'warning' : 'info',
      },
      ...signal.evidence,
      ...extraEvidence,
      ...(program === undefined
        ? []
        : [
            {
              detail: program,
              label: '交易程序',
              severity: 'info' as const,
            },
          ]),
      ...(xxyyPoolUrl === undefined
        ? []
        : [
            {
              detail: xxyyPoolUrl,
              label: 'XXYY 池子页面',
              severity: 'info' as const,
            },
          ]),
    ],
    explorerUrl: normalizedSource.explorerUrl,
    confidence: signal.confidence,
    ...(poolAddress === undefined ? {} : { poolAddress }),
    ...(routerAddress === undefined ? {} : { routerAddress }),
    relatedTransactions,
    screenshotUrl,
    ...(screenshotTargetRowMarked ? { screenshotTargetRowMarked } : {}),
    summary: createSummary(signal, normalizedSnapshot),
    ...(targetTradeSide === undefined ? {} : { targetTradeSide }),
    ...(targetTraderAddress === undefined ? {} : { targetTraderAddress }),
    ...(transactionTime === undefined ? {} : { transactionTime }),
    txHash,
    verdict: signal.verdict,
    ...(xxyyPoolUrl === undefined ? {} : { xxyyPoolUrl }),
  };
}

async function applyBrowserAnalysisReview(
  reviewer: BrowserTxAnalysisReviewer | undefined,
  chain: TxAnalysisChain,
  requestedTxHash: string,
  snapshot: BrowserTxSnapshotBase,
  ruleAnalysis: SandwichWindowAnalysis,
): Promise<SandwichWindowAnalysis> {
  if (reviewer === undefined) {
    return ruleAnalysis;
  }

  let review: BrowserTxAnalysisReview | undefined;
  try {
    const contractAddress = nonBlankOptionalString(snapshot.contractAddress);
    const poolAddress = nonBlankOptionalString(snapshot.poolAddress);
    review = await reviewer.review({
      chain,
      ...(contractAddress === undefined ? {} : { contractAddress }),
      ...(poolAddress === undefined ? {} : { poolAddress }),
      requestedTxHash,
      ruleAnalysis,
      targetTrade: snapshot.targetTrade,
      tradeWindow: snapshot.tradeWindow,
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? (nonBlankOptionalString(error.message) ?? '交易分析复核器不可用。')
        : '交易分析复核器不可用。';
    return {
      ...ruleAnalysis,
      evidence: [
        ...ruleAnalysis.evidence,
        {
          detail,
          label: '模型复核',
          severity: 'warning',
        },
      ],
    };
  }

  if (review === undefined) {
    return {
      ...ruleAnalysis,
      evidence: [
        ...ruleAnalysis.evidence,
        {
          detail: '交易分析复核器未返回可用复核结果，已保留规则化判断。',
          label: '模型复核',
          severity: 'warning',
        },
      ],
    };
  }

  const reviewSummary = nonBlankOptionalString(review.summary);
  const reviewEvidence = normalizeBrowserEvidence(review.evidence);
  const reviewVerdict = normalizeBrowserReviewVerdict(review.verdict);
  const rejectUnverifiableSandwich =
    reviewVerdict === 'sandwiched' && !hasStructuredSandwichLegs(ruleAnalysis);
  const invalidReviewVerdict = review.verdict !== undefined && reviewVerdict === undefined;
  return {
    ...ruleAnalysis,
    confidence:
      rejectUnverifiableSandwich || review.confidence === undefined
        ? ruleAnalysis.confidence
        : normalizeAnalysisConfidence(review.confidence, ruleAnalysis.confidence),
    evidence: [
      ...ruleAnalysis.evidence,
      ...reviewEvidence,
      ...(rejectUnverifiableSandwich
        ? [
            {
              detail:
                '模型复核返回 sandwiched，但规则结果没有可复查的前置和后置交易，已保留规则化判断。',
              label: '模型复核',
              severity: 'warning' as const,
            },
          ]
        : []),
      ...(invalidReviewVerdict
        ? [
            {
              detail: '复核器返回了无法识别的 verdict，已保留规则化判断。',
              label: '模型复核',
              severity: 'warning' as const,
            },
          ]
        : []),
    ],
    summary: rejectUnverifiableSandwich
      ? ruleAnalysis.summary
      : (reviewSummary ?? ruleAnalysis.summary),
    verdict: rejectUnverifiableSandwich
      ? ruleAnalysis.verdict
      : (reviewVerdict ?? ruleAnalysis.verdict),
  };
}

function normalizeBrowserReviewVerdict(
  verdict: BrowserTxAnalysisReview['verdict'] | undefined,
): TxAnalysisResult['verdict'] | undefined {
  switch (verdict) {
    case 'inconclusive':
    case 'not_sandwiched':
    case 'sandwiched':
      return verdict;
    default:
      return undefined;
  }
}

function normalizeAnalysisConfidence(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, value));
}

function hasStructuredSandwichLegs(analysis: SandwichWindowAnalysis): boolean {
  return analysis.frontRun !== undefined && analysis.backRun !== undefined;
}

function browserTargetHashMatches(
  chain: TxAnalysisChain,
  targetHash: string,
  requestedHash: string,
): boolean {
  const normalizedTargetHash = normalizeBrowserTransactionHash(targetHash);
  const normalizedRequestedHash = normalizeBrowserTransactionHash(requestedHash);
  if (normalizedTargetHash.length === 0 || normalizedRequestedHash.length === 0) {
    return false;
  }

  if (chain === 'base' || chain === 'ethereum' || chain === 'bsc') {
    return normalizedTargetHash.toLowerCase() === normalizedRequestedHash.toLowerCase();
  }

  return normalizedTargetHash === normalizedRequestedHash;
}

function createBrowserFailureMetadata(
  chain: TxAnalysisChain,
  snapshot: BrowserTxSnapshotBase,
  source: BrowserTxAnalysisResultSource,
  relatedTransactions?: TxAnalysisResult['relatedTransactions'],
): TxAnalysisFailureMetadata {
  const contractAddress = nonBlankOptionalString(snapshot.contractAddress);
  const poolAddress = nonBlankOptionalString(snapshot.poolAddress);
  const routerAddress = nonBlankOptionalString(snapshot.routerAddress);
  const targetTradeSide = normalizeTxAnalysisTradeSide(snapshot.targetTrade.side);
  const targetTraderAddress = nonBlankOptionalString(snapshot.targetTrade.traderAddress);
  const transactionTime = nonBlankOptionalString(snapshotTransactionTime(snapshot));
  const screenshotUrl = nonBlankOptionalString(snapshot.screenshotUrl);
  const screenshotTargetRowMarked = snapshot.screenshotTargetRowMarked === true;
  const explorerUrl = nonBlankOptionalString(source.explorerUrl);
  const xxyyPoolUrl = browserXxyyPoolUrl(chain, snapshot, poolAddress);
  const reviewableXxyyPoolUrl =
    xxyyPoolUrl !== undefined &&
    browserXxyyPoolUrlMatchesPoolAddress(chain, xxyyPoolUrl, poolAddress)
      ? xxyyPoolUrl
      : undefined;
  return {
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(explorerUrl === undefined ? {} : { explorerUrl }),
    ...(poolAddress === undefined ? {} : { poolAddress }),
    ...(relatedTransactions === undefined || relatedTransactions.length === 0
      ? {}
      : { relatedTransactions }),
    ...(routerAddress === undefined ? {} : { routerAddress }),
    ...(screenshotUrl === undefined ? {} : { screenshotUrl }),
    ...(screenshotTargetRowMarked ? { screenshotTargetRowMarked } : {}),
    ...(targetTradeSide === undefined ? {} : { targetTradeSide }),
    ...(targetTraderAddress === undefined ? {} : { targetTraderAddress }),
    ...(transactionTime === undefined ? {} : { transactionTime }),
    ...(reviewableXxyyPoolUrl === undefined ? {} : { xxyyPoolUrl: reviewableXxyyPoolUrl }),
  };
}

function nonBlankOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function sanitizedRelatedTransactionSummary(
  summary: string | undefined,
  role: TxAnalysisResult['relatedTransactions'][number]['role'],
): string {
  return nonBlankOptionalString(summary) ?? defaultRelatedTransactionSummary(role);
}

function normalizeRelatedTransactionRole(
  role: unknown,
): TxAnalysisResult['relatedTransactions'][number]['role'] {
  if (typeof role !== 'string') {
    return 'related';
  }

  const normalized = role
    .trim()
    .replace(/([a-z\d])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');

  switch (normalized) {
    case 'front':
    case 'front_run':
    case 'front_runner':
    case 'frontrun':
      return 'front_run';
    case 'target':
    case 'target_trade':
    case 'user':
    case 'user_trade':
    case 'victim':
      return 'user';
    case 'back':
    case 'back_run':
    case 'back_runner':
    case 'backrun':
      return 'back_run';
    case 'context':
    case 'neighbor':
    case 'related':
      return 'related';
    default:
      return 'related';
  }
}

function defaultRelatedTransactionSummary(
  role: TxAnalysisResult['relatedTransactions'][number]['role'],
): string {
  switch (role) {
    case 'front_run':
      return '前置交易';
    case 'user':
      return '用户交易';
    case 'back_run':
      return '后置交易';
    case 'related':
      return '相关交易';
  }
}

function browserXxyyPoolUrl(
  chain: TxAnalysisChain,
  snapshot: BrowserTxSnapshotBase,
  poolAddress: string | undefined,
): string | undefined {
  const collectedXxyyPoolUrl = nonBlankOptionalString(snapshot.xxyyPoolUrl);
  if (collectedXxyyPoolUrl !== undefined && browserXxyyPoolUrlIsPoolPage(collectedXxyyPoolUrl)) {
    return collectedXxyyPoolUrl;
  }

  return buildXxyyPoolUrl(chain, poolAddress);
}

function browserXxyyPoolUrlMatchesPoolAddress(
  chain: TxAnalysisChain,
  xxyyPoolUrl: string,
  poolAddress: string | undefined,
): boolean {
  const reviewablePoolAddress = reviewableXxyyPoolUrlAddress(chain, xxyyPoolUrl);
  if (reviewablePoolAddress === '') {
    return false;
  }
  if (reviewablePoolAddress === undefined) {
    return poolAddress !== undefined;
  }
  if (poolAddress === undefined) {
    return isReviewableXxyyPoolAddress(chain, reviewablePoolAddress);
  }

  return (
    normalizeComparablePoolAddress(reviewablePoolAddress) ===
    normalizeComparablePoolAddress(poolAddress)
  );
}

function browserXxyyPoolUrlIsPoolPage(xxyyPoolUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(xxyyPoolUrl);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./u, '');
  if (host !== 'xxyy.io') {
    return false;
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  const [routeChain, poolAddress] = pathParts;
  if (routeChain === undefined) {
    return false;
  }

  const normalizedRouteChain = routeChain.toLowerCase();
  if (normalizedRouteChain === 'discover') {
    const [, discoverChain, resourceType, discoverPoolAddress] = pathParts;
    return (
      discoverChain !== undefined &&
      resourceType?.toLowerCase() === 'pool' &&
      nonBlankOptionalString(discoverPoolAddress) !== undefined
    );
  }

  return (
    new Set(['base', 'bsc', 'eth', 'ethereum', 'sol']).has(normalizedRouteChain) &&
    nonBlankOptionalString(poolAddress) !== undefined
  );
}

function reviewableXxyyPoolUrlAddress(
  chain: TxAnalysisChain,
  xxyyPoolUrl: string,
): string | undefined {
  let url: URL;
  try {
    url = new URL(xxyyPoolUrl);
  } catch {
    return undefined;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./u, '');
  if (host !== 'xxyy.io') {
    return undefined;
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  const [routeChain, poolAddress] = pathParts;
  if (routeChain === undefined) {
    return undefined;
  }

  const normalizedRouteChain = routeChain.toLowerCase();
  if (normalizedRouteChain === 'discover') {
    return discoverXxyyPoolUrlAddress(chain, pathParts);
  }

  const directRoutes = new Set(['base', 'bsc', 'eth', 'ethereum', 'sol']);
  if (!directRoutes.has(normalizedRouteChain)) {
    return undefined;
  }

  if (!xxyyPoolRouteMatchesChain(normalizedRouteChain, chain)) {
    return '';
  }

  return nonBlankOptionalString(poolAddress) ?? '';
}

function reviewableXxyyPoolUrlAddressForBackfill(
  chain: TxAnalysisChain,
  xxyyPoolUrl: string,
): string | undefined {
  const poolAddress = nonBlankOptionalString(reviewableXxyyPoolUrlAddress(chain, xxyyPoolUrl));
  if (poolAddress === undefined) {
    return undefined;
  }

  return isReviewableXxyyPoolAddress(chain, poolAddress) ? poolAddress : undefined;
}

function discoverXxyyPoolUrlAddress(
  chain: TxAnalysisChain,
  pathParts: string[],
): string | undefined {
  const [, discoverChain, resourceType, poolAddress] = pathParts;
  if (
    discoverChain === undefined ||
    resourceType?.toLowerCase() !== 'pool' ||
    poolAddress === undefined
  ) {
    return undefined;
  }

  if (!xxyyPoolRouteMatchesChain(discoverChain.toLowerCase(), chain)) {
    return '';
  }

  return isReviewableXxyyPoolAddress(chain, poolAddress) ? poolAddress : undefined;
}

function xxyyPoolRouteMatchesChain(routeChain: string, chain: TxAnalysisChain): boolean {
  if (chain === 'solana') {
    return routeChain === 'sol' || routeChain === 'solana';
  }
  if (chain === 'ethereum') {
    return routeChain === 'eth' || routeChain === 'ethereum';
  }

  return xxyyPoolRouteChain(chain) === routeChain;
}

function isReviewableXxyyPoolAddress(chain: TxAnalysisChain, poolAddress: string): boolean {
  const normalizedPoolAddress = poolAddress.trim();
  if (chain === 'base' || chain === 'ethereum' || chain === 'bsc') {
    return EVM_ADDRESS_PATTERN.test(normalizedPoolAddress);
  }
  if (chain === 'solana') {
    return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/u.test(normalizedPoolAddress);
  }

  return false;
}

function normalizeComparablePoolAddress(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.toLowerCase() : value;
}

function buildXxyyPoolUrl(
  chain: TxAnalysisChain,
  poolAddress: string | undefined,
): string | undefined {
  if (poolAddress === undefined) {
    return undefined;
  }

  const routeChain = xxyyPoolRouteChain(chain);
  if (routeChain === undefined) {
    return undefined;
  }

  const normalizedPoolAddress =
    routeChain === 'base' || routeChain === 'eth' || routeChain === 'bsc'
      ? poolAddress.toLowerCase()
      : poolAddress;
  return `https://www.xxyy.io/${routeChain}/${encodeURIComponent(normalizedPoolAddress)}`;
}

function xxyyPoolRouteChain(chain: TxAnalysisChain): string | undefined {
  switch (chain) {
    case 'base':
      return 'base';
    case 'bsc':
      return 'bsc';
    case 'ethereum':
      return 'eth';
    case 'solana':
      return 'sol';
    case 'unknown':
      return undefined;
  }
}

function normalizeBrowserEvidence(
  evidence: TxAnalysisEvidence[] | undefined,
): TxAnalysisEvidence[] {
  return (evidence ?? [])
    .map((item) => {
      const detail = nonBlankOptionalString(item.detail);
      const label = nonBlankOptionalString(item.label);
      const severity = normalizeBrowserEvidenceSeverity(item.severity);
      if (detail === undefined || label === undefined || severity === undefined) {
        return undefined;
      }

      return { ...item, detail, label, severity };
    })
    .filter((item): item is TxAnalysisEvidence => item !== undefined);
}

function normalizeBrowserEvidenceSeverity(
  severity: TxAnalysisEvidence['severity'] | undefined,
): TxAnalysisEvidence['severity'] | undefined {
  switch (severity) {
    case 'critical':
    case 'info':
    case 'warning':
      return severity;
    default:
      return undefined;
  }
}

function createBrowserWindowRelatedTransactions(
  ruleAnalysis: SandwichWindowAnalysis,
  snapshot: BrowserTxSnapshotBase,
  relatedExplorerContext: { chain: TxAnalysisChain; sourceExplorerUrl: string },
): TxAnalysisResult['relatedTransactions'] {
  const transactions: TxAnalysisResult['relatedTransactions'] = [
    ...snapshot.tradeWindow.before.map((trade) =>
      toRelatedTransaction(
        trade,
        ruleAnalysis.frontRun !== undefined &&
          browserTargetHashMatches(
            relatedExplorerContext.chain,
            trade.hash,
            ruleAnalysis.frontRun.hash,
          )
          ? 'front_run'
          : 'related',
        relatedExplorerContext,
      ),
    ),
    toRelatedTransaction(snapshot.targetTrade, 'user', relatedExplorerContext),
    ...snapshot.tradeWindow.after.map((trade) =>
      toRelatedTransaction(
        trade,
        ruleAnalysis.backRun !== undefined &&
          browserTargetHashMatches(
            relatedExplorerContext.chain,
            trade.hash,
            ruleAnalysis.backRun.hash,
          )
          ? 'back_run'
          : 'related',
        relatedExplorerContext,
      ),
    ),
  ];
  return deduplicateBrowserRelatedTransactions(relatedExplorerContext.chain, transactions);
}

function snapshotTransactionTime(snapshot: BrowserTxSnapshotBase): string | undefined {
  return snapshot.transactionTime ?? snapshot.targetTrade.timestamp;
}

function analyzeTradeWindow(
  targetTrade: BrowserTxTrade,
  tradeWindow: BrowserSolanaTxSnapshot['tradeWindow'],
  poolAddress: string | undefined,
): SandwichWindowAnalysis {
  return analyzeSandwichWindow(withDefaultTradePool(targetTrade, poolAddress), {
    after: tradeWindow.after.map((trade) => withDefaultTradePool(trade, poolAddress)),
    before: tradeWindow.before.map((trade) => withDefaultTradePool(trade, poolAddress)),
  });
}

function withDefaultTradePool(
  trade: BrowserTxTrade,
  poolAddress: string | undefined,
): BrowserTxTrade {
  if (poolAddress === undefined || trade.poolAddress !== undefined) {
    return trade;
  }

  return { ...trade, poolAddress };
}

function createSummary(signal: SandwichWindowAnalysis, snapshot: BrowserTxSnapshotBase): string {
  const poolAddress = nonBlankOptionalString(snapshot.poolAddress);
  const contractAddress = nonBlankOptionalString(snapshot.contractAddress);
  const transactionTime = nonBlankOptionalString(snapshotTransactionTime(snapshot));
  const details = [
    signal.summary,
    poolAddress === undefined ? undefined : `池子：${poolAddress}`,
    contractAddress === undefined ? undefined : `合约：${contractAddress}`,
    transactionTime === undefined ? undefined : `交易时间：${transactionTime}`,
  ].filter((item): item is string => item !== undefined);

  return details.join(' ');
}

function toRelatedTransaction(
  trade: BrowserTxTrade,
  role: TxAnalysisResult['relatedTransactions'][number]['role'],
  context: { chain: TxAnalysisChain; sourceExplorerUrl: string },
): TxAnalysisResult['relatedTransactions'][number] {
  const hash = normalizeBrowserTransactionHash(trade.hash);
  const collectedExplorerUrl = nonBlankOptionalString(trade.explorerUrl);
  const explorerUrl =
    collectedExplorerUrl !== undefined &&
    browserExplorerUrlMatchesTransaction(context.chain, collectedExplorerUrl, hash)
      ? collectedExplorerUrl
      : buildRelatedTransactionExplorerUrl(context, hash);
  const timestamp = nonBlankOptionalString(trade.timestamp);
  const traderAddress = nonBlankOptionalString(trade.traderAddress);
  const side = normalizeTxAnalysisTradeSide(trade.side);
  const summary = sanitizedRelatedTransactionSummary(trade.summary, role);
  return {
    hash,
    role,
    summary,
    ...(explorerUrl === undefined ? {} : { explorerUrl }),
    ...(side === undefined ? {} : { side }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(traderAddress === undefined ? {} : { traderAddress }),
  };
}

function normalizeTxAnalysisTradeSide(value: unknown): TxAnalysisTradeSide | undefined {
  return value === 'buy' || value === 'sell' || value === 'unknown' ? value : undefined;
}

function buildRelatedTransactionExplorerUrl(
  context: { chain: TxAnalysisChain; sourceExplorerUrl: string },
  txHash: string,
): string | undefined {
  const normalizedTxHash = normalizeBrowserTransactionHash(txHash);
  if (!isValidTransactionHashForChain(context.chain, normalizedTxHash)) {
    return undefined;
  }

  try {
    const url = new URL(context.sourceExplorerUrl);
    const pathParts = url.pathname.split('/').filter((part) => part.length > 0);
    const txPartIndex = pathParts.findIndex((part) => part.toLowerCase() === 'tx');
    if (txPartIndex < 0) {
      return undefined;
    }

    pathParts[txPartIndex + 1] = normalizedTxHash;
    url.pathname = `/${pathParts.join('/')}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function browserExplorerUrlMatchesTransaction(
  chain: TxAnalysisChain,
  explorerUrl: string,
  txHash: string,
): boolean {
  const reference = parseTransactionReference(explorerUrl);
  return (
    reference !== undefined &&
    reference.chain === chain &&
    browserTargetHashMatches(chain, reference.txHash, txHash)
  );
}

function isValidTransactionHashForChain(chain: TxAnalysisChain, txHash: string): boolean {
  const normalizedTxHash = normalizeBrowserTransactionHash(txHash);
  if (chain === 'base' || chain === 'ethereum' || chain === 'bsc') {
    return EVM_TX_HASH_PATTERN.test(normalizedTxHash);
  }
  if (chain === 'solana') {
    return /^[1-9A-HJ-NP-Za-km-z]{64,96}$/u.test(normalizedTxHash);
  }

  return false;
}

function normalizeBrowserTransactionHash(txHash: string): string {
  const normalized = txHash.trim();
  return parseTransactionReference(normalized)?.txHash ?? normalized;
}

function normalizeReviewableTransactionHash(chain: TxAnalysisChain, txHash: string): string {
  const normalized = txHash.trim();
  return chain === 'base' || chain === 'ethereum' || chain === 'bsc'
    ? normalized.toLowerCase()
    : normalized;
}
