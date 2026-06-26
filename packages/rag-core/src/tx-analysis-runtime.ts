import type { TxAnalysisResult } from '@xxyy/shared';

import {
  createBrowserTxAnalysisProvider,
  type BrowserTxAnalysisReportWriter,
  type BrowserTxAnalysisReviewer,
} from './browser-tx-analysis.js';
import type { RagConfig } from './config.js';
import { createOpenAiTxAnalysisReviewer } from './openai-tx-analysis-reviewer.js';
import { createPlaywrightBrowserTxAnalysisDriver } from './playwright-browser-tx-driver.js';
import { createPgPool } from './pgvector-store.js';
import {
  parseOptionalTxAnalysisChainInput,
  toTxAnalysisReferenceInput,
} from './tx-analysis-chain.js';
import {
  createFileTxAnalysisReportWriter,
  createPgTxAnalysisReportStore,
  findFileTxAnalysisReports,
  getFileTxAnalysisReportDocument,
  summarizeFileTxAnalysisReports,
  updateFileTxAnalysisReportReview,
  type FindTxAnalysisReportsOptions,
  type SummarizeTxAnalysisReportsOptions,
  type TxAnalysisReportIndexEntry,
  type TxAnalysisReportReview,
  type TxAnalysisReportSummary,
  type TxAnalysisStoredReportDocument,
  type UpdateTxAnalysisReportReviewInput,
} from './tx-analysis-report-store.js';
import {
  TxAnalysisProviderUnavailableError,
  TxAnalysisUnsupportedChainError,
  type TxAnalysisFailureMetadata,
  type TxAnalysisProvider,
  type TxAnalysisUnavailableReason,
} from './tx-analysis.js';
import { parseTransactionReference } from './tx-hash.js';

export interface AnalyzeTransactionInput {
  chain?: unknown;
  txHash: string;
}

export interface AnalyzeTransactionOptions {
  input: AnalyzeTransactionInput;
  provider: TxAnalysisProvider | undefined;
}

export type AnalyzeTransactionOutput =
  | {
      result: TxAnalysisResult;
      status: 'success';
    }
  | {
      failure: {
        message: string;
        metadata?: TxAnalysisFailureMetadata;
        reason: TxAnalysisUnavailableReason;
        reportUrl?: string;
      };
      status: 'failure';
    };

export interface TxAnalysisReportReader {
  findReports(options: FindTxAnalysisReportsOptions): Promise<TxAnalysisReportIndexEntry[]>;
  getReportDocument?(id: string): Promise<TxAnalysisStoredReportDocument | undefined>;
  summarizeReports(options?: SummarizeTxAnalysisReportsOptions): Promise<TxAnalysisReportSummary>;
  updateReportReview?(
    input: UpdateTxAnalysisReportReviewInput,
  ): Promise<TxAnalysisReportReview | undefined>;
}

type TxAnalysisRuntimeConfig = Pick<RagConfig, 'txAnalysisProvider'> & Partial<RagConfig>;
type TxAnalysisReportReaderConfig = Partial<
  Pick<RagConfig, 'databaseUrl' | 'txAnalysisReportStore' | 'txAnalysisScreenshotDir'>
>;

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TX_ANALYSIS_BROWSER_HEADLESS = true;
const DEFAULT_TX_ANALYSIS_BROWSER_MAX_CONCURRENCY = 1;
const DEFAULT_TX_ANALYSIS_BROWSER_MAX_RETRIES = 1;
const DEFAULT_TX_ANALYSIS_BROWSER_TIMEOUT_MS = 60000;
const DEFAULT_TX_ANALYSIS_REPORT_STORE = 'file';
const DEFAULT_TX_ANALYSIS_REVIEWER = 'none';
const DEFAULT_TX_ANALYSIS_SCREENSHOT_BASE_URL = '/assets';

