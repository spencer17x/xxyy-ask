#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SAMPLES_FILE = path.join(
  WORKSPACE_ROOT,
  'docs/tx-analysis-smoke-samples.example.json',
);
const MCP_PACKAGE_REQUIRE = createRequire(
  new URL('../packages/tx-analysis-mcp/package.json', import.meta.url),
);
const TX_ANALYSIS_CHAINS = new Set(['solana', 'base', 'ethereum', 'bsc', 'unknown']);
const TX_ANALYSIS_DATA_SOURCES = new Set(['browser']);
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
const TX_ANALYSIS_RELATED_TRANSACTION_ROLES = new Set(['front_run', 'user', 'back_run', 'related']);
const TX_ANALYSIS_STATUSES = new Set(['success', 'failure']);
const TX_ANALYSIS_TRADE_SIDES = new Set(['buy', 'sell', 'unknown']);
const TX_ANALYSIS_VERDICTS = new Set(['sandwiched', 'not_sandwiched', 'inconclusive']);
const SUPPORTED_TOP_LEVEL_EXPECTED_FIELDS = new Set([
  'expectedAnalysisRuleVersion',
  'expectedChain',
  'expectedConfidence',
  'expectedContractAddress',
  'expectedDataSource',
  'expectedExplorerUrl',
  'expectedFailureMessage',
  'expectedFailureReason',
  'expectedPoolAddress',
  'expectedProbeAttempts',
  'expectedRelatedTransactionCount',
  'expectedRelatedTransactionRoles',
  'expectedRelatedTransactions',
  'expectedRouterAddress',
  'expectedScreenshotTargetRowMarked',
  'expectedStatus',
  'expectedTargetTradeSide',
  'expectedTargetTraderAddress',
  'expectedTransactionTime',
  'expectedVerdict',
  'expectedXxyyPoolUrl',
]);
const SUPPORTED_NESTED_EXPECTED_FIELDS = new Set([
  'analysisRuleVersion',
  'chain',
  'confidence',
  'contractAddress',
  'dataSource',
  'explorerUrl',
  'failureMessage',
  'failureReason',
  'poolAddress',
  'probeAttempts',
  'relatedTransactionCount',
  'relatedTransactionRoles',
  'relatedTransactions',
  'routerAddress',
  'screenshotTargetRowMarked',
  'status',
  'targetTradeSide',
  'targetTraderAddress',
  'transactionTime',
  'verdict',
  'xxyyPoolUrl',
]);
const RELATED_TRANSACTION_EXPLORER_URL_KEYS = [
  'explorerUrl',
  'explorer_url',
  'explorerLink',
  'explorer_link',
  'txUrl',
  'tx_url',
  'txLink',
  'tx_link',
  'transactionUrl',
  'transaction_url',
  'transactionLink',
  'transaction_link',
  'url',
  'link',
  'href',
];
const SUPPORTED_RELATED_TRANSACTION_EXPECTED_FIELDS = new Set([
  'hash',
  'txHash',
  'role',
  'side',
  'tradeSide',
  'timestamp',
  'traderAddress',
  ...RELATED_TRANSACTION_EXPLORER_URL_KEYS,
]);

export async function runTxAnalysisMcpSmoke(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const smokeOptions = parseTxAnalysisMcpSmokeArgs(args);
  if (smokeOptions.help) {
    printUsage();
    return 0;
  }

  const samples = readTxAnalysisMcpSmokeSamples(smokeOptions.samplesFile);
  const { Client, StdioClientTransport } = await loadMcpClientSdk();
  const client = new Client({ name: 'xxyy-tx-analysis-mcp-smoke', version: '0.1.0' });
  const transport = new StdioClientTransport({
    args: ['--silent', '--filter', '@xxyy/tx-analysis-mcp', 'start'],
    command: 'pnpm',
    cwd: WORKSPACE_ROOT,
    env: createChildEnv(env),
  });
  let failedSamples = 0;

  try {
    await client.connect(transport);
    log(`MCP smoke starting: ${samples.length} sample${samples.length === 1 ? '' : 's'}.`);

    for (const sample of samples) {
      log(`==> ${sample.label}`);
      const errors = await runSample(client, sample);
      if (errors.length > 0) {
        failedSamples += 1;
        log(`FAIL ${sample.label}`);
        for (const error of errors) {
          log(`  - ${error}`);
        }
        continue;
      }

      log(`OK ${sample.label}`);
    }
  } finally {
    await closeQuietly(client);
    await closeQuietly(transport);
  }

  if (failedSamples > 0) {
    log(
      `MCP smoke failed: ${failedSamples}/${samples.length} sample${
        failedSamples === 1 ? '' : 's'
      } failed.`,
    );
    return 1;
  }

  log(`MCP smoke passed: ${samples.length}/${samples.length} samples OK.`);
  return 0;
}

