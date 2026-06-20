import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createFileTxAnalysisReportWriter,
  createPgTxAnalysisReportStore,
  findFileTxAnalysisReports,
  getFileTxAnalysisReportDocument,
  summarizeFileTxAnalysisReports,
  updateFileTxAnalysisReportReview,
} from './tx-analysis-report-store.js';

const SOLANA_TX =
  '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: unknown[] = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    const rows = this.queuedRows.length > 0 ? (this.queuedRows.shift() ?? []) : this.rows;
    return Promise.resolve({ rows: rows as T[] });
  }
}

function expectPgReportReviewColumnFallbacks(sql: string): void {
  for (const [column, property] of [
    ['contract_address', 'contractAddress'],
    ['explorer_url', 'explorerUrl'],
    ['pool_address', 'poolAddress'],
    ['router_address', 'routerAddress'],
    ['screenshot_url', 'screenshotUrl'],
    ['target_trader_address', 'targetTraderAddress'],
    ['transaction_time', 'transactionTime'],
    ['xxyy_pool_url', 'xxyyPoolUrl'],
  ]) {
    expect(sql).toMatch(
      new RegExp(
        `coalesce\\(\\s*${column},\\s*report_document -> 'result' ->> '${property}',\\s*report_document -> 'failure' -> 'metadata' ->> '${property}'\\s*\\) as ${column}`,
        'u',
      ),
    );
  }
}

