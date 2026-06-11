import type { ChatAttachment, ChatResponse, TxAnalysisResult } from '@xxyy/shared';

import type { TransactionReference } from './tx-hash.js';

export interface TxAnalysisProvider {
  analyze(reference: TransactionReference): Promise<TxAnalysisResult>;
}

export type TxAnalysisUnavailableReason =
  | 'not_configured'
  | 'provider_unavailable'
  | 'invalid_reference'
  | 'unsupported_chain';

export interface MockTxAnalysisProviderOptions {
  analyzedAt?: string;
  screenshotUrl?: string;
}

export class TxAnalysisProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxAnalysisProviderUnavailableError';
  }
}

export class TxAnalysisUnsupportedChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxAnalysisUnsupportedChainError';
  }
}

export function createMockTxAnalysisProvider(
  options: MockTxAnalysisProviderOptions = {},
): TxAnalysisProvider {
  return {
    analyze(reference) {
      return Promise.resolve({
        analyzedAt: options.analyzedAt ?? new Date().toISOString(),
        chain: reference.chain,
        confidence: 0.62,
        dataSource: 'fixture',
        evidence: [
          {
            detail: 'Fixture 中用户交易前后各存在一笔相邻 swap，用于演示截图与结果结构。',
            label: '前后交易模式',
            severity: 'warning',
          },
          {
            detail: '当前结果未连接真实链上数据源，不能作为真实取证结论。',
            label: '数据来源',
            severity: 'info',
          },
        ],
        relatedTransactions: [
          {
            hash: `${reference.txHash.slice(0, 10)}...front`,
            role: 'front_run',
            summary: '演示前置交易',
          },
          {
            hash: reference.txHash,
            role: 'user',
            summary: '用户提交的交易',
          },
          {
            hash: `${reference.txHash.slice(0, 10)}...back`,
            role: 'back_run',
            summary: '演示后置交易',
          },
        ],
        screenshotUrl: options.screenshotUrl ?? '/assets/tx-analysis-fixture.svg',
        summary: '演示数据：疑似存在 sandwich 模式。该结论来自本地 fixture，不代表真实链上分析。',
        txHash: reference.txHash,
        verdict: 'sandwiched',
      });
    },
  };
}

export function createTxAnalysisAnswer(result: TxAnalysisResult): ChatResponse {
  return {
    answer: [
      `交易哈希：${result.txHash}`,
      `链：${formatChain(result.chain)}`,
      `结论：${formatVerdict(result.verdict)}，置信度 ${Math.round(result.confidence * 100)}%。`,
      `摘要：${result.summary}`,
      ...formatEvidence(result),
      ...formatRelatedTransactions(result),
      formatAnalysisHint(result),
    ].join('\n'),
    ...(result.screenshotUrl === undefined ? {} : { attachments: [createImageAttachment(result)] }),
    citations: [],
    confidence: result.confidence,
    intent: 'tx_sandwich_detection',
  };
}

export function createTxAnalysisUnavailableAnswer(
  reason: TxAnalysisUnavailableReason,
): ChatResponse {
  return {
    answer: unavailableAnswerText(reason),
    citations: [],
    confidence: 0.35,
    intent: 'tx_sandwich_detection',
  };
}

function createImageAttachment(result: TxAnalysisResult): ChatAttachment {
  return {
    kind: 'image',
    mediaType: mediaTypeForImageUrl(result.screenshotUrl ?? ''),
    title: '交易分析截图',
    url: result.screenshotUrl ?? '',
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

function formatRelatedTransactions(result: TxAnalysisResult): string[] {
  if (result.relatedTransactions.length === 0) {
    return [];
  }

  return [
    '相关交易：',
    ...result.relatedTransactions.map(
      (transaction) =>
        `- ${formatRelatedTransactionRole(transaction.role)}：${transaction.hash}，${transaction.summary}`,
    ),
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

function unavailableAnswerText(reason: TxAnalysisUnavailableReason): string {
  switch (reason) {
    case 'not_configured':
      return '交易哈希夹子检测功能暂未启用。当前不会编造链上分析结论；接入正式链上数据源后才能判断是否被夹并生成截图。';
    case 'provider_unavailable':
      return '交易分析数据源暂时不可用，无法确认这笔交易是否被夹。当前不会编造链上分析结论，请稍后重试。';
    case 'invalid_reference':
      return '我识别到你想做交易哈希夹子检测，但没有拿到有效交易哈希。请直接发送完整交易哈希或受支持的交易浏览器链接。';
    case 'unsupported_chain':
      return '当前交易哈希夹子检测只支持已接入的数据源链。Solana 浏览器分析已规划接入；其他链暂不支持，当前不会编造链上分析结论。';
  }
}

function formatAnalysisHint(result: TxAnalysisResult): string {
  if (result.dataSource === 'browser') {
    return '提示：这是基于公开浏览器页面和 XXYY 交易窗口的辅助分析，不构成投资建议；页面缺失或筛选不完整时可能无法确认。';
  }

  return '提示：只有接入正式链上数据源后的结果才可作为真实分析；fixture 或 demo 结果只用于展示产品形态。';
}