function parseTxAnalysisMcpSmokeArgs(args) {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  let samplesFile = DEFAULT_SAMPLES_FILE;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const option = normalizedArgs[index];

    if (option === '--help' || option === '-h') {
      return { help: true, samplesFile };
    }

    if (option === '--tx-samples') {
      const rawSamplesFile = normalizedArgs[index + 1];
      if (rawSamplesFile === undefined) {
        throw new Error('Missing value for --tx-samples.');
      }
      samplesFile = path.resolve(process.cwd(), rawSamplesFile);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${option}`);
  }

  return { samplesFile };
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: pnpm tx:mcp:smoke [-- --tx-samples <file>]',
      '',
      'Runs the transaction analysis MCP server through the official stdio client transport using real transaction-analysis samples.',
    ].join('\n'),
  );
  process.stdout.write('\n');
}

function readTxAnalysisMcpSmokeSamples(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to read transaction analysis MCP smoke samples from ${filePath}: ${
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
    throw new Error('Transaction analysis MCP smoke samples must be a non-empty array.');
  }

  return rawSamples.map((sample, index) => normalizeSample(sample, index));
}

export function normalizeTxAnalysisMcpSmokeSample(sample, index = 0) {
  return normalizeSample(sample, index);
}

function normalizeSample(sample, index) {
  if (!isRecord(sample)) {
    throw new Error(`Transaction analysis MCP smoke sample ${index + 1} must be an object.`);
  }

  const label = normalizeOptionalString(sample.label) ?? `sample ${index + 1}`;
  const txHash = normalizeOptionalString(sample.txHash);
  if (txHash === undefined) {
    throw new Error(`Transaction analysis MCP smoke sample "${label}" must include txHash.`);
  }

  if (
    Object.hasOwn(sample, 'chain') &&
    sample.chain !== undefined &&
    typeof sample.chain !== 'string'
  ) {
    throw new Error(`Transaction analysis MCP smoke sample "${label}" chain must be a string.`);
  }
  const chain = normalizeOptionalString(sample.chain);
  if (chain !== undefined && !TX_ANALYSIS_CHAINS.has(chain)) {
    throw new Error(
      `Transaction analysis MCP smoke sample "${label}" has unsupported chain: ${chain}.`,
    );
  }

  return {
    chain,
    expected: normalizeExpected(sample, label),
    label,
    txHash,
  };
}

function normalizeExpected(sample, label) {
  const nestedExpected = normalizeNestedExpected(sample.expected, label);
  assertSupportedExpectedFields(sample, nestedExpected, label);

  return {
    analysisRuleVersion: normalizeExpectedString(
      expectedValue(sample, nestedExpected, 'expectedAnalysisRuleVersion', 'analysisRuleVersion'),
      `${label} expected analysisRuleVersion`,
    ),
    confidence: normalizeOptionalNumber(
      expectedValue(sample, nestedExpected, 'expectedConfidence', 'confidence'),
      `${label} expected confidence`,
    ),
    contractAddress: normalizeExpectedString(
      expectedValue(sample, nestedExpected, 'expectedContractAddress', 'contractAddress'),
      `${label} expected contractAddress`,
    ),
    dataSource: normalizeExpectedEnum(
      expectedValue(sample, nestedExpected, 'expectedDataSource', 'dataSource'),
      TX_ANALYSIS_DATA_SOURCES,
      `${label} expected dataSource`,
    ),
    explorerUrl: normalizeExpectedString(
      expectedValue(sample, nestedExpected, 'expectedExplorerUrl', 'explorerUrl'),
      `${label} expected explorerUrl`,
    ),
    failureMessage: normalizeExpectedString(
      expectedValue(sample, nestedExpected, 'expectedFailureMessage', 'failureMessage'),
      `${label} expected failureMessage`,
    ),
    failureReason: normalizeExpectedEnum(
      expectedValue(sample, nestedExpected, 'expectedFailureReason', 'failureReason'),
      TX_ANALYSIS_FAILURE_REASONS,
      `${label} expected failureReason`,
    ),
    poolAddress: normalizeExpectedString(
      expectedValue(sample, nestedExpected, 'expectedPoolAddress', 'poolAddress'),
      `${label} expected poolAddress`,
    ),
    probeAttempts: normalizeExpectedProbeAttempts(
      expectedValue(sample, nestedExpected, 'expectedProbeAttempts', 'probeAttempts'),
      label,
    ),
    relatedTransactionCount: normalizeExpectedRelatedTransactionCount(
      expectedValue(
        sample,
        nestedExpected,
        'expectedRelatedTransactionCount',
        'relatedTransactionCount',
      ),
      label,
    ),
    relatedTransactionRoles: normalizeExpectedRelatedTransactionRoles(
      expectedValue(
        sample,
        nestedExpected,
        'expectedRelatedTransactionRoles',
        'relatedTransactionRoles',
      ),
      label,
    ),
    relatedTransactions: normalizeExpectedRelatedTransactions(
      expectedValue(sample, nestedExpected, 'expectedRelatedTransactions', 'relatedTransactions'),
      label,
    ),
    resultChain: normalizeExpectedEnum(
      expectedValue(sample, nestedExpected, 'expectedChain', 'chain'),
      TX_ANALYSIS_CHAINS,
      `${label} expected chain`,
    ),
    routerAddress: normalizeExpectedString(
      expectedValue(sample, nestedExpected, 'expectedRouterAddress', 'routerAddress'),
      `${label} expected routerAddress`,
    ),
    screenshotTargetRowMarked: normalizeExpectedBoolean(
      expectedValue(
        sample,
        nestedExpected,
        'expectedScreenshotTargetRowMarked',
        'screenshotTargetRowMarked',
      ),
      `${label} expected screenshotTargetRowMarked`,
    ),
    status: normalizeExpectedEnum(
      expectedValue(sample, nestedExpected, 'expectedStatus', 'status'),
      TX_ANALYSIS_STATUSES,
      `${label} expected status`,
    ),
    targetTradeSide: normalizeExpectedEnum(
      expectedValue(sample, nestedExpected, 'expectedTargetTradeSide', 'targetTradeSide'),
      TX_ANALYSIS_TRADE_SIDES,
      `${label} expected targetTradeSide`,
    ),
    targetTraderAddress: normalizeExpectedString(
      expectedValue(sample, nestedExpected, 'expectedTargetTraderAddress', 'targetTraderAddress'),
      `${label} expected targetTraderAddress`,
    ),
    transactionTime: normalizeExpectedString(
      expectedValue(sample, nestedExpected, 'expectedTransactionTime', 'transactionTime'),
      `${label} expected transactionTime`,
    ),
    verdict: normalizeExpectedEnum(
      expectedValue(sample, nestedExpected, 'expectedVerdict', 'verdict'),
      TX_ANALYSIS_VERDICTS,
      `${label} expected verdict`,
    ),
    xxyyPoolUrl: normalizeExpectedString(
      expectedValue(sample, nestedExpected, 'expectedXxyyPoolUrl', 'xxyyPoolUrl'),
      `${label} expected xxyyPoolUrl`,
    ),
  };
}

async function runSample(client, sample) {
  try {
    const output = await client.callTool({
      arguments: {
        ...(sample.chain === undefined ? {} : { chain: sample.chain }),
        txHash: sample.txHash,
      },
      name: 'analyze_transaction',
    });
    return validateToolOutput(sample, output);
  } catch (error) {
    return [`tool call failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

export function validateTxAnalysisMcpSmokeToolOutput(sample, output) {
  return validateToolOutput(sample, output);
}

function validateToolOutput(sample, output) {
  const errors = [];
  if (isRecord(output) && output.isError === true) {
    errors.push('tool returned isError=true.');
  }

  const structuredContent = isRecord(output) ? output.structuredContent : undefined;
  if (!isRecord(structuredContent)) {
    return [...errors, 'tool result did not include structuredContent.'];
  }

  const status = structuredContent.status;
  if (!TX_ANALYSIS_STATUSES.has(status)) {
    errors.push(`structuredContent.status must be success or failure, got ${formatValue(status)}.`);
  }
  if (sample.expected.status !== undefined && status !== sample.expected.status) {
    errors.push(
      `expected status ${sample.expected.status}, got ${formatValue(structuredContent.status)}.`,
    );
  }

  if (status === 'success') {
    errors.push(...validateSuccessOutput(sample, structuredContent));
  }
  if (status === 'failure') {
    errors.push(...validateFailureOutput(sample, structuredContent));
  }

  return errors;
}

function validateSuccessOutput(sample, structuredContent) {
  const errors = [];
  const result = structuredContent.result;
  if (!isRecord(result)) {
    return ['structuredContent.result must be present for success status.'];
  }

  errors.push(...validateExpectedResultFields(sample, result));
  errors.push(...validateExpectedFailureFields(sample, undefined));
  errors.push(...validateExpectedReviewFields(sample, result, 'result'));
  return errors;
}

function validateFailureOutput(sample, structuredContent) {
  const errors = [];
  const failure = structuredContent.failure;
  if (!isRecord(failure)) {
    return ['structuredContent.failure must be present for failure status.'];
  }

  if (!TX_ANALYSIS_FAILURE_REASONS.has(failure.reason)) {
    errors.push(
      `failure.reason must be one of: ${[...TX_ANALYSIS_FAILURE_REASONS].join(', ')}, got ${formatValue(
        failure.reason,
      )}.`,
    );
  }
  if (typeof failure.message !== 'string' || failure.message.trim().length === 0) {
    errors.push('failure.message must be a non-empty string.');
  }

  errors.push(...validateExpectedResultFields(sample, undefined));
  errors.push(...validateExpectedFailureFields(sample, failure));
  errors.push(...validateExpectedReviewFields(sample, failure.metadata, 'failure.metadata'));
  return errors;
}

function validateExpectedResultFields(sample, result) {
  const errors = [];
  if (sample.expected.resultChain !== undefined && result?.chain !== sample.expected.resultChain) {
    errors.push(
      `expected result.chain ${sample.expected.resultChain}, got ${formatValue(result?.chain)}.`,
    );
  }
  if (sample.expected.verdict !== undefined && result?.verdict !== sample.expected.verdict) {
    errors.push(
      `expected result.verdict ${sample.expected.verdict}, got ${formatValue(result?.verdict)}.`,
    );
  }
  if (
    sample.expected.confidence !== undefined &&
    !numbersEqual(result?.confidence, sample.expected.confidence)
  ) {
    errors.push(
      `expected result.confidence ${sample.expected.confidence}, got ${formatValue(
        result?.confidence,
      )}.`,
    );
  }
  if (
    sample.expected.dataSource !== undefined &&
    result?.dataSource !== sample.expected.dataSource
  ) {
    errors.push(
      `expected result.dataSource ${sample.expected.dataSource}, got ${formatValue(
        result?.dataSource,
      )}.`,
    );
  }
  if (
    sample.expected.analysisRuleVersion !== undefined &&
    result?.analysisRuleVersion !== sample.expected.analysisRuleVersion
  ) {
    errors.push(
      `expected result.analysisRuleVersion ${sample.expected.analysisRuleVersion}, got ${formatValue(
        result?.analysisRuleVersion,
      )}.`,
    );
  }

  return errors;
}

function validateExpectedFailureFields(sample, failure) {
  const errors = [];
  if (
    sample.expected.failureReason !== undefined &&
    failure?.reason !== sample.expected.failureReason
  ) {
    errors.push(
      `expected failure.reason ${sample.expected.failureReason}, got ${formatValue(
        failure?.reason,
      )}.`,
    );
  }
  if (
    sample.expected.failureMessage !== undefined &&
    !reviewFieldMatchesExpected(failure?.message, sample.expected.failureMessage)
  ) {
    errors.push(
      `expected failure.message ${sample.expected.failureMessage}, got ${formatValue(
        failure?.message,
      )}.`,
    );
  }

  return errors;
}

function validateExpectedReviewFields(sample, reviewSource, sourceLabel) {
  const errors = [];
  const textFields = [
    ['contractAddress', 'contractAddress'],
    ['explorerUrl', 'explorerUrl'],
    ['poolAddress', 'poolAddress'],
    ['routerAddress', 'routerAddress'],
    ['targetTraderAddress', 'targetTraderAddress'],
    ['transactionTime', 'transactionTime'],
    ['xxyyPoolUrl', 'xxyyPoolUrl'],
  ];

  for (const [expectedKey, sourceKey] of textFields) {
    const expected = sample.expected[expectedKey];
    if (
      expected !== undefined &&
      !reviewFieldMatchesExpected(reviewSource?.[sourceKey], expected)
    ) {
      errors.push(
        `expected ${sourceLabel}.${sourceKey} ${expected}, got ${formatValue(
          reviewSource?.[sourceKey],
        )}.`,
      );
    }
  }

  if (
    sample.expected.screenshotTargetRowMarked !== undefined &&
    reviewSource?.screenshotTargetRowMarked !== sample.expected.screenshotTargetRowMarked
  ) {
    errors.push(
      `expected ${sourceLabel}.screenshotTargetRowMarked ${
        sample.expected.screenshotTargetRowMarked
      }, got ${formatValue(reviewSource?.screenshotTargetRowMarked)}.`,
    );
  }
  if (
    sample.expected.targetTradeSide !== undefined &&
    reviewSource?.targetTradeSide !== sample.expected.targetTradeSide
  ) {
    errors.push(
      `expected ${sourceLabel}.targetTradeSide ${
        sample.expected.targetTradeSide
      }, got ${formatValue(reviewSource?.targetTradeSide)}.`,
    );
  }

  errors.push(...validateExpectedRelatedFields(sample, reviewSource?.relatedTransactions));
  errors.push(...validateExpectedProbeAttempts(sample, reviewSource?.probeAttempts));
  return errors;
}

async function loadMcpClientSdk() {
  const [clientModule, stdioModule] = await Promise.all([
    import(MCP_PACKAGE_REQUIRE.resolve('@modelcontextprotocol/sdk/client/index.js')),
    import(MCP_PACKAGE_REQUIRE.resolve('@modelcontextprotocol/sdk/client/stdio.js')),
  ]);

  return {
    Client: clientModule.Client,
    StdioClientTransport: stdioModule.StdioClientTransport,
  };
}

function createChildEnv(env) {
  const childEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  return childEnv;
}

async function closeQuietly(closeable) {
  try {
    await closeable.close();
  } catch {
    // Best-effort cleanup; the smoke result above carries the actionable failure.
  }
}

function normalizeNestedExpected(value, label) {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`Transaction analysis MCP smoke sample "${label}" expected must be an object.`);
  }

  return value;
}

