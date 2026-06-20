import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TxAnalysisChain, TxAnalysisResult } from '@xxyy/shared';

import type { BrowserTxAnalysisReportWriter } from './browser-tx-analysis.js';
import { resolveWorkspaceCwd } from './env.js';
import type { PgClientLike } from './pgvector-store.js';
import type {
  TxAnalysisFailureMetadata,
  TxAnalysisProbeAttempt,
  TxAnalysisUnavailableReason,
} from './tx-analysis.js';
import { parseTransactionReference, type TransactionReference } from './tx-hash.js';

export interface FileTxAnalysisReportWriterOptions {
  reportBaseUrl?: string;
  reportDir?: string;
}

export interface FindTxAnalysisReportsOptions {
  chain?: TxAnalysisChain;
  limit?: number;
  reason?: TxAnalysisUnavailableReason;
  reviewAssignee?: string;
  reviewStatus?: TxAnalysisReportReviewStatus;
  status?: TxAnalysisReportStatus;
  txHash?: string;
}

export interface FindFileTxAnalysisReportsOptions extends FindTxAnalysisReportsOptions {
  reportDir?: string;
}

export type TxAnalysisReportStatus = 'failure' | 'success';

export interface SummarizeTxAnalysisReportsOptions {
  latestLimit?: number;
}

export interface SummarizeFileTxAnalysisReportsOptions extends SummarizeTxAnalysisReportsOptions {
  reportDir?: string;
}

export interface PgTxAnalysisReportStoreOptions {
  client: PgClientLike;
  reportBaseUrl?: string;
}

export interface TxAnalysisReportStore extends BrowserTxAnalysisReportWriter {
  findReports(options: FindTxAnalysisReportsOptions): Promise<TxAnalysisReportIndexEntry[]>;
  getReportDocument(id: string): Promise<TxAnalysisStoredReportDocument | undefined>;
  migrate(): Promise<void>;
  summarizeReports(options?: SummarizeTxAnalysisReportsOptions): Promise<TxAnalysisReportSummary>;
  updateReportReview(
    input: UpdateTxAnalysisReportReviewInput,
  ): Promise<TxAnalysisReportReview | undefined>;
}

export type TxAnalysisReportReviewStatus = 'closed' | 'in_review' | 'open';

export interface TxAnalysisReportReview {
  assignee?: string;
  note?: string;
  status: TxAnalysisReportReviewStatus;
  updatedAt: string;
  updatedBy?: string;
}

export interface UpdateTxAnalysisReportReviewInput {
  assignee?: string;
  id: string;
  note?: string;
  status: TxAnalysisReportReviewStatus;
  updatedBy?: string;
}

interface TxAnalysisReportIndexEntryReviewFields {
  review?: TxAnalysisReportReview;
}

export type TxAnalysisReportIndexEntry =
  | (TxAnalysisReportIndexEntryReviewFields & {
      analysisRuleVersion?: string;
      chain: TxAnalysisChain;
      contractAddress?: string;
      confidence?: number;
      explorerUrl?: string;
      generatedAt: string;
      poolAddress?: string;
      reportUrl: string;
      relatedTransactions?: TxAnalysisResult['relatedTransactions'];
      routerAddress?: string;
      screenshotUrl?: string;
      screenshotTargetRowMarked?: boolean;
      status: 'success';
      targetTradeSide?: TxAnalysisResult['targetTradeSide'];
      targetTraderAddress?: string;
      transactionTime?: string;
      txHash: string;
      verdict?: TxAnalysisResult['verdict'];
      xxyyPoolUrl?: string;
    })
  | (TxAnalysisReportIndexEntryReviewFields & {
      chain: TxAnalysisChain;
      contractAddress?: string;
      explorerUrl?: string;
      generatedAt: string;
      message?: string;
      poolAddress?: string;
      probeAttempts?: TxAnalysisProbeAttempt[];
      reason: TxAnalysisUnavailableReason;
      relatedTransactions?: TxAnalysisResult['relatedTransactions'];
      reportUrl: string;
      routerAddress?: string;
      screenshotUrl?: string;
      screenshotTargetRowMarked?: boolean;
      status: 'failure';
      targetTradeSide?: TxAnalysisResult['targetTradeSide'];
      targetTraderAddress?: string;
      transactionTime?: string;
      txHash: string;
      unsupportedChainHint?: string;
      unsupportedExplorerHost?: string;
      xxyyPoolUrl?: string;
    });

export interface TxAnalysisReportSummary {
  byChain: Partial<Record<TxAnalysisChain, number>>;
  byReviewStatus?: Partial<Record<TxAnalysisReportReviewStatus, number>>;
  byRuleVersion: Record<string, number>;
  failureCount: number;
  failureReasons: Partial<Record<TxAnalysisUnavailableReason, number>>;
  latestGeneratedAt?: string;
  latestReports: TxAnalysisReportIndexEntry[];
  successCount: number;
  totalCount: number;
}

export interface TxAnalysisReportDocument {
  generatedAt: string;
  reference: TransactionReference;
  status: 'success';
  result: TxAnalysisResult;
  version: 1;
}

export interface TxAnalysisFailureReportDocument {
  failure: {
    metadata?: TxAnalysisFailureMetadata;
    message: string;
    reason: TxAnalysisUnavailableReason;
  };
  generatedAt: string;
  reference: TransactionReference;
  status: 'failure';
  version: 1;
}

type TxAnalysisStoredReportDocumentReviewFields = {
  review?: TxAnalysisReportReview;
};

export type TxAnalysisStoredReportDocument =
  | (TxAnalysisFailureReportDocument & TxAnalysisStoredReportDocumentReviewFields)
  | (TxAnalysisReportDocument & TxAnalysisStoredReportDocumentReviewFields);

export interface GetFileTxAnalysisReportDocumentOptions {
  id: string;
  reportDir?: string;
}

export interface UpdateFileTxAnalysisReportReviewInput extends UpdateTxAnalysisReportReviewInput {
  reportDir?: string;
}

const DEFAULT_REPORT_BASE_URL = '/assets';
const DEFAULT_PG_REPORT_BASE_URL = '/assets/tx-analysis-reports';
const EVM_TX_HASH_PATTERN = /^0x[a-f0-9]{64}$/iu;
const MAX_REPORT_QUERY_LIMIT = 100;
const REPORT_INDEX_FILE_NAME = 'tx-analysis-report-index.jsonl';

interface InsertPgReportBaseInput {
  chain: TxAnalysisChain;
  contractAddress?: string;
  explorerUrl?: string;
  generatedAt: string;
  id: string;
  poolAddress?: string;
  reportBaseUrl: string;
  reportDocument: TxAnalysisStoredReportDocument;
  routerAddress?: string;
  screenshotUrl?: string;
  screenshotTargetRowMarked?: boolean;
  targetTraderAddress?: string;
  transactionTime?: string;
  txHash: string;
  xxyyPoolUrl?: string;
}

type InsertPgReportInput =
  | (InsertPgReportBaseInput & {
      confidence?: number;
      status: 'success';
      verdict?: TxAnalysisResult['verdict'];
    })
  | (InsertPgReportBaseInput & {
      message?: string;
      reason: TxAnalysisUnavailableReason;
      status: 'failure';
    });

