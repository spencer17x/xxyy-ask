#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_CHAT_BOUNDARY_QUESTION = '帮我查一下钱包余额';
const DEFAULT_CHAT_QUESTION = 'XXYY Pro 有哪些权益？';
const DEFAULT_CHAT_FOLLOW_UP_QUESTION = '怎么升级？';
const DEFAULT_CHAT_SESSION_ID = 'api-smoke-session';
const DEFAULT_TX_ANALYSIS_CHAIN = 'unknown';
const CHAT_HANDOFF_WORDING_PATTERNS = [
  /人工客服/u,
  /人工处理/u,
  /转人工/u,
  /manual handoff/iu,
  /human support/iu,
];
const TX_ANALYSIS_FAILURE_REASONS = new Set([
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
  'timeout',
]);
const TX_ANALYSIS_CHAINS = new Set(['solana', 'base', 'ethereum', 'bsc', 'unknown']);
const TX_ANALYSIS_FAILURE_METADATA_TEXT_FIELDS = [
  'contractAddress',
  'explorerUrl',
  'poolAddress',
  'reportWriteError',
  'routerAddress',
  'screenshotUrl',
  'targetTraderAddress',
  'transactionTime',
  'unsupportedChainHint',
  'unsupportedExplorerHost',
  'xxyyPoolUrl',
];
const TX_ANALYSIS_FAILURE_METADATA_CLEAN_ERROR =
  'transaction analysis failure metadata must not contain blank or untrimmed review fields.';
const TX_ANALYSIS_RELATED_TRANSACTION_ROLES = new Set(['front_run', 'user', 'back_run', 'related']);
const TX_ANALYSIS_TRADE_SIDES = new Set(['buy', 'sell', 'unknown']);

export function createApiSmokeChecks(args, env = process.env) {
  const options = parseApiSmokeArgs(args, env);
  return createApiSmokeChecksFromOptions(options);
}