function assertSupportedExpectedFields(sample, nestedExpected, label) {
  for (const field of Object.keys(sample)) {
    if (
      field !== 'expected' &&
      field.startsWith('expected') &&
      !SUPPORTED_TOP_LEVEL_EXPECTED_FIELDS.has(field)
    ) {
      throw new Error(
        `Transaction analysis MCP smoke sample "${label}" has unsupported expected field: ${field}.`,
      );
    }
  }

  for (const field of Object.keys(nestedExpected)) {
    if (!SUPPORTED_NESTED_EXPECTED_FIELDS.has(field)) {
      throw new Error(
        `Transaction analysis MCP smoke sample "${label}" has unsupported expected field: expected.${field}.`,
      );
    }
  }
}

function expectedValue(sample, nestedExpected, topLevelField, nestedField) {
  return Object.hasOwn(sample, topLevelField) ? sample[topLevelField] : nestedExpected[nestedField];
}

function normalizeExpectedEnum(value, allowedValues, label) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!allowedValues.has(normalized)) {
    throw new Error(`${label} must be one of ${[...allowedValues].join(', ')}.`);
  }
  return normalized;
}

function normalizeExpectedString(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must be non-empty when provided.`);
  }

  return normalized;
}

function normalizeOptionalNumber(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number from 0 to 1.`);
  }
  return value;
}