interface PgTxAnalysisReportRow {
  analysis_rule_version?: string | null;
  chain: TxAnalysisChain;
  confidence: number | null;
  contract_address: string | null;
  explorer_url: string | null;
  failure_message: string | null;
  failure_reason: TxAnalysisUnavailableReason | null;
  generated_at: Date | string;
  pool_address: string | null;
  probe_attempts?: unknown;
  related_transactions?: unknown;
  report_url: string;
  review_assignee?: string | null;
  review_note?: string | null;
  review_status?: TxAnalysisReportReviewStatus | null;
  review_updated_at?: Date | string | null;
  review_updated_by?: string | null;
  router_address: string | null;
  screenshot_target_row_marked?: boolean | null;
  screenshot_url: string | null;
  status: TxAnalysisReportStatus;
  target_trade_side?: string | null;
  target_trader_address: string | null;
  transaction_time: string | null;
  tx_hash: string;
  unsupported_chain_hint?: string | null;
  unsupported_explorer_host?: string | null;
  verdict: TxAnalysisResult['verdict'] | null;
  xxyy_pool_url: string | null;
}

interface PgTxAnalysisReportReviewRow {
  review_assignee: string | null;
  review_note: string | null;
  review_status: TxAnalysisReportReviewStatus;
  review_updated_at: Date | string;
  review_updated_by: string | null;
}

export function createFileTxAnalysisReportWriter(
  options: FileTxAnalysisReportWriterOptions = {},
): BrowserTxAnalysisReportWriter {
  return {
    async writeFailureReport(input) {
      const reportDir = resolveReportDir(options);
      await mkdir(reportDir, { recursive: true });

      const generatedAt = new Date().toISOString();
      const message = normalizeFailureReportMessage(input.message);
      const metadata = normalizeFailureMetadataForReport(input.metadata);
      const report: TxAnalysisFailureReportDocument = {
        failure: {
          message,
          ...(metadata === undefined ? {} : { metadata }),
          reason: input.reason,
        },
        generatedAt,
        reference: input.reference,
        status: 'failure',
        version: 1,
      };
      const fileName = createFailureReportFileName(input.reference, input.reason, generatedAt);
      await writeFile(path.join(reportDir, fileName), `${JSON.stringify(report, null, 2)}\n`);

      const reportUrl = `${normalizeBaseUrl(options.reportBaseUrl)}/${fileName}`;
      await appendReportIndexEntry(reportDir, {
        chain: input.reference.chain,
        ...(metadata?.contractAddress === undefined
          ? {}
          : { contractAddress: metadata.contractAddress }),
        ...(metadata?.explorerUrl === undefined ? {} : { explorerUrl: metadata.explorerUrl }),
        generatedAt,
        message,
        ...(metadata?.poolAddress === undefined ? {} : { poolAddress: metadata.poolAddress }),
        ...(metadata?.probeAttempts === undefined ? {} : { probeAttempts: metadata.probeAttempts }),
        reason: input.reason,
        ...(metadata?.relatedTransactions === undefined || metadata.relatedTransactions.length === 0
          ? {}
          : { relatedTransactions: metadata.relatedTransactions }),
        reportUrl,
        ...(metadata?.routerAddress === undefined ? {} : { routerAddress: metadata.routerAddress }),
        ...(metadata?.screenshotUrl === undefined ? {} : { screenshotUrl: metadata.screenshotUrl }),
        ...(metadata?.screenshotTargetRowMarked === undefined
          ? {}
          : { screenshotTargetRowMarked: metadata.screenshotTargetRowMarked }),
        status: 'failure',
        ...(metadata?.targetTradeSide === undefined
          ? {}
          : { targetTradeSide: metadata.targetTradeSide }),
        ...(metadata?.targetTraderAddress === undefined
          ? {}
          : { targetTraderAddress: metadata.targetTraderAddress }),
        ...(metadata?.transactionTime === undefined
          ? {}
          : { transactionTime: metadata.transactionTime }),
        txHash: input.reference.txHash,
        ...(metadata?.unsupportedChainHint === undefined
          ? {}
          : { unsupportedChainHint: metadata.unsupportedChainHint }),
        ...(metadata?.unsupportedExplorerHost === undefined
          ? {}
          : { unsupportedExplorerHost: metadata.unsupportedExplorerHost }),
        ...(metadata?.xxyyPoolUrl === undefined ? {} : { xxyyPoolUrl: metadata.xxyyPoolUrl }),
      });

      return { reportUrl };
    },
    async writeReport(input) {
      const reportDir = resolveReportDir(options);
      await mkdir(reportDir, { recursive: true });

      const result = normalizeReportResultRelatedTransactions(input.result);
      const report: TxAnalysisReportDocument = {
        generatedAt: new Date().toISOString(),
        reference: input.reference,
        result,
        status: 'success',
        version: 1,
      };
      const fileName = createReportFileName(input.reference, result);
      await writeFile(path.join(reportDir, fileName), `${JSON.stringify(report, null, 2)}\n`);

      const reportUrl = `${normalizeBaseUrl(options.reportBaseUrl)}/${fileName}`;
      await appendReportIndexEntry(reportDir, {
        ...(result.analysisRuleVersion === undefined
          ? {}
          : { analysisRuleVersion: result.analysisRuleVersion }),
        chain: input.reference.chain,
        ...(result.contractAddress === undefined
          ? {}
          : { contractAddress: result.contractAddress }),
        confidence: result.confidence,
        ...(result.explorerUrl === undefined ? {} : { explorerUrl: result.explorerUrl }),
        generatedAt: report.generatedAt,
        ...(result.poolAddress === undefined ? {} : { poolAddress: result.poolAddress }),
        reportUrl,
        ...(result.relatedTransactions.length === 0
          ? {}
          : { relatedTransactions: result.relatedTransactions }),
        ...(result.routerAddress === undefined ? {} : { routerAddress: result.routerAddress }),
        ...(result.screenshotUrl === undefined ? {} : { screenshotUrl: result.screenshotUrl }),
        ...(result.screenshotTargetRowMarked === undefined
          ? {}
          : { screenshotTargetRowMarked: result.screenshotTargetRowMarked }),
        status: 'success',
        ...(result.targetTradeSide === undefined
          ? {}
          : { targetTradeSide: result.targetTradeSide }),
        ...(result.targetTraderAddress === undefined
          ? {}
          : { targetTraderAddress: result.targetTraderAddress }),
        ...(result.transactionTime === undefined
          ? {}
          : { transactionTime: result.transactionTime }),
        txHash: input.reference.txHash,
        verdict: result.verdict,
        ...(result.xxyyPoolUrl === undefined ? {} : { xxyyPoolUrl: result.xxyyPoolUrl }),
      });

      return { reportUrl };
    },
  };
}