describe('createFileTxAnalysisReportWriter', () => {
  it('persists a JSON transaction analysis report and returns its public asset URL', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-reports-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });

    const output = await writer.writeReport({
      reference: { chain: 'solana', txHash: SOLANA_TX },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        analysisRuleVersion: 'sandwich-window-rules-v1',
        chain: 'solana',
        confidence: 0.58,
        dataSource: 'browser',
        evidence: [{ detail: 'target row highlighted', label: 'XXYY 原页面', severity: 'info' }],
        relatedTransactions: [
          {
            explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            hash: SOLANA_TX,
            role: 'user',
            side: 'buy',
            summary: '用户交易',
          },
        ],
        routerAddress: 'Router1111111111111111111111111111111111111',
        screenshotUrl: '/analysis-assets/tx-analysis-solana-window.png',
        screenshotTargetRowMarked: true,
        summary: 'not sandwiched',
        targetTradeSide: 'buy',
        targetTraderAddress: 'UserTrader11111111111111111111111111111111111',
        transactionTime: '2026-06-10T01:00:05.000Z',
        txHash: SOLANA_TX,
        verdict: 'not_sandwiched',
        xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      },
    });

    expect(output.reportUrl).toMatch(/^\/analysis-assets\/tx-analysis-report-solana-/u);
    expect(output.reportUrl.endsWith('.json')).toBe(true);

    const fileName = path.basename(output.reportUrl);
    const report = JSON.parse(await readFile(path.join(reportDir, fileName), 'utf8')) as unknown;
    expect(report).toMatchObject({
      reference: { chain: 'solana', txHash: SOLANA_TX },
      result: {
        analysisRuleVersion: 'sandwich-window-rules-v1',
        screenshotUrl: '/analysis-assets/tx-analysis-solana-window.png',
        screenshotTargetRowMarked: true,
        targetTradeSide: 'buy',
        txHash: SOLANA_TX,
        xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      },
      version: 1,
    });

    const reports = await findFileTxAnalysisReports({ reportDir, txHash: SOLANA_TX });
    expect(reports).toEqual([
      expect.objectContaining({
        analysisRuleVersion: 'sandwich-window-rules-v1',
        reportUrl: output.reportUrl,
        routerAddress: 'Router1111111111111111111111111111111111111',
        screenshotTargetRowMarked: true,
        status: 'success',
        targetTradeSide: 'buy',
        targetTraderAddress: 'UserTrader11111111111111111111111111111111111',
        transactionTime: '2026-06-10T01:00:05.000Z',
        relatedTransactions: [
          {
            explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            hash: SOLANA_TX,
            role: 'user',
            side: 'buy',
            summary: '用户交易',
          },
        ],
        xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      }),
    ]);
  });

  it('deduplicates related transactions before writing file success reports and index rows', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-file-success-dedup-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const output = await writer.writeReport({
      reference: { chain: 'base', txHash: evmTx },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        chain: 'base',
        confidence: 0.58,
        dataSource: 'browser',
        evidence: [],
        relatedTransactions: [
          {
            explorerUrl: `https://basescan.org/tx/${evmTx.toUpperCase()}`,
            hash: evmTx.toUpperCase(),
            role: 'related',
            summary: '重复上下文交易',
          },
          {
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            hash: evmTx,
            role: 'user',
            summary: '用户交易',
          },
        ],
        summary: 'not sandwiched',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
    });

    const report = JSON.parse(
      await readFile(path.join(reportDir, path.basename(output.reportUrl)), 'utf8'),
    ) as {
      result?: { relatedTransactions?: unknown };
    };
    const indexEntry = JSON.parse(
      (await readFile(path.join(reportDir, 'tx-analysis-report-index.jsonl'), 'utf8')).trim(),
    ) as { relatedTransactions?: unknown };

    const expectedRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: '用户交易',
      },
    ];
    expect(report.result?.relatedTransactions).toEqual(expectedRelatedTransactions);
    expect(indexEntry.relatedTransactions).toEqual(expectedRelatedTransactions);
  });

  it('normalizes related transactions before writing file success reports and index rows', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-file-related-clean-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const output = await writer.writeReport({
      reference: { chain: 'base', txHash: evmTx },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        chain: 'base',
        confidence: 0.58,
        dataSource: 'browser',
        evidence: [],
        relatedTransactions: [
          {
            explorerUrl: `  https://basescan.org/tx/${evmTx}  `,
            hash: `  ${evmTx}  `,
            role: 'user',
            side: 'buy',
            summary: '  用户交易  ',
            timestamp: '  2026-06-11T00:00:00.000Z  ',
            traderAddress: '  0xUser0000000000000000000000000000000000000  ',
          },
          {
            hash: '   ',
            role: 'related',
            summary: '空白 hash 交易',
          },
        ],
        summary: 'not sandwiched',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
    });

    const report = JSON.parse(
      await readFile(path.join(reportDir, path.basename(output.reportUrl)), 'utf8'),
    ) as {
      result?: { relatedTransactions?: unknown };
    };
    const indexEntry = JSON.parse(
      (await readFile(path.join(reportDir, 'tx-analysis-report-index.jsonl'), 'utf8')).trim(),
    ) as { relatedTransactions?: unknown };
    const expectedRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        side: 'buy',
        summary: '用户交易',
        timestamp: '2026-06-11T00:00:00.000Z',
        traderAddress: '0xUser0000000000000000000000000000000000000',
      },
    ];

    expect(report.result?.relatedTransactions).toEqual(expectedRelatedTransactions);
    expect(indexEntry.relatedTransactions).toEqual(expectedRelatedTransactions);
  });

  it('normalizes evidence before writing file success reports', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-file-evidence-clean-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const output = await writer.writeReport({
      reference: { chain: 'base', txHash: evmTx },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        chain: 'base',
        confidence: 0.58,
        dataSource: 'browser',
        evidence: [
          {
            detail: '  目标行已在 XXYY 原页面截图中标记。  ',
            label: '  XXYY 原页面  ',
            severity: 'info',
          },
          {
            detail: '空白 label 不应写入报告。',
            label: '   ',
            severity: 'warning',
          },
          {
            detail: '   ',
            label: '空白 detail',
            severity: 'warning',
          },
        ],
        relatedTransactions: [],
        summary: 'not sandwiched',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
    });

    const report = JSON.parse(
      await readFile(path.join(reportDir, path.basename(output.reportUrl)), 'utf8'),
    ) as {
      result?: { evidence?: unknown };
    };

    expect(report.result?.evidence).toEqual([
      {
        detail: '目标行已在 XXYY 原页面截图中标记。',
        label: 'XXYY 原页面',
        severity: 'info',
      },
    ]);
  });

  it('persists a JSON transaction analysis failure report', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-failures-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    if (typeof writer.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }

    const output = await writer.writeFailureReport({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress: 'Pool1111111111111111111111111111111111111111',
        probeAttempts: [
          {
            chain: 'base',
            message: 'BaseScan HTTP 503 Service Unavailable',
            reason: 'provider_unavailable',
          },
          {
            chain: 'ethereum',
            message: 'Etherscan requires browser verification',
            reason: 'browser_verification_required',
          },
        ],
        relatedTransactions: [
          {
            explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            hash: SOLANA_TX,
            role: 'user',
            side: 'buy',
            summary: '用户交易',
          },
        ],
        routerAddress: 'Router1111111111111111111111111111111111111',
        screenshotTargetRowMarked: true,
        screenshotUrl: '/analysis-assets/tx-analysis-failure-solana.png',
        targetTradeSide: 'buy',
        unsupportedChainHint: 'devnet',
        unsupportedExplorerHost: 'explorer.solana.com',
        xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      },
      message: 'XXYY pool not found',
      reason: 'pool_not_found',
      reference: { chain: 'solana', txHash: SOLANA_TX },
    });

    expect(output.reportUrl).toMatch(/^\/analysis-assets\/tx-analysis-failure-solana-/u);
    expect(output.reportUrl.endsWith('.json')).toBe(true);

    const fileName = path.basename(output.reportUrl);
    const report = JSON.parse(await readFile(path.join(reportDir, fileName), 'utf8')) as unknown;
    expect(report).toMatchObject({
      failure: {
        message: 'XXYY pool not found',
        metadata: {
          contractAddress: 'So11111111111111111111111111111111111111112',
          explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
          poolAddress: 'Pool1111111111111111111111111111111111111111',
          probeAttempts: [
            {
              chain: 'base',
              message: 'BaseScan HTTP 503 Service Unavailable',
              reason: 'provider_unavailable',
            },
            {
              chain: 'ethereum',
              message: 'Etherscan requires browser verification',
              reason: 'browser_verification_required',
            },
          ],
          relatedTransactions: [
            {
              explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
              hash: SOLANA_TX,
              role: 'user',
              side: 'buy',
              summary: '用户交易',
            },
          ],
          routerAddress: 'Router1111111111111111111111111111111111111',
          screenshotTargetRowMarked: true,
          screenshotUrl: '/analysis-assets/tx-analysis-failure-solana.png',
          targetTradeSide: 'buy',
          unsupportedChainHint: 'devnet',
          unsupportedExplorerHost: 'explorer.solana.com',
          xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
        },
        reason: 'pool_not_found',
      },
      reference: { chain: 'solana', txHash: SOLANA_TX },
      status: 'failure',
      version: 1,
    });

    const reports = await findFileTxAnalysisReports({ reportDir, txHash: SOLANA_TX });
    expect(reports).toEqual([
      expect.objectContaining({
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress: 'Pool1111111111111111111111111111111111111111',
        probeAttempts: [
          {
            chain: 'base',
            message: 'BaseScan HTTP 503 Service Unavailable',
            reason: 'provider_unavailable',
          },
          {
            chain: 'ethereum',
            message: 'Etherscan requires browser verification',
            reason: 'browser_verification_required',
          },
        ],
        relatedTransactions: [
          {
            explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
            hash: SOLANA_TX,
            role: 'user',
            side: 'buy',
            summary: '用户交易',
          },
        ],
        routerAddress: 'Router1111111111111111111111111111111111111',
        screenshotTargetRowMarked: true,
        screenshotUrl: '/analysis-assets/tx-analysis-failure-solana.png',
        status: 'failure',
        targetTradeSide: 'buy',
        unsupportedChainHint: 'devnet',
        unsupportedExplorerHost: 'explorer.solana.com',
        xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      }),
    ]);
  });

  it('deduplicates related transactions before writing file failure reports and index rows', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-file-failure-dedup-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    if (typeof writer.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const output = await writer.writeFailureReport({
      metadata: {
        relatedTransactions: [
          {
            explorerUrl: `https://basescan.org/tx/${evmTx.toUpperCase()}`,
            hash: evmTx.toUpperCase(),
            role: 'related',
            summary: '重复上下文交易',
          },
          {
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            hash: evmTx,
            role: 'user',
            summary: '用户交易',
          },
        ],
      },
      message: 'XXYY target trade not found',
      reason: 'target_trade_not_found',
      reference: { chain: 'base', txHash: evmTx },
    });

    const report = JSON.parse(
      await readFile(path.join(reportDir, path.basename(output.reportUrl)), 'utf8'),
    ) as {
      failure?: { metadata?: { relatedTransactions?: unknown } };
    };
    const indexEntry = JSON.parse(
      (await readFile(path.join(reportDir, 'tx-analysis-report-index.jsonl'), 'utf8')).trim(),
    ) as { relatedTransactions?: unknown };

    const expectedRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: '用户交易',
      },
    ];
    expect(report.failure?.metadata?.relatedTransactions).toEqual(expectedRelatedTransactions);
    expect(indexEntry.relatedTransactions).toEqual(expectedRelatedTransactions);
  });

  it('normalizes probe attempts before writing file failure reports and index rows', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-file-probe-clean-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    if (typeof writer.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const output = await writer.writeFailureReport({
      metadata: {
        probeAttempts: [
          {
            chain: 'base',
            message: '  BaseScan timed out  ',
            reason: 'timeout',
          },
          {
            chain: 'ethereum',
            message: '   ',
            reason: 'provider_unavailable',
          },
          {
            chain: 'bsc',
            message: 'BscScan requires browser verification',
            reason: 'browser_verification_required',
          },
        ],
      },
      message: 'No supported EVM explorer found this transaction',
      reason: 'tx_not_found',
      reference: { chain: 'unknown', txHash: evmTx },
    });

    const report = JSON.parse(
      await readFile(path.join(reportDir, path.basename(output.reportUrl)), 'utf8'),
    ) as {
      failure?: { metadata?: { probeAttempts?: unknown } };
    };
    const indexEntry = JSON.parse(
      (await readFile(path.join(reportDir, 'tx-analysis-report-index.jsonl'), 'utf8')).trim(),
    ) as { probeAttempts?: unknown };
    const expectedProbeAttempts = [
      {
        chain: 'base',
        message: 'BaseScan timed out',
        reason: 'timeout',
      },
      {
        chain: 'bsc',
        message: 'BscScan requires browser verification',
        reason: 'browser_verification_required',
      },
    ];

    expect(report.failure?.metadata?.probeAttempts).toEqual(expectedProbeAttempts);
    expect(indexEntry.probeAttempts).toEqual(expectedProbeAttempts);
  });

  it('omits empty metadata after removing blank file failure probe attempts', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-file-probe-empty-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    if (typeof writer.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const output = await writer.writeFailureReport({
      metadata: {
        probeAttempts: [
          {
            chain: 'base',
            message: '   ',
            reason: 'provider_unavailable',
          },
        ],
      },
      message: 'No supported EVM explorer found this transaction',
      reason: 'tx_not_found',
      reference: { chain: 'unknown', txHash: evmTx },
    });

    const report = JSON.parse(
      await readFile(path.join(reportDir, path.basename(output.reportUrl)), 'utf8'),
    ) as {
      failure?: { metadata?: unknown };
    };

    expect(report.failure).not.toHaveProperty('metadata');
  });

  it('normalizes transaction analysis failure messages before writing JSON reports', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-clean-failure-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    if (typeof writer.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }

    const output = await writer.writeFailureReport({
      message: '  XXYY pool not found  ',
      reason: 'pool_not_found',
      reference: { chain: 'solana', txHash: SOLANA_TX },
    });

    const fileName = path.basename(output.reportUrl);
    const report = JSON.parse(await readFile(path.join(reportDir, fileName), 'utf8')) as {
      failure?: { message?: string };
    };
    expect(report.failure?.message).toBe('XXYY pool not found');

    const reports = await findFileTxAnalysisReports({ reportDir, txHash: SOLANA_TX });
    expect(reports).toEqual([
      expect.objectContaining({
        message: 'XXYY pool not found',
        status: 'failure',
      }),
    ]);
  });

  it('indexes success and failure reports by chain and transaction hash', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-index-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });

    const success = await writer.writeReport({
      reference: { chain: 'solana', txHash: SOLANA_TX },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        chain: 'solana',
        contractAddress: 'So11111111111111111111111111111111111111112',
        confidence: 0.58,
        dataSource: 'browser',
        evidence: [],
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress: 'Pool1111111111111111111111111111111111111111',
        relatedTransactions: [],
        screenshotUrl: '/analysis-assets/tx-analysis-solana-window.png',
        summary: 'not sandwiched',
        txHash: SOLANA_TX,
        verdict: 'not_sandwiched',
      },
    });
    if (typeof writer.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    const failure = await writer.writeFailureReport({
      message: '  XXYY pool not found  ',
      reason: 'pool_not_found',
      reference: { chain: 'solana', txHash: SOLANA_TX },
    });

    const reports = await findFileTxAnalysisReports({
      chain: 'solana',
      reportDir,
      txHash: SOLANA_TX,
    });

    expect(reports.map((report) => report.reportUrl)).toEqual(
      expect.arrayContaining([success.reportUrl, failure.reportUrl]),
    );
    expect(reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chain: 'solana',
          contractAddress: 'So11111111111111111111111111111111111111112',
          explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
          poolAddress: 'Pool1111111111111111111111111111111111111111',
          reportUrl: success.reportUrl,
          screenshotUrl: '/analysis-assets/tx-analysis-solana-window.png',
          status: 'success',
          txHash: SOLANA_TX,
        }),
        expect.objectContaining({
          chain: 'solana',
          message: 'XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: failure.reportUrl,
          status: 'failure',
          txHash: SOLANA_TX,
        }),
      ]),
    );
  });

  it('can find reports by transaction hash across all chains', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-cross-chain-index-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const baseReport = await writer.writeReport({
      reference: { chain: 'base', txHash: evmTx },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        chain: 'base',
        confidence: 0.42,
        dataSource: 'browser',
        evidence: [],
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        relatedTransactions: [],
        summary: 'base report',
        txHash: evmTx,
        verdict: 'inconclusive',
      },
    });
    const ethereumReport = await writer.writeReport({
      reference: { chain: 'ethereum', txHash: evmTx },
      result: {
        analyzedAt: '2026-06-11T00:01:00.000Z',
        chain: 'ethereum',
        confidence: 0.86,
        dataSource: 'browser',
        evidence: [],
        explorerUrl: `https://etherscan.io/tx/${evmTx}`,
        relatedTransactions: [],
        summary: 'ethereum report',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
    });

    const reports = await findFileTxAnalysisReports({
      reportDir,
      txHash: evmTx,
    });

    expect(reports.map((report) => report.reportUrl)).toEqual(
      expect.arrayContaining([ethereumReport.reportUrl, baseReport.reportUrl]),
    );
    expect(reports.map((report) => report.chain)).toEqual(
      expect.arrayContaining(['ethereum', 'base']),
    );
  });

  it('matches EVM transaction hashes case-insensitively when querying file reports', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-evm-case-index-'));
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      JSON.stringify({
        chain: 'base',
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportUrl: '/analysis-assets/tx-analysis-report-base.json',
        status: 'success',
        txHash: evmTx,
      }),
    );

    const reports = await findFileTxAnalysisReports({
      reportDir,
      txHash: evmTx.toUpperCase(),
    });

    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'base',
        reportUrl: '/analysis-assets/tx-analysis-report-base.json',
        txHash: evmTx,
      }),
    ]);
  });

  it('filters dirty file failure probe attempts from report index rows', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-probe-index-'));
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      `${JSON.stringify({
        chain: 'unknown',
        generatedAt: '2026-06-11T00:00:00.000Z',
        probeAttempts: [
          {
            chain: 'base',
            message: 'BaseScan did not find the transaction',
            reason: 'tx_not_found',
          },
          {
            chain: 'ethereum',
            message: '  Etherscan requires browser verification  ',
            reason: 'browser_verification_required',
          },
          {
            chain: 'bsc',
            message: '   ',
            reason: 'provider_unavailable',
          },
        ],
        reason: 'tx_not_found',
        reportUrl: '/analysis-assets/tx-analysis-failure-unknown.json',
        status: 'failure',
        txHash: evmTx,
      })}\n`,
    );

    const reports = await findFileTxAnalysisReports({ reportDir, status: 'failure' });

    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'unknown',
        probeAttempts: [
          {
            chain: 'base',
            message: 'BaseScan did not find the transaction',
            reason: 'tx_not_found',
          },
        ],
        reason: 'tx_not_found',
        status: 'failure',
        txHash: evmTx,
      }),
    ]);
  });

  it('normalizes dirty file failure messages from report index rows', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-message-index-'));
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      `${JSON.stringify({
        chain: 'base',
        generatedAt: '2026-06-11T00:00:00.000Z',
        message: '  XXYY pool not found  ',
        reason: 'pool_not_found',
        reportUrl: '/analysis-assets/tx-analysis-failure-base.json',
        status: 'failure',
        txHash: evmTx,
      })}\n${JSON.stringify({
        chain: 'ethereum',
        generatedAt: '2026-06-11T00:01:00.000Z',
        message: '   ',
        reason: 'provider_unavailable',
        reportUrl: '/analysis-assets/tx-analysis-failure-ethereum.json',
        status: 'failure',
        txHash: evmTx,
      })}\n`,
    );

    const reports = await findFileTxAnalysisReports({ reportDir, status: 'failure' });

    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'ethereum',
        reason: 'provider_unavailable',
        status: 'failure',
        txHash: evmTx,
      }),
      expect.objectContaining({
        chain: 'base',
        message: 'XXYY pool not found',
        reason: 'pool_not_found',
        status: 'failure',
        txHash: evmTx,
      }),
    ]);
    expect(reports[0]).not.toHaveProperty('message');
  });

  it('filters dirty file related transactions from report index rows', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-related-index-'));
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      `${JSON.stringify({
        chain: 'base',
        generatedAt: '2026-06-11T00:00:00.000Z',
        relatedTransactions: [
          {
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            hash: evmTx,
            role: 'user',
            summary: '用户交易',
          },
          {
            explorerUrl: 'https://basescan.org/tx/0xdef',
            hash: '0xdef',
            role: 'related',
            summary: '上下文交易',
            timestamp: '  2026-06-11T00:02:00.000Z  ',
          },
          {
            explorerUrl: '   ',
            hash: '0xghi',
            role: 'related',
            summary: '空链接交易',
          },
        ],
        reportUrl: '/analysis-assets/tx-analysis-report-base.json',
        status: 'success',
        txHash: evmTx,
      })}\n`,
    );

    const reports = await findFileTxAnalysisReports({ reportDir, status: 'success' });

    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'base',
        relatedTransactions: [
          {
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            hash: evmTx,
            role: 'user',
            summary: '用户交易',
          },
        ],
        status: 'success',
        txHash: evmTx,
      }),
    ]);
  });

  it('deduplicates file related transactions from report index rows by hash', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-related-dedup-index-'));
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      `${JSON.stringify({
        chain: 'base',
        generatedAt: '2026-06-11T00:00:00.000Z',
        relatedTransactions: [
          {
            explorerUrl: `https://basescan.org/tx/${evmTx.toUpperCase()}`,
            hash: evmTx.toUpperCase(),
            role: 'related',
            summary: '重复上下文交易',
          },
          {
            explorerUrl: `https://basescan.org/tx/${evmTx}`,
            hash: evmTx,
            role: 'user',
            summary: '用户交易',
          },
        ],
        reportUrl: '/analysis-assets/tx-analysis-report-base.json',
        status: 'success',
        txHash: evmTx,
      })}\n`,
    );

    const reports = await findFileTxAnalysisReports({ reportDir, status: 'success' });

    expect(reports[0]?.relatedTransactions).toEqual([
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: '用户交易',
      },
    ]);
  });

  it('trims transaction hashes when querying file reports', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-trimmed-hash-index-'));
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      JSON.stringify({
        chain: 'base',
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportUrl: '/analysis-assets/tx-analysis-report-base.json',
        status: 'success',
        txHash: ` ${evmTx}\n`,
      }),
    );

    const reports = await findFileTxAnalysisReports({
      reportDir,
      txHash: `\t${evmTx.toUpperCase()} `,
    });

    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'base',
        reportUrl: '/analysis-assets/tx-analysis-report-base.json',
        txHash: ` ${evmTx}\n`,
      }),
    ]);
  });

  it('finds file reports when the query is a transaction explorer link', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-link-hash-index-'));
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      JSON.stringify({
        chain: 'solana',
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportUrl: '/analysis-assets/tx-analysis-report-solana.json',
        status: 'success',
        txHash: SOLANA_TX,
      }),
    );

    const reports = await findFileTxAnalysisReports({
      reportDir,
      txHash: `https://solscan.io/tx/${SOLANA_TX}`,
    });

    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'solana',
        reportUrl: '/analysis-assets/tx-analysis-report-solana.json',
        txHash: SOLANA_TX,
      }),
    ]);
  });

  it('does not match mainnet file reports when the query is an unsupported explorer link', async () => {
    const reportDir = await mkdtemp(
      path.join(tmpdir(), 'xxyy-tx-analysis-unsupported-link-index-'),
    );
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      JSON.stringify({
        chain: 'solana',
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportUrl: '/analysis-assets/tx-analysis-report-solana.json',
        status: 'success',
        txHash: SOLANA_TX,
      }),
    );

    const reports = await findFileTxAnalysisReports({
      reportDir,
      txHash: `https://explorer.solana.com/tx/${SOLANA_TX}?cluster=devnet`,
    });

    expect(reports).toEqual([]);
  });

  it('does not match mainnet file reports when the query names an unsupported EVM chain', async () => {
    const reportDir = await mkdtemp(
      path.join(tmpdir(), 'xxyy-tx-analysis-unsupported-chain-index-'),
    );
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      JSON.stringify({
        chain: 'base',
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportUrl: '/analysis-assets/tx-analysis-report-base.json',
        status: 'success',
        txHash: evmTx,
      }),
    );

    const reports = await findFileTxAnalysisReports({
      reportDir,
      txHash: `Polygon ${evmTx}`,
    });

    expect(reports).toEqual([]);
  });

  it('can find failure reports by reason for ops triage', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-reason-index-'));
    const baseTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const ethTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const bscTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/analysis-assets/tx-analysis-report-base.json',
          status: 'success',
          txHash: baseTx,
        }),
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          message: 'XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: '/analysis-assets/tx-analysis-failure-ethereum.json',
          status: 'failure',
          txHash: ethTx,
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:02:00.000Z',
          message: 'Browser timeout',
          reason: 'timeout',
          reportUrl: '/analysis-assets/tx-analysis-failure-base-timeout.json',
          status: 'failure',
          txHash: baseTx,
        }),
        JSON.stringify({
          chain: 'bsc',
          generatedAt: '2026-06-11T00:03:00.000Z',
          message: 'Another XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: '/analysis-assets/tx-analysis-failure-bsc.json',
          status: 'failure',
          txHash: bscTx,
        }),
      ].join('\n'),
    );

    const reports = await findFileTxAnalysisReports({
      reason: 'pool_not_found',
      reportDir,
    });

    expect(reports.map((report) => report.reportUrl)).toEqual([
      '/analysis-assets/tx-analysis-failure-bsc.json',
      '/analysis-assets/tx-analysis-failure-ethereum.json',
    ]);
    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'bsc',
        reason: 'pool_not_found',
        status: 'failure',
        txHash: bscTx,
      }),
      expect.objectContaining({
        chain: 'ethereum',
        reason: 'pool_not_found',
        status: 'failure',
        txHash: ethTx,
      }),
    ]);
  });

  it('can find the latest reports by status with a limit', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-status-index-'));
    const baseTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const ethTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const bscTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:00:00.000Z',
          message: 'XXYY pool not found',
          reason: 'pool_not_found',
          reportUrl: '/analysis-assets/tx-analysis-failure-ethereum.json',
          status: 'failure',
          txHash: ethTx,
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:01:00.000Z',
          message: 'Browser timeout',
          reason: 'timeout',
          reportUrl: '/analysis-assets/tx-analysis-failure-base-timeout.json',
          status: 'failure',
          txHash: baseTx,
        }),
        JSON.stringify({
          chain: 'bsc',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reportUrl: '/analysis-assets/tx-analysis-report-bsc.json',
          status: 'success',
          txHash: bscTx,
        }),
      ].join('\n'),
    );

    const reports = await findFileTxAnalysisReports({
      limit: 1,
      reportDir,
      status: 'failure',
    });

    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'base',
        reason: 'timeout',
        reportUrl: '/analysis-assets/tx-analysis-failure-base-timeout.json',
        status: 'failure',
        txHash: baseTx,
      }),
    ]);
  });

  it('caps oversized file report queries to the ops page maximum', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-limit-cap-'));
    const entries = Array.from({ length: 150 }, (_, index) =>
      JSON.stringify({
        chain: 'base',
        generatedAt: new Date(Date.UTC(2026, 5, 11, 0, 0, index)).toISOString(),
        reportUrl: `/analysis-assets/tx-analysis-report-${index}.json`,
        status: 'success',
        txHash: `0x${index.toString(16).padStart(64, '0')}`,
      }),
    );

    await writeFile(path.join(reportDir, 'tx-analysis-report-index.jsonl'), entries.join('\n'));

    const reports = await findFileTxAnalysisReports({
      limit: 1000,
      reportDir,
    });

    expect(reports).toHaveLength(100);
    expect(reports[0]?.reportUrl).toBe('/analysis-assets/tx-analysis-report-149.json');
  });

  it('places file reports with invalid generatedAt values after dated reports', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-invalid-date-index-'));
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: 'not-a-date',
          reportUrl: '/analysis-assets/tx-analysis-report-invalid.json',
          status: 'success',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reportUrl: '/analysis-assets/tx-analysis-report-dated.json',
          status: 'success',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );

    const reports = await findFileTxAnalysisReports({ reportDir });

    expect(reports.map((report) => report.reportUrl)).toEqual([
      '/analysis-assets/tx-analysis-report-dated.json',
      '/analysis-assets/tx-analysis-report-invalid.json',
    ]);
  });

  it('can find file reports assigned to an ops owner', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-assignee-index-'));
    const baseTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const ethTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const bscTx = '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/analysis-assets/tx-analysis-report-base.json',
          review: {
            assignee: 'Alice',
            status: 'in_review',
            updatedAt: '2026-06-11T00:00:30.000Z',
          },
          status: 'success',
          txHash: baseTx,
        }),
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reportUrl: '/analysis-assets/tx-analysis-report-ethereum.json',
          review: {
            assignee: 'bob',
            status: 'open',
            updatedAt: '2026-06-11T00:01:30.000Z',
          },
          status: 'success',
          txHash: ethTx,
        }),
        JSON.stringify({
          chain: 'bsc',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reportUrl: '/analysis-assets/tx-analysis-report-bsc.json',
          review: {
            assignee: 'alice',
            status: 'closed',
            updatedAt: '2026-06-11T00:02:30.000Z',
          },
          status: 'success',
          txHash: bscTx,
        }),
      ].join('\n'),
    );

    const reports = await findFileTxAnalysisReports({
      reportDir,
      reviewAssignee: ' alice ',
    });

    expect(reports.map((report) => report.reportUrl)).toEqual([
      '/analysis-assets/tx-analysis-report-bsc.json',
      '/analysis-assets/tx-analysis-report-base.json',
    ]);
  });

  it('summarizes persisted report outcomes for ops review', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-summary-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });
    const baseTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const ethTx = '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    await writer.writeReport({
      reference: { chain: 'base', txHash: baseTx },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        analysisRuleVersion: 'sandwich-window-rules-v1',
        chain: 'base',
        confidence: 0.8,
        dataSource: 'browser',
        evidence: [],
        relatedTransactions: [],
        summary: 'base success',
        txHash: baseTx,
        verdict: 'not_sandwiched',
      },
    });
    if (typeof writer.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    await writer.writeFailureReport({
      message: 'XXYY pool not found',
      reason: 'pool_not_found',
      reference: { chain: 'ethereum', txHash: ethTx },
    });
    await writer.writeFailureReport({
      message: 'Browser timeout',
      reason: 'timeout',
      reference: { chain: 'base', txHash: baseTx },
    });

    const summary = await summarizeFileTxAnalysisReports({ reportDir });

    expect(summary).toMatchObject({
      byChain: {
        base: 2,
        ethereum: 1,
      },
      byReviewStatus: {
        open: 3,
      },
      byRuleVersion: {
        'sandwich-window-rules-v1': 1,
      },
      failureCount: 2,
      failureReasons: {
        pool_not_found: 1,
        timeout: 1,
      },
      successCount: 1,
      totalCount: 3,
    });
    expect(summary.latestReports).toHaveLength(3);
  });

  it('summarizes file report review status counts for ops queues', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-review-summary-'));
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      [
        JSON.stringify({
          chain: 'base',
          generatedAt: '2026-06-11T00:00:00.000Z',
          reportUrl: '/analysis-assets/tx-analysis-report-base-open.json',
          status: 'success',
          txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'ethereum',
          generatedAt: '2026-06-11T00:01:00.000Z',
          reportUrl: '/analysis-assets/tx-analysis-report-ethereum-review.json',
          review: {
            status: 'in_review',
            updatedAt: '2026-06-11T00:01:30.000Z',
          },
          status: 'success',
          txHash: '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
        JSON.stringify({
          chain: 'bsc',
          generatedAt: '2026-06-11T00:02:00.000Z',
          reason: 'timeout',
          reportUrl: '/analysis-assets/tx-analysis-failure-bsc-closed.json',
          review: {
            assignee: 'ops-user',
            status: 'closed',
            updatedAt: '2026-06-11T00:02:30.000Z',
          },
          status: 'failure',
          txHash: '0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        }),
      ].join('\n'),
    );

    const summary = await summarizeFileTxAnalysisReports({ reportDir });

    expect(summary).toMatchObject({
      byReviewStatus: {
        closed: 1,
        in_review: 1,
        open: 1,
      },
      totalCount: 3,
    });
  });

  it('treats legacy invalid file report review statuses as open when filtering ops queues', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-invalid-status-'));
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    await writeFile(
      path.join(reportDir, 'tx-analysis-report-index.jsonl'),
      JSON.stringify({
        chain: 'base',
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportUrl: '/analysis-assets/tx-analysis-report-base-legacy.json',
        review: {
          status: 'needs_review',
          updatedAt: '2026-06-11T00:01:00.000Z',
        },
        status: 'success',
        txHash: evmTx,
      }),
    );

    const reports = await findFileTxAnalysisReports({
      reportDir,
      reviewStatus: 'open',
    });

    expect(reports).toEqual([
      expect.objectContaining({
        reportUrl: '/analysis-assets/tx-analysis-report-base-legacy.json',
        txHash: evmTx,
      }),
    ]);
  });

  it('updates file report review metadata in the index and report document', async () => {
    const reportDir = await mkdtemp(path.join(tmpdir(), 'xxyy-tx-analysis-file-review-'));
    const writer = createFileTxAnalysisReportWriter({
      reportBaseUrl: '/analysis-assets',
      reportDir,
    });

    const output = await writer.writeReport({
      reference: { chain: 'solana', txHash: SOLANA_TX },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        chain: 'solana',
        confidence: 0.58,
        dataSource: 'browser',
        evidence: [],
        relatedTransactions: [],
        screenshotUrl: '/analysis-assets/tx-analysis-solana-window.png',
        summary: 'not sandwiched',
        txHash: SOLANA_TX,
        verdict: 'not_sandwiched',
      },
    });

    const reportId = path.basename(output.reportUrl);
    const review = await updateFileTxAnalysisReportReview({
      assignee: ' alice ',
      id: reportId,
      note: ' 已回复用户并附上原页面截图。 ',
      reportDir,
      status: 'closed',
      updatedBy: ' ops-user ',
    });

    if (review === undefined) {
      throw new Error('file review update should return the saved review');
    }
    expect(typeof review.updatedAt).toBe('string');
    expect(review).toEqual({
      assignee: 'alice',
      note: '已回复用户并附上原页面截图。',
      status: 'closed',
      updatedAt: review.updatedAt,
      updatedBy: 'ops-user',
    });

    const reports = await findFileTxAnalysisReports({
      reportDir,
      reviewAssignee: 'ALICE',
      reviewStatus: 'closed',
    });
    expect(reports).toEqual([
      expect.objectContaining({
        reportUrl: output.reportUrl,
        review,
      }),
    ]);

    const document = await getFileTxAnalysisReportDocument({
      id: reportId,
      reportDir,
    });
    expect(document).toMatchObject({
      reference: { chain: 'solana', txHash: SOLANA_TX },
      review,
      status: 'success',
    });
  });
});