function createApiSmokeChecksFromOptions(options) {
  const checks = [
    createCheck('health', 'health', options.baseUrl, '/health'),
    createCheck('deepHealth', 'deep health', options.baseUrl, '/health/deep'),
  ];

  if (options.opsToken !== undefined) {
    checks.push(
      createCheck('opsSummary', 'ops summary', options.baseUrl, '/api/ops/summary', {
        headers: { Authorization: `Bearer ${options.opsToken}` },
      }),
    );
  }

  if (options.chatFollowUp) {
    checks.push(
      createCheck('chat', 'chat', options.baseUrl, '/api/chat', {
        body: JSON.stringify({
          channel: 'cli',
          message: options.question,
          sessionId: options.chatSessionId,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
      createCheck('chatFollowUp', 'chat follow-up', options.baseUrl, '/api/chat', {
        body: JSON.stringify({
          channel: 'cli',
          message: options.followUpQuestion,
          sessionId: options.chatSessionId,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
  } else if (options.chat) {
    checks.push(
      createCheck('chat', 'chat', options.baseUrl, '/api/chat', {
        body: JSON.stringify({ channel: 'cli', message: options.question }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
  }

  if (options.chatBoundary) {
    checks.push(
      createCheck('chatBoundary', 'chat boundary', options.baseUrl, '/api/chat', {
        body: JSON.stringify({ channel: 'cli', message: options.boundaryQuestion }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
  }

  if (options.txAnalysis && options.txHash !== undefined) {
    checks.push(
      createCheck('txAnalysis', 'transaction analysis', options.baseUrl, '/api/tx-analysis', {
        body: JSON.stringify({ chain: options.txChain, txHash: options.txHash }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        requireReport: options.txRequireReport,
        requireScreenshot: options.txRequireScreenshot,
        txChain: options.txChain,
        txHash: options.txHash,
        verifyAssets: options.txVerifyAssets,
      }),
    );
  }

  for (const sample of options.txSamples) {
    checks.push(
      createCheck(
        'txAnalysis',
        `transaction analysis: ${sample.label}`,
        options.baseUrl,
        '/api/tx-analysis',
        {
          body: JSON.stringify({ chain: sample.txChain, txHash: sample.txHash }),
          expectedAnalysisRuleVersion: sample.expectedAnalysisRuleVersion,
          expectedChain: sample.expectedChain,
          expectedConfidence: sample.expectedConfidence,
          expectedContractAddress: sample.expectedContractAddress,
          expectedDataSource: sample.expectedDataSource,
          expectedExplorerUrl: sample.expectedExplorerUrl,
          expectedFailureMessage: sample.expectedFailureMessage,
          expectedFailureReason: sample.expectedFailureReason,
          expectedPoolAddress: sample.expectedPoolAddress,
          expectedProbeAttempts: sample.expectedProbeAttempts,
          expectedRelatedTransactionCount: sample.expectedRelatedTransactionCount,
          expectedRelatedTransactionRoles: sample.expectedRelatedTransactionRoles,
          expectedRelatedTransactions: sample.expectedRelatedTransactions,
          expectedRouterAddress: sample.expectedRouterAddress,
          expectedScreenshotTargetRowMarked: sample.expectedScreenshotTargetRowMarked,
          expectedStatus: sample.expectedStatus,
          expectedTargetTradeSide: sample.expectedTargetTradeSide,
          expectedTargetTraderAddress: sample.expectedTargetTraderAddress,
          expectedTransactionTime: sample.expectedTransactionTime,
          expectedVerdict: sample.expectedVerdict,
          expectedXxyyPoolUrl: sample.expectedXxyyPoolUrl,
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
          requireReport: sample.txRequireReport,
          requireScreenshot: sample.txRequireScreenshot,
          txChain: sample.txChain,
          txHash: sample.txHash,
          verifyAssets: sample.txVerifyAssets,
        },
      ),
    );
  }

  return checks;
}

export async function runApiSmoke(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const smokeOptions = parseApiSmokeArgs(args, env);
  const checks = createApiSmokeChecksFromOptions(smokeOptions);
  let failedChecks = 0;

  for (const check of checks) {
    log(`==> ${check.label}`);
    const response = await fetchFn(check.url, {
      body: check.body,
      headers: check.headers,
      method: check.method,
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      log(`Failed ${check.label}: HTTP ${response.status}`);
      log(formatPayload(payload));
      failedChecks += 1;
      if (!smokeOptions.continueOnError) {
        return 1;
      }
      continue;
    }

    const validationError = validatePayload(check, payload);
    if (validationError !== undefined) {
      log(`Failed ${check.label}: ${validationError}`);
      log(formatPayload(payload));
      failedChecks += 1;
      if (!smokeOptions.continueOnError) {
        return 1;
      }
      continue;
    }

    if (check.kind === 'txAnalysis' && check.verifyAssets === true) {
      const assetsOk = await verifyTxAnalysisAssets(check, payload, fetchFn, log);
      if (!assetsOk) {
        failedChecks += 1;
        if (!smokeOptions.continueOnError) {
          return 1;
        }
        continue;
      }
    }

    log(`OK ${check.label}`);
  }

  if (failedChecks > 0) {
    log(`API smoke failed: ${failedChecks} check${failedChecks === 1 ? '' : 's'} failed.`);
    return 1;
  }

  log('API smoke passed.');
  return 0;
}

function parseApiSmokeArgs(args, env) {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  let baseUrl = normalizeBaseUrl(env.API_BASE_URL ?? DEFAULT_BASE_URL);
  let chat = false;
  let chatBoundary = parseBoolean(env.API_SMOKE_CHAT_BOUNDARY);
  let boundaryQuestion =
    normalizeOptionalText(env.API_SMOKE_CHAT_BOUNDARY_QUESTION) ?? DEFAULT_CHAT_BOUNDARY_QUESTION;
  let chatFollowUp = parseBoolean(env.API_SMOKE_CHAT_FOLLOW_UP);
  let chatSessionId =
    normalizeOptionalText(env.API_SMOKE_CHAT_SESSION_ID) ?? DEFAULT_CHAT_SESSION_ID;
  let continueOnError = parseBoolean(env.API_SMOKE_CONTINUE_ON_ERROR);
  let followUpQuestion =
    normalizeOptionalText(env.API_SMOKE_CHAT_FOLLOW_UP_QUESTION) ?? DEFAULT_CHAT_FOLLOW_UP_QUESTION;
  let opsToken = normalizeOptionalText(env.API_OPS_TOKEN);
  let question = DEFAULT_CHAT_QUESTION;
  let txAnalysis = false;
  let txChain = normalizeOptionalText(env.TX_ANALYSIS_SMOKE_CHAIN) ?? DEFAULT_TX_ANALYSIS_CHAIN;
  let txHash = normalizeOptionalText(env.TX_ANALYSIS_SMOKE_TX_HASH);
  let txRequireReport = parseBoolean(env.TX_ANALYSIS_SMOKE_REQUIRE_REPORT);
  let txRequireScreenshot = parseBoolean(env.TX_ANALYSIS_SMOKE_REQUIRE_SCREENSHOT);
  let txSamplesFile = normalizeOptionalText(env.TX_ANALYSIS_SMOKE_SAMPLES_FILE);
  let txVerifyAssets = parseBoolean(env.TX_ANALYSIS_SMOKE_VERIFY_ASSETS);

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const option = normalizedArgs[index];

    if (option === '--chat') {
      chat = true;
      continue;
    }

    if (option === '--chat-boundary') {
      chatBoundary = true;
      continue;
    }

    if (option === '--chat-follow-up') {
      chat = true;
      chatFollowUp = true;
      continue;
    }

    if (option === '--continue-on-error') {
      continueOnError = true;
      continue;
    }

    if (option === '--base-url') {
      const rawBaseUrl = normalizedArgs[index + 1];
      if (rawBaseUrl === undefined) {
        throw new Error('Missing value for --base-url.');
      }
      baseUrl = normalizeBaseUrl(rawBaseUrl);
      index += 1;
      continue;
    }

    if (option === '--ops-token') {
      const rawOpsToken = normalizedArgs[index + 1];
      if (rawOpsToken === undefined) {
        throw new Error('Missing value for --ops-token.');
      }
      opsToken = normalizeOptionalText(rawOpsToken);
      index += 1;
      continue;
    }

    if (option === '--question') {
      const rawQuestion = normalizedArgs[index + 1];
      if (rawQuestion === undefined) {
        throw new Error('Missing value for --question.');
      }
      question = rawQuestion;
      index += 1;
      continue;
    }

    if (option === '--boundary-question' || option === '--chat-boundary-question') {
      const rawQuestion = normalizedArgs[index + 1];
      if (rawQuestion === undefined) {
        throw new Error(`Missing value for ${option}.`);
      }
      boundaryQuestion = rawQuestion;
      index += 1;
      continue;
    }

    if (option === '--chat-session-id') {
      const rawSessionId = normalizedArgs[index + 1];
      if (rawSessionId === undefined) {
        throw new Error('Missing value for --chat-session-id.');
      }
      chatSessionId = normalizeOptionalText(rawSessionId) ?? DEFAULT_CHAT_SESSION_ID;
      index += 1;
      continue;
    }

    if (option === '--follow-up-question') {
      const rawFollowUpQuestion = normalizedArgs[index + 1];
      if (rawFollowUpQuestion === undefined) {
        throw new Error('Missing value for --follow-up-question.');
      }
      followUpQuestion = rawFollowUpQuestion;
      index += 1;
      continue;
    }

    if (option === '--tx-analysis') {
      txAnalysis = true;
      continue;
    }

    if (option === '--tx-require-report') {
      txRequireReport = true;
      continue;
    }

    if (option === '--tx-require-screenshot') {
      txRequireScreenshot = true;
      continue;
    }

    if (option === '--tx-verify-assets') {
      txVerifyAssets = true;
      continue;
    }

    if (option === '--tx-samples' || option === '--tx-sample-file') {
      const rawTxSamplesFile = normalizedArgs[index + 1];
      if (rawTxSamplesFile === undefined) {
        throw new Error(`Missing value for ${option}.`);
      }
      txSamplesFile = normalizeOptionalText(rawTxSamplesFile);
      txAnalysis = true;
      index += 1;
      continue;
    }

    if (option === '--tx-chain') {
      const rawTxChain = normalizedArgs[index + 1];
      if (rawTxChain === undefined) {
        throw new Error('Missing value for --tx-chain.');
      }
      txChain = rawTxChain;
      index += 1;
      continue;
    }

    if (option === '--tx-hash') {
      const rawTxHash = normalizedArgs[index + 1];
      if (rawTxHash === undefined) {
        throw new Error('Missing value for --tx-hash.');
      }
      txHash = normalizeOptionalText(rawTxHash);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${option}`);
  }

  const txSamples =
    txSamplesFile === undefined
      ? []
      : readTxAnalysisSamples(txSamplesFile, {
          txChain,
          txRequireReport,
          txRequireScreenshot,
          txVerifyAssets,
        });

  if (txAnalysis && txHash === undefined && txSamples.length === 0) {
    throw new Error('Missing value for --tx-hash or TX_ANALYSIS_SMOKE_TX_HASH.');
  }

  return {
    baseUrl,
    chat,
    chatBoundary,
    chatFollowUp,
    chatSessionId,
    continueOnError,
    boundaryQuestion,
    followUpQuestion,
    opsToken,
    question,
    txAnalysis,
    txChain,
    txHash,
    txRequireReport: txRequireReport || txVerifyAssets,
    txRequireScreenshot: txRequireScreenshot || txVerifyAssets,
    txSamples,
    txVerifyAssets,
  };
}

function createCheck(kind, label, baseUrl, pathname, options = {}) {
  return {
    body: options.body,
    headers: options.headers ?? {},
    kind,
    label,
    method: options.method ?? 'GET',
    ...(options.expectedAnalysisRuleVersion === undefined
      ? {}
      : { expectedAnalysisRuleVersion: options.expectedAnalysisRuleVersion }),
    ...(options.expectedChain === undefined ? {} : { expectedChain: options.expectedChain }),
    ...(options.expectedConfidence === undefined
      ? {}
      : { expectedConfidence: options.expectedConfidence }),
    ...(options.expectedContractAddress === undefined
      ? {}
      : { expectedContractAddress: options.expectedContractAddress }),
    ...(options.expectedDataSource === undefined
      ? {}
      : { expectedDataSource: options.expectedDataSource }),
    ...(options.expectedExplorerUrl === undefined
      ? {}
      : { expectedExplorerUrl: options.expectedExplorerUrl }),
    ...(options.expectedFailureMessage === undefined
      ? {}
      : { expectedFailureMessage: options.expectedFailureMessage }),
    ...(options.expectedFailureReason === undefined
      ? {}
      : { expectedFailureReason: options.expectedFailureReason }),
    ...(options.expectedPoolAddress === undefined
      ? {}
      : { expectedPoolAddress: options.expectedPoolAddress }),
    ...(options.expectedProbeAttempts === undefined
      ? {}
      : { expectedProbeAttempts: options.expectedProbeAttempts }),
    ...(options.expectedRelatedTransactionCount === undefined
      ? {}
      : { expectedRelatedTransactionCount: options.expectedRelatedTransactionCount }),
    ...(options.expectedRelatedTransactionRoles === undefined
      ? {}
      : { expectedRelatedTransactionRoles: options.expectedRelatedTransactionRoles }),
    ...(options.expectedRelatedTransactions === undefined
      ? {}
      : { expectedRelatedTransactions: options.expectedRelatedTransactions }),
    ...(options.expectedRouterAddress === undefined
      ? {}
      : { expectedRouterAddress: options.expectedRouterAddress }),
    ...(options.expectedScreenshotTargetRowMarked === undefined
      ? {}
      : { expectedScreenshotTargetRowMarked: options.expectedScreenshotTargetRowMarked }),
    ...(options.expectedStatus === undefined ? {} : { expectedStatus: options.expectedStatus }),
    ...(options.expectedTargetTraderAddress === undefined
      ? {}
      : { expectedTargetTraderAddress: options.expectedTargetTraderAddress }),
    ...(options.expectedTargetTradeSide === undefined
      ? {}
      : { expectedTargetTradeSide: options.expectedTargetTradeSide }),
    ...(options.expectedTransactionTime === undefined
      ? {}
      : { expectedTransactionTime: options.expectedTransactionTime }),
    ...(options.expectedVerdict === undefined ? {} : { expectedVerdict: options.expectedVerdict }),
    ...(options.expectedXxyyPoolUrl === undefined
      ? {}
      : { expectedXxyyPoolUrl: options.expectedXxyyPoolUrl }),
    ...(options.requireReport === true ? { requireReport: true } : {}),
    ...(options.requireScreenshot === true ? { requireScreenshot: true } : {}),
    ...(options.txChain === undefined ? {} : { txChain: options.txChain }),
    ...(options.txHash === undefined ? {} : { txHash: options.txHash }),
    ...(options.verifyAssets === true ? { verifyAssets: true } : {}),
    url: new URL(pathname, baseUrl).toString(),
  };
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  return url.toString();
}

function normalizeOptionalText(value) {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return value;
}

function parseBoolean(value) {
  if (value === undefined) {
    return false;
  }

  return /^(?:1|true|yes)$/iu.test(value.trim());
}

function readTxAnalysisSamples(filePath, defaults) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to read transaction analysis smoke samples from ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const rawSamples = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.samples)
      ? parsed.samples
      : undefined;
  if (rawSamples === undefined || rawSamples.length === 0) {
    throw new Error(
      'Transaction analysis smoke sample file must contain a non-empty samples array.',
    );
  }

  return rawSamples.map((sample, index) => normalizeTxAnalysisSample(sample, index, defaults));
}

function normalizeTxAnalysisSample(sample, index, defaults) {
  if (!isRecord(sample)) {
    throw new Error(`Transaction analysis smoke sample ${index + 1} must be an object.`);
  }

  const txHash = normalizeOptionalText(sample.txHash ?? sample.hash);
  if (txHash === undefined) {
    throw new Error(`Transaction analysis smoke sample ${index + 1} must include txHash.`);
  }

  const expectedStatus = normalizeExpectedStatus(sample.expectedStatus, index);
  const expectedVerdict = normalizeExpectedVerdict(sample.expectedVerdict, index);
  const expectedDataSource = normalizeExpectedDataSource(sample.expectedDataSource, index);
  const expectedChain = normalizeExpectedChain(sample.expectedChain, index);
  const expectedConfidence = normalizeExpectedConfidence(sample.expectedConfidence, index);
  const expectedAnalysisRuleVersion = normalizeExpectedNonEmptyReviewField(
    sample.expectedAnalysisRuleVersion,
    `Transaction analysis smoke sample ${index + 1} expectedAnalysisRuleVersion`,
  );
  const expectedExplorerUrl = normalizeExpectedNonEmptyReviewField(
    sample.expectedExplorerUrl,
    `Transaction analysis smoke sample ${index + 1} expectedExplorerUrl`,
  );
  const expectedFailureMessage = normalizeExpectedNonEmptyReviewField(
    sample.expectedFailureMessage,
    `Transaction analysis smoke sample ${index + 1} expectedFailureMessage`,
  );
  const expectedFailureReason = normalizeExpectedFailureReason(sample.expectedFailureReason, index);
  const expectedPoolAddress = normalizeExpectedNonEmptyReviewField(
    sample.expectedPoolAddress,
    `Transaction analysis smoke sample ${index + 1} expectedPoolAddress`,
  );
  const expectedContractAddress = normalizeExpectedNonEmptyReviewField(
    sample.expectedContractAddress,
    `Transaction analysis smoke sample ${index + 1} expectedContractAddress`,
  );
  const expectedRouterAddress = normalizeExpectedNonEmptyReviewField(
    sample.expectedRouterAddress,
    `Transaction analysis smoke sample ${index + 1} expectedRouterAddress`,
  );
  const expectedScreenshotTargetRowMarked = parseOptionalBoolean(
    sample.expectedScreenshotTargetRowMarked,
    `sample ${index + 1} expectedScreenshotTargetRowMarked`,
  );
  const expectedTargetTradeSide = normalizeExpectedTradeSide(
    sample.expectedTargetTradeSide,
    `Transaction analysis smoke sample ${index + 1} expectedTargetTradeSide`,
  );
  const expectedTargetTraderAddress = normalizeExpectedNonEmptyReviewField(
    sample.expectedTargetTraderAddress,
    `Transaction analysis smoke sample ${index + 1} expectedTargetTraderAddress`,
  );
  const expectedTransactionTime = normalizeExpectedNonEmptyReviewField(
    sample.expectedTransactionTime,
    `Transaction analysis smoke sample ${index + 1} expectedTransactionTime`,
  );
  const expectedXxyyPoolUrl = normalizeExpectedNonEmptyReviewField(
    sample.expectedXxyyPoolUrl,
    `Transaction analysis smoke sample ${index + 1} expectedXxyyPoolUrl`,
  );
  const expectedProbeAttempts = normalizeExpectedProbeAttempts(sample.expectedProbeAttempts, index);
  const expectedRelatedTransactionCount = normalizeExpectedRelatedTransactionCount(
    sample.expectedRelatedTransactionCount,
    index,
  );
  const expectedRelatedTransactionRoles = normalizeExpectedRelatedTransactionRoles(
    sample.expectedRelatedTransactionRoles,
    index,
  );
  const expectedRelatedTransactions = normalizeExpectedRelatedTransactions(
    sample.expectedRelatedTransactions,
    index,
  );
  const hasExpectedReportValue =
    expectedStatus !== undefined ||
    expectedChain !== undefined ||
    expectedVerdict !== undefined ||
    expectedDataSource !== undefined ||
    expectedConfidence !== undefined ||
    expectedAnalysisRuleVersion !== undefined ||
    expectedExplorerUrl !== undefined ||
    expectedFailureMessage !== undefined ||
    expectedFailureReason !== undefined ||
    expectedPoolAddress !== undefined ||
    expectedProbeAttempts !== undefined ||
    expectedContractAddress !== undefined ||
    expectedRouterAddress !== undefined ||
    expectedScreenshotTargetRowMarked !== undefined ||
    expectedTargetTradeSide !== undefined ||
    expectedTargetTraderAddress !== undefined ||
    expectedTransactionTime !== undefined ||
    expectedXxyyPoolUrl !== undefined ||
    expectedRelatedTransactionCount !== undefined ||
    expectedRelatedTransactionRoles !== undefined ||
    expectedRelatedTransactions !== undefined;
  const txChain = normalizeOptionalText(sample.chain ?? sample.txChain) ?? defaults.txChain;
  const label = normalizeOptionalText(sample.label) ?? `sample ${index + 1}`;
  const sampleVerifyAssets = parseOptionalBoolean(
    sample.verifyAssets,
    `sample ${index + 1} verifyAssets`,
  );
  const txVerifyAssets = sampleVerifyAssets ?? (defaults.txVerifyAssets || hasExpectedReportValue);
  const txRequireReport =
    (parseOptionalBoolean(sample.requireReport, `sample ${index + 1} requireReport`) ??
      defaults.txRequireReport) ||
    txVerifyAssets;
  const txRequireScreenshot =
    (parseOptionalBoolean(sample.requireScreenshot, `sample ${index + 1} requireScreenshot`) ??
      defaults.txRequireScreenshot) ||
    txVerifyAssets;

  return {
    expectedAnalysisRuleVersion,
    expectedChain,
    expectedConfidence,
    expectedContractAddress,
    expectedDataSource,
    expectedExplorerUrl,
    expectedFailureMessage,
    expectedFailureReason,
    expectedPoolAddress,
    expectedProbeAttempts,
    expectedRelatedTransactionCount,
    expectedRelatedTransactionRoles,
    expectedRelatedTransactions,
    expectedRouterAddress,
    expectedScreenshotTargetRowMarked,
    expectedStatus,
    expectedTargetTradeSide,
    expectedTargetTraderAddress,
    expectedTransactionTime,
    expectedVerdict,
    expectedXxyyPoolUrl,
    label,
    txChain,
    txHash,
    txRequireReport,
    txRequireScreenshot,
    txVerifyAssets,
  };
}

function parseOptionalBoolean(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return parseBoolean(value);
  }

  throw new Error(`Transaction analysis smoke ${label} must be boolean.`);
}

function normalizeExpectedStatus(value, index) {
  const expectedStatus = normalizeOptionalText(value);
  if (expectedStatus === undefined) {
    return undefined;
  }
  if (expectedStatus !== 'success' && expectedStatus !== 'failure') {
    throw new Error(
      `Transaction analysis smoke sample ${index + 1} expectedStatus must be success or failure.`,
    );
  }

  return expectedStatus;
}

function normalizeExpectedChain(value, index) {
  if (value === undefined) {
    return undefined;
  }
  const expectedChain = normalizeReportChainStrict(value);
  if (expectedChain === undefined || !TX_ANALYSIS_CHAINS.has(expectedChain)) {
    throw new Error(
      `Transaction analysis smoke sample ${index + 1} expectedChain must be a supported chain.`,
    );
  }

  return expectedChain;
}

function normalizeExpectedVerdict(value, index) {
  const expectedVerdict = normalizeOptionalText(value);
  if (expectedVerdict === undefined) {
    return undefined;
  }
  if (!isSupportedVerdict(expectedVerdict)) {
    throw new Error(
      `Transaction analysis smoke sample ${index + 1} expectedVerdict must be a supported verdict.`,
    );
  }

  return expectedVerdict;
}

function normalizeExpectedDataSource(value, index) {
  const expectedDataSource = normalizeOptionalText(value);
  if (expectedDataSource === undefined) {
    return undefined;
  }
  if (expectedDataSource !== 'fixture' && expectedDataSource !== 'browser') {
    throw new Error(
      `Transaction analysis smoke sample ${index + 1} expectedDataSource must be fixture or browser.`,
    );
  }

  return expectedDataSource;
}

function normalizeExpectedConfidence(value, index) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `Transaction analysis smoke sample ${index + 1} expectedConfidence must be a number from 0 to 1.`,
    );
  }

  return value;
}

function normalizeExpectedFailureReason(value, index) {
  const expectedFailureReason = normalizeOptionalText(value);
  if (expectedFailureReason === undefined) {
    return undefined;
  }
  if (!TX_ANALYSIS_FAILURE_REASONS.has(expectedFailureReason)) {
    throw new Error(
      `Transaction analysis smoke sample ${index + 1} expectedFailureReason must be a supported failure reason.`,
    );
  }

  return expectedFailureReason;
}

function normalizeExpectedReviewField(value) {
  return normalizeOptionalText(value)?.trim();
}

function normalizeExpectedNonEmptyReviewField(value, label) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeExpectedReviewField(value);
  if (normalized === undefined) {
    throw new Error(`${label} must be non-empty when provided.`);
  }

  return normalized;
}

function normalizeExpectedTradeSide(value, label) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeExpectedReviewField(value);
  if (normalized === undefined || !TX_ANALYSIS_TRADE_SIDES.has(normalized)) {
    throw new Error(`${label} must be buy, sell, or unknown.`);
  }

  return normalized;
}

function normalizeExpectedRelatedTransactionCount(value, sampleIndex) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `Transaction analysis smoke sample ${
        sampleIndex + 1
      } expectedRelatedTransactionCount must be a non-negative integer.`,
    );
  }

  return value;
}

function normalizeExpectedRelatedTransactionRoles(value, sampleIndex) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Transaction analysis smoke sample ${
        sampleIndex + 1
      } expectedRelatedTransactionRoles must be a non-empty array.`,
    );
  }

  return value.map((role, roleIndex) => {
    const normalized = normalizeExpectedReviewField(role);
    if (normalized === undefined || !TX_ANALYSIS_RELATED_TRANSACTION_ROLES.has(normalized)) {
      throw new Error(
        `Transaction analysis smoke sample ${
          sampleIndex + 1
        } expectedRelatedTransactionRoles item ${roleIndex + 1} must be a supported role.`,
      );
    }

    return normalized;
  });
}

function normalizeExpectedRelatedTransactions(value, sampleIndex) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Transaction analysis smoke sample ${sampleIndex + 1} expectedRelatedTransactions must be a non-empty array.`,
    );
  }

  return value.map((item, itemIndex) =>
    normalizeExpectedRelatedTransaction(item, sampleIndex, itemIndex),
  );
}

function normalizeExpectedRelatedTransaction(item, sampleIndex, itemIndex) {
  if (!isRecord(item)) {
    throw new Error(
      `Transaction analysis smoke sample ${sampleIndex + 1} expectedRelatedTransactions item ${
        itemIndex + 1
      } must be an object.`,
    );
  }

  const hash = normalizeExpectedReviewField(item.hash ?? item.txHash);
  const role = normalizeExpectedReviewField(item.role);
  const side = normalizeExpectedTradeSide(
    item.side ?? item.tradeSide,
    `Transaction analysis smoke sample ${sampleIndex + 1} expectedRelatedTransactions item ${
      itemIndex + 1
    } side`,
  );
  const explorerUrl = normalizeExpectedNonEmptyReviewField(
    item.explorerUrl ??
      item.explorer_url ??
      item.explorerLink ??
      item.explorer_link ??
      item.txUrl ??
      item.tx_url ??
      item.txLink ??
      item.tx_link ??
      item.transactionUrl ??
      item.transaction_url ??
      item.transactionLink ??
      item.transaction_link ??
      item.url ??
      item.link ??
      item.href,
    `Transaction analysis smoke sample ${sampleIndex + 1} expectedRelatedTransactions item ${
      itemIndex + 1
    } explorerUrl`,
  );
  if (explorerUrl !== undefined && !isHttpUrl(explorerUrl)) {
    throw new Error(
      `Transaction analysis smoke sample ${sampleIndex + 1} expectedRelatedTransactions item ${
        itemIndex + 1
      } explorerUrl must be an HTTP URL when provided.`,
    );
  }
  const timestamp = normalizeExpectedNonEmptyReviewField(
    item.timestamp,
    `Transaction analysis smoke sample ${sampleIndex + 1} expectedRelatedTransactions item ${
      itemIndex + 1
    } timestamp`,
  );
  const traderAddress = normalizeExpectedNonEmptyReviewField(
    item.traderAddress,
    `Transaction analysis smoke sample ${sampleIndex + 1} expectedRelatedTransactions item ${
      itemIndex + 1
    } traderAddress`,
  );
  if (
    hash === undefined ||
    role === undefined ||
    !TX_ANALYSIS_RELATED_TRANSACTION_ROLES.has(role)
  ) {
    throw new Error(
      `Transaction analysis smoke sample ${sampleIndex + 1} expectedRelatedTransactions item ${
        itemIndex + 1
      } must include hash and a supported role.`,
    );
  }

  return {
    hash,
    role,
    ...(explorerUrl === undefined ? {} : { explorerUrl }),
    ...(side === undefined ? {} : { side }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(traderAddress === undefined ? {} : { traderAddress }),
  };
}

function normalizeExpectedProbeAttempts(value, sampleIndex) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `Transaction analysis smoke sample ${sampleIndex + 1} expectedProbeAttempts must be a non-empty array.`,
    );
  }

  return value.map((item, itemIndex) =>
    normalizeExpectedProbeAttempt(item, sampleIndex, itemIndex),
  );
}

function normalizeExpectedProbeAttempt(item, sampleIndex, itemIndex) {
  if (!isRecord(item)) {
    throw new Error(
      `Transaction analysis smoke sample ${sampleIndex + 1} expectedProbeAttempts item ${
        itemIndex + 1
      } must be an object.`,
    );
  }

  const chain = normalizeExpectedReviewField(item.chain);
  const reason = normalizeExpectedReviewField(item.reason);
  const message = normalizeExpectedNonEmptyReviewField(
    item.message,
    `Transaction analysis smoke sample ${sampleIndex + 1} expectedProbeAttempts item ${
      itemIndex + 1
    } message`,
  );
  if (
    chain === undefined ||
    reason === undefined ||
    !TX_ANALYSIS_CHAINS.has(chain) ||
    !TX_ANALYSIS_FAILURE_REASONS.has(reason)
  ) {
    throw new Error(
      `Transaction analysis smoke sample ${sampleIndex + 1} expectedProbeAttempts item ${
        itemIndex + 1
      } must include a supported chain and reason.`,
    );
  }

  return {
    chain,
    ...(message === undefined ? {} : { message }),
    reason,
  };
}

async function readPayload(response) {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}

function validatePayload(check, payload) {
  if (check.kind === 'opsSummary') {
    return validateOpsSummaryPayload(payload);
  }

  if (check.kind === 'chat' || check.kind === 'chatBoundary' || check.kind === 'chatFollowUp') {
    return validateChatPayload(payload, check);
  }

  if (check.kind === 'txAnalysis') {
    if (payload === null || typeof payload !== 'object') {
      return 'transaction analysis response must be JSON.';
    }
    if (typeof payload.answer !== 'string' || payload.answer.trim().length === 0) {
      return 'transaction analysis response must include an answer.';
    }
    if (payload.intent !== 'tx_sandwich_detection') {
      return 'transaction analysis response must use tx_sandwich_detection intent.';
    }
    if (check.verifyAssets === true && !hasImageAttachment(payload)) {
      return 'transaction analysis response must include an image attachment when verifying assets.';
    }
    if (check.verifyAssets === true && !hasReportLink(payload.answer)) {
      return 'transaction analysis response must include a report link when verifying assets.';
    }
    if (check.requireScreenshot === true && !hasImageAttachment(payload)) {
      return 'transaction analysis response must include an image attachment.';
    }
    if (check.requireReport === true && !hasReportLink(payload.answer)) {
      return 'transaction analysis response must include a report link.';
    }
  }

  return undefined;
}

function validateChatPayload(payload, check) {
  if (payload === null || typeof payload !== 'object') {
    return 'chat response must be JSON.';
  }
  if (typeof payload.answer !== 'string' || payload.answer.trim().length === 0) {
    return 'chat response must include an answer.';
  }
  if (!Array.isArray(payload.citations)) {
    return 'chat response must include citations.';
  }
  if (check.kind !== 'chatBoundary' && payload.citations.length === 0) {
    return 'chat response must include citations.';
  }
  if (check.kind === 'chatBoundary' && payload.intent !== 'realtime_account_query') {
    return 'chat boundary response must use realtime_account_query intent.';
  }
  if (CHAT_HANDOFF_WORDING_PATTERNS.some((pattern) => pattern.test(payload.answer))) {
    return `${check.label} response must not ask for manual handoff.`;
  }

  return undefined;
}

function validateOpsSummaryPayload(payload) {
  if (!isRecord(payload)) {
    return 'ops summary response must be JSON.';
  }

  const runtime = payload.txAnalysisRuntime;
  if (
    !isRecord(runtime) ||
    !isCleanNonEmptyString(runtime.provider) ||
    !isCleanNonEmptyString(runtime.reviewer) ||
    !isCleanNonEmptyString(runtime.reportStore)
  ) {
    return 'ops summary must include transaction analysis runtime provider, reviewer, and report store.';
  }

  const browser = runtime.browser;
  if (
    !isRecord(browser) ||
    !isPositiveInteger(browser.maxConcurrency) ||
    !isNonNegativeInteger(browser.maxRetries) ||
    !isPositiveInteger(browser.timeoutMs)
  ) {
    return 'ops summary must include transaction analysis browser concurrency, retries, and timeout.';
  }

  if (typeof browser.headless !== 'boolean' || !isCleanNonEmptyString(browser.screenshotBaseUrl)) {
    return 'ops summary must include transaction analysis browser mode and screenshot base URL.';
  }

  const knowledgeCandidateQueues = payload.knowledgeCandidateQueues;
  const knowledgeCandidateQueueError =
    validateKnowledgeCandidateQueueSummary(knowledgeCandidateQueues);
  if (knowledgeCandidateQueueError !== undefined) {
    return knowledgeCandidateQueueError;
  }

  return undefined;
}

function validateKnowledgeCandidateQueueSummary(value) {
  if (!isRecord(value)) {
    return 'ops summary must include knowledge candidate queue counts and recent quality gaps.';
  }

  if (
    !isNonNegativeInteger(value.needsReviewCount) ||
    !isNonNegativeInteger(value.qualitySignalNeedsReviewCount) ||
    !isNonNegativeInteger(value.approvedEvalCaseCount) ||
    !isNonNegativeInteger(value.evalFailedCount) ||
    !Array.isArray(value.recentEvalFailures) ||
    !Array.isArray(value.recentQualitySignals)
  ) {
    return 'ops summary must include knowledge candidate queue counts and recent quality gaps.';
  }

  if (!hasReasonCounts(value.evalFailureReasonCounts)) {
    return 'ops summary must include valid eval failure reason counts.';
  }

  if (!value.recentQualitySignals.every(isQualitySignalCandidateSummary)) {
    return 'ops summary must include knowledge candidate queue counts and recent quality gaps.';
  }

  if (!hasReasonCounts(value.qualitySignalReasonCounts)) {
    return 'ops summary must include valid quality signal reason counts.';
  }

  if (!hasReasonCounts(value.qualitySignalAgentRouteCounts)) {
    return 'ops summary must include valid quality signal route counts.';
  }

  const reasonTotal = Object.values(value.qualitySignalReasonCounts).reduce(
    (total, count) => total + count,
    0,
  );
  if (reasonTotal !== value.qualitySignalNeedsReviewCount) {
    return 'ops summary quality signal reason counts must match the quality gap queue count.';
  }

  const routeTotal = Object.values(value.qualitySignalAgentRouteCounts).reduce(
    (total, count) => total + count,
    0,
  );
  if (routeTotal !== value.qualitySignalNeedsReviewCount) {
    return 'ops summary quality signal route counts must match the quality gap queue count.';
  }

  return undefined;
}

function hasReasonCounts(value) {
  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).every(
    ([reason, count]) => isCleanNonEmptyString(reason) && isNonNegativeInteger(count),
  );
}

function isQualitySignalCandidateSummary(value) {
  return (
    isRecord(value) &&
    isCleanNonEmptyString(value.agentRoute) &&
    isCleanNonEmptyString(value.candidateId) &&
    isCleanNonEmptyString(value.createdAt) &&
    isCleanNonEmptyString(value.question) &&
    isCleanNonEmptyString(value.riskLevel) &&
    isCleanNonEmptyString(value.targetCategory) &&
    isCleanNonEmptyString(value.type)
  );
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

async function verifyTxAnalysisAssets(check, payload, fetchFn, log) {
  const assetChecks = createTxAnalysisAssetChecks(check.url, payload);

  for (const assetCheck of assetChecks) {
    log(`==> ${assetCheck.label}`);
    const response = await fetchFn(assetCheck.url, { headers: {}, method: 'GET' });
    const reportPayload = assetCheck.kind === 'report' ? await readPayload(response) : undefined;
    if (!response.ok) {
      log(`Failed ${assetCheck.label}: HTTP ${response.status}`);
      log(formatPayload(reportPayload ?? (await readPayload(response))));
      return false;
    }
    if (assetCheck.kind === 'screenshot') {
      const validationError = await validateTxAnalysisScreenshotResponse(response);
      if (validationError !== undefined) {
        log(`Failed ${assetCheck.label}: ${validationError}`);
        return false;
      }
    }
    if (assetCheck.kind === 'report') {
      const validationError = validateTxAnalysisReportDocument(reportPayload, check, payload);
      if (validationError !== undefined) {
        log(`Failed ${assetCheck.label}: ${validationError}`);
        log(formatPayload(reportPayload));
        return false;
      }
    }
    log(`OK ${assetCheck.label}`);
  }

  return true;
}

function createTxAnalysisAssetChecks(txAnalysisUrl, payload) {
  return [
    {
      kind: 'screenshot',
      label: 'transaction analysis screenshot',
      url: new URL(firstImageAttachmentUrl(payload), txAnalysisUrl).toString(),
    },
    {
      kind: 'report',
      label: 'transaction analysis report',
      url: new URL(extractReportLink(payload.answer), txAnalysisUrl).toString(),
    },
  ];
}

async function validateTxAnalysisScreenshotResponse(response) {
  if (!response.headers?.get('content-type')?.toLowerCase().startsWith('image/')) {
    return 'transaction analysis screenshot must return an image content type.';
  }
  const bytes = await readResponseBytes(response);
  if (!isSupportedImageBody(bytes)) {
    return 'transaction analysis screenshot must return a non-empty supported image body.';
  }

  return undefined;
}

async function readResponseBytes(response) {
  if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  return new TextEncoder().encode(await response.text());
}

function isSupportedImageBody(bytes) {
  if (bytes.length === 0) {
    return false;
  }

  return (
    hasBytePrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    hasBytePrefix(bytes, [0xff, 0xd8, 0xff]) ||
    hasBytePrefix(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    isWebpBody(bytes) ||
    isSvgBody(bytes)
  );
}

function hasBytePrefix(bytes, prefix) {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function isWebpBody(bytes) {
  return (
    bytes.length >= 12 &&
    hasBytePrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function isSvgBody(bytes) {
  const text = new TextDecoder().decode(bytes).trimStart().toLowerCase();
  return text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'));
}

function validateTxAnalysisReportDocument(payload, check, chatPayload) {
  const error =
    'transaction analysis report document must include version 1, status, reference, and result/failure.';
  if (!isRecord(payload) || payload.version !== 1 || !isRecord(payload.reference)) {
    return error;
  }

  const hasValidBody =
    (payload.status === 'success' && isRecord(payload.result)) ||
    (payload.status === 'failure' && isRecord(payload.failure));
  if (!hasValidBody) {
    return error;
  }

  const expectedReportError = validateTxAnalysisExpectedReportValues(payload, check);
  if (expectedReportError !== undefined) {
    return expectedReportError;
  }

  const referenceError = validateTxAnalysisReportReference(payload.reference, check);
  if (referenceError !== undefined) {
    return referenceError;
  }
  if (payload.status === 'success') {
    const resultError = validateTxAnalysisReportResult(payload.result, check);
    if (resultError !== undefined) {
      return resultError;
    }
    const resultShapeError = validateTxAnalysisReportResultShape(payload.result, check);
    if (resultShapeError !== undefined) {
      return resultShapeError;
    }
    const screenshotError = validateTxAnalysisReportResultScreenshot(
      payload.result,
      chatPayload,
      check.url,
    );
    if (screenshotError !== undefined) {
      return screenshotError;
    }
  }
  if (payload.status === 'failure') {
    const failureShapeError = validateTxAnalysisFailureReportShape(payload.failure, check);
    if (failureShapeError !== undefined) {
      return failureShapeError;
    }
    const screenshotError = validateTxAnalysisFailureReportScreenshot(
      payload.failure,
      chatPayload,
      check.url,
    );
    if (screenshotError !== undefined) {
      return screenshotError;
    }
  }

  return undefined;
}

function validateTxAnalysisExpectedReportValues(payload, check) {
  if (check.expectedStatus !== undefined && payload.status !== check.expectedStatus) {
    return 'transaction analysis report status must match expected sample status.';
  }

  if (
    check.expectedVerdict !== undefined &&
    (payload.status !== 'success' || payload.result?.verdict !== check.expectedVerdict)
  ) {
    return 'transaction analysis report verdict must match expected sample verdict.';
  }

  if (
    check.expectedDataSource !== undefined &&
    (payload.status !== 'success' || payload.result?.dataSource !== check.expectedDataSource)
  ) {
    return 'transaction analysis report data source must match expected sample data source.';
  }

  if (
    check.expectedConfidence !== undefined &&
    (payload.status !== 'success' || payload.result?.confidence !== check.expectedConfidence)
  ) {
    return 'transaction analysis report confidence must match expected sample confidence.';
  }

  if (
    check.expectedAnalysisRuleVersion !== undefined &&
    (payload.status !== 'success' ||
      payload.result?.analysisRuleVersion !== check.expectedAnalysisRuleVersion)
  ) {
    return 'transaction analysis report rule version must match expected sample rule version.';
  }

  if (
    check.expectedFailureReason !== undefined &&
    (payload.status !== 'failure' || payload.failure?.reason !== check.expectedFailureReason)
  ) {
    return 'transaction analysis failure reason must match expected sample reason.';
  }

  if (
    check.expectedFailureMessage !== undefined &&
    (payload.status !== 'failure' ||
      !reviewFieldMatchesExpected(payload.failure?.message, check.expectedFailureMessage))
  ) {
    return 'transaction analysis failure message must match expected sample message.';
  }

  const reviewSource =
    payload.status === 'success'
      ? payload.result
      : isRecord(payload.failure)
        ? payload.failure.metadata
        : undefined;
  if (
    check.expectedExplorerUrl !== undefined &&
    !reviewFieldMatchesExpected(reviewSource?.explorerUrl, check.expectedExplorerUrl)
  ) {
    return 'transaction analysis report explorer URL must match expected sample explorer URL.';
  }
  if (
    check.expectedPoolAddress !== undefined &&
    !reviewFieldMatchesExpected(reviewSource?.poolAddress, check.expectedPoolAddress)
  ) {
    return 'transaction analysis report pool address must match expected sample pool address.';
  }
  if (
    check.expectedContractAddress !== undefined &&
    !reviewFieldMatchesExpected(reviewSource?.contractAddress, check.expectedContractAddress)
  ) {
    return 'transaction analysis report contract address must match expected sample contract address.';
  }
  if (
    check.expectedRouterAddress !== undefined &&
    !reviewFieldMatchesExpected(reviewSource?.routerAddress, check.expectedRouterAddress)
  ) {
    return 'transaction analysis report router address must match expected sample router address.';
  }
  if (
    check.expectedTargetTraderAddress !== undefined &&
    !reviewFieldMatchesExpected(
      reviewSource?.targetTraderAddress,
      check.expectedTargetTraderAddress,
    )
  ) {
    return 'transaction analysis report target trader address must match expected sample target trader address.';
  }
  if (
    check.expectedScreenshotTargetRowMarked !== undefined &&
    reviewSource?.screenshotTargetRowMarked !== check.expectedScreenshotTargetRowMarked
  ) {
    return 'transaction analysis report screenshot target row marker must match expected sample value.';
  }
  if (
    check.expectedTargetTradeSide !== undefined &&
    !tradeSideMatchesExpected(reviewSource?.targetTradeSide, check.expectedTargetTradeSide)
  ) {
    return 'transaction analysis report target trade side must match expected sample target trade side.';
  }
  if (
    check.expectedTransactionTime !== undefined &&
    !reviewFieldMatchesExpected(reviewSource?.transactionTime, check.expectedTransactionTime)
  ) {
    return 'transaction analysis report transaction time must match expected sample transaction time.';
  }
  if (
    check.expectedXxyyPoolUrl !== undefined &&
    !reviewFieldMatchesExpected(reviewSource?.xxyyPoolUrl, check.expectedXxyyPoolUrl)
  ) {
    return 'transaction analysis report XXYY pool URL must match expected sample XXYY pool URL.';
  }
  if (check.expectedRelatedTransactionCount !== undefined) {
    const relatedTransactionCountError = validateExpectedRelatedTransactionCount(
      reviewSource?.relatedTransactions,
      check.expectedRelatedTransactionCount,
    );
    if (relatedTransactionCountError !== undefined) {
      return relatedTransactionCountError;
    }
  }
  if (check.expectedRelatedTransactionRoles !== undefined) {
    const relatedTransactionRolesError = validateExpectedRelatedTransactionRoles(
      reviewSource?.relatedTransactions,
      check.expectedRelatedTransactionRoles,
    );
    if (relatedTransactionRolesError !== undefined) {
      return relatedTransactionRolesError;
    }
  }
  if (check.expectedRelatedTransactions !== undefined) {
    const relatedTransactionsError = validateExpectedRelatedTransactions(
      reviewSource?.relatedTransactions,
      check.expectedRelatedTransactions,
    );
    if (relatedTransactionsError !== undefined) {
      return relatedTransactionsError;
    }
  }
  if (check.expectedProbeAttempts !== undefined) {
    const probeAttemptsError = validateExpectedProbeAttempts(
      reviewSource?.probeAttempts,
      check.expectedProbeAttempts,
    );
    if (probeAttemptsError !== undefined) {
      return probeAttemptsError;
    }
  }

  return undefined;
}

function validateExpectedRelatedTransactionCount(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected) {
    return 'transaction analysis report related transaction count must match expected sample count.';
  }

  return undefined;
}

function validateExpectedRelatedTransactionRoles(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    return 'transaction analysis report related transaction roles must match expected sample roles.';
  }

  for (const [index, expectedRole] of expected.entries()) {
    const actualItem = actual[index];
    if (!isRecord(actualItem) || actualItem.role !== expectedRole) {
      return 'transaction analysis report related transaction roles must match expected sample roles.';
    }
  }

  return undefined;
}

function reviewFieldMatchesExpected(actual, expected) {
  if (typeof actual !== 'string' || actual.trim().length === 0) {
    return false;
  }

  return normalizeComparableAddress(actual.trim()) === normalizeComparableAddress(expected);
}

function validateExpectedRelatedTransactions(actual, expected) {
  if (!Array.isArray(actual)) {
    return 'transaction analysis report related transactions must include expected sample transactions.';
  }

  for (const expectedItem of expected) {
    const candidates = actual.filter(
      (item) =>
        isRecord(item) &&
        item.role === expectedItem.role &&
        normalizeComparableTxHash(item.hash) === normalizeComparableTxHash(expectedItem.hash),
    );

    if (candidates.length === 0) {
      return 'transaction analysis report related transactions must include expected sample transactions.';
    }

    if (candidates.some((item) => relatedTransactionMatchesExpected(item, expectedItem))) {
      continue;
    }

    const detailError = relatedTransactionDetailMismatch(candidates, expectedItem);
    if (detailError !== undefined) {
      return detailError;
    }

    return 'transaction analysis report related transactions must include expected sample transactions.';
  }

  return undefined;
}

function relatedTransactionMatchesExpected(actual, expected) {
  return (
    optionalReviewFieldMatchesExpected(actual.explorerUrl, expected.explorerUrl) &&
    optionalTradeSideMatchesExpected(actual.side, expected.side) &&
    optionalReviewFieldMatchesExpected(actual.timestamp, expected.timestamp) &&
    optionalReviewFieldMatchesExpected(actual.traderAddress, expected.traderAddress)
  );
}

function relatedTransactionDetailMismatch(candidates, expected) {
  if (
    expected.explorerUrl !== undefined &&
    !candidates.some((item) =>
      optionalReviewFieldMatchesExpected(item.explorerUrl, expected.explorerUrl),
    )
  ) {
    return 'transaction analysis report related transaction explorer URL must match expected sample transaction.';
  }
  if (
    expected.side !== undefined &&
    !candidates.some((item) => optionalTradeSideMatchesExpected(item.side, expected.side))
  ) {
    return 'transaction analysis report related transaction side must match expected sample transaction.';
  }
  if (
    expected.timestamp !== undefined &&
    !candidates.some((item) =>
      optionalReviewFieldMatchesExpected(item.timestamp, expected.timestamp),
    )
  ) {
    return 'transaction analysis report related transaction timestamp must match expected sample transaction.';
  }
  if (
    expected.traderAddress !== undefined &&
    !candidates.some((item) =>
      optionalReviewFieldMatchesExpected(item.traderAddress, expected.traderAddress),
    )
  ) {
    return 'transaction analysis report related transaction trader address must match expected sample transaction.';
  }

  return undefined;
}

function validateExpectedProbeAttempts(actual, expected) {
  if (!Array.isArray(actual)) {
    return 'transaction analysis failure probe attempts must include expected sample probes.';
  }

  for (const expectedItem of expected) {
    const candidates = actual.filter((item) => isRecord(item));
    if (candidates.some((item) => probeAttemptMatchesExpected(item, expectedItem))) {
      continue;
    }

    const detailError = probeAttemptDetailMismatch(candidates, expectedItem);
    if (detailError !== undefined) {
      return detailError;
    }

    return 'transaction analysis failure probe attempts must include expected sample probes.';
  }

  return undefined;
}

function probeAttemptMatchesExpected(actual, expected) {
  return (
    actual.chain === expected.chain &&
    actual.reason === expected.reason &&
    optionalPlainTextMatchesExpected(actual.message, expected.message)
  );
}

function probeAttemptDetailMismatch(candidates, expected) {
  if (
    !candidates.some(
      (item) =>
        item.chain === expected.chain &&
        optionalPlainTextMatchesExpected(item.message, expected.message),
    ) &&
    candidates.some(
      (item) =>
        item.reason === expected.reason &&
        optionalPlainTextMatchesExpected(item.message, expected.message),
    )
  ) {
    return 'transaction analysis failure probe attempt chain must match expected sample probe.';
  }
  if (
    !candidates.some(
      (item) =>
        item.reason === expected.reason &&
        optionalPlainTextMatchesExpected(item.message, expected.message),
    ) &&
    candidates.some(
      (item) =>
        item.chain === expected.chain &&
        optionalPlainTextMatchesExpected(item.message, expected.message),
    )
  ) {
    return 'transaction analysis failure probe attempt reason must match expected sample probe.';
  }
  if (
    expected.message !== undefined &&
    !candidates.some(
      (item) =>
        item.message === expected.message &&
        item.chain === expected.chain &&
        item.reason === expected.reason,
    ) &&
    candidates.some((item) => item.chain === expected.chain && item.reason === expected.reason)
  ) {
    return 'transaction analysis failure probe attempt message must match expected sample probe.';
  }

  return undefined;
}

function optionalPlainTextMatchesExpected(actual, expected) {
  return expected === undefined || (typeof actual === 'string' && actual.trim() === expected);
}

function optionalReviewFieldMatchesExpected(actual, expected) {
  return expected === undefined || reviewFieldMatchesExpected(actual, expected);
}

function tradeSideMatchesExpected(actual, expected) {
  return typeof actual === 'string' && actual === expected;
}

function optionalTradeSideMatchesExpected(actual, expected) {
  return expected === undefined || tradeSideMatchesExpected(actual, expected);
}

function validateTxAnalysisFailureReportShape(failure, check) {
  if (!isCleanNonEmptyString(failure.message) || !TX_ANALYSIS_FAILURE_REASONS.has(failure.reason)) {
    return 'transaction analysis failure report must include a supported reason and clean non-empty message.';
  }

  const metadataError = validateTxAnalysisFailureMetadata(failure.metadata);
  if (metadataError !== undefined) {
    return metadataError;
  }

  if (
    isTargetTradeFailureReason(failure.reason) &&
    (!isHttpUrl(failure.metadata?.explorerUrl) || !isHttpUrl(failure.metadata?.xxyyPoolUrl))
  ) {
    return 'transaction analysis target-trade failure report must include transaction explorer and XXYY pool URLs.';
  }

  if (
    isTargetTradeFailureReason(failure.reason) &&
    !hasChainMatchedFailureReviewLinks(failure, check)
  ) {
    return 'transaction analysis failure review links must match requested chain.';
  }

  if (
    isTargetTradeFailureReason(failure.reason) &&
    !explorerUrlMatchesRequestedTxHash(failure.metadata?.explorerUrl, check)
  ) {
    return 'transaction analysis failure explorer URL must match requested transaction hash.';
  }

  if (
    isTargetTradeFailureReason(failure.reason) &&
    !xxyyPoolUrlMatchesPoolAddress(failure.metadata?.xxyyPoolUrl, failure.metadata?.poolAddress)
  ) {
    return 'transaction analysis failure XXYY pool URL must match reported pool address.';
  }

  if (
    isTargetTradeFailureReason(failure.reason) &&
    !hasOptionalReviewableRelatedTransactions(failure.metadata?.relatedTransactions)
  ) {
    return 'transaction analysis failure related transactions must include valid role, hash, and summary.';
  }

  if (
    isTargetTradeFailureReason(failure.reason) &&
    !hasOptionalUniqueRelatedTransactionHashes(failure.metadata?.relatedTransactions)
  ) {
    return 'transaction analysis failure related transactions must not contain duplicate hashes.';
  }

  if (
    isTargetTradeFailureReason(failure.reason) &&
    !hasOptionalUsableFailureRelatedTransactions(failure.metadata?.relatedTransactions, check)
  ) {
    return 'transaction analysis failure related transactions must include requested user transaction.';
  }

  if (
    isTargetTradeFailureReason(failure.reason) &&
    !hasOptionalRelatedTransactionExplorerUrlsMatchingHashes(failure.metadata?.relatedTransactions)
  ) {
    return 'transaction analysis failure related transaction explorer URLs must match their transaction hashes.';
  }

  return undefined;
}

function validateTxAnalysisFailureMetadata(metadata) {
  if (metadata === undefined || metadata === null) {
    return undefined;
  }
  if (!isRecord(metadata)) {
    return TX_ANALYSIS_FAILURE_METADATA_CLEAN_ERROR;
  }

  for (const field of TX_ANALYSIS_FAILURE_METADATA_TEXT_FIELDS) {
    if (!Object.hasOwn(metadata, field)) {
      continue;
    }

    const value = metadata[field];
    if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
      return TX_ANALYSIS_FAILURE_METADATA_CLEAN_ERROR;
    }
  }

  if (
    Object.hasOwn(metadata, 'probeAttempts') &&
    !hasCleanFailureProbeAttempts(metadata.probeAttempts)
  ) {
    return TX_ANALYSIS_FAILURE_METADATA_CLEAN_ERROR;
  }

  if (
    Object.hasOwn(metadata, 'targetTradeSide') &&
    !TX_ANALYSIS_TRADE_SIDES.has(metadata.targetTradeSide)
  ) {
    return TX_ANALYSIS_FAILURE_METADATA_CLEAN_ERROR;
  }

  if (
    Object.hasOwn(metadata, 'screenshotTargetRowMarked') &&
    typeof metadata.screenshotTargetRowMarked !== 'boolean'
  ) {
    return TX_ANALYSIS_FAILURE_METADATA_CLEAN_ERROR;
  }

  return undefined;
}

function hasCleanFailureProbeAttempts(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        isRecord(item) &&
        TX_ANALYSIS_CHAINS.has(item.chain) &&
        TX_ANALYSIS_FAILURE_REASONS.has(item.reason) &&
        typeof item.message === 'string' &&
        item.message.trim().length > 0 &&
        item.message === item.message.trim(),
    )
  );
}

function isTargetTradeFailureReason(reason) {
  return reason === 'target_trade_not_found' || reason === 'screenshot_unavailable';
}

function validateTxAnalysisReportReference(reference, check) {
  return validateTxAnalysisReportIdentity(reference, check, 'reference');
}

function validateTxAnalysisReportResult(result, check) {
  return validateTxAnalysisReportIdentity(result, check, 'result');
}

function validateTxAnalysisReportResultShape(result, check) {
  const error =
    'transaction analysis report result must include verdict, confidence, summary, evidence, related transactions, and analyzedAt.';
  if (
    !isSupportedVerdict(result.verdict) ||
    typeof result.confidence !== 'number' ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > 1 ||
    !isCleanNonEmptyString(result.summary) ||
    !isCleanNonEmptyString(result.analyzedAt) ||
    !hasUsableEvidence(result.evidence) ||
    !hasUsableRelatedTransactions(result.relatedTransactions, check)
  ) {
    return error;
  }

  if (!isHttpUrl(result.explorerUrl) || !isHttpUrl(result.xxyyPoolUrl)) {
    return 'transaction analysis report result must include transaction explorer and XXYY pool URLs.';
  }

  if (!hasRelatedTransactionExplorerUrls(result.relatedTransactions)) {
    return 'transaction analysis report related transactions must include valid explorer URLs.';
  }

  if (!hasReviewableRelatedTransactions(result.relatedTransactions)) {
    return 'transaction analysis report related transactions must include valid role, hash, and summary.';
  }

  if (!hasUniqueRelatedTransactionHashes(result.relatedTransactions)) {
    return 'transaction analysis report related transactions must not contain duplicate hashes.';
  }

  if (!hasRelatedTransactionExplorerUrlsMatchingHashes(result.relatedTransactions)) {
    return 'transaction analysis report related transaction explorer URLs must match their transaction hashes.';
  }

  if (
    Object.hasOwn(result, 'targetTradeSide') &&
    !TX_ANALYSIS_TRADE_SIDES.has(result.targetTradeSide)
  ) {
    return 'transaction analysis report result target trade side must be buy, sell, or unknown.';
  }

  if (!hasChainMatchedReviewLinks(result, check)) {
    return 'transaction analysis report review links must match requested chain.';
  }

  if (!explorerUrlMatchesRequestedTxHash(result.explorerUrl, check)) {
    return 'transaction analysis report explorer URL must match requested transaction hash.';
  }

  if (!xxyyPoolUrlMatchesPoolAddress(result.xxyyPoolUrl, result.poolAddress)) {
    return 'transaction analysis report XXYY pool URL must match reported pool address.';
  }

  if (result.verdict === 'sandwiched' && !hasSandwichLegTransactions(result.relatedTransactions)) {
    return 'sandwiched reports must include front-run and back-run transactions.';
  }

  if (
    result.verdict === 'sandwiched' &&
    !hasSandwichEvidenceHashes(result.evidence, result.relatedTransactions)
  ) {
    return 'sandwiched reports must include evidence that references the target, front-run, and back-run hashes.';
  }

  return undefined;
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isSupportedVerdict(value) {
  return value === 'sandwiched' || value === 'not_sandwiched' || value === 'inconclusive';
}

function hasUsableEvidence(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        isRecord(item) &&
        isCleanNonEmptyString(item.label) &&
        isCleanNonEmptyString(item.detail) &&
        (item.severity === 'info' || item.severity === 'warning' || item.severity === 'critical'),
    )
  );
}

function isCleanNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

function hasUsableRelatedTransactions(value, check) {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  const requestedTxHash = extractRequestedTxHash(check.txHash);
  if (requestedTxHash === undefined) {
    return true;
  }

  return value.some(
    (item) =>
      isRecord(item) &&
      item.role === 'user' &&
      normalizeComparableTxHash(item.hash) === normalizeComparableTxHash(requestedTxHash),
  );
}

function hasRelatedTransactionExplorerUrls(value) {
  return (
    Array.isArray(value) && value.every((item) => isRecord(item) && isHttpUrl(item.explorerUrl))
  );
}

function hasRelatedTransactionExplorerUrlsMatchingHashes(value) {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && relatedTransactionExplorerUrlMatchesHash(item))
  );
}

function hasReviewableRelatedTransactions(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isRecord(item) && isReviewableRelatedTransaction(item))
  );
}

function hasOptionalReviewableRelatedTransactions(value) {
  if (value === undefined || value === null) {
    return true;
  }

  return hasReviewableRelatedTransactions(value);
}

function hasUniqueRelatedTransactionHashes(value) {
  if (!Array.isArray(value)) {
    return false;
  }

  const seenHashes = new Set();
  for (const item of value) {
    if (!isRecord(item) || typeof item.hash !== 'string') {
      return false;
    }

    const hash = normalizeComparableTxHash(item.hash);
    if (hash === undefined || seenHashes.has(hash)) {
      return false;
    }

    seenHashes.add(hash);
  }

  return true;
}

function hasOptionalUniqueRelatedTransactionHashes(value) {
  if (value === undefined || value === null) {
    return true;
  }

  return hasUniqueRelatedTransactionHashes(value);
}

function isReviewableRelatedTransaction(item) {
  return (
    TX_ANALYSIS_RELATED_TRANSACTION_ROLES.has(item.role) &&
    typeof item.hash === 'string' &&
    item.hash.trim().length > 0 &&
    item.hash === item.hash.trim() &&
    typeof item.summary === 'string' &&
    item.summary.trim().length > 0 &&
    item.summary === item.summary.trim() &&
    isOptionalCleanNonEmptyString(item.timestamp) &&
    isOptionalTradeSide(item.side) &&
    isOptionalCleanNonEmptyString(item.traderAddress)
  );
}

function isOptionalTradeSide(value) {
  return value === undefined || TX_ANALYSIS_TRADE_SIDES.has(value);
}

function isOptionalCleanNonEmptyString(value) {
  return value === undefined || isCleanNonEmptyString(value);
}

function hasChainMatchedReviewLinks(result, check) {
  const chain = normalizeReportChain(check.txChain) ?? normalizeReportChain(result.chain);
  if (!isSupportedReviewLinkChain(chain)) {
    return true;
  }

  return (
    isExplorerUrlForChain(result.explorerUrl, chain) &&
    isXxyyPoolUrlForChain(result.xxyyPoolUrl, chain) &&
    Array.isArray(result.relatedTransactions) &&
    result.relatedTransactions.every(
      (item) => isRecord(item) && isExplorerUrlForChain(item.explorerUrl, chain),
    )
  );
}

function hasChainMatchedFailureReviewLinks(failure, check) {
  const chain =
    normalizeReportChain(check.txChain) ?? normalizeReportChain(failure.metadata?.chain);
  if (!isSupportedReviewLinkChain(chain)) {
    return true;
  }

  return (
    isExplorerUrlForChain(failure.metadata?.explorerUrl, chain) &&
    isXxyyPoolUrlForChain(failure.metadata?.xxyyPoolUrl, chain) &&
    hasOptionalChainMatchedRelatedTransactionLinks(failure.metadata?.relatedTransactions, chain)
  );
}

function hasOptionalChainMatchedRelatedTransactionLinks(value, chain) {
  if (value === undefined || value === null) {
    return true;
  }

  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && isExplorerUrlForChain(item.explorerUrl, chain))
  );
}

function hasOptionalRelatedTransactionExplorerUrlsMatchingHashes(value) {
  if (value === undefined || value === null) {
    return true;
  }

  return hasRelatedTransactionExplorerUrlsMatchingHashes(value);
}

function relatedTransactionExplorerUrlMatchesHash(item) {
  if (
    typeof item.hash !== 'string' ||
    item.hash.trim().length === 0 ||
    typeof item.explorerUrl !== 'string' ||
    item.explorerUrl.trim().length === 0
  ) {
    return false;
  }

  const urlTxHash = extractRequestedTxHash(item.explorerUrl);
  return (
    urlTxHash !== undefined &&
    normalizeComparableTxHash(urlTxHash) === normalizeComparableTxHash(item.hash)
  );
}

function explorerUrlMatchesRequestedTxHash(explorerUrl, check) {
  const requestedTxHash = extractRequestedTxHash(check.txHash);
  if (requestedTxHash === undefined) {
    return true;
  }

  const urlTxHash = extractRequestedTxHash(explorerUrl);
  return (
    urlTxHash !== undefined &&
    normalizeComparableTxHash(urlTxHash) === normalizeComparableTxHash(requestedTxHash)
  );
}

function xxyyPoolUrlMatchesPoolAddress(xxyyPoolUrl, poolAddress) {
  if (typeof poolAddress !== 'string' || poolAddress.trim().length === 0) {
    return true;
  }

  const urlPoolAddress = extractXxyyPoolUrlAddress(xxyyPoolUrl);
  if (urlPoolAddress === undefined) {
    return false;
  }

  return normalizeComparableAddress(urlPoolAddress) === normalizeComparableAddress(poolAddress);
}

function extractXxyyPoolUrlAddress(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    const url = new URL(value);
    const pathParts = url.pathname.split('/').filter(Boolean);
    return pathParts[1];
  } catch {
    return undefined;
  }
}

function normalizeComparableAddress(value) {
  return value.startsWith('0x') || value.startsWith('0X') ? value.toLowerCase() : value;
}

function hasOptionalUsableFailureRelatedTransactions(value, check) {
  if (value === undefined || value === null) {
    return true;
  }

  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  const requestedTxHash = extractRequestedTxHash(check.txHash);
  if (requestedTxHash === undefined) {
    return true;
  }

  return value.some(
    (item) =>
      isRecord(item) &&
      item.role === 'user' &&
      normalizeComparableTxHash(item.hash) === normalizeComparableTxHash(requestedTxHash),
  );
}

function isSupportedReviewLinkChain(chain) {
  return chain === 'base' || chain === 'ethereum' || chain === 'bsc' || chain === 'solana';
}

function isExplorerUrlForChain(value, chain) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./u, '');
    if (chain === 'base') {
      return host === 'basescan.org' || host === 'base.blockscout.com';
    }
    if (chain === 'ethereum') {
      return host === 'etherscan.io' || host === 'eth.blockscout.com';
    }
    if (chain === 'bsc') {
      return host === 'bscscan.com' || host === 'bsctrace.com';
    }
    if (chain === 'solana') {
      return host === 'solscan.io' || host === 'explorer.solana.com' || host === 'solana.fm';
    }
  } catch {
    return false;
  }

  return false;
}

function isXxyyPoolUrlForChain(value, chain) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./u, '');
    if (host !== 'xxyy.io') {
      return false;
    }
    const chainPath = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    if (chain === 'solana') {
      return chainPath === 'sol';
    }
    if (chain === 'ethereum') {
      return chainPath === 'eth' || chainPath === 'ethereum';
    }
    return chainPath === chain;
  } catch {
    return false;
  }
}

function hasSandwichLegTransactions(value) {
  return (
    Array.isArray(value) &&
    value.some((item) => isRecord(item) && item.role === 'front_run') &&
    value.some((item) => isRecord(item) && item.role === 'back_run')
  );
}

function hasSandwichEvidenceHashes(evidence, relatedTransactions) {
  if (!Array.isArray(evidence) || !Array.isArray(relatedTransactions)) {
    return false;
  }

  const frontRunHash = relatedTransactionHashByRole(relatedTransactions, 'front_run');
  const targetHash = relatedTransactionHashByRole(relatedTransactions, 'user');
  const backRunHash = relatedTransactionHashByRole(relatedTransactions, 'back_run');
  if (frontRunHash === undefined || targetHash === undefined || backRunHash === undefined) {
    return false;
  }

  return evidence.some(
    (item) =>
      isRecord(item) &&
      typeof item.detail === 'string' &&
      evidenceDetailContainsHash(item.detail, targetHash) &&
      evidenceDetailContainsHash(item.detail, frontRunHash) &&
      evidenceDetailContainsHash(item.detail, backRunHash),
  );
}

function relatedTransactionHashByRole(relatedTransactions, role) {
  const transaction = relatedTransactions.find((item) => isRecord(item) && item.role === role);
  return typeof transaction?.hash === 'string' && transaction.hash.trim().length > 0
    ? transaction.hash.trim()
    : undefined;
}

function evidenceDetailContainsHash(detail, hash) {
  const comparableHash = normalizeComparableTxHash(hash);
  if (comparableHash === undefined) {
    return false;
  }

  return comparableHash.startsWith('0x')
    ? detail.toLowerCase().includes(comparableHash)
    : detail.includes(comparableHash);
}

function validateTxAnalysisReportResultScreenshot(result, chatPayload, txAnalysisUrl) {
  const screenshotError = validateTxAnalysisReportScreenshotUrl(
    result.screenshotUrl,
    chatPayload,
    txAnalysisUrl,
    'transaction analysis report result must include a clean screenshot URL.',
    'transaction analysis report result screenshot must match the returned image attachment.',
  );
  if (screenshotError !== undefined) {
    return screenshotError;
  }

  return result.screenshotTargetRowMarked === true
    ? undefined
    : 'transaction analysis report result screenshot must be marked on the target row.';
}

function validateTxAnalysisFailureReportScreenshot(failure, chatPayload, txAnalysisUrl) {
  return validateTxAnalysisReportScreenshotUrl(
    failure.metadata?.screenshotUrl,
    chatPayload,
    txAnalysisUrl,
    'transaction analysis failure report must include a clean screenshot URL.',
    'transaction analysis failure report screenshot must match the returned image attachment.',
  );
}

function validateTxAnalysisReportScreenshotUrl(
  screenshotUrl,
  chatPayload,
  txAnalysisUrl,
  missingMessage,
  mismatchMessage,
) {
  const attachmentUrl = firstImageAttachmentUrl(chatPayload);
  if (attachmentUrl === undefined) {
    return undefined;
  }

  if (!isCleanNonEmptyString(screenshotUrl)) {
    return missingMessage;
  }

  if (
    new URL(screenshotUrl, txAnalysisUrl).toString() !==
    new URL(attachmentUrl, txAnalysisUrl).toString()
  ) {
    return mismatchMessage;
  }

  return undefined;
}

function validateTxAnalysisReportIdentity(value, check, label) {
  const requestedTxHash = extractRequestedTxHash(check.txHash);
  if (
    requestedTxHash !== undefined &&
    normalizeComparableTxHash(value.txHash) !== normalizeComparableTxHash(requestedTxHash)
  ) {
    return `transaction analysis report ${label} must match requested transaction hash.`;
  }

  const expectedChain = normalizeReportChainStrict(check.expectedChain);
  if (expectedChain !== undefined && normalizeReportChainStrict(value.chain) !== expectedChain) {
    return `transaction analysis report ${label} must match expected sample chain.`;
  }

  const requestedChain = normalizeReportChain(check.txChain);
  if (requestedChain !== undefined && normalizeReportChain(value.chain) !== requestedChain) {
    return `transaction analysis report ${label} must match requested chain.`;
  }

  return undefined;
}

function extractRequestedTxHash(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const evmTxHash = /\b0x[a-fA-F0-9]{64}\b/u.exec(value)?.[0];
  if (evmTxHash !== undefined) {
    return evmTxHash;
  }

  return /(?:^|\/tx\/|\/transaction\/)([1-9A-HJ-NP-Za-km-z]{64,96})(?:$|[/?#])/u.exec(value)?.[1];
}

function normalizeComparableTxHash(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.startsWith('0x') || value.startsWith('0X') ? value.toLowerCase() : value;
}

function normalizeReportChain(value) {
  const normalized = normalizeReportChainStrict(value);
  return normalized === 'unknown' ? undefined : normalized;
}

function normalizeReportChainStrict(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, '');
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized === 'unknown') {
    return 'unknown';
  }
  if (normalized === 'sol' || normalized === 'solana' || normalized === 'solchain') {
    return 'solana';
  }
  if (normalized === 'eth' || normalized === 'ethereum' || normalized === 'ethchain') {
    return 'ethereum';
  }
  if (
    normalized === 'bsc' ||
    normalized === 'bnb' ||
    normalized === 'bnbchain' ||
    normalized === 'bnbsmartchain' ||
    normalized === 'binancechain' ||
    normalized === 'binancesmartchain' ||
    normalized === 'bep20'
  ) {
    return 'bsc';
  }

  return normalized;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasImageAttachment(payload) {
  return firstImageAttachmentUrl(payload) !== undefined;
}

function firstImageAttachmentUrl(payload) {
  if (!Array.isArray(payload.attachments)) {
    return undefined;
  }

  const attachment = payload.attachments.find(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      item.kind === 'image' &&
      typeof item.url === 'string' &&
      item.url.trim().length > 0,
  );
  return attachment?.url;
}

function hasReportLink(answer) {
  return extractReportLink(answer) !== undefined;
}

function extractReportLink(answer) {
  if (typeof answer !== 'string') {
    return undefined;
  }

  return /^报告：(\S+)/mu.exec(answer)?.[1];
}

function formatPayload(payload) {
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

function isDirectRun() {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    const exitCode = await runApiSmoke();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