export function createPgTxAnalysisReportStore(
  options: PgTxAnalysisReportStoreOptions,
): TxAnalysisReportStore {
  return {
    async findReports(input: FindTxAnalysisReportsOptions): Promise<TxAnalysisReportIndexEntry[]> {
      return findPgTxAnalysisReports(options.client, input);
    },

    async getReportDocument(id: string): Promise<TxAnalysisStoredReportDocument | undefined> {
      return getPgTxAnalysisReportDocument(options.client, id);
    },

    async migrate(): Promise<void> {
      await migratePgTxAnalysisReportStore(options.client);
    },

    async summarizeReports(
      input: SummarizeTxAnalysisReportsOptions = {},
    ): Promise<TxAnalysisReportSummary> {
      return summarizePgTxAnalysisReports(options.client, input);
    },

    async updateReportReview(input) {
      return updatePgTxAnalysisReportReview(options.client, input);
    },

    async writeFailureReport(input) {
      const generatedAt = new Date().toISOString();
      const message = normalizeFailureReportMessage(input.message);
      const metadata = normalizeFailureMetadataForReport(input.metadata);
      const report: TxAnalysisFailureReportDocument = {
        failure: {
          message,
          ...(metadata === undefined ? {} : { metadata }),
          reason: input.reason,
        },
        generatedAt,
        reference: input.reference,
        status: 'failure',
        version: 1,
      };
      const id = createPgReportId(input.reference, 'failure', generatedAt, input.reason);
      const reportUrl = await insertPgReport(options.client, {
        chain: input.reference.chain,
        ...(metadata?.contractAddress === undefined
          ? {}
          : { contractAddress: metadata.contractAddress }),
        ...(metadata?.explorerUrl === undefined ? {} : { explorerUrl: metadata.explorerUrl }),
        generatedAt,
        id,
        message,
        ...(metadata?.poolAddress === undefined ? {} : { poolAddress: metadata.poolAddress }),
        reason: input.reason,
        reportBaseUrl: normalizeBaseUrl(options.reportBaseUrl ?? DEFAULT_PG_REPORT_BASE_URL),
        reportDocument: report,
        ...(metadata?.routerAddress === undefined ? {} : { routerAddress: metadata.routerAddress }),
        ...(metadata?.screenshotUrl === undefined ? {} : { screenshotUrl: metadata.screenshotUrl }),
        ...(metadata?.screenshotTargetRowMarked === undefined
          ? {}
          : { screenshotTargetRowMarked: metadata.screenshotTargetRowMarked }),
        status: 'failure',
        ...(metadata?.targetTraderAddress === undefined
          ? {}
          : { targetTraderAddress: metadata.targetTraderAddress }),
        ...(metadata?.transactionTime === undefined
          ? {}
          : { transactionTime: metadata.transactionTime }),
        txHash: input.reference.txHash,
        ...(metadata?.xxyyPoolUrl === undefined ? {} : { xxyyPoolUrl: metadata.xxyyPoolUrl }),
      });

      return { reportUrl };
    },

    async writeReport(input) {
      const generatedAt = new Date().toISOString();
      const result = normalizeReportResultRelatedTransactions(input.result);
      const report: TxAnalysisReportDocument = {
        generatedAt,
        reference: input.reference,
        result,
        status: 'success',
        version: 1,
      };
      const id = createPgReportId(input.reference, 'success', generatedAt);
      const reportUrl = await insertPgReport(options.client, {
        chain: input.reference.chain,
        ...(result.contractAddress === undefined
          ? {}
          : { contractAddress: result.contractAddress }),
        confidence: result.confidence,
        ...(result.explorerUrl === undefined ? {} : { explorerUrl: result.explorerUrl }),
        generatedAt,
        id,
        ...(result.poolAddress === undefined ? {} : { poolAddress: result.poolAddress }),
        reportBaseUrl: normalizeBaseUrl(options.reportBaseUrl ?? DEFAULT_PG_REPORT_BASE_URL),
        reportDocument: report,
        ...(result.routerAddress === undefined ? {} : { routerAddress: result.routerAddress }),
        ...(result.screenshotUrl === undefined ? {} : { screenshotUrl: result.screenshotUrl }),
        ...(result.screenshotTargetRowMarked === undefined
          ? {}
          : { screenshotTargetRowMarked: result.screenshotTargetRowMarked }),
        status: 'success',
        ...(result.targetTraderAddress === undefined
          ? {}
          : { targetTraderAddress: result.targetTraderAddress }),
        ...(result.transactionTime === undefined
          ? {}
          : { transactionTime: result.transactionTime }),
        txHash: input.reference.txHash,
        verdict: result.verdict,
        ...(result.xxyyPoolUrl === undefined ? {} : { xxyyPoolUrl: result.xxyyPoolUrl }),
      });

      return { reportUrl };
    },
  };
}

export async function migratePgTxAnalysisReportStore(client: PgClientLike): Promise<void> {
  await client.query(`
    create table if not exists tx_analysis_reports (
      id text primary key,
      tx_hash text not null,
      chain text not null check (chain in ('solana', 'base', 'ethereum', 'bsc', 'unknown')),
      status text not null check (status in ('success', 'failure')),
      generated_at timestamptz not null,
      report_url text not null,
      screenshot_url text,
      explorer_url text,
      xxyy_pool_url text,
      pool_address text,
      router_address text,
      contract_address text,
      target_trader_address text,
      transaction_time text,
      verdict text check (verdict in ('sandwiched', 'not_sandwiched', 'inconclusive')),
      confidence double precision,
      failure_reason text check (
        failure_reason in (
          'not_configured',
          'provider_unavailable',
          'invalid_reference',
          'unsupported_chain',
          'browser_verification_required',
          'tx_not_found',
          'tx_failed',
          'tx_pending',
          'pool_not_found',
          'target_trade_not_found',
          'screenshot_unavailable',
          'timeout'
        )
      ),
      failure_message text,
      review_status text not null default 'open' check (review_status in ('open', 'in_review', 'closed')),
      review_note text,
      review_assignee text,
      review_updated_at timestamptz,
      review_updated_by text,
      report_document jsonb not null,
      created_at timestamptz not null default now()
    )
  `);
  await client.query(`
    alter table tx_analysis_reports
      add column if not exists target_trader_address text
  `);
  await client.query(`
    alter table tx_analysis_reports
      add column if not exists transaction_time text
  `);
  await client.query(`
    alter table tx_analysis_reports
      add column if not exists router_address text
  `);
  await client.query(`
    alter table tx_analysis_reports
      add column if not exists review_status text not null default 'open'
        check (review_status in ('open', 'in_review', 'closed'))
  `);
  await client.query(`
    alter table tx_analysis_reports
      add column if not exists review_note text
  `);
  await client.query(`
    alter table tx_analysis_reports
      add column if not exists review_assignee text
  `);
  await client.query(`
    alter table tx_analysis_reports
      add column if not exists review_updated_at timestamptz
  `);
  await client.query(`
    alter table tx_analysis_reports
      add column if not exists review_updated_by text
  `);
  await client.query(`
    alter table tx_analysis_reports
      drop constraint if exists tx_analysis_reports_failure_reason_check
  `);
  await client.query(`
    alter table tx_analysis_reports
      add constraint tx_analysis_reports_failure_reason_check check (
        failure_reason in (
          'not_configured',
          'provider_unavailable',
          'invalid_reference',
          'unsupported_chain',
          'browser_verification_required',
          'tx_not_found',
          'tx_failed',
          'tx_pending',
          'pool_not_found',
          'target_trade_not_found',
          'screenshot_unavailable',
          'timeout'
        )
      )
  `);
  await client.query(`
    create index if not exists tx_analysis_reports_tx_hash_idx
      on tx_analysis_reports (tx_hash, generated_at desc)
  `);
  await client.query(`
    create index if not exists tx_analysis_reports_chain_idx
      on tx_analysis_reports (chain, generated_at desc)
  `);
  await client.query(`
    create index if not exists tx_analysis_reports_status_idx
      on tx_analysis_reports (status, generated_at desc)
  `);
  await client.query(`
    create index if not exists tx_analysis_reports_failure_reason_idx
      on tx_analysis_reports (failure_reason, generated_at desc)
      where failure_reason is not null
  `);
  await client.query(`
    create index if not exists tx_analysis_reports_generated_at_idx
      on tx_analysis_reports (generated_at desc)
  `);
}

export async function findFileTxAnalysisReports(
  options: FindFileTxAnalysisReportsOptions,
): Promise<TxAnalysisReportIndexEntry[]> {
  const entries = await readReportIndexEntries(options);
  const limit = normalizeReportLimit(options.limit, 20);
  const reviewAssignee = normalizedReportAssignee(options.reviewAssignee);

  return entries
    .filter(
      (entry) =>
        options.txHash === undefined || transactionHashesMatch(entry.txHash, options.txHash),
    )
    .filter((entry) => options.chain === undefined || entry.chain === options.chain)
    .filter((entry) => options.status === undefined || entry.status === options.status)
    .filter(
      (entry) =>
        options.reviewStatus === undefined ||
        reviewStatusForSummary(entry) === options.reviewStatus,
    )
    .filter(
      (entry) =>
        reviewAssignee === undefined ||
        normalizedReportAssignee(entry.review?.assignee) === reviewAssignee,
    )
    .filter(
      (entry) =>
        options.reason === undefined ||
        (entry.status === 'failure' && entry.reason === options.reason),
    )
    .sort(compareTxAnalysisReportsByGeneratedAtDesc)
    .slice(0, limit);
}