export async function analyzeTransaction(
  options: AnalyzeTransactionOptions,
): Promise<AnalyzeTransactionOutput> {
  let parsedChainInput: ReturnType<typeof parseOptionalTxAnalysisChainInput>;
  try {
    parsedChainInput = parseOptionalTxAnalysisChainInput(options.input.chain);
  } catch {
    return createFailure('invalid_reference', 'Transaction reference is invalid or ambiguous.');
  }

  if (parsedChainInput.unsupportedChainText !== undefined) {
    return createFailure(
      'unsupported_chain',
      `Transaction analysis does not support ${parsedChainInput.unsupportedChainText}.`,
      {
        metadata: { unsupportedChainHint: parsedChainInput.unsupportedChainText },
      },
    );
  }

  const reference = parseTransactionReference(
    toTxAnalysisReferenceInput({
      ...(parsedChainInput.chain === undefined ? {} : { chain: parsedChainInput.chain }),
      txHash: options.input.txHash,
    }),
  );
  if (reference === undefined) {
    return createFailure('invalid_reference', 'Transaction reference is invalid or ambiguous.');
  }

  if (
    reference.unsupportedExplorerHost !== undefined ||
    reference.unsupportedChainHint !== undefined
  ) {
    return createFailure(
      'unsupported_chain',
      'Transaction analysis does not support this chain or explorer.',
      {
        metadata: {
          ...(reference.unsupportedExplorerHost === undefined
            ? {}
            : { unsupportedExplorerHost: reference.unsupportedExplorerHost }),
          ...(reference.unsupportedChainHint === undefined
            ? {}
            : { unsupportedChainHint: reference.unsupportedChainHint }),
        },
      },
    );
  }

  if (options.provider === undefined) {
    return createFailure('not_configured', 'Transaction analysis provider is not configured.');
  }

  try {
    return {
      result: await options.provider.analyze(reference),
      status: 'success',
    };
  } catch (error) {
    if (error instanceof TxAnalysisProviderUnavailableError) {
      return createFailure(error.reason, error.message, {
        ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
        ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
      });
    }
    if (error instanceof TxAnalysisUnsupportedChainError) {
      return createFailure('unsupported_chain', error.message, {
        ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
        ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
      });
    }

    throw error;
  }
}

export function createConfiguredTxAnalysisProvider(
  config: TxAnalysisRuntimeConfig,
): TxAnalysisProvider | undefined {
  if (config.txAnalysisProvider === 'none') {
    return undefined;
  }
  if (config.txAnalysisProvider === 'browser') {
    const analysisReviewer = createConfiguredTxAnalysisReviewer(config);
    return createBrowserTxAnalysisProvider({
      ...(analysisReviewer === undefined ? {} : { analysisReviewer }),
      driver: createPlaywrightBrowserTxAnalysisDriver({
        ...(config.txAnalysisDiscoverUrl === undefined
          ? {}
          : { discoverUrl: config.txAnalysisDiscoverUrl }),
        headless: config.txAnalysisBrowserHeadless ?? DEFAULT_TX_ANALYSIS_BROWSER_HEADLESS,
        screenshotBaseUrl:
          config.txAnalysisScreenshotBaseUrl ?? DEFAULT_TX_ANALYSIS_SCREENSHOT_BASE_URL,
        timeoutMs: config.txAnalysisBrowserTimeoutMs ?? DEFAULT_TX_ANALYSIS_BROWSER_TIMEOUT_MS,
        ...(config.txAnalysisChromeExecutablePath === undefined
          ? {}
          : { chromeExecutablePath: config.txAnalysisChromeExecutablePath }),
        ...optionalRuntimeConfigValue('screenshotDir', config.txAnalysisScreenshotDir),
        ...(config.txAnalysisBrowserUserDataDir === undefined
          ? {}
          : { userDataDir: config.txAnalysisBrowserUserDataDir }),
      }),
      maxConcurrentAnalyses:
        config.txAnalysisBrowserMaxConcurrency ?? DEFAULT_TX_ANALYSIS_BROWSER_MAX_CONCURRENCY,
      maxRetries: config.txAnalysisBrowserMaxRetries ?? DEFAULT_TX_ANALYSIS_BROWSER_MAX_RETRIES,
      reportWriter: createConfiguredTxAnalysisReportWriter(config),
    });
  }

  throw new Error(`Unsupported TX_ANALYSIS_PROVIDER: ${config.txAnalysisProvider}`);
}