function normalizeExpectedBoolean(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be boolean.`);
  }

  return value;
}

function normalizeExpectedRelatedTransactionCount(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} expected relatedTransactionCount must be a non-negative integer.`);
  }

  return value;
}

function normalizeExpectedRelatedTransactionRoles(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} expected relatedTransactionRoles must be a non-empty array.`);
  }

  return value.map((role, index) =>
    normalizeExpectedEnum(
      role,
      TX_ANALYSIS_RELATED_TRANSACTION_ROLES,
      `${label} expected relatedTransactionRoles item ${index + 1}`,
    ),
  );
}

function normalizeExpectedRelatedTransactions(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} expected relatedTransactions must be a non-empty array.`);
  }

  return value.map((item, index) => normalizeExpectedRelatedTransaction(item, label, index));
}

function normalizeExpectedRelatedTransaction(item, label, index) {
  const itemLabel = `${label} expected relatedTransactions item ${index + 1}`;
  if (!isRecord(item)) {
    throw new Error(`${itemLabel} must be an object.`);
  }
  for (const field of Object.keys(item)) {
    if (!SUPPORTED_RELATED_TRANSACTION_EXPECTED_FIELDS.has(field)) {
      throw new Error(`${itemLabel} has unsupported field: ${field}.`);
    }
  }

  const hash = normalizeExpectedString(
    firstPresentValue(item, ['hash', 'txHash']),
    `${itemLabel} hash`,
  );
  const role = normalizeExpectedEnum(
    firstPresentValue(item, ['role']),
    TX_ANALYSIS_RELATED_TRANSACTION_ROLES,
    `${itemLabel} role`,
  );
  if (hash === undefined || role === undefined) {
    throw new Error(`${itemLabel} must include hash and role.`);
  }
  const explorerUrl = normalizeExpectedString(
    firstPresentValue(item, RELATED_TRANSACTION_EXPLORER_URL_KEYS),
    `${itemLabel} explorerUrl`,
  );
  if (explorerUrl !== undefined && !isHttpUrl(explorerUrl)) {
    throw new Error(`${itemLabel} explorerUrl must be an HTTP URL when provided.`);
  }

  return {
    hash,
    role,
    ...(explorerUrl === undefined ? {} : { explorerUrl }),
    ...optionalNormalizedExpected(
      'side',
      normalizeExpectedEnum(
        firstPresentValue(item, ['side', 'tradeSide']),
        TX_ANALYSIS_TRADE_SIDES,
        `${itemLabel} side`,
      ),
    ),
    ...optionalNormalizedExpected(
      'timestamp',
      normalizeExpectedString(firstPresentValue(item, ['timestamp']), `${itemLabel} timestamp`),
    ),
    ...optionalNormalizedExpected(
      'traderAddress',
      normalizeExpectedString(
        firstPresentValue(item, ['traderAddress']),
        `${itemLabel} traderAddress`,
      ),
    ),
  };
}