function compareTxAnalysisReportsByGeneratedAtDesc(
  left: TxAnalysisReportIndexEntry,
  right: TxAnalysisReportIndexEntry,
): number {
  const leftTime = Date.parse(left.generatedAt);
  const rightTime = Date.parse(right.generatedAt);
  const leftHasValidTime = Number.isFinite(leftTime);
  const rightHasValidTime = Number.isFinite(rightTime);
  if (leftHasValidTime && rightHasValidTime) {
    return rightTime - leftTime;
  }
  if (leftHasValidTime) {
    return -1;
  }
  if (rightHasValidTime) {
    return 1;
  }

  return 0;
}

function transactionHashesMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeTransactionHashForLookup(left);
  const normalizedRight = normalizeTransactionHashForLookup(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return false;
  }

  if (isEvmTransactionHash(normalizedLeft) && isEvmTransactionHash(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

function isEvmTransactionHash(value: string): boolean {
  return EVM_TX_HASH_PATTERN.test(normalizeTransactionHashForLookup(value));
}

function normalizeTransactionHashForLookup(value: string): string {
  const normalized = value.trim();
  const reference = parseTransactionReference(normalized);
  if (
    reference === undefined ||
    reference.unsupportedExplorerHost !== undefined ||
    reference.unsupportedChainHint !== undefined
  ) {
    return normalized;
  }

  return reference.txHash;
}

function normalizeReportLimit(limit: number | undefined, defaultLimit: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return defaultLimit;
  }

  return Math.min(MAX_REPORT_QUERY_LIMIT, Math.floor(limit));
}

function normalizeReviewAssigneeForLookup(value: string): string {
  return value.trim();
}

function normalizedReportAssignee(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = normalizeReviewAssigneeForLookup(value).toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

async function findPgTxAnalysisReports(
  client: PgClientLike,
  options: FindTxAnalysisReportsOptions,
): Promise<TxAnalysisReportIndexEntry[]> {
  const limit = normalizeReportLimit(options.limit, 20);
  const values: unknown[] = [];
  const where: string[] = [];
  if (options.txHash !== undefined) {
    const txHash = normalizeTransactionHashForLookup(options.txHash);
    values.push(txHash);
    where.push(
      isEvmTransactionHash(txHash)
        ? `lower(tx_hash) = lower($${values.length})`
        : `tx_hash = $${values.length}`,
    );
  }
  if (options.chain !== undefined) {
    values.push(options.chain);
    where.push(`chain = $${values.length}`);
  }
  if (options.status !== undefined) {
    values.push(options.status);
    where.push(`status = $${values.length}`);
  }
  if (options.reviewStatus !== undefined) {
    values.push(options.reviewStatus);
    where.push(`coalesce(review_status, 'open') = $${values.length}`);
  }
  const reviewAssignee = normalizedReportAssignee(options.reviewAssignee);
  if (reviewAssignee !== undefined) {
    values.push(reviewAssignee);
    where.push(`lower(review_assignee) = lower($${values.length})`);
  }
  if (options.reason !== undefined) {
    values.push(options.reason);
    where.push(`failure_reason = $${values.length}`);
  }
  values.push(limit);

  const result = await client.query<PgTxAnalysisReportRow>(
    `
    select
      report_document -> 'result' ->> 'analysisRuleVersion' as analysis_rule_version,
      chain,
      confidence,
      coalesce(
        contract_address,
        report_document -> 'result' ->> 'contractAddress',
        report_document -> 'failure' -> 'metadata' ->> 'contractAddress'
      ) as contract_address,
      coalesce(
        explorer_url,
        report_document -> 'result' ->> 'explorerUrl',
        report_document -> 'failure' -> 'metadata' ->> 'explorerUrl'
      ) as explorer_url,
      failure_message,
      failure_reason,
      generated_at,
      coalesce(
        pool_address,
        report_document -> 'result' ->> 'poolAddress',
        report_document -> 'failure' -> 'metadata' ->> 'poolAddress'
      ) as pool_address,
      coalesce(report_document -> 'result' -> 'relatedTransactions', report_document -> 'failure' -> 'metadata' -> 'relatedTransactions') as related_transactions,
      report_document -> 'failure' -> 'metadata' -> 'probeAttempts' as probe_attempts,
      report_url,
      review_assignee,
      review_note,
      review_status,
      review_updated_at,
      review_updated_by,
      coalesce(
        router_address,
        report_document -> 'result' ->> 'routerAddress',
        report_document -> 'failure' -> 'metadata' ->> 'routerAddress'
      ) as router_address,
      coalesce(
        screenshot_url,
        report_document -> 'result' ->> 'screenshotUrl',
        report_document -> 'failure' -> 'metadata' ->> 'screenshotUrl'
        ) as screenshot_url,
      case coalesce(
        report_document -> 'result' ->> 'screenshotTargetRowMarked',
        report_document -> 'failure' -> 'metadata' ->> 'screenshotTargetRowMarked'
      )
        when 'true' then true
        when 'false' then false
        else null
      end as screenshot_target_row_marked,
      status,
      coalesce(
        report_document -> 'result' ->> 'targetTradeSide',
        report_document -> 'failure' -> 'metadata' ->> 'targetTradeSide'
      ) as target_trade_side,
      coalesce(
        target_trader_address,
        report_document -> 'result' ->> 'targetTraderAddress',
        report_document -> 'failure' -> 'metadata' ->> 'targetTraderAddress'
      ) as target_trader_address,
      coalesce(
        transaction_time,
        report_document -> 'result' ->> 'transactionTime',
        report_document -> 'failure' -> 'metadata' ->> 'transactionTime'
      ) as transaction_time,
      tx_hash,
      report_document -> 'failure' -> 'metadata' ->> 'unsupportedChainHint' as unsupported_chain_hint,
      report_document -> 'failure' -> 'metadata' ->> 'unsupportedExplorerHost' as unsupported_explorer_host,
      verdict,
      coalesce(
        xxyy_pool_url,
        report_document -> 'result' ->> 'xxyyPoolUrl',
        report_document -> 'failure' -> 'metadata' ->> 'xxyyPoolUrl'
      ) as xxyy_pool_url
    from tx_analysis_reports
    ${where.length === 0 ? '' : `where ${where.join(' and ')}`}
    order by generated_at desc
    limit $${values.length}
    `,
    values,
  );

  return result.rows.map(pgReportRowToIndexEntry);
}

export async function summarizeFileTxAnalysisReports(
  options: SummarizeFileTxAnalysisReportsOptions = {},
): Promise<TxAnalysisReportSummary> {
  const entries = await readReportIndexEntries(options);
  const sortedEntries = [...entries].sort(compareTxAnalysisReportsByGeneratedAtDesc);
  const latestLimit =
    options.latestLimit === undefined ? 10 : normalizeReportLimit(options.latestLimit, 10);
  const byReviewStatus: Partial<Record<TxAnalysisReportReviewStatus, number>> = {};
  const summary: TxAnalysisReportSummary = {
    byChain: {},
    byReviewStatus,
    byRuleVersion: {},
    failureCount: 0,
    failureReasons: {},
    latestReports: sortedEntries.slice(0, latestLimit),
    successCount: 0,
    totalCount: entries.length,
  };

  for (const entry of entries) {
    summary.byChain[entry.chain] = (summary.byChain[entry.chain] ?? 0) + 1;
    const reviewStatus = reviewStatusForSummary(entry);
    byReviewStatus[reviewStatus] = (byReviewStatus[reviewStatus] ?? 0) + 1;
    if (entry.status === 'success') {
      summary.successCount += 1;
      if (entry.analysisRuleVersion !== undefined) {
        summary.byRuleVersion[entry.analysisRuleVersion] =
          (summary.byRuleVersion[entry.analysisRuleVersion] ?? 0) + 1;
      }
    } else {
      summary.failureCount += 1;
      summary.failureReasons[entry.reason] = (summary.failureReasons[entry.reason] ?? 0) + 1;
    }
  }

  if (sortedEntries[0] !== undefined) {
    summary.latestGeneratedAt = sortedEntries[0].generatedAt;
  }

  return summary;
}

export async function getFileTxAnalysisReportDocument(
  options: GetFileTxAnalysisReportDocumentOptions,
): Promise<TxAnalysisStoredReportDocument | undefined> {
  const reportDir = resolveReportDir(options);
  const reportFileName = normalizeFileReportId(options.id);
  if (reportFileName === undefined) {
    return undefined;
  }

  const reportText = await readFile(path.join(reportDir, reportFileName), 'utf8').catch(
    (error: unknown) => {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    },
  );
  if (reportText === undefined) {
    return undefined;
  }

  return parseFileReportDocument(reportText);
}

export async function updateFileTxAnalysisReportReview(
  input: UpdateFileTxAnalysisReportReviewInput,
): Promise<TxAnalysisReportReview | undefined> {
  const reportDir = resolveReportDir(input);
  const reportFileName = normalizeFileReportId(input.id);
  if (reportFileName === undefined) {
    return undefined;
  }

  const entries = await readReportIndexEntries({ reportDir });
  const entryIndex = entries.findIndex(
    (entry) => reportFileNameFromUrl(entry.reportUrl) === reportFileName,
  );
  if (entryIndex < 0) {
    return undefined;
  }

  const review = createReportReview(input);
  const currentEntry = entries[entryIndex];
  if (currentEntry === undefined) {
    return undefined;
  }

  entries[entryIndex] = {
    ...currentEntry,
    review,
  };
  await writeReportIndexEntries(reportDir, entries);
  await updateFileReportDocumentReview(reportDir, reportFileName, review);

  return review;
}

async function summarizePgTxAnalysisReports(
  client: PgClientLike,
  options: SummarizeTxAnalysisReportsOptions = {},
): Promise<TxAnalysisReportSummary> {
  const latestLimit =
    options.latestLimit === undefined ? 10 : normalizeReportLimit(options.latestLimit, 10);
  const [
    totals,
    byChainRows,
    failureReasonRows,
    byRuleVersionRows,
    byReviewStatusRows,
    latestRows,
  ] = await Promise.all([
    client.query<{
      failure_count: number | string;
      success_count: number | string;
      total_count: number | string;
    }>(`
      select
        count(*)::integer as total_count,
        count(*) filter (where status = 'success')::integer as success_count,
        count(*) filter (where status = 'failure')::integer as failure_count
      from tx_analysis_reports
    `),
    client.query<{ chain: TxAnalysisChain; report_count: number | string }>(`
      select chain, count(*)::integer as report_count
      from tx_analysis_reports
      group by chain
    `),
    client.query<{ reason: TxAnalysisUnavailableReason; report_count: number | string }>(`
      select failure_reason as reason, count(*)::integer as report_count
      from tx_analysis_reports
      where failure_reason is not null
      group by failure_reason
    `),
    client.query<{ analysis_rule_version: string; report_count: number | string }>(`
      select
        report_document -> 'result' ->> 'analysisRuleVersion' as analysis_rule_version,
        count(*)::integer as report_count
      from tx_analysis_reports
      where status = 'success'
        and report_document -> 'result' ->> 'analysisRuleVersion' is not null
      group by analysis_rule_version
    `),
    client.query<{
      report_count: number | string;
      review_status: TxAnalysisReportReviewStatus;
    }>(`
      select coalesce(review_status, 'open') as review_status, count(*)::integer as report_count
      from tx_analysis_reports
      group by coalesce(review_status, 'open')
    `),
    client.query<PgTxAnalysisReportRow>(
      `
      select
        report_document -> 'result' ->> 'analysisRuleVersion' as analysis_rule_version,
        chain,
        confidence,
        coalesce(
          contract_address,
          report_document -> 'result' ->> 'contractAddress',
          report_document -> 'failure' -> 'metadata' ->> 'contractAddress'
        ) as contract_address,
        coalesce(
          explorer_url,
          report_document -> 'result' ->> 'explorerUrl',
          report_document -> 'failure' -> 'metadata' ->> 'explorerUrl'
        ) as explorer_url,
        failure_message,
        failure_reason,
        generated_at,
        coalesce(
          pool_address,
          report_document -> 'result' ->> 'poolAddress',
          report_document -> 'failure' -> 'metadata' ->> 'poolAddress'
        ) as pool_address,
        coalesce(report_document -> 'result' -> 'relatedTransactions', report_document -> 'failure' -> 'metadata' -> 'relatedTransactions') as related_transactions,
        report_document -> 'failure' -> 'metadata' -> 'probeAttempts' as probe_attempts,
        report_url,
        review_assignee,
        review_note,
        review_status,
        review_updated_at,
        review_updated_by,
        coalesce(
          router_address,
          report_document -> 'result' ->> 'routerAddress',
          report_document -> 'failure' -> 'metadata' ->> 'routerAddress'
        ) as router_address,
        coalesce(
          screenshot_url,
          report_document -> 'result' ->> 'screenshotUrl',
          report_document -> 'failure' -> 'metadata' ->> 'screenshotUrl'
        ) as screenshot_url,
        case coalesce(
          report_document -> 'result' ->> 'screenshotTargetRowMarked',
          report_document -> 'failure' -> 'metadata' ->> 'screenshotTargetRowMarked'
        )
          when 'true' then true
          when 'false' then false
          else null
        end as screenshot_target_row_marked,
        status,
        coalesce(
          report_document -> 'result' ->> 'targetTradeSide',
          report_document -> 'failure' -> 'metadata' ->> 'targetTradeSide'
        ) as target_trade_side,
        coalesce(
          target_trader_address,
          report_document -> 'result' ->> 'targetTraderAddress',
          report_document -> 'failure' -> 'metadata' ->> 'targetTraderAddress'
        ) as target_trader_address,
        coalesce(
          transaction_time,
          report_document -> 'result' ->> 'transactionTime',
          report_document -> 'failure' -> 'metadata' ->> 'transactionTime'
        ) as transaction_time,
        tx_hash,
        report_document -> 'failure' -> 'metadata' ->> 'unsupportedChainHint' as unsupported_chain_hint,
        report_document -> 'failure' -> 'metadata' ->> 'unsupportedExplorerHost' as unsupported_explorer_host,
        verdict,
        coalesce(
          xxyy_pool_url,
          report_document -> 'result' ->> 'xxyyPoolUrl',
          report_document -> 'failure' -> 'metadata' ->> 'xxyyPoolUrl'
        ) as xxyy_pool_url
      from tx_analysis_reports
      order by generated_at desc
      limit $1
      `,
      [latestLimit],
    ),
  ]);
  const totalRow = totals.rows[0];
  const latestReports = latestRows.rows.map(pgReportRowToIndexEntry);

  return {
    byChain: Object.fromEntries(
      byChainRows.rows.map((row) => [row.chain, Number(row.report_count)]),
    ),
    byReviewStatus: Object.fromEntries(
      byReviewStatusRows.rows.map((row) => [row.review_status, Number(row.report_count)]),
    ),
    byRuleVersion: Object.fromEntries(
      byRuleVersionRows.rows.map((row) => [row.analysis_rule_version, Number(row.report_count)]),
    ),
    failureCount: totalRow === undefined ? 0 : Number(totalRow.failure_count),
    failureReasons: Object.fromEntries(
      failureReasonRows.rows.map((row) => [row.reason, Number(row.report_count)]),
    ),
    ...(latestReports[0] === undefined ? {} : { latestGeneratedAt: latestReports[0].generatedAt }),
    latestReports,
    successCount: totalRow === undefined ? 0 : Number(totalRow.success_count),
    totalCount: totalRow === undefined ? 0 : Number(totalRow.total_count),
  };
}

function reviewStatusForSummary(entry: TxAnalysisReportIndexEntry): TxAnalysisReportReviewStatus {
  const status = entry.review?.status;
  return status === 'closed' || status === 'in_review' || status === 'open' ? status : 'open';
}

async function insertPgReport(client: PgClientLike, input: InsertPgReportInput): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
    insert into tx_analysis_reports (
      id,
      tx_hash,
      chain,
      status,
      generated_at,
      report_url,
      screenshot_url,
      explorer_url,
      xxyy_pool_url,
      pool_address,
      router_address,
      contract_address,
      target_trader_address,
      transaction_time,
      verdict,
      confidence,
      failure_reason,
      failure_message,
      screenshot_target_row_marked,
      report_document
    )
    values (
      $1,
      $2,
      $3,
      $4,
      $5::timestamptz,
      $6 || '/' || $1,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15,
      $16,
      $17,
      $18,
      $19,
      $20::jsonb
    )
    returning id
    `,
    [
      input.id,
      input.txHash,
      input.chain,
      input.status,
      input.generatedAt,
      input.reportBaseUrl,
      input.screenshotUrl ?? null,
      input.explorerUrl ?? null,
      input.xxyyPoolUrl ?? null,
      input.poolAddress ?? null,
      input.routerAddress ?? null,
      input.contractAddress ?? null,
      input.targetTraderAddress ?? null,
      input.transactionTime ?? null,
      input.status === 'success' ? (input.verdict ?? null) : null,
      input.status === 'success' ? (input.confidence ?? null) : null,
      input.status === 'failure' ? input.reason : null,
      input.status === 'failure' ? (input.message ?? null) : null,
      input.screenshotTargetRowMarked ?? null,
      JSON.stringify(input.reportDocument),
    ],
  );
  const insertedId = result.rows[0]?.id ?? input.id;
  return `${input.reportBaseUrl}/${insertedId}`;
}

async function getPgTxAnalysisReportDocument(
  client: PgClientLike,
  id: string,
): Promise<TxAnalysisStoredReportDocument | undefined> {
  const result = await client.query<{ report_document: TxAnalysisStoredReportDocument }>(
    `
    select report_document
    from tx_analysis_reports
    where id = $1
    `,
    [id],
  );

  return result.rows[0]?.report_document;
}

async function updatePgTxAnalysisReportReview(
  client: PgClientLike,
  input: UpdateTxAnalysisReportReviewInput,
): Promise<TxAnalysisReportReview | undefined> {
  const assignee = normalizeOptionalReviewText(input.assignee);
  const note = normalizeOptionalReviewText(input.note);
  const updatedBy = normalizeOptionalReviewText(input.updatedBy);
  const result = await client.query<PgTxAnalysisReportReviewRow>(
    `
    update tx_analysis_reports
    set
      review_status = $1,
      review_note = $2,
      review_assignee = $3,
      review_updated_by = $4,
      review_updated_at = now()
    where id = $5
    returning
      review_assignee,
      review_note,
      review_status,
      review_updated_at,
      review_updated_by
    `,
    [input.status, note ?? null, assignee ?? null, updatedBy ?? null, input.id],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : pgReportReviewRowToReview(row);
}

function normalizeOptionalReviewText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function createReportReview(input: UpdateTxAnalysisReportReviewInput): TxAnalysisReportReview {
  const assignee = normalizeOptionalReviewText(input.assignee);
  const note = normalizeOptionalReviewText(input.note);
  const updatedBy = normalizeOptionalReviewText(input.updatedBy);

  return {
    ...(assignee === undefined ? {} : { assignee }),
    ...(note === undefined ? {} : { note }),
    status: input.status,
    updatedAt: new Date().toISOString(),
    ...(updatedBy === undefined ? {} : { updatedBy }),
  };
}

function pgReportRowToIndexEntry(row: PgTxAnalysisReportRow): TxAnalysisReportIndexEntry {
  const base = {
    ...(row.analysis_rule_version === null || row.analysis_rule_version === undefined
      ? {}
      : { analysisRuleVersion: row.analysis_rule_version }),
    chain: row.chain,
    ...(row.contract_address === null ? {} : { contractAddress: row.contract_address }),
    ...(row.explorer_url === null ? {} : { explorerUrl: row.explorer_url }),
    generatedAt: normalizeTimestamp(row.generated_at),
    ...(row.pool_address === null ? {} : { poolAddress: row.pool_address }),
    ...relatedTransactionsFromPgRow(row),
    reportUrl: row.report_url,
    ...pgReportRowReview(row),
    ...(row.router_address === null || row.router_address === undefined
      ? {}
      : { routerAddress: row.router_address }),
    ...(row.screenshot_url === null ? {} : { screenshotUrl: row.screenshot_url }),
    ...(row.screenshot_target_row_marked === null || row.screenshot_target_row_marked === undefined
      ? {}
      : { screenshotTargetRowMarked: row.screenshot_target_row_marked }),
    ...(isTxAnalysisTradeSide(row.target_trade_side)
      ? { targetTradeSide: row.target_trade_side }
      : {}),
    ...(row.target_trader_address === null || row.target_trader_address === undefined
      ? {}
      : { targetTraderAddress: row.target_trader_address }),
    ...(row.transaction_time === null || row.transaction_time === undefined
      ? {}
      : { transactionTime: row.transaction_time }),
    txHash: row.tx_hash,
    ...(row.unsupported_chain_hint === null || row.unsupported_chain_hint === undefined
      ? {}
      : { unsupportedChainHint: row.unsupported_chain_hint }),
    ...(row.unsupported_explorer_host === null || row.unsupported_explorer_host === undefined
      ? {}
      : { unsupportedExplorerHost: row.unsupported_explorer_host }),
    ...(row.xxyy_pool_url === null ? {} : { xxyyPoolUrl: row.xxyy_pool_url }),
  };

  if (row.status === 'success') {
    return {
      ...base,
      ...(row.confidence === null ? {} : { confidence: row.confidence }),
      status: 'success',
      ...(row.verdict === null ? {} : { verdict: row.verdict }),
    };
  }

  return {
    ...base,
    ...failureMessageFromPgRow(row),
    ...probeAttemptsFromPgRow(row),
    reason: row.failure_reason ?? 'provider_unavailable',
    status: 'failure',
  };
}

function pgReportRowReview(
  row: PgTxAnalysisReportRow,
): { review: TxAnalysisReportReview } | Record<string, never> {
  if (row.review_status === null || row.review_status === undefined) {
    return {
      review: {
        status: 'open',
        updatedAt: normalizeTimestamp(row.generated_at),
      },
    };
  }

  return {
    review: pgReportReviewRowToReview({
      review_assignee: row.review_assignee ?? null,
      review_note: row.review_note ?? null,
      review_status: row.review_status,
      review_updated_at: row.review_updated_at ?? row.generated_at,
      review_updated_by: row.review_updated_by ?? null,
    }),
  };
}

function pgReportReviewRowToReview(row: PgTxAnalysisReportReviewRow): TxAnalysisReportReview {
  return {
    ...(row.review_assignee === null ? {} : { assignee: row.review_assignee }),
    ...(row.review_note === null ? {} : { note: row.review_note }),
    status: row.review_status,
    updatedAt: normalizeTimestamp(row.review_updated_at),
    ...(row.review_updated_by === null ? {} : { updatedBy: row.review_updated_by }),
  };
}

function relatedTransactionsFromPgRow(
  row: PgTxAnalysisReportRow,
): { relatedTransactions: TxAnalysisResult['relatedTransactions'] } | Record<string, never> {
  if (!Array.isArray(row.related_transactions) || row.related_transactions.length === 0) {
    return {};
  }

  const relatedTransactions = deduplicateRelatedTransactions(
    row.related_transactions.filter(isTxAnalysisRelatedTransaction),
  );
  return relatedTransactions.length === 0 ? {} : { relatedTransactions };
}

function probeAttemptsFromPgRow(
  row: PgTxAnalysisReportRow,
): { probeAttempts: TxAnalysisProbeAttempt[] } | Record<string, never> {
  if (!Array.isArray(row.probe_attempts) || row.probe_attempts.length === 0) {
    return {};
  }

  const probeAttempts = row.probe_attempts.filter(isTxAnalysisProbeAttempt);
  return probeAttempts.length === 0 ? {} : { probeAttempts };
}

function failureMessageFromPgRow(
  row: PgTxAnalysisReportRow,
): { message: string } | Record<string, never> {
  const message = normalizeCleanNonEmptyString(row.failure_message);
  return message === undefined ? {} : { message };
}

function isTxAnalysisProbeAttempt(value: unknown): value is TxAnalysisProbeAttempt {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<TxAnalysisProbeAttempt>;
  return (
    isTxAnalysisChain(record.chain) &&
    isCleanNonEmptyString(record.message) &&
    isTxAnalysisUnavailableReason(record.reason)
  );
}

function isTxAnalysisChain(value: unknown): value is TxAnalysisChain {
  return (
    value === 'solana' ||
    value === 'base' ||
    value === 'ethereum' ||
    value === 'bsc' ||
    value === 'unknown'
  );
}

function isTxAnalysisUnavailableReason(value: unknown): value is TxAnalysisUnavailableReason {
  return (
    value === 'not_configured' ||
    value === 'provider_unavailable' ||
    value === 'invalid_reference' ||
    value === 'unsupported_chain' ||
    value === 'browser_verification_required' ||
    value === 'tx_not_found' ||
    value === 'tx_failed' ||
    value === 'tx_pending' ||
    value === 'pool_not_found' ||
    value === 'target_trade_not_found' ||
    value === 'screenshot_unavailable' ||
    value === 'timeout'
  );
}

function isTxAnalysisRelatedTransaction(
  value: unknown,
): value is TxAnalysisResult['relatedTransactions'][number] {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<TxAnalysisResult['relatedTransactions'][number]>;
  return (
    isCleanNonEmptyString(record.hash) &&
    isCleanNonEmptyString(record.summary) &&
    (record.role === 'front_run' ||
      record.role === 'user' ||
      record.role === 'back_run' ||
      record.role === 'related') &&
    isOptionalCleanNonEmptyString(record.explorerUrl) &&
    isOptionalTxAnalysisTradeSide(record.side) &&
    isOptionalCleanNonEmptyString(record.timestamp) &&
    isOptionalCleanNonEmptyString(record.traderAddress)
  );
}

function isOptionalTxAnalysisTradeSide(
  value: unknown,
): value is TxAnalysisResult['targetTradeSide'] {
  return value === undefined || isTxAnalysisTradeSide(value);
}

function isTxAnalysisTradeSide(
  value: unknown,
): value is NonNullable<TxAnalysisResult['targetTradeSide']> {
  return value === 'buy' || value === 'sell' || value === 'unknown';
}

function isCleanNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

function normalizeCleanNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeFailureReportMessage(value: string): string {
  return normalizeCleanNonEmptyString(value) ?? '交易分析失败。';
}

function isOptionalCleanNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isCleanNonEmptyString(value);
}

function createPgReportId(
  reference: TransactionReference,
  status: TxAnalysisReportStatus,
  generatedAt: string,
  reason?: TxAnalysisUnavailableReason,
): string {
  const fingerprint = createHash('sha256')
    .update(`${reference.chain}:${reference.txHash}:${status}:${reason ?? ''}:${generatedAt}`)
    .digest('hex')
    .slice(0, 14);
  return [
    'txr',
    reference.chain,
    sanitizeFileNameSegment(reference.txHash.slice(0, 12)),
    fingerprint,
  ].join('_');
}

function normalizeTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function readReportIndexEntries(options: {
  reportDir?: string;
}): Promise<TxAnalysisReportIndexEntry[]> {
  const reportDir = resolveReportDir(options);
  const indexText = await readFile(path.join(reportDir, REPORT_INDEX_FILE_NAME), 'utf8').catch(
    (error: unknown) => {
      if (isMissingFileError(error)) {
        return '';
      }
      throw error;
    },
  );

  return indexText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseReportIndexLine)
    .filter((entry): entry is TxAnalysisReportIndexEntry => entry !== undefined);
}

async function appendReportIndexEntry(
  reportDir: string,
  entry: TxAnalysisReportIndexEntry,
): Promise<void> {
  await appendFile(path.join(reportDir, REPORT_INDEX_FILE_NAME), `${JSON.stringify(entry)}\n`);
}

async function writeReportIndexEntries(
  reportDir: string,
  entries: TxAnalysisReportIndexEntry[],
): Promise<void> {
  const indexText = entries.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(
    path.join(reportDir, REPORT_INDEX_FILE_NAME),
    indexText.length === 0 ? '' : `${indexText}\n`,
  );
}

async function updateFileReportDocumentReview(
  reportDir: string,
  reportFileName: string,
  review: TxAnalysisReportReview,
): Promise<void> {
  const reportPath = path.join(reportDir, reportFileName);
  const reportDocument = parseFileReportDocument(await readFile(reportPath, 'utf8'));
  if (reportDocument === undefined) {
    return;
  }

  await writeFile(reportPath, `${JSON.stringify({ ...reportDocument, review }, null, 2)}\n`);
}

function parseFileReportDocument(text: string): TxAnalysisStoredReportDocument | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<TxAnalysisStoredReportDocument>;
    if (
      (parsed.status === 'success' || parsed.status === 'failure') &&
      typeof parsed.generatedAt === 'string' &&
      typeof parsed.reference === 'object' &&
      parsed.reference !== null &&
      parsed.version === 1
    ) {
      return parsed as TxAnalysisStoredReportDocument;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function normalizeFileReportId(id: string): string | undefined {
  const reportFileName = path.basename(id.trim());
  if (
    reportFileName.length === 0 ||
    reportFileName === '.' ||
    reportFileName === '..' ||
    !reportFileName.endsWith('.json')
  ) {
    return undefined;
  }

  return reportFileName;
}

function reportFileNameFromUrl(reportUrl: string): string {
  return path.basename(reportUrl);
}

function parseReportIndexLine(line: string): TxAnalysisReportIndexEntry | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<TxAnalysisReportIndexEntry>;
    if (!isReportIndexEntry(parsed)) {
      return undefined;
    }

    return normalizeReportIndexEntry(parsed);
  } catch {
    return undefined;
  }
}

function normalizeReportIndexEntry(entry: TxAnalysisReportIndexEntry): TxAnalysisReportIndexEntry {
  const normalizedRelatedTransactions = normalizeReportIndexEntryRelatedTransactions(entry);
  if (normalizedRelatedTransactions.status !== 'failure') {
    return normalizedRelatedTransactions;
  }

  return normalizeReportIndexEntryProbeAttempts(
    normalizeReportIndexEntryFailureMessage(normalizedRelatedTransactions),
  );
}

function normalizeReportIndexEntryRelatedTransactions(
  entry: TxAnalysisReportIndexEntry,
): TxAnalysisReportIndexEntry {
  if (!Array.isArray(entry.relatedTransactions)) {
    return entry;
  }

  const relatedTransactions = deduplicateRelatedTransactions(
    entry.relatedTransactions.filter(isTxAnalysisRelatedTransaction),
  );
  if (relatedTransactions.length === entry.relatedTransactions.length) {
    return entry;
  }

  const { relatedTransactions: _relatedTransactions, ...rest } = entry;
  return relatedTransactions.length === 0 ? rest : { ...rest, relatedTransactions };
}

function normalizeReportResultRelatedTransactions(result: TxAnalysisResult): TxAnalysisResult {
  return normalizeReportResultEvidence({
    ...result,
    relatedTransactions: normalizeReportRelatedTransactions(result.relatedTransactions),
  });
}

function normalizeReportResultEvidence(result: TxAnalysisResult): TxAnalysisResult {
  const evidence = result.evidence.flatMap((item) => {
    const label = normalizeCleanNonEmptyString(item.label);
    const detail = normalizeCleanNonEmptyString(item.detail);
    if (label === undefined || detail === undefined) {
      return [];
    }

    return [{ ...item, detail, label }];
  });

  return evidence.length === result.evidence.length &&
    evidence.every(
      (item, index) =>
        item.label === result.evidence[index]?.label &&
        item.detail === result.evidence[index]?.detail,
    )
    ? result
    : { ...result, evidence };
}

function normalizeFailureMetadataForReport(
  metadata: TxAnalysisFailureMetadata | undefined,
): TxAnalysisFailureMetadata | undefined {
  const normalizedMetadata = normalizeFailureMetadataProbeAttempts(
    normalizeFailureMetadataRelatedTransactions(metadata),
  );
  return normalizedMetadata === undefined || Object.keys(normalizedMetadata).length > 0
    ? normalizedMetadata
    : undefined;
}

function normalizeFailureMetadataRelatedTransactions(
  metadata: TxAnalysisFailureMetadata | undefined,
): TxAnalysisFailureMetadata | undefined {
  if (metadata?.relatedTransactions === undefined) {
    return metadata;
  }

  const relatedTransactions = normalizeReportRelatedTransactions(metadata.relatedTransactions);
  const { relatedTransactions: _relatedTransactions, ...rest } = metadata;
  return relatedTransactions.length === 0 ? rest : { ...rest, relatedTransactions };
}

function normalizeReportRelatedTransactions(
  transactions: TxAnalysisResult['relatedTransactions'],
): TxAnalysisResult['relatedTransactions'] {
  return deduplicateRelatedTransactions(
    transactions
      .map(normalizeReportRelatedTransaction)
      .filter(
        (transaction): transaction is TxAnalysisResult['relatedTransactions'][number] =>
          transaction !== undefined,
      ),
  );
}

function normalizeReportRelatedTransaction(
  transaction: TxAnalysisResult['relatedTransactions'][number],
): TxAnalysisResult['relatedTransactions'][number] | undefined {
  const hash = normalizeCleanNonEmptyString(transaction.hash);
  if (hash === undefined) {
    return undefined;
  }

  const role = normalizeReportRelatedTransactionRole(transaction.role);
  const summary = normalizeCleanNonEmptyString(transaction.summary) ?? summaryForRelatedRole(role);
  const explorerUrl = normalizeCleanNonEmptyString(transaction.explorerUrl);
  const side = isTxAnalysisTradeSide(transaction.side) ? transaction.side : undefined;
  const timestamp = normalizeCleanNonEmptyString(transaction.timestamp);
  const traderAddress = normalizeCleanNonEmptyString(transaction.traderAddress);

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

function normalizeReportRelatedTransactionRole(
  role: TxAnalysisResult['relatedTransactions'][number]['role'],
): TxAnalysisResult['relatedTransactions'][number]['role'] {
  switch (role) {
    case 'back_run':
    case 'front_run':
    case 'related':
    case 'user':
      return role;
  }
}

function summaryForRelatedRole(
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

function normalizeFailureMetadataProbeAttempts(
  metadata: TxAnalysisFailureMetadata | undefined,
): TxAnalysisFailureMetadata | undefined {
  if (metadata?.probeAttempts === undefined) {
    return metadata;
  }

  let changed = false;
  const probeAttempts: TxAnalysisProbeAttempt[] = [];
  for (const attempt of metadata.probeAttempts) {
    const message = normalizeCleanNonEmptyString(attempt.message);
    if (message === undefined) {
      changed = true;
      continue;
    }

    if (message === attempt.message) {
      probeAttempts.push(attempt);
      continue;
    }

    changed = true;
    probeAttempts.push({ ...attempt, message });
  }

  if (!changed) {
    return metadata;
  }

  const { probeAttempts: _probeAttempts, ...rest } = metadata;
  return probeAttempts.length === 0 ? rest : { ...rest, probeAttempts };
}

function deduplicateRelatedTransactions(
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

function normalizeReportIndexEntryProbeAttempts(
  entry: Extract<TxAnalysisReportIndexEntry, { status: 'failure' }>,
): Extract<TxAnalysisReportIndexEntry, { status: 'failure' }> {
  if (!Array.isArray(entry.probeAttempts)) {
    return entry;
  }

  const probeAttempts = entry.probeAttempts.filter(isTxAnalysisProbeAttempt);
  if (probeAttempts.length === entry.probeAttempts.length) {
    return entry;
  }

  const { probeAttempts: _probeAttempts, ...rest } = entry;
  return probeAttempts.length === 0 ? rest : { ...rest, probeAttempts };
}

function normalizeReportIndexEntryFailureMessage(
  entry: Extract<TxAnalysisReportIndexEntry, { status: 'failure' }>,
): Extract<TxAnalysisReportIndexEntry, { status: 'failure' }> {
  const message = normalizeCleanNonEmptyString(entry.message);
  if (message === entry.message) {
    return entry;
  }

  const { message: _message, ...rest } = entry;
  return message === undefined ? rest : { ...rest, message };
}

function isReportIndexEntry(
  value: Partial<TxAnalysisReportIndexEntry>,
): value is TxAnalysisReportIndexEntry {
  return (
    typeof value.chain === 'string' &&
    typeof value.generatedAt === 'string' &&
    typeof value.reportUrl === 'string' &&
    typeof value.txHash === 'string' &&
    (value.status === 'success' || value.status === 'failure')
  );
}

function createFailureReportFileName(
  reference: TransactionReference,
  reason: TxAnalysisUnavailableReason,
  generatedAt: string,
): string {
  const fingerprint = createHash('sha256')
    .update(`${reference.chain}:${reference.txHash}:${reason}:${generatedAt}`)
    .digest('hex')
    .slice(0, 12);
  return (
    [
      'tx-analysis-failure',
      reference.chain,
      sanitizeFileNameSegment(reference.txHash.slice(0, 16)),
      reason,
      fingerprint,
    ].join('-') + '.json'
  );
}

function createReportFileName(reference: TransactionReference, result: TxAnalysisResult): string {
  const fingerprint = createHash('sha256')
    .update(`${reference.chain}:${reference.txHash}:${result.analyzedAt}`)
    .digest('hex')
    .slice(0, 12);
  return (
    [
      'tx-analysis-report',
      reference.chain,
      sanitizeFileNameSegment(reference.txHash.slice(0, 16)),
      fingerprint,
    ].join('-') + '.json'
  );
}

function sanitizeFileNameSegment(value: string): string {
  return value.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '') || 'tx';
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_REPORT_BASE_URL).replace(/\/+$/u, '');
}

function resolveReportDir(options: FileTxAnalysisReportWriterOptions): string {
  if (options.reportDir !== undefined) {
    return path.resolve(options.reportDir);
  }

  const workspaceCwd = resolveWorkspaceCwd(process.cwd(), process.env);
  return path.join(workspaceCwd, 'docs', 'product-features', 'assets');
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