describe('createPgTxAnalysisReportStore', () => {
  it('migrates the transaction analysis report table and indexes', async () => {
    const client = new FakePgClient();
    const store = createPgTxAnalysisReportStore({ client });

    await store.migrate();

    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists tx_analysis_reports');
    expect(sql).toContain('router_address text');
    expect(sql).toContain('review_status text');
    expect(sql).toContain('tx_analysis_reports_tx_hash_idx');
    expect(sql).toContain('tx_analysis_reports_failure_reason_idx');
    expect(sql).toContain("'tx_failed'");
    expect(sql).toContain("'tx_pending'");
  });

  it('persists success and failure reports in Postgres', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ id: 'txr_success_1' }], [{ id: 'txr_failure_1' }]];
    const store = createPgTxAnalysisReportStore({ client });

    const success = await store.writeReport({
      reference: { chain: 'solana', txHash: SOLANA_TX },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        chain: 'solana',
        confidence: 0.58,
        dataSource: 'browser',
        evidence: [{ detail: 'target row highlighted', label: 'XXYY 原页面', severity: 'info' }],
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress: 'Pool1111111111111111111111111111111111111111',
        relatedTransactions: [{ hash: SOLANA_TX, role: 'user', summary: '用户交易' }],
        routerAddress: 'Router1111111111111111111111111111111111111',
        screenshotTargetRowMarked: true,
        screenshotUrl: '/assets/tx-analysis-solana-window.png',
        summary: 'not sandwiched',
        targetTraderAddress: 'UserTrader11111111111111111111111111111111111',
        transactionTime: '2026-06-10T01:00:05.000Z',
        txHash: SOLANA_TX,
        verdict: 'not_sandwiched',
        xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      },
    });
    if (typeof store.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    const failure = await store.writeFailureReport({
      metadata: {
        contractAddress: 'So11111111111111111111111111111111111111112',
        explorerUrl: `https://solscan.io/tx/${SOLANA_TX}`,
        poolAddress: 'Pool1111111111111111111111111111111111111111',
        routerAddress: 'Router1111111111111111111111111111111111111',
        screenshotTargetRowMarked: true,
        screenshotUrl: '/assets/tx-analysis-failure-solana.png',
        targetTraderAddress: 'UserTrader11111111111111111111111111111111111',
        transactionTime: '2026-06-10T01:00:05.000Z',
        xxyyPoolUrl: 'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      },
      message: 'XXYY pool not found',
      reason: 'pool_not_found',
      reference: { chain: 'solana', txHash: SOLANA_TX },
    });

    expect(success.reportUrl).toBe('tx-analysis-report:txr_success_1');
    expect(failure.reportUrl).toBe('tx-analysis-report:txr_failure_1');
    expect(client.queries[0]?.sql).toContain('insert into tx_analysis_reports');
    expect(client.queries[0]?.values).toEqual([
      expect.stringMatching(/^txr_/u),
      SOLANA_TX,
      'solana',
      'success',
      expect.any(String),
      'tx-analysis-report:',
      '/assets/tx-analysis-solana-window.png',
      `https://solscan.io/tx/${SOLANA_TX}`,
      'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      'Pool1111111111111111111111111111111111111111',
      'Router1111111111111111111111111111111111111',
      null,
      'UserTrader11111111111111111111111111111111111',
      '2026-06-10T01:00:05.000Z',
      'not_sandwiched',
      0.58,
      null,
      null,
      true,
      expect.any(String),
    ]);
    expect(client.queries[1]?.values).toEqual([
      expect.stringMatching(/^txr_/u),
      SOLANA_TX,
      'solana',
      'failure',
      expect.any(String),
      'tx-analysis-report:',
      '/assets/tx-analysis-failure-solana.png',
      `https://solscan.io/tx/${SOLANA_TX}`,
      'https://www.xxyy.io/sol/Pool1111111111111111111111111111111111111111',
      'Pool1111111111111111111111111111111111111111',
      'Router1111111111111111111111111111111111111',
      'So11111111111111111111111111111111111111112',
      'UserTrader11111111111111111111111111111111111',
      '2026-06-10T01:00:05.000Z',
      null,
      null,
      'pool_not_found',
      'XXYY pool not found',
      true,
      expect.any(String),
    ]);
    expect(
      JSON.parse(client.queries[1]?.values[19] as string) as {
        failure?: { message?: string };
      },
    ).toMatchObject({
      failure: {
        message: 'XXYY pool not found',
      },
    });
  });

  it('deduplicates related transactions before writing Postgres report documents', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ id: 'txr_success_1' }], [{ id: 'txr_failure_1' }]];
    const store = createPgTxAnalysisReportStore({ client });
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const duplicateRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${evmTx.toUpperCase()}`,
        hash: evmTx.toUpperCase(),
        role: 'related' as const,
        summary: '重复上下文交易',
      },
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user' as const,
        summary: '用户交易',
      },
    ];

    await store.writeReport({
      reference: { chain: 'base', txHash: evmTx },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        chain: 'base',
        confidence: 0.58,
        dataSource: 'browser',
        evidence: [],
        relatedTransactions: duplicateRelatedTransactions,
        summary: 'not sandwiched',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
    });
    if (typeof store.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    await store.writeFailureReport({
      metadata: { relatedTransactions: duplicateRelatedTransactions },
      message: 'XXYY target trade not found',
      reason: 'target_trade_not_found',
      reference: { chain: 'base', txHash: evmTx },
    });

    const successDocument = JSON.parse(String(client.queries[0]?.values[19])) as {
      result?: { relatedTransactions?: unknown };
    };
    const failureDocument = JSON.parse(String(client.queries[1]?.values[19])) as {
      failure?: { metadata?: { relatedTransactions?: unknown } };
    };
    const expectedRelatedTransactions = [
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: '用户交易',
      },
    ];

    expect(successDocument.result?.relatedTransactions).toEqual(expectedRelatedTransactions);
    expect(failureDocument.failure?.metadata?.relatedTransactions).toEqual(
      expectedRelatedTransactions,
    );
  });

  it('normalizes evidence before writing Postgres success report documents', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ id: 'txr_success_1' }]];
    const store = createPgTxAnalysisReportStore({ client });
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    await store.writeReport({
      reference: { chain: 'base', txHash: evmTx },
      result: {
        analyzedAt: '2026-06-11T00:00:00.000Z',
        chain: 'base',
        confidence: 0.58,
        dataSource: 'browser',
        evidence: [
          {
            detail: '  目标行已在 XXYY 原页面截图中标记。  ',
            label: '  XXYY 原页面  ',
            severity: 'info',
          },
          {
            detail: '空白 label 不应写入报告。',
            label: '   ',
            severity: 'warning',
          },
          {
            detail: '   ',
            label: '空白 detail',
            severity: 'warning',
          },
        ],
        relatedTransactions: [],
        summary: 'not sandwiched',
        txHash: evmTx,
        verdict: 'not_sandwiched',
      },
    });

    const successDocument = JSON.parse(String(client.queries[0]?.values[19])) as {
      result?: { evidence?: unknown };
    };

    expect(successDocument.result?.evidence).toEqual([
      {
        detail: '目标行已在 XXYY 原页面截图中标记。',
        label: 'XXYY 原页面',
        severity: 'info',
      },
    ]);
  });

  it('normalizes probe attempts before writing Postgres report documents', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ id: 'txr_failure_1' }]];
    const store = createPgTxAnalysisReportStore({ client });
    if (typeof store.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    await store.writeFailureReport({
      metadata: {
        probeAttempts: [
          {
            chain: 'base',
            message: '  BaseScan timed out  ',
            reason: 'timeout',
          },
          {
            chain: 'ethereum',
            message: '   ',
            reason: 'provider_unavailable',
          },
          {
            chain: 'bsc',
            message: 'BscScan requires browser verification',
            reason: 'browser_verification_required',
          },
        ],
      },
      message: 'No supported EVM explorer found this transaction',
      reason: 'tx_not_found',
      reference: { chain: 'unknown', txHash: evmTx },
    });

    const failureDocument = JSON.parse(String(client.queries[0]?.values[19])) as {
      failure?: { metadata?: { probeAttempts?: unknown } };
    };

    expect(failureDocument.failure?.metadata?.probeAttempts).toEqual([
      {
        chain: 'base',
        message: 'BaseScan timed out',
        reason: 'timeout',
      },
      {
        chain: 'bsc',
        message: 'BscScan requires browser verification',
        reason: 'browser_verification_required',
      },
    ]);
  });

  it('normalizes related transactions before writing Postgres failure report documents', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ id: 'txr_failure_1' }]];
    const store = createPgTxAnalysisReportStore({ client });
    if (typeof store.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    await store.writeFailureReport({
      metadata: {
        relatedTransactions: [
          {
            explorerUrl: `  https://basescan.org/tx/${evmTx}  `,
            hash: `  ${evmTx}  `,
            role: 'user',
            side: 'buy',
            summary: '  用户交易  ',
            timestamp: '  2026-06-11T00:00:00.000Z  ',
            traderAddress: '  0xUser0000000000000000000000000000000000000  ',
          },
          {
            hash: '   ',
            role: 'related',
            summary: '空白 hash 交易',
          },
        ],
      },
      message: 'XXYY target trade not found',
      reason: 'target_trade_not_found',
      reference: { chain: 'base', txHash: evmTx },
    });

    const failureDocument = JSON.parse(String(client.queries[0]?.values[19])) as {
      failure?: { metadata?: { relatedTransactions?: unknown } };
    };

    expect(failureDocument.failure?.metadata?.relatedTransactions).toEqual([
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        side: 'buy',
        summary: '用户交易',
        timestamp: '2026-06-11T00:00:00.000Z',
        traderAddress: '0xUser0000000000000000000000000000000000000',
      },
    ]);
  });

  it('omits empty metadata after removing blank Postgres failure probe attempts', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ id: 'txr_failure_1' }]];
    const store = createPgTxAnalysisReportStore({ client });
    if (typeof store.writeFailureReport !== 'function') {
      throw new Error('failure report writer should be configured');
    }
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    await store.writeFailureReport({
      metadata: {
        probeAttempts: [
          {
            chain: 'base',
            message: '   ',
            reason: 'provider_unavailable',
          },
        ],
      },
      message: 'No supported EVM explorer found this transaction',
      reason: 'tx_not_found',
      reference: { chain: 'unknown', txHash: evmTx },
    });

    const failureDocument = JSON.parse(String(client.queries[0]?.values[19])) as {
      failure?: { metadata?: unknown };
    };

    expect(failureDocument.failure).not.toHaveProperty('metadata');
  });

  it('queries Postgres reports with the same filters as the file index', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        {
          analysis_rule_version: 'sandwich-window-rules-v1',
          chain: 'base',
          confidence: 0.8,
          contract_address: '0xToken',
          explorer_url: 'https://basescan.org/tx/0xabc',
          failure_message: null,
          failure_reason: null,
          generated_at: '2026-06-11T00:02:00.000Z',
          pool_address: '0xPool',
          related_transactions: [
            {
              explorerUrl: 'https://basescan.org/tx/0xfront',
              hash: '0xfront',
              role: 'front_run',
              summary: '前置交易',
            },
            {
              explorerUrl: 'https://basescan.org/tx/0xabc',
              hash: '0xabc',
              role: 'user',
              summary: '用户交易',
            },
          ],
          report_url: '/assets/tx-analysis-reports/txr_base_success',
          review_assignee: 'alice',
          review_note: '已回复用户并附上截图。',
          review_status: 'closed',
          review_updated_at: '2026-06-11T00:05:00.000Z',
          review_updated_by: 'ops-user',
          router_address: '0xRouter',
          screenshot_target_row_marked: true,
          screenshot_url: '/assets/base.png',
          status: 'success',
          tx_hash: '0xabc',
          verdict: 'not_sandwiched',
          xxyy_pool_url: 'https://www.xxyy.io/base/0xpool',
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const reports = await store.findReports({
      chain: 'base',
      limit: 5,
      reviewAssignee: 'Alice',
      reviewStatus: 'closed',
      status: 'success',
      txHash: '0xabc',
    });

    expect(client.queries[0]?.sql).toContain('from tx_analysis_reports');
    expect(client.queries[0]?.sql).toContain('tx_hash = $1');
    expect(client.queries[0]?.sql).toContain('chain = $2');
    expect(client.queries[0]?.sql).toContain('status = $3');
    expect(client.queries[0]?.sql).toContain("coalesce(review_status, 'open') = $4");
    expect(client.queries[0]?.sql).toContain('lower(review_assignee) = lower($5)');
    expectPgReportReviewColumnFallbacks(client.queries[0]?.sql ?? '');
    expect(client.queries[0]?.sql).toContain(
      "coalesce(report_document -> 'result' -> 'relatedTransactions', report_document -> 'failure' -> 'metadata' -> 'relatedTransactions') as related_transactions",
    );
    expect(client.queries[0]?.sql).toContain(
      "report_document -> 'failure' -> 'metadata' ->> 'screenshotTargetRowMarked'",
    );
    expect(client.queries[0]?.values).toEqual(['0xabc', 'base', 'success', 'closed', 'alice', 5]);
    expect(reports).toEqual([
      {
        analysisRuleVersion: 'sandwich-window-rules-v1',
        chain: 'base',
        confidence: 0.8,
        contractAddress: '0xToken',
        explorerUrl: 'https://basescan.org/tx/0xabc',
        generatedAt: '2026-06-11T00:02:00.000Z',
        poolAddress: '0xPool',
        relatedTransactions: [
          {
            explorerUrl: 'https://basescan.org/tx/0xfront',
            hash: '0xfront',
            role: 'front_run',
            summary: '前置交易',
          },
          {
            explorerUrl: 'https://basescan.org/tx/0xabc',
            hash: '0xabc',
            role: 'user',
            summary: '用户交易',
          },
        ],
        reportUrl: '/assets/tx-analysis-reports/txr_base_success',
        review: {
          assignee: 'alice',
          note: '已回复用户并附上截图。',
          status: 'closed',
          updatedAt: '2026-06-11T00:05:00.000Z',
          updatedBy: 'ops-user',
        },
        routerAddress: '0xRouter',
        screenshotTargetRowMarked: true,
        screenshotUrl: '/assets/base.png',
        status: 'success',
        txHash: '0xabc',
        verdict: 'not_sandwiched',
        xxyyPoolUrl: 'https://www.xxyy.io/base/0xpool',
      },
    ]);
  });

  it('filters dirty related transactions from Postgres report index rows', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        {
          analysis_rule_version: null,
          chain: 'base',
          confidence: 0.8,
          contract_address: null,
          explorer_url: 'https://basescan.org/tx/0xabc',
          failure_message: null,
          failure_reason: null,
          generated_at: '2026-06-11T00:02:00.000Z',
          pool_address: null,
          related_transactions: [
            {
              explorerUrl: 'https://basescan.org/tx/0xabc',
              hash: '0xabc',
              role: 'user',
              summary: '用户交易',
            },
            {
              explorerUrl: 'https://basescan.org/tx/0xdef',
              hash: '0xdef',
              role: 'related',
              summary: '上下文交易',
              timestamp: '  2026-06-11T00:02:00.000Z  ',
              traderAddress: '0x2222222222222222222222222222222222222222',
            },
            {
              explorerUrl: '   ',
              hash: '0xghi',
              role: 'related',
              summary: '空链接交易',
            },
          ],
          report_url: '/assets/tx-analysis-reports/txr_base_success',
          review_assignee: null,
          review_note: null,
          review_status: null,
          review_updated_at: null,
          review_updated_by: null,
          router_address: null,
          screenshot_url: null,
          status: 'success',
          target_trader_address: null,
          transaction_time: null,
          tx_hash: '0xabc',
          verdict: 'not_sandwiched',
          xxyy_pool_url: 'https://www.xxyy.io/base/0xpool',
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const reports = await store.findReports({ limit: 5 });

    expect(reports[0]?.relatedTransactions).toEqual([
      {
        explorerUrl: 'https://basescan.org/tx/0xabc',
        hash: '0xabc',
        role: 'user',
        summary: '用户交易',
      },
    ]);
  });

  it('deduplicates related transactions from Postgres report index rows by hash', async () => {
    const client = new FakePgClient();
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    client.queuedRows = [
      [
        {
          analysis_rule_version: null,
          chain: 'base',
          confidence: 0.8,
          contract_address: null,
          explorer_url: `https://basescan.org/tx/${evmTx}`,
          failure_message: null,
          failure_reason: null,
          generated_at: '2026-06-11T00:02:00.000Z',
          pool_address: null,
          related_transactions: [
            {
              explorerUrl: `https://basescan.org/tx/${evmTx.toUpperCase()}`,
              hash: evmTx.toUpperCase(),
              role: 'related',
              summary: '重复上下文交易',
            },
            {
              explorerUrl: `https://basescan.org/tx/${evmTx}`,
              hash: evmTx,
              role: 'user',
              summary: '用户交易',
            },
          ],
          report_url: '/assets/tx-analysis-reports/txr_base_success',
          review_assignee: null,
          review_note: null,
          review_status: null,
          review_updated_at: null,
          review_updated_by: null,
          router_address: null,
          screenshot_url: null,
          status: 'success',
          target_trader_address: null,
          transaction_time: null,
          tx_hash: evmTx,
          verdict: 'not_sandwiched',
          xxyy_pool_url: 'https://www.xxyy.io/base/0xpool',
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const reports = await store.findReports({ limit: 5 });

    expect(reports[0]?.relatedTransactions).toEqual([
      {
        explorerUrl: `https://basescan.org/tx/${evmTx}`,
        hash: evmTx,
        role: 'user',
        summary: '用户交易',
      },
    ]);
  });

  it('treats legacy null Postgres report review statuses as open when filtering ops queues', async () => {
    const client = new FakePgClient();
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    client.queuedRows = [
      [
        {
          analysis_rule_version: null,
          chain: 'base',
          confidence: null,
          contract_address: null,
          explorer_url: 'https://basescan.org/tx/0xabc',
          failure_message: null,
          failure_reason: null,
          generated_at: '2026-06-11T00:02:00.000Z',
          pool_address: null,
          related_transactions: null,
          report_url: '/assets/tx-analysis-reports/txr_base_legacy',
          review_assignee: null,
          review_note: null,
          review_status: null,
          review_updated_at: null,
          review_updated_by: null,
          router_address: null,
          screenshot_url: null,
          status: 'success',
          target_trader_address: null,
          transaction_time: null,
          tx_hash: evmTx,
          verdict: null,
          xxyy_pool_url: null,
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const reports = await store.findReports({
      limit: 5,
      reviewStatus: 'open',
    });

    expect(client.queries[0]?.sql).toContain("coalesce(review_status, 'open') = $1");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      reportUrl: '/assets/tx-analysis-reports/txr_base_legacy',
      txHash: evmTx,
    });
    expect(reports[0]?.review).toMatchObject({ status: 'open' });
  });

  it('caps oversized Postgres report queries to the ops page maximum', async () => {
    const client = new FakePgClient();
    const store = createPgTxAnalysisReportStore({ client });

    await store.findReports({ limit: 1000 });

    expect(client.queries[0]?.values).toEqual([100]);
  });

  it('queries Postgres EVM reports by transaction hash case-insensitively', async () => {
    const client = new FakePgClient();
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const store = createPgTxAnalysisReportStore({ client });

    await store.findReports({
      limit: 5,
      txHash: evmTx.toUpperCase(),
    });

    expect(client.queries[0]?.sql).toContain('lower(tx_hash) = lower($1)');
    expect(client.queries[0]?.values).toEqual([evmTx.toUpperCase(), 5]);
  });

  it('returns Postgres failure probe attempts from report metadata', async () => {
    const client = new FakePgClient();
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    client.queuedRows = [
      [
        {
          analysis_rule_version: null,
          chain: 'ethereum',
          confidence: null,
          contract_address: null,
          explorer_url: null,
          failure_message: 'Etherscan requires browser verification',
          failure_reason: 'browser_verification_required',
          generated_at: '2026-06-11T00:02:00.000Z',
          pool_address: null,
          probe_attempts: [
            {
              chain: 'base',
              message: 'BaseScan HTTP 503 Service Unavailable',
              reason: 'provider_unavailable',
            },
            {
              chain: 'ethereum',
              message: 'Etherscan requires browser verification',
              reason: 'browser_verification_required',
            },
          ],
          related_transactions: null,
          report_url: '/assets/tx-analysis-reports/txr_eth_failure',
          review_assignee: null,
          review_note: null,
          review_status: 'open',
          review_updated_at: null,
          review_updated_by: null,
          router_address: null,
          screenshot_url: null,
          status: 'failure',
          unsupported_chain_hint: 'testnet',
          unsupported_explorer_host: 'explorer.solana.com',
          tx_hash: evmTx,
          verdict: null,
          xxyy_pool_url: null,
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const reports = await store.findReports({ limit: 5, status: 'failure' });

    expect(client.queries[0]?.sql).toContain(
      "report_document -> 'failure' -> 'metadata' -> 'probeAttempts' as probe_attempts",
    );
    expect(client.queries[0]?.sql).toContain(
      "report_document -> 'failure' -> 'metadata' ->> 'unsupportedChainHint'",
    );
    expect(client.queries[0]?.sql).toContain(
      "report_document -> 'failure' -> 'metadata' ->> 'unsupportedExplorerHost'",
    );
    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'ethereum',
        probeAttempts: [
          {
            chain: 'base',
            message: 'BaseScan HTTP 503 Service Unavailable',
            reason: 'provider_unavailable',
          },
          {
            chain: 'ethereum',
            message: 'Etherscan requires browser verification',
            reason: 'browser_verification_required',
          },
        ],
        reason: 'browser_verification_required',
        status: 'failure',
        txHash: evmTx,
        unsupportedChainHint: 'testnet',
        unsupportedExplorerHost: 'explorer.solana.com',
      }),
    ]);
  });

  it('filters dirty Postgres failure probe attempts from report metadata', async () => {
    const client = new FakePgClient();
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    client.queuedRows = [
      [
        {
          analysis_rule_version: null,
          chain: 'unknown',
          confidence: null,
          contract_address: null,
          explorer_url: null,
          failure_message: 'Could not identify the transaction chain',
          failure_reason: 'tx_not_found',
          generated_at: '2026-06-11T00:02:00.000Z',
          pool_address: null,
          probe_attempts: [
            {
              chain: 'base',
              message: 'BaseScan did not find the transaction',
              reason: 'tx_not_found',
            },
            {
              chain: 'ethereum',
              message: '  Etherscan requires browser verification  ',
              reason: 'browser_verification_required',
            },
            {
              chain: 'bsc',
              message: '   ',
              reason: 'provider_unavailable',
            },
          ],
          related_transactions: null,
          report_url: '/assets/tx-analysis-reports/txr_unknown_failure',
          review_assignee: null,
          review_note: null,
          review_status: 'open',
          review_updated_at: null,
          review_updated_by: null,
          router_address: null,
          screenshot_url: null,
          status: 'failure',
          target_trader_address: null,
          transaction_time: null,
          tx_hash: evmTx,
          verdict: null,
          xxyy_pool_url: null,
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const reports = await store.findReports({ limit: 5, status: 'failure' });

    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'unknown',
        probeAttempts: [
          {
            chain: 'base',
            message: 'BaseScan did not find the transaction',
            reason: 'tx_not_found',
          },
        ],
        reason: 'tx_not_found',
        status: 'failure',
        txHash: evmTx,
      }),
    ]);
  });

  it('normalizes dirty Postgres failure messages from report rows', async () => {
    const client = new FakePgClient();
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    client.queuedRows = [
      [
        {
          analysis_rule_version: null,
          chain: 'base',
          confidence: null,
          contract_address: null,
          explorer_url: null,
          failure_message: '  XXYY pool not found  ',
          failure_reason: 'pool_not_found',
          generated_at: '2026-06-11T00:02:00.000Z',
          pool_address: null,
          probe_attempts: null,
          related_transactions: null,
          report_url: '/assets/tx-analysis-reports/txr_base_failure',
          review_assignee: null,
          review_note: null,
          review_status: 'open',
          review_updated_at: null,
          review_updated_by: null,
          router_address: null,
          screenshot_url: null,
          status: 'failure',
          target_trader_address: null,
          transaction_time: null,
          tx_hash: evmTx,
          verdict: null,
          xxyy_pool_url: null,
        },
        {
          analysis_rule_version: null,
          chain: 'ethereum',
          confidence: null,
          contract_address: null,
          explorer_url: null,
          failure_message: '   ',
          failure_reason: 'provider_unavailable',
          generated_at: '2026-06-11T00:01:00.000Z',
          pool_address: null,
          probe_attempts: null,
          related_transactions: null,
          report_url: '/assets/tx-analysis-reports/txr_eth_failure',
          review_assignee: null,
          review_note: null,
          review_status: 'open',
          review_updated_at: null,
          review_updated_by: null,
          router_address: null,
          screenshot_url: null,
          status: 'failure',
          target_trader_address: null,
          transaction_time: null,
          tx_hash: evmTx,
          verdict: null,
          xxyy_pool_url: null,
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const reports = await store.findReports({ limit: 5, status: 'failure' });

    expect(reports).toEqual([
      expect.objectContaining({
        chain: 'base',
        message: 'XXYY pool not found',
        reason: 'pool_not_found',
        status: 'failure',
        txHash: evmTx,
      }),
      expect.objectContaining({
        chain: 'ethereum',
        reason: 'provider_unavailable',
        status: 'failure',
        txHash: evmTx,
      }),
    ]);
    expect(reports[1]).not.toHaveProperty('message');
  });

  it('trims transaction hash filters before querying Postgres reports', async () => {
    const client = new FakePgClient();
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const store = createPgTxAnalysisReportStore({ client });

    await store.findReports({
      limit: 5,
      txHash: ` ${evmTx.toUpperCase()}\n`,
    });

    expect(client.queries[0]?.sql).toContain('lower(tx_hash) = lower($1)');
    expect(client.queries[0]?.values).toEqual([evmTx.toUpperCase(), 5]);
  });

  it('normalizes transaction explorer links before querying Postgres reports', async () => {
    const client = new FakePgClient();
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const store = createPgTxAnalysisReportStore({ client });

    await store.findReports({
      limit: 5,
      txHash: `https://basescan.org/tx/${evmTx.toUpperCase()}`,
    });

    expect(client.queries[0]?.sql).toContain('lower(tx_hash) = lower($1)');
    expect(client.queries[0]?.values).toEqual([evmTx.toUpperCase(), 5]);
  });

  it('does not normalize unsupported explorer links before querying Postgres reports', async () => {
    const client = new FakePgClient();
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const txUrl = `https://sepolia.basescan.org/tx/${evmTx}`;
    const store = createPgTxAnalysisReportStore({ client });

    await store.findReports({
      limit: 5,
      txHash: txUrl,
    });

    expect(client.queries[0]?.sql).toContain('tx_hash = $1');
    expect(client.queries[0]?.sql).not.toContain('lower(tx_hash) = lower($1)');
    expect(client.queries[0]?.values).toEqual([txUrl, 5]);
  });

  it('updates Postgres report review status for ops triage', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        {
          review_assignee: 'alice',
          review_note: '已回复用户并附上 XXYY 原页面截图。',
          review_status: 'closed',
          review_updated_at: '2026-06-11T00:05:00.000Z',
          review_updated_by: 'ops-user',
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const review = await store.updateReportReview({
      assignee: 'alice',
      id: 'txr_base_success',
      note: '已回复用户并附上 XXYY 原页面截图。',
      status: 'closed',
      updatedBy: 'ops-user',
    });

    expect(client.queries[0]?.sql).toContain('update tx_analysis_reports');
    expect(client.queries[0]?.sql).toContain('review_status = $1');
    expect(client.queries[0]?.sql).toContain('where id = $5');
    expect(client.queries[0]?.values).toEqual([
      'closed',
      '已回复用户并附上 XXYY 原页面截图。',
      'alice',
      'ops-user',
      'txr_base_success',
    ]);
    expect(review).toEqual({
      assignee: 'alice',
      note: '已回复用户并附上 XXYY 原页面截图。',
      status: 'closed',
      updatedAt: '2026-06-11T00:05:00.000Z',
      updatedBy: 'ops-user',
    });
  });

  it('normalizes Postgres report review text fields before saving', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        {
          review_assignee: 'alice',
          review_note: null,
          review_status: 'in_review',
          review_updated_at: '2026-06-11T00:05:00.000Z',
          review_updated_by: 'ops-user',
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const review = await store.updateReportReview({
      assignee: ' alice ',
      id: 'txr_base_success',
      note: '   ',
      status: 'in_review',
      updatedBy: ' ops-user ',
    });

    expect(client.queries[0]?.values).toEqual([
      'in_review',
      null,
      'alice',
      'ops-user',
      'txr_base_success',
    ]);
    expect(review).toEqual({
      assignee: 'alice',
      status: 'in_review',
      updatedAt: '2026-06-11T00:05:00.000Z',
      updatedBy: 'ops-user',
    });
  });

  it('summarizes Postgres report outcomes for ops review', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [{ total_count: 3, success_count: 1, failure_count: 2 }],
      [
        { chain: 'base', report_count: 2 },
        { chain: 'ethereum', report_count: 1 },
      ],
      [
        { reason: 'pool_not_found', report_count: 1 },
        { reason: 'timeout', report_count: 1 },
      ],
      [{ analysis_rule_version: 'sandwich-window-rules-v1', report_count: 1 }],
      [
        { report_count: 1, review_status: 'open' },
        { report_count: 1, review_status: 'in_review' },
        { report_count: 1, review_status: 'closed' },
      ],
      [
        {
          chain: 'base',
          confidence: null,
          contract_address: null,
          explorer_url: null,
          failure_message: 'Browser timeout',
          failure_reason: 'timeout',
          generated_at: '2026-06-11T00:02:00.000Z',
          pool_address: null,
          router_address: '0xRouter',
          report_url: '/assets/tx-analysis-reports/txr_timeout',
          screenshot_url: null,
          status: 'failure',
          tx_hash: '0xabc',
          verdict: null,
          xxyy_pool_url: null,
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    const summary = await store.summarizeReports({ latestLimit: 1 });

    expect(summary).toEqual({
      byChain: {
        base: 2,
        ethereum: 1,
      },
      byRuleVersion: {
        'sandwich-window-rules-v1': 1,
      },
      byReviewStatus: {
        closed: 1,
        in_review: 1,
        open: 1,
      },
      failureCount: 2,
      failureReasons: {
        pool_not_found: 1,
        timeout: 1,
      },
      latestGeneratedAt: '2026-06-11T00:02:00.000Z',
      latestReports: [
        {
          chain: 'base',
          generatedAt: '2026-06-11T00:02:00.000Z',
          message: 'Browser timeout',
          reason: 'timeout',
          reportUrl: '/assets/tx-analysis-reports/txr_timeout',
          review: {
            status: 'open',
            updatedAt: '2026-06-11T00:02:00.000Z',
          },
          routerAddress: '0xRouter',
          status: 'failure',
          txHash: '0xabc',
        },
      ],
      successCount: 1,
      totalCount: 3,
    });
    expect(client.queries[4]?.sql).toContain("coalesce(review_status, 'open') as review_status");
    expect(client.queries[4]?.sql).toContain("group by coalesce(review_status, 'open')");
    expect(client.queries[5]?.values).toEqual([1]);
    expectPgReportReviewColumnFallbacks(client.queries[5]?.sql ?? '');
  });

  it('loads a stored report document by id', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        {
          report_document: {
            generatedAt: '2026-06-11T00:00:00.000Z',
            reference: { chain: 'solana', txHash: SOLANA_TX },
            result: { txHash: SOLANA_TX, verdict: 'not_sandwiched' },
            status: 'success',
            version: 1,
          },
        },
      ],
    ];
    const store = createPgTxAnalysisReportStore({ client });

    await expect(store.getReportDocument('txr_success_1')).resolves.toMatchObject({
      reference: { chain: 'solana', txHash: SOLANA_TX },
      status: 'success',
      version: 1,
    });
    expect(client.queries[0]?.sql).toContain('select report_document');
    expect(client.queries[0]?.values).toEqual(['txr_success_1']);
  });
});