function normalizeExpectedProbeAttempts(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} expected probeAttempts must be a non-empty array.`);
  }

  return value.map((item, index) => normalizeExpectedProbeAttempt(item, label, index));
}

function normalizeExpectedProbeAttempt(item, label, index) {
  const itemLabel = `${label} expected probeAttempts item ${index + 1}`;
  if (!isRecord(item)) {
    throw new Error(`${itemLabel} must be an object.`);
  }

  const chain = normalizeExpectedEnum(
    firstPresentValue(item, ['chain']),
    TX_ANALYSIS_CHAINS,
    `${itemLabel} chain`,
  );
  const reason = normalizeExpectedEnum(
    firstPresentValue(item, ['reason']),
    TX_ANALYSIS_FAILURE_REASONS,
    `${itemLabel} reason`,
  );
  if (chain === undefined || reason === undefined) {
    throw new Error(`${itemLabel} must include chain and reason.`);
  }

  return {
    chain,
    ...optionalNormalizedExpected(
      'message',
      normalizeExpectedString(firstPresentValue(item, ['message']), `${itemLabel} message`),
    ),
    reason,
  };
}

function firstPresentValue(record, keys) {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
  }

  return undefined;
}

function optionalNormalizedExpected(key, value) {
  return value === undefined ? {} : { [key]: value };
}

function validateExpectedRelatedFields(sample, relatedTransactions) {
  const errors = [];

  if (sample.expected.relatedTransactionCount !== undefined) {
    const actualCount = Array.isArray(relatedTransactions) ? relatedTransactions.length : undefined;
    if (actualCount !== sample.expected.relatedTransactionCount) {
      errors.push(
        `expected relatedTransactions length ${sample.expected.relatedTransactionCount}, got ${formatValue(
          actualCount,
        )}.`,
      );
    }
  }

  if (sample.expected.relatedTransactionRoles !== undefined) {
    if (
      !Array.isArray(relatedTransactions) ||
      relatedTransactions.length !== sample.expected.relatedTransactionRoles.length
    ) {
      errors.push('expected relatedTransactions roles to match, but length differed.');
    } else {
      for (const [index, expectedRole] of sample.expected.relatedTransactionRoles.entries()) {
        const actualItem = relatedTransactions[index];
        if (!isRecord(actualItem) || actualItem.role !== expectedRole) {
          errors.push(
            `expected relatedTransactions[${index}].role ${expectedRole}, got ${formatValue(
              actualItem?.role,
            )}.`,
          );
          break;
        }
      }
    }
  }

  if (sample.expected.relatedTransactions !== undefined) {
    const error = validateExpectedRelatedTransactions(
      relatedTransactions,
      sample.expected.relatedTransactions,
    );
    if (error !== undefined) {
      errors.push(error);
    }
  }

  return errors;
}

function validateExpectedRelatedTransactions(actual, expected) {
  if (!Array.isArray(actual)) {
    return 'expected relatedTransactions to include expected sample transactions, got no array.';
  }

  for (const expectedItem of expected) {
    const candidates = actual.filter(
      (item) =>
        isRecord(item) &&
        item.role === expectedItem.role &&
        normalizeComparableTxHash(item.hash) === normalizeComparableTxHash(expectedItem.hash),
    );

    if (candidates.length === 0) {
      return `expected related transaction ${expectedItem.role}/${expectedItem.hash} was not found.`;
    }
    if (candidates.some((item) => relatedTransactionMatchesExpected(item, expectedItem))) {
      continue;
    }

    const detailError = relatedTransactionDetailMismatch(candidates, expectedItem);
    if (detailError !== undefined) {
      return detailError;
    }

    return `expected related transaction ${expectedItem.role}/${expectedItem.hash} did not match.`;
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
    return `expected related transaction explorerUrl ${expected.explorerUrl} did not match.`;
  }
  if (
    expected.side !== undefined &&
    !candidates.some((item) => optionalTradeSideMatchesExpected(item.side, expected.side))
  ) {
    return `expected related transaction side ${expected.side} did not match.`;
  }
  if (
    expected.timestamp !== undefined &&
    !candidates.some((item) =>
      optionalReviewFieldMatchesExpected(item.timestamp, expected.timestamp),
    )
  ) {
    return `expected related transaction timestamp ${expected.timestamp} did not match.`;
  }
  if (
    expected.traderAddress !== undefined &&
    !candidates.some((item) =>
      optionalReviewFieldMatchesExpected(item.traderAddress, expected.traderAddress),
    )
  ) {
    return `expected related transaction traderAddress ${expected.traderAddress} did not match.`;
  }

  return undefined;
}

function validateExpectedProbeAttempts(sample, probeAttempts) {
  const expected = sample.expected.probeAttempts;
  if (expected === undefined) {
    return [];
  }
  if (!Array.isArray(probeAttempts)) {
    return ['expected probeAttempts to include expected sample probes, got no array.'];
  }

  const errors = [];
  for (const expectedItem of expected) {
    if (probeAttempts.some((item) => probeAttemptMatchesExpected(item, expectedItem))) {
      continue;
    }

    errors.push(
      `expected probe attempt ${expectedItem.chain}/${expectedItem.reason}${
        expectedItem.message === undefined ? '' : `/${expectedItem.message}`
      } was not found.`,
    );
  }

  return errors;
}

function probeAttemptMatchesExpected(actual, expected) {
  return (
    isRecord(actual) &&
    actual.chain === expected.chain &&
    actual.reason === expected.reason &&
    optionalPlainTextMatchesExpected(actual.message, expected.message)
  );
}

function optionalPlainTextMatchesExpected(actual, expected) {
  return expected === undefined || (typeof actual === 'string' && actual.trim() === expected);
}

function optionalReviewFieldMatchesExpected(actual, expected) {
  return expected === undefined || reviewFieldMatchesExpected(actual, expected);
}

function reviewFieldMatchesExpected(actual, expected) {
  if (typeof actual !== 'string' || actual.trim().length === 0) {
    return false;
  }

  return normalizeComparableAddress(actual.trim()) === normalizeComparableAddress(expected);
}

function optionalTradeSideMatchesExpected(actual, expected) {
  return expected === undefined || actual === expected;
}

function normalizeComparableAddress(value) {
  return value.startsWith('0x') || value.startsWith('0X') ? value.toLowerCase() : value;
}

function normalizeComparableTxHash(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.startsWith('0x') || value.startsWith('0X') ? value.toLowerCase() : value;
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

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function numbersEqual(left, right) {
  return typeof left === 'number' && Math.abs(left - right) <= 1e-9;
}

function formatValue(value) {
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    process.exitCode = await runTxAnalysisMcpSmoke();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
