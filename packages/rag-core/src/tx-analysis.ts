import type {
  ChatAttachment,
  ChatResponse,
  TxAnalysisChain,
  TxAnalysisResult,
  TxAnalysisTradeSide,
} from '@xxyy/shared';

import type { TransactionReference } from './tx-hash.js';

export interface TxAnalysisProvider {
  analyze(reference: TransactionReference): Promise<TxAnalysisResult>;
}

export type TxAnalysisUnavailableReason =
  | 'not_configured'
  | 'provider_unavailable'
  | 'invalid_reference'
  | 'unsupported_chain'
  | 'browser_verification_required'
  | 'tx_not_found'
  | 'tx_failed'
  | 'tx_pending'
  | 'pool_not_found'
  | 'target_trade_not_found'
  | 'screenshot_unavailable'
  | 'timeout';

export interface TxAnalysisErrorOptions {
  metadata?: TxAnalysisFailureMetadata;
  reference?: TransactionReference;
  reportUrl?: string;
}

export interface TxAnalysisProbeAttempt {
  chain: TxAnalysisChain;
  message: string;
  reason: TxAnalysisUnavailableReason;
}

export interface TxAnalysisFailureMetadata {
  contractAddress?: string;
  explorerUrl?: string;
  poolAddress?: string;
  probeAttempts?: TxAnalysisProbeAttempt[];
  relatedTransactions?: TxAnalysisResult['relatedTransactions'];
  reportWriteError?: string;
  routerAddress?: string;
  screenshotUrl?: string;
  screenshotTargetRowMarked?: boolean;
  targetTradeSide?: TxAnalysisTradeSide;
  targetTraderAddress?: string;
  transactionTime?: string;
  unsupportedChainHint?: string;
  unsupportedExplorerHost?: string;
  xxyyPoolUrl?: string;
}

export class TxAnalysisProviderUnavailableError extends Error {
  readonly metadata?: TxAnalysisFailureMetadata;
  readonly reference?: TransactionReference;
  readonly reason: TxAnalysisUnavailableReason;
  readonly reportUrl?: string;

  constructor(
    message: string,
    reason: TxAnalysisUnavailableReason = 'provider_unavailable',
    options: TxAnalysisErrorOptions = {},
  ) {
    super(message);
    this.name = 'TxAnalysisProviderUnavailableError';
    this.reason = reason;
    if (options.metadata !== undefined) {
      this.metadata = options.metadata;
    }
    if (options.reference !== undefined) {
      this.reference = options.reference;
    }
    if (options.reportUrl !== undefined) {
      this.reportUrl = options.reportUrl;
    }
  }
}

export class TxAnalysisUnsupportedChainError extends Error {
  readonly metadata?: TxAnalysisFailureMetadata;
  readonly reportUrl?: string;

  constructor(message: string, options: TxAnalysisErrorOptions = {}) {
    super(message);
    this.name = 'TxAnalysisUnsupportedChainError';
    if (options.metadata !== undefined) {
      this.metadata = options.metadata;
    }
    if (options.reportUrl !== undefined) {
      this.reportUrl = options.reportUrl;
    }
  }
}

export function createTxAnalysisAnswer(result: TxAnalysisResult): ChatResponse {
  const normalizedResult = normalizeAnswerResultLinks(result);
  const screenshotUrl = normalizedResult.screenshotUrl;
  return {
    answer: [
      `交易哈希：${normalizedResult.txHash}`,
      `链：${formatChain(normalizedResult.chain)}`,
      `结论：${formatVerdict(normalizedResult.verdict)}，置信度 ${Math.round(normalizedResult.confidence * 100)}%。`,
      `摘要：${normalizedResult.summary}`,
      ...(normalizedResult.reportUrl === undefined ? [] : [`报告：${normalizedResult.reportUrl}`]),
      ...formatReviewReferences(normalizedResult),
      ...formatEvidence(normalizedResult),
      ...formatRelatedTransactions(normalizedResult),
      formatAnalysisHint(normalizedResult),
    ].join('\n'),
    ...(screenshotUrl === undefined ? {} : { attachments: [createImageAttachment(screenshotUrl)] }),
    citations: [],
    confidence: normalizedResult.confidence,
    intent: 'tx_sandwich_detection',
  };
}