export function createConfiguredTxAnalysisReportReader(
  config: TxAnalysisReportReaderConfig,
): TxAnalysisReportReader {
  const reportStore = config.txAnalysisReportStore ?? DEFAULT_TX_ANALYSIS_REPORT_STORE;
  if (reportStore === 'postgres') {
    return createPgTxAnalysisReportStore({ client: createPgPool(config.databaseUrl) });
  }
  if (reportStore === 'file') {
    const reportDir = normalizeOptionalRuntimeConfigString(config.txAnalysisScreenshotDir);
    return {
      findReports(options) {
        if (reportDir === undefined) {
          return findFileTxAnalysisReports(options);
        }
        return findFileTxAnalysisReports({ ...options, reportDir });
      },
      getReportDocument(id) {
        if (reportDir === undefined) {
          return getFileTxAnalysisReportDocument({ id });
        }
        return getFileTxAnalysisReportDocument({ id, reportDir });
      },
      summarizeReports(options = {}) {
        if (reportDir === undefined) {
          return summarizeFileTxAnalysisReports(options);
        }
        return summarizeFileTxAnalysisReports({ ...options, reportDir });
      },
      updateReportReview(input) {
        if (reportDir === undefined) {
          return updateFileTxAnalysisReportReview(input);
        }
        return updateFileTxAnalysisReportReview({ ...input, reportDir });
      },
    };
  }

  throw new Error(`Unsupported TX_ANALYSIS_REPORT_STORE: ${reportStore}`);
}

function createConfiguredTxAnalysisReviewer(
  config: TxAnalysisRuntimeConfig,
): BrowserTxAnalysisReviewer | undefined {
  const reviewer = config.txAnalysisReviewer ?? DEFAULT_TX_ANALYSIS_REVIEWER;
  if (reviewer === 'none') {
    return undefined;
  }
  if (reviewer === 'openai') {
    return createOpenAiTxAnalysisReviewer({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl ?? DEFAULT_OPENAI_BASE_URL,
      model: config.openAiModel,
      ...(config.openAiMaxRetries === undefined ? {} : { maxRetries: config.openAiMaxRetries }),
      ...(config.openAiRequestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: config.openAiRequestTimeoutMs }),
    });
  }

  throw new Error(`Unsupported TX_ANALYSIS_REVIEWER: ${reviewer}`);
}

function createConfiguredTxAnalysisReportWriter(
  config: TxAnalysisRuntimeConfig,
): BrowserTxAnalysisReportWriter {
  const reportStore = config.txAnalysisReportStore ?? DEFAULT_TX_ANALYSIS_REPORT_STORE;
  if (reportStore === 'file') {
    return createFileTxAnalysisReportWriter({
      reportBaseUrl: config.txAnalysisScreenshotBaseUrl ?? DEFAULT_TX_ANALYSIS_SCREENSHOT_BASE_URL,
      ...optionalRuntimeConfigValue('reportDir', config.txAnalysisScreenshotDir),
    });
  }
  if (reportStore === 'postgres') {
    return createLazyPgTxAnalysisReportWriter(config.databaseUrl);
  }

  throw new Error(`Unsupported TX_ANALYSIS_REPORT_STORE: ${reportStore}`);
}

function createLazyPgTxAnalysisReportWriter(
  databaseUrl: string | undefined,
): BrowserTxAnalysisReportWriter {
  let writer: BrowserTxAnalysisReportWriter | undefined;

  function loadWriter(): BrowserTxAnalysisReportWriter {
    writer ??= createPgTxAnalysisReportStore({ client: createPgPool(databaseUrl) });
    return writer;
  }

  return {
    async writeFailureReport(input) {
      const currentWriter = loadWriter();
      if (currentWriter.writeFailureReport === undefined) {
        throw new Error('Transaction analysis failure report writer is not configured.');
      }
      return currentWriter.writeFailureReport(input);
    },

    async writeReport(input) {
      return loadWriter().writeReport(input);
    },
  };
}

function optionalRuntimeConfigValue<T extends string>(
  key: T,
  value: string | undefined,
): Partial<Record<T, string>> {
  const normalized = normalizeOptionalRuntimeConfigString(value);
  return normalized === undefined ? {} : ({ [key]: normalized } as Record<T, string>);
}

function normalizeOptionalRuntimeConfigString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function createFailure(
  reason: TxAnalysisUnavailableReason,
  message: string,
  options: { metadata?: TxAnalysisFailureMetadata; reportUrl?: string } = {},
): AnalyzeTransactionOutput {
  return {
    failure: {
      message,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      reason,
      ...(options.reportUrl === undefined ? {} : { reportUrl: options.reportUrl }),
    },
    status: 'failure',
  };
}