export function createTxAnalysisUnavailableAnswer(
  reason: TxAnalysisUnavailableReason,
  options: { metadata?: TxAnalysisFailureMetadata; reportUrl?: string } = {},
): ChatResponse {
  const metadata = normalizeFailureMetadataLinks(options.metadata);
  const reportUrl = nonBlankOptionalString(options.reportUrl);
  const screenshotUrl = metadata?.screenshotUrl;
  return {
    answer: [
      unavailableAnswerText(reason),
      ...(reportUrl === undefined ? [] : [`报告：${reportUrl}`]),
      ...formatFailureReviewReferences(metadata),
    ].join('\n'),
    ...(screenshotUrl === undefined
      ? {}
      : {
          attachments: [createImageAttachment(screenshotUrl, '交易分析失败截图')],
        }),
    citations: [],
    confidence: 0.35,
    intent: 'tx_sandwich_detection',
  };
}

function normalizeAnswerResultLinks(result: TxAnalysisResult): TxAnalysisResult {
  const normalized = { ...result };
  assignTrimmedOptionalString(normalized, 'analysisRuleVersion', result.analysisRuleVersion);
  normalized.analyzedAt = nonBlankOptionalString(result.analyzedAt) ?? '未知';
  assignTrimmedOptionalString(normalized, 'contractAddress', result.contractAddress);
  normalized.confidence = normalizeConfidenceForAnswer(result.confidence);
  normalized.evidence = normalizeEvidenceForAnswer(result.evidence);
  assignTrimmedOptionalString(normalized, 'explorerUrl', result.explorerUrl);
  assignTrimmedOptionalString(normalized, 'poolAddress', result.poolAddress);
  assignTrimmedOptionalString(normalized, 'reportUrl', result.reportUrl);
  assignTrimmedOptionalString(normalized, 'routerAddress', result.routerAddress);
  assignTrimmedOptionalString(normalized, 'screenshotUrl', result.screenshotUrl);
  normalized.summary = sanitizeCustomerFacingReviewText(
    nonBlankOptionalString(result.summary) ?? defaultSummaryForVerdict(result.verdict),
  );
  assignOptionalTradeSide(normalized, result.targetTradeSide);
  assignTrimmedOptionalString(normalized, 'targetTraderAddress', result.targetTraderAddress);
  assignTrimmedOptionalString(normalized, 'transactionTime', result.transactionTime);
  assignTrimmedOptionalString(normalized, 'xxyyPoolUrl', result.xxyyPoolUrl);
  normalized.relatedTransactions = normalizeRelatedTransactionsForAnswer(
    result.relatedTransactions,
  );

  return normalized;
}

function normalizeConfidenceForAnswer(confidence: number): number {
  if (!Number.isFinite(confidence)) {
    return 0;
  }

  return Math.min(1, Math.max(0, confidence));
}

function defaultSummaryForVerdict(verdict: TxAnalysisResult['verdict']): string {
  switch (verdict) {
    case 'sandwiched':
      return '检测到疑似 sandwich 模式。';
    case 'not_sandwiched':
      return '未发现明确 sandwich 模式。';
    case 'inconclusive':
      return '当前证据不足，无法确认是否被夹。';
  }
}

function normalizeEvidenceForAnswer(
  evidence: TxAnalysisResult['evidence'],
): TxAnalysisResult['evidence'] {
  return evidence.flatMap((item) => {
    const label = nonBlankOptionalString(item.label);
    const detail = nonBlankOptionalString(item.detail);
    if (label === undefined || detail === undefined) {
      return [];
    }

    return [{ ...item, detail: sanitizeCustomerFacingReviewText(detail), label }];
  });
}

function sanitizeCustomerFacingReviewText(text: string): string {
  return text.replace(/人工复查/gu, '复查').replace(/人工关注/gu, '关注');
}

function normalizeFailureMetadataLinks(
  metadata: TxAnalysisFailureMetadata | undefined,
): TxAnalysisFailureMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const normalized = { ...metadata };
  assignTrimmedOptionalString(normalized, 'contractAddress', metadata.contractAddress);
  assignTrimmedOptionalString(normalized, 'explorerUrl', metadata.explorerUrl);
  assignTrimmedOptionalString(normalized, 'poolAddress', metadata.poolAddress);
  assignTrimmedOptionalString(normalized, 'reportWriteError', metadata.reportWriteError);
  assignTrimmedOptionalString(normalized, 'routerAddress', metadata.routerAddress);
  assignTrimmedOptionalString(normalized, 'screenshotUrl', metadata.screenshotUrl);
  if (metadata.screenshotTargetRowMarked === true) {
    normalized.screenshotTargetRowMarked = true;
  } else {
    delete normalized.screenshotTargetRowMarked;
  }
  assignOptionalTradeSide(normalized, metadata.targetTradeSide);
  assignTrimmedOptionalString(normalized, 'targetTraderAddress', metadata.targetTraderAddress);
  assignTrimmedOptionalString(normalized, 'transactionTime', metadata.transactionTime);
  assignTrimmedOptionalString(normalized, 'unsupportedChainHint', metadata.unsupportedChainHint);
  assignTrimmedOptionalString(
    normalized,
    'unsupportedExplorerHost',
    metadata.unsupportedExplorerHost,
  );
  assignTrimmedOptionalString(normalized, 'xxyyPoolUrl', metadata.xxyyPoolUrl);
  normalized.relatedTransactions = normalizeRelatedTransactionsForAnswer(
    metadata.relatedTransactions,
  );
  const probeAttempts = normalizeProbeAttemptsForAnswer(metadata.probeAttempts);
  if (probeAttempts.length === 0) {
    delete normalized.probeAttempts;
  } else {
    normalized.probeAttempts = probeAttempts;
  }

  return normalized;
}

function normalizeProbeAttemptsForAnswer(
  attempts: TxAnalysisProbeAttempt[] | undefined,
): TxAnalysisProbeAttempt[] {
  return (attempts ?? []).flatMap((attempt) => {
    const message = nonBlankOptionalString(attempt.message);
    return message === undefined ? [] : [{ ...attempt, message }];
  });
}

function normalizeRelatedTransactionsForAnswer(
  transactions: TxAnalysisResult['relatedTransactions'] | undefined,
): TxAnalysisResult['relatedTransactions'] {
  const normalizedTransactions = (transactions ?? []).flatMap((transaction) => {
    const hash = nonBlankOptionalString(transaction.hash);
    if (hash === undefined) {
      return [];
    }

    const normalizedHash = normalizeComparableRelatedTransactionHash(hash);
    const explorerUrl = nonBlankOptionalString(transaction.explorerUrl);
    const summary =
      nonBlankOptionalString(transaction.summary) ?? formatRelatedTransactionRole(transaction.role);
    const side = normalizeTradeSide(transaction.side);
    const timestamp = nonBlankOptionalString(transaction.timestamp);
    const traderAddress = nonBlankOptionalString(transaction.traderAddress);
    const normalized = { ...transaction, hash: normalizedHash, summary };
    delete normalized.explorerUrl;
    delete normalized.side;
    delete normalized.timestamp;
    delete normalized.traderAddress;
    if (explorerUrl !== undefined) {
      normalized.explorerUrl = explorerUrl;
    }
    if (side !== undefined) {
      normalized.side = side;
    }
    if (timestamp !== undefined) {
      normalized.timestamp = timestamp;
    }
    if (traderAddress !== undefined) {
      normalized.traderAddress = traderAddress;
    }

    return [normalized];
  });

  return deduplicateRelatedTransactionsForAnswer(normalizedTransactions);
}

function deduplicateRelatedTransactionsForAnswer(
  transactions: TxAnalysisResult['relatedTransactions'],
): TxAnalysisResult['relatedTransactions'] {
  const deduplicated: TxAnalysisResult['relatedTransactions'] = [];

  for (const transaction of transactions) {
    const duplicateIndex = deduplicated.findIndex(
      (existing) =>
        normalizeComparableRelatedTransactionHash(existing.hash) ===
        normalizeComparableRelatedTransactionHash(transaction.hash),
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

function normalizeComparableRelatedTransactionHash(hash: string): string {
  const normalized = hash.trim();
  return /^0x[a-f0-9]{64}$/iu.test(normalized) ? normalized.toLowerCase() : normalized;
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

function assignOptionalTradeSide(
  target: { targetTradeSide?: TxAnalysisTradeSide },
  value: TxAnalysisTradeSide | undefined,
): void {
  const normalized = normalizeTradeSide(value);
  if (normalized === undefined) {
    delete target.targetTradeSide;
    return;
  }

  target.targetTradeSide = normalized;
}

function normalizeTradeSide(value: unknown): TxAnalysisTradeSide | undefined {
  return value === 'buy' || value === 'sell' || value === 'unknown' ? value : undefined;
}

function assignTrimmedOptionalString<T extends Record<string, unknown>, K extends keyof T>(
  target: T,
  key: K,
  value: string | undefined,
): void {
  const normalized = nonBlankOptionalString(value);
  if (normalized === undefined) {
    delete target[key];
    return;
  }

  target[key] = normalized as T[K];
}

function nonBlankOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function createImageAttachment(url: string, title = '交易分析截图'): ChatAttachment {
  return {
    kind: 'image',
    mediaType: mediaTypeForImageUrl(url),
    title,
    url,
  };
}

function mediaTypeForImageUrl(
  url: string,
): Extract<ChatAttachment, { kind: 'image' }>['mediaType'] {
  const lower = url.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.svg')) {
    return 'image/svg+xml';
  }

  return 'image/png';
}

function formatChain(chain: TxAnalysisResult['chain']): string {
  switch (chain) {
    case 'base':
      return 'Base';
    case 'bsc':
      return 'BSC';
    case 'ethereum':
      return 'Ethereum';
    case 'solana':
      return 'Solana';
    case 'unknown':
      return '未知';
  }
}

function formatVerdict(verdict: TxAnalysisResult['verdict']): string {
  switch (verdict) {
    case 'sandwiched':
      return '疑似被夹';
    case 'not_sandwiched':
      return '未发现明确被夹迹象';
    case 'inconclusive':
      return '无法确认是否被夹';
  }
}

function formatEvidence(result: TxAnalysisResult): string[] {
  if (result.evidence.length === 0) {
    return [];
  }

  return [
    '证据：',
    ...result.evidence.map((item) => `- ${item.label}（${item.severity}）：${item.detail}`),
  ];
}

function formatReviewReferences(result: TxAnalysisResult): string[] {
  const references = [
    result.explorerUrl === undefined ? undefined : `交易浏览器：${result.explorerUrl}`,
    result.targetTraderAddress === undefined
      ? undefined
      : `交易地址：${result.targetTraderAddress}`,
    result.targetTradeSide === undefined
      ? undefined
      : `交易方向：${formatTradeSide(result.targetTradeSide)}`,
    result.transactionTime === undefined ? undefined : `交易时间：${result.transactionTime}`,
    result.poolAddress === undefined ? undefined : `池子：${result.poolAddress}`,
    result.contractAddress === undefined ? undefined : `合约：${result.contractAddress}`,
    result.routerAddress === undefined ? undefined : `路由合约：${result.routerAddress}`,
    `分析时间：${result.analyzedAt}`,
    result.analysisRuleVersion === undefined
      ? undefined
      : `规则版本：${result.analysisRuleVersion}`,
    result.xxyyPoolUrl === undefined ? undefined : `XXYY 池子页：${result.xxyyPoolUrl}`,
    result.screenshotUrl === undefined ? undefined : `截图：${result.screenshotUrl}`,
  ].filter((item): item is string => item !== undefined);

  return references.length === 0 ? [] : ['复查信息：', ...references.map((item) => `- ${item}`)];
}

function formatFailureReviewReferences(metadata: TxAnalysisFailureMetadata | undefined): string[] {
  if (metadata === undefined) {
    return [];
  }

  const relatedTransactions = formatRelatedTransactionList(metadata.relatedTransactions);
  const references = [
    metadata.explorerUrl === undefined ? undefined : `交易浏览器：${metadata.explorerUrl}`,
    metadata.targetTraderAddress === undefined
      ? undefined
      : `交易地址：${metadata.targetTraderAddress}`,
    metadata.targetTradeSide === undefined
      ? undefined
      : `交易方向：${formatTradeSide(metadata.targetTradeSide)}`,
    metadata.transactionTime === undefined ? undefined : `交易时间：${metadata.transactionTime}`,
    metadata.poolAddress === undefined ? undefined : `池子：${metadata.poolAddress}`,
    metadata.contractAddress === undefined ? undefined : `合约：${metadata.contractAddress}`,
    metadata.routerAddress === undefined ? undefined : `路由合约：${metadata.routerAddress}`,
    metadata.unsupportedExplorerHost === undefined
      ? undefined
      : `不支持的交易浏览器：${metadata.unsupportedExplorerHost}`,
    metadata.unsupportedChainHint === undefined
      ? undefined
      : `不支持的链或网络：${metadata.unsupportedChainHint}`,
    metadata.xxyyPoolUrl === undefined ? undefined : `XXYY 池子页：${metadata.xxyyPoolUrl}`,
    metadata.screenshotUrl === undefined ? undefined : `截图：${metadata.screenshotUrl}`,
    metadata.reportWriteError === undefined
      ? undefined
      : `报告保存失败：${metadata.reportWriteError}`,
    formatProbeAttempts(metadata.probeAttempts),
  ].filter((item): item is string => item !== undefined);

  return references.length === 0 && relatedTransactions.length === 0
    ? []
    : ['复查信息：', ...references.map((item) => `- ${item}`), ...relatedTransactions];
}

function formatProbeAttempts(attempts: TxAnalysisProbeAttempt[] | undefined): string | undefined {
  if (attempts === undefined || attempts.length === 0) {
    return undefined;
  }

  return `链探测：${attempts
    .map((attempt) => `${formatChain(attempt.chain)}：${formatUnavailableReason(attempt.reason)}`)
    .join('；')}`;
}

function formatUnavailableReason(reason: TxAnalysisUnavailableReason): string {
  switch (reason) {
    case 'browser_verification_required':
      return '浏览器安全验证';
    case 'invalid_reference':
      return '交易格式无效';
    case 'not_configured':
      return '未启用';
    case 'pool_not_found':
      return '找不到池子';
    case 'provider_unavailable':
      return '服务暂时不可用';
    case 'screenshot_unavailable':
      return '截图不可用';
    case 'target_trade_not_found':
      return '找不到目标交易';
    case 'timeout':
      return '超时';
    case 'tx_failed':
      return '交易执行失败';
    case 'tx_pending':
      return '交易未确认';
    case 'tx_not_found':
      return '找不到交易';
    case 'unsupported_chain':
      return '暂不支持';
  }
}

function formatRelatedTransactions(result: TxAnalysisResult): string[] {
  return formatRelatedTransactionList(result.relatedTransactions);
}

function formatRelatedTransactionList(
  transactions: TxAnalysisResult['relatedTransactions'] | undefined,
): string[] {
  if (transactions === undefined || transactions.length === 0) {
    return [];
  }

  return [
    '相关交易：',
    ...transactions.map((transaction) => {
      const side =
        transaction.side === undefined ? '' : `，方向：${formatTradeSide(transaction.side)}`;
      const traderAddress =
        transaction.traderAddress === undefined ? '' : `，交易者：${transaction.traderAddress}`;
      const timestamp =
        transaction.timestamp === undefined ? '' : `，时间：${transaction.timestamp}`;
      const explorer =
        transaction.explorerUrl === undefined ? '' : `，浏览器：${transaction.explorerUrl}`;
      return `- ${formatRelatedTransactionRole(transaction.role)}：${transaction.hash}，${transaction.summary}${side}${traderAddress}${timestamp}${explorer}`;
    }),
  ];
}

function formatRelatedTransactionRole(
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

function formatTradeSide(side: TxAnalysisTradeSide): string {
  switch (side) {
    case 'buy':
      return '买入';
    case 'sell':
      return '卖出';
    case 'unknown':
      return '未知';
  }
}

function unavailableAnswerText(reason: TxAnalysisUnavailableReason): string {
  switch (reason) {
    case 'not_configured':
      return '交易哈希夹子检测功能暂未启用。当前不会编造链上分析结论；接入正式链上数据源后才能判断是否被夹并生成截图。';
    case 'provider_unavailable':
      return '交易分析数据源暂时不可用，无法确认这笔交易是否被夹。当前不会编造链上分析结论，请稍后重试。';
    case 'invalid_reference':
      return '我识别到你想做交易哈希夹子检测，但没有拿到单笔有效交易哈希。请一次只发送一笔完整交易哈希或一个受支持的交易浏览器链接。';
    case 'unsupported_chain':
      return '当前交易哈希夹子检测只支持已接入的数据源链。浏览器取证已支持 Solana、Base、Ethereum、BSC；其他链暂不支持，当前不会编造链上分析结论。';
    case 'browser_verification_required':
      return '交易分析卡在浏览器安全验证。请用可见 Chrome 打开对应交易浏览器页面并完成验证后重试；当前不会绕过验证或编造链上分析结论。';
    case 'tx_not_found':
      return '公开交易浏览器里找不到这笔交易，无法确认是否被夹。请检查交易哈希和链是否正确；当前不会编造链上分析结论。';
    case 'tx_failed':
      return '公开交易浏览器显示这笔交易执行失败，通常没有成功成交记录可用于判断是否被夹。当前不会把失败交易当成成功 swap 编造链上分析结论。';
    case 'tx_pending':
      return '公开交易浏览器显示这笔交易还未确认，或已被丢弃/替换，当前没有最终成功成交记录可用于判断是否被夹。当前不会把未确认交易当成成功 swap 编造链上分析结论。';
    case 'pool_not_found':
      return '已读取交易信息，但无法在 XXYY 中确认对应交易池子，暂时不能判断是否被夹。请稍后重试或补充明确的池子页面。';
    case 'target_trade_not_found':
      return '已打开 XXYY 池子页面，但没有在池子成交列表中定位到目标交易，暂时不能判断是否被夹。当前不会用相邻时间段猜测结论。';
    case 'screenshot_unavailable':
      return '交易分析截图生成失败，无法返回带目标行标记的原页面截图。当前不会用自绘截图冒充原页面证据，请稍后重试。';
    case 'timeout':
      return '交易分析浏览器取证超时，可能是交易浏览器或 XXYY 页面加载较慢。当前不会编造链上分析结论，请稍后重试。';
  }
}

function formatAnalysisHint(result: TxAnalysisResult): string {
  if (result.dataSource === 'browser') {
    return '提示：这是基于公开浏览器页面和 XXYY 交易窗口的辅助分析，不构成投资建议；页面缺失或筛选不完整时可能无法确认。';
  }

  return '提示：交易分析只作为公开链上页面和 XXYY 交易窗口的辅助判断，不构成投资建议；数据源缺失时不会生成结论。';
}
