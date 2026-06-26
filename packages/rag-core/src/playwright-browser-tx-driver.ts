import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';

import type { TxAnalysisRelatedTransaction } from '@xxyy/shared';

import type {
  BrowserEvmChain,
  BrowserSolanaTxSnapshot,
  BrowserTradeSide,
  BrowserTxAnalysisDriver,
  BrowserTxTrade,
} from './browser-tx-analysis.js';
import { isBrowserTimeoutError, isTransientBrowserNetworkError } from './browser-errors.js';
import { isBrowserVerificationText } from './browser-verification.js';
import { resolveWorkspaceCwd } from './env.js';
import {
  TxAnalysisProviderUnavailableError,
  type TxAnalysisFailureMetadata,
  type TxAnalysisUnavailableReason,
} from './tx-analysis.js';
import { parseTransactionReference } from './tx-hash.js';

export interface PlaywrightBrowserTxAnalysisDriverOptions {
  chromeExecutablePath?: string;
  discoverUrl?: string;
  fetch?: TxAnalysisFetch;
  headless?: boolean;
  screenshotBaseUrl?: string;
  screenshotDir?: string;
  solanaRpcUrl?: string;
  timeoutMs?: number;
  userDataDir?: string;
}

type TxAnalysisFetch = (
  input: string,
  init?: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  json(): Promise<unknown>;
  ok?: boolean;
  status?: number;
  statusText?: string;
}>;

interface SolscanExtraction {
  contractAddress?: string;
  poolAddress?: string;
  poolCandidates: XxyyPoolCandidate[];
  program?: string;
  signerAddress?: string;
  side: BrowserTradeSide;
  solscanUrl: string;
  transactionTime?: string;
}

interface EvmExplorerExtraction {
  chain: BrowserEvmChain;
  contractAddress?: string;
  explorerUrl: string;
  poolAddress?: string;
  poolCandidates: XxyyPoolCandidate[];
  routerAddress?: string;
  signerAddress?: string;
  side: BrowserTradeSide;
  transactionTime?: string;
}

interface XxyyTradeContext {
  nativeSymbol?: string;
  poolAddress?: string;
  signerAddress?: string;
  solscanUrl: string;
  transactionTime?: string;
}

interface XxyyExtraction {
  screenshotUrl?: string;
  screenshotTargetRowMarked?: boolean;
  text: string;
  tradeWindow?: XxyyTradeWindow;
  xxyyPoolUrl?: string;
}

interface PageLink {
  href: string;
  text: string;
}

export interface EvmTokenCandidate {
  address: string;
  text?: string;
}

interface SearchItemCandidate {
  text: string;
}

export interface XxyyPoolCandidate {
  address: string;
  nativeAmount?: string;
}

export interface XxyyTradeRecord {
  maker: string;
  nativeAmount?: string;
  poolAddress?: string;
  priceUsd?: string;
  timestamp: number | string;
  tokenAmount?: string;
  txHash: string;
  type: string;
  usdAmount?: string;
}

export interface XxyyTradeWindow {
  selectedPoolAddress?: string;
  targetTrade: BrowserTxTrade;
  tradeWindow: BrowserSolanaTxSnapshot['tradeWindow'];
}

export interface XxyyTradeWindowInput {
  afterTrades: XxyyTradeRecord[];
  beforeTrades: XxyyTradeRecord[];
  nativeSymbol?: string;
  selectedPoolAddress?: string;
  targetTrade: XxyyTradeRecord;
}

interface XxyyTradeQueryInput {
  poolAddress: string;
  signerAddress?: string;
  timeEnd?: number;
  timeStart?: number;
  txHash: string;
}

interface XxyyTradeQueryOutput {
  afterTrades: XxyyTradeRecord[];
  beforeTrades: XxyyTradeRecord[];
  targetTrade?: XxyyTradeRecord;
}

type XxyySearchChain = 'solana' | BrowserEvmChain;

interface XxyyOriginalTradeListTargetPosition {
  rowHeight: number;
  targetIndex: number;
  targetRowY: number;
}

export interface XxyyOriginalTargetRowCandidate {
  attributes?: string[];
  centerY: number;
  hrefs: string[];
  text: string;
}

type BrowserEventLike = object;

interface BrowserEventConstructor {
  new (type: string, init?: Record<string, unknown>): BrowserEventLike;
}

interface BrowserInputElementLike {
  dispatchEvent(event: BrowserEventLike): boolean;
  focus(): void;
  value: string;
}

interface BrowserElementLike {
  dispatchEvent(event: BrowserEventLike): boolean;
}

interface BrowserGlobalLike {
  Event: BrowserEventConstructor;
  HTMLInputElement: {
    prototype: object;
  };
  MouseEvent: BrowserEventConstructor;
}

const DEFAULT_DISCOVER_URL = 'https://www.xxyy.io/discover';
const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
const DEFAULT_TIMEOUT_MS = 60000;
const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const XXYY_ORIGINAL_SCREENSHOT_MIN_HEIGHT = 1800;
const XXYY_ORIGINAL_SCREENSHOT_MIN_WIDTH = 1440;
const SOLANA_ADDRESS_CAPTURE = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const SOLANA_TX_SIGNATURE_CAPTURE = '[1-9A-HJ-NP-Za-km-z]{64,96}';
const EVM_FLEXIBLE_ADDRESS_CAPTURE = '0x(?:[a-fA-F0-9]\\s*){40}';
const EVM_ABI_WORD_ADDRESS_CAPTURE = '(?:0x)?(?:0\\s*){24}((?:[a-fA-F0-9]\\s*){40})';
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const EVM_TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/iu;
const EVM_TX_HASH_TEXT_PATTERN = /\b0x[a-fA-F0-9]{64}\b/iu;
const HASH_ABBREVIATION_SEPARATOR_PATTERN = '(?:\\.{2,3}|…|⋯|[-–—])';
const EVM_ABBREVIATED_TX_HASH_TEXT_PATTERN = new RegExp(
  `\\b0x[a-fA-F0-9]{2,12}\\s*${HASH_ABBREVIATION_SEPARATOR_PATTERN}\\s*[a-fA-F0-9]{4,12}\\b`,
  'iu',
);
const EVM_ABBREVIATED_ADDRESS_TEXT_PATTERN = new RegExp(
  `\\b0x[a-fA-F0-9]{2,12}\\s*${HASH_ABBREVIATION_SEPARATOR_PATTERN}\\s*[a-fA-F0-9]{4,12}\\b`,
  'gu',
);
const SOLANA_TX_SIGNATURE_TEXT_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{64,96}\b/u;
const SOLANA_ABBREVIATED_TX_SIGNATURE_TEXT_PATTERN = new RegExp(
  `\\b[1-9A-HJ-NP-Za-km-z]{4,12}\\s*${HASH_ABBREVIATION_SEPARATOR_PATTERN}\\s*[1-9A-HJ-NP-Za-km-z]{4,12}\\b`,
  'u',
);
const STABLE_SOLANA_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);
const COMMON_EVM_QUOTE_TOKEN_ADDRESSES = new Set(
  [
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    '0x4200000000000000000000000000000000000006',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    '0x55d398326f99059fF775485246999027B3197955',
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
  ].map((address) => address.toLowerCase()),
);
const COMMON_EVM_QUOTE_TOKEN_SYMBOL_PATTERN =
  /(?:^|[^A-Z0-9])(?:USDC|USDBC|USDT|DAI|WETH|WBNB|WBTC)(?:[^A-Z0-9]|$)/u;
const EVM_POOL_LABEL_PATTERN =
  '_?(?:Pair|Pool|LP|AMM|Market(?!\\s*Cap(?:italization)?\\b))(?:\\s*[_-]?\\s*(?:Address|Addr|Contract|Token|Id|Identifier))?|[a-z0-9]+(?:pair|pool|amm|market)(?:address|addr|contract|id|identifier)?|_?(?:pair|pool|lp|amm|market)[_-]?(?:address|addr|contract|id|identifier)|lp[_-]?token(?:[_-]?(?:address|addr|contract|id|identifier))?|liquidity[_-]?pool(?:[_-]?(?:address|addr|contract|id|identifier))?';
const SOLANA_POOL_LINK_LABEL_PATTERN = /\b(?:AMM(?:\s+ID)?|Market|Pool|Pair|LP|Liquidity)\b/iu;
const EVM_ROUTER_LABEL_PATTERN =
  'Router|[a-z0-9]+router[a-z0-9]*|(?:Exchange|Protocol)\\s*Proxy|router[_-]?(?:address|addr|contract)?|permit2(?:[_-]?(?:address|addr|contract))?|spender|allowance[_-]?target';
const EVM_ROUTE_PATH_LABEL_PATTERN =
  '_?(?:(?:encoded|packed|bytes)\\s*[_-]?\\s*path|(?:route|swap|tokens?)\\s*[_-]?\\s*path(?:\\s*[_-]?\\s*(?:bytes|hex|data))?|path\\s*[_-]?\\s*(?:tokens?|addresses?|addrs?|bytes|hex|data)|path|routes?)';
const EVM_ROUTE_PATH_SEPARATOR_PATTERN = '(?:->|=>|→|>|›|»)';
const EVM_TRANSACTION_SENDER_LABEL_PATTERN =
  '(?:From|Sender|Caller|Called\\s+by|Initiated\\s+by|Initiator|Submitted\\s+by|Originating\\s+Address|(?:Transaction|Txn)\\s+Origin|(?:Transaction|Txn|Tx)\\s+Initiator)';

export function createPlaywrightBrowserTxAnalysisDriver(
  options: PlaywrightBrowserTxAnalysisDriverOptions = {},
): BrowserTxAnalysisDriver {
  return {
    async analyzeEvmTransaction(input) {
      const context = await launchBrowserContext(options);
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const explorer = await extractEvmTransaction(page, input.chain, input.txHash, options);
        const xxyy = await extractXxyyEvmPoolWindow(page, input.txHash, explorer, options);
        const fallbackTradeWindow = extractTradeWindowFromText(xxyy.text, explorer.signerAddress);

        return {
          ...(explorer.contractAddress === undefined
            ? {}
            : { contractAddress: explorer.contractAddress }),
          explorerUrl: explorer.explorerUrl,
          ...(xxyy.tradeWindow?.selectedPoolAddress === undefined &&
          explorer.poolAddress === undefined
            ? {}
            : { poolAddress: xxyy.tradeWindow?.selectedPoolAddress ?? explorer.poolAddress }),
          ...(explorer.routerAddress === undefined
            ? {}
            : { routerAddress: explorer.routerAddress }),
          ...(xxyy.screenshotUrl === undefined ? {} : { screenshotUrl: xxyy.screenshotUrl }),
          ...(xxyy.screenshotTargetRowMarked === true ? { screenshotTargetRowMarked: true } : {}),
          targetTrade:
            xxyy.tradeWindow?.targetTrade ?? createEvmFallbackTargetTrade(input.txHash, explorer),
          ...(explorer.transactionTime === undefined
            ? {}
            : { transactionTime: explorer.transactionTime }),
          tradeWindow: xxyy.tradeWindow?.tradeWindow ?? fallbackTradeWindow,
          ...(xxyy.xxyyPoolUrl === undefined ? {} : { xxyyPoolUrl: xxyy.xxyyPoolUrl }),
        };
      } finally {
        await context.close();
      }
    },
    async analyzeSolanaTransaction(input) {
      const context = await launchBrowserContext(options);
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const solscan = await extractSolanaTransaction(page, input.txHash, options);
        const xxyy = await extractXxyyPoolWindow(page, input.txHash, solscan, options);
        const fallbackTradeWindow = extractTradeWindowFromText(xxyy.text, solscan.signerAddress);

        return {
          ...(solscan.contractAddress === undefined
            ? {}
            : { contractAddress: solscan.contractAddress }),
          ...(xxyy.tradeWindow?.selectedPoolAddress === undefined &&
          solscan.poolAddress === undefined
            ? {}
            : { poolAddress: xxyy.tradeWindow?.selectedPoolAddress ?? solscan.poolAddress }),
          ...(solscan.program === undefined ? {} : { program: solscan.program }),
          ...(xxyy.screenshotUrl === undefined ? {} : { screenshotUrl: xxyy.screenshotUrl }),
          ...(xxyy.screenshotTargetRowMarked === true ? { screenshotTargetRowMarked: true } : {}),
          solscanUrl: solscan.solscanUrl,
          targetTrade:
            xxyy.tradeWindow?.targetTrade ??
            createSolscanFallbackTargetTrade(input.txHash, solscan),
          ...(solscan.transactionTime === undefined
            ? {}
            : { transactionTime: solscan.transactionTime }),
          tradeWindow: xxyy.tradeWindow?.tradeWindow ?? fallbackTradeWindow,
          ...(xxyy.xxyyPoolUrl === undefined ? {} : { xxyyPoolUrl: xxyy.xxyyPoolUrl }),
        };
      } finally {
        await context.close();
      }
    },
  };
}

export function isBrowserVerificationPageText(text: string): boolean {
  return isBrowserVerificationText(text);
}

export function createSolanaPublicFallbackUnavailableError(
  cause: Error,
  fallbackErrors: unknown[],
): TxAnalysisProviderUnavailableError {
  const allErrors = [cause, ...fallbackErrors];
  const unavailableErrors = [cause, ...fallbackErrors].filter(
    (error): error is TxAnalysisProviderUnavailableError =>
      error instanceof TxAnalysisProviderUnavailableError,
  );
  if (
    unavailableErrors.length > 0 &&
    unavailableErrors.every((error) => error.reason === 'browser_verification_required')
  ) {
    return new TxAnalysisProviderUnavailableError(
      '公开交易浏览器正在进行安全验证。请用可见 Chrome 完成验证后重试；当前不会把安全验证误报为交易不存在。',
      'browser_verification_required',
    );
  }
  if (allErrors.length > 0 && allErrors.every(isBrowserTimeoutError)) {
    return new TxAnalysisProviderUnavailableError(
      '公开交易浏览器访问超时。请稍后重试，或用可见 Chrome 打开 Solscan/Solana Explorer/SolanaFM 确认页面可访问；当前不会把公开页面超时误报为交易不存在。',
      'timeout',
    );
  }
  if (allErrors.length > 0 && allErrors.every(isTransientBrowserNetworkError)) {
    return new TxAnalysisProviderUnavailableError(
      `公开交易浏览器临时不可用：${cause.message}`,
      'provider_unavailable',
    );
  }

  return new TxAnalysisProviderUnavailableError(
    `Solscan 不可用，且公开浏览器 fallback 未能解析交易：${cause.message}`,
    'tx_not_found',
  );
}

async function launchBrowserContext(
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<BrowserContext> {
  const executablePath =
    options.chromeExecutablePath === undefined
      ? resolveChromeExecutablePath()
      : options.chromeExecutablePath;
  const workspaceCwd = resolveWorkspaceCwd(process.cwd(), process.env);
  const userDataDir =
    options.userDataDir === undefined
      ? path.join(workspaceCwd, '.tx-analysis-browser-profile')
      : path.resolve(options.userDataDir);

  try {
    return await chromium.launchPersistentContext(userDataDir, {
      headless: options.headless ?? false,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      viewport: { height: 1200, width: 1440 },
      ...(executablePath === undefined ? {} : { executablePath }),
    });
  } catch (error) {
    throw new TxAnalysisProviderUnavailableError(
      `无法启动本地 Chrome 浏览器：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function extractSolanaTransaction(
  page: Page,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<SolscanExtraction> {
  try {
    return await extractSolscanTransaction(page, txHash, options);
  } catch (error) {
    if (!isRecoverableSolscanExtractionError(error)) {
      throw error;
    }

    return extractPublicSolanaTransactionFallback(page, txHash, options, normalizeError(error));
  }
}

function isRecoverableSolscanExtractionError(error: unknown): boolean {
  if (error instanceof TxAnalysisProviderUnavailableError) {
    return (
      error.reason !== 'browser_verification_required' &&
      !isFinalTransactionStatusUnavailableError(error)
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    isBrowserTimeoutError(error) ||
    isTransientBrowserNetworkError(error) ||
    /net::err_/iu.test(message)
  );
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function isFinalTransactionStatusUnavailableError(error: unknown): boolean {
  return (
    error instanceof TxAnalysisProviderUnavailableError &&
    (error.reason === 'tx_failed' || error.reason === 'tx_pending')
  );
}

async function extractSolscanTransaction(
  page: Page,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<SolscanExtraction> {
  const solscanUrl = `https://solscan.io/tx/${txHash}`;
  await page.goto(solscanUrl, {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(5000);

  const bodyText = await page.locator('body').innerText();
  if (isBrowserVerificationPageText(bodyText)) {
    throw new TxAnalysisProviderUnavailableError(
      'Solscan 正在进行浏览器安全验证。请用可见 Chrome 完成验证后重试，或关闭 headless 模式。',
      'browser_verification_required',
    );
  }
  assertSolanaExplorerSignatureMatches(bodyText, txHash, solscanUrl);

  if (isSolanaTransactionPendingStatus(bodyText)) {
    const signerAddress = extractSigner(bodyText);
    const transactionTime = extractTransactionTime(bodyText);
    throw new TxAnalysisProviderUnavailableError(
      'Solscan 显示这笔交易还未确认或已被丢弃/替换，无法把它当作成功成交继续做夹子判断。',
      'tx_pending',
      {
        metadata: createSolanaExplorerFailureMetadata({
          poolCandidates: [],
          ...(signerAddress === undefined ? {} : { signerAddress }),
          side: 'unknown',
          solscanUrl,
          ...(transactionTime === undefined ? {} : { transactionTime }),
        }),
      },
    );
  }

  if (isSolanaTransactionFailedStatus(bodyText)) {
    const signerAddress = extractSigner(bodyText);
    const transactionTime = extractTransactionTime(bodyText);
    throw new TxAnalysisProviderUnavailableError(
      'Solscan 显示这笔交易执行失败，无法把它当作成功成交继续做夹子判断。',
      'tx_failed',
      {
        metadata: createSolanaExplorerFailureMetadata({
          poolCandidates: [],
          ...(signerAddress === undefined ? {} : { signerAddress }),
          side: 'unknown',
          solscanUrl,
          ...(transactionTime === undefined ? {} : { transactionTime }),
        }),
      },
    );
  }

  const links = await collectPageLinks(page);
  const tokenLinks = links
    .filter((link) => link.href.includes('/token/'))
    .map((link) => ({
      ...link,
      address: extractLastPathSegment(link.href),
    }))
    .filter((link) => SOLANA_ADDRESS_PATTERN.test(link.address));
  const contractToken =
    tokenLinks.find((link) => !STABLE_SOLANA_MINTS.has(link.address)) ?? tokenLinks[0];
  const contractAddress = contractToken?.address;
  const poolAddress = links
    .map((link) => ({
      ...link,
      address: extractLastPathSegment(link.href),
    }))
    .find(
      (link) =>
        link.href.includes('/account/') &&
        SOLANA_ADDRESS_PATTERN.test(link.address) &&
        SOLANA_POOL_LINK_LABEL_PATTERN.test(link.text),
    )?.address;
  const poolCandidates = poolAddress === undefined ? [] : [{ address: poolAddress }];

  const program = extractProgram(bodyText);
  const signerAddress = extractSigner(bodyText);
  const transactionTime = extractTransactionTime(bodyText);

  return enrichSolscanExtractionFromRpcIfNeeded(
    {
      ...(contractAddress === undefined ? {} : { contractAddress }),
      ...(poolAddress === undefined ? {} : { poolAddress }),
      poolCandidates,
      ...(program === undefined ? {} : { program }),
      ...(signerAddress === undefined ? {} : { signerAddress }),
      side: inferEvmTradeSide(bodyText, contractToken?.text),
      solscanUrl,
      ...(transactionTime === undefined ? {} : { transactionTime }),
    },
    txHash,
    options,
  );
}

async function enrichSolscanExtractionFromRpcIfNeeded(
  solscan: SolscanExtraction,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<SolscanExtraction> {
  if (
    solscan.contractAddress !== undefined &&
    solscan.poolAddress !== undefined &&
    solscan.signerAddress !== undefined
  ) {
    return solscan;
  }

  const rpcExtraction = await extractSolanaRpcTransaction(txHash, options).catch(() => undefined);
  if (rpcExtraction === undefined) {
    return solscan;
  }

  const contractAddress = solscan.contractAddress ?? rpcExtraction.contractAddress;
  const poolAddress = solscan.poolAddress ?? rpcExtraction.poolAddress;
  const program = solscan.program ?? rpcExtraction.program;
  const signerAddress = solscan.signerAddress ?? rpcExtraction.signerAddress;
  const transactionTime = solscan.transactionTime ?? rpcExtraction.transactionTime;
  const poolCandidates = uniquePoolCandidates([
    ...solscan.poolCandidates,
    ...(rpcExtraction.poolAddress === undefined ? [] : [{ address: rpcExtraction.poolAddress }]),
  ]);

  return {
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(poolAddress === undefined ? {} : { poolAddress }),
    poolCandidates,
    ...(program === undefined ? {} : { program }),
    ...(signerAddress === undefined ? {} : { signerAddress }),
    side: solscan.side === 'unknown' ? (rpcExtraction.side ?? solscan.side) : solscan.side,
    solscanUrl: solscan.solscanUrl,
    ...(transactionTime === undefined ? {} : { transactionTime }),
  };
}

async function extractSolanaRpcTransaction(
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<Partial<SolscanExtraction> | undefined> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchFn(options.solanaRpcUrl ?? DEFAULT_SOLANA_RPC_URL, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'getTransaction',
        params: [
          txHash,
          {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    });
    if (response.ok === false) {
      return undefined;
    }

    return solanaRpcExtractionFromResponse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function solanaRpcExtractionFromResponse(payload: unknown): Partial<SolscanExtraction> | undefined {
  const result = readRecord(readRecord(payload).result);
  if (Object.keys(result).length === 0) {
    return undefined;
  }

  const pumpInstruction = findSolanaRpcPumpAmmInstruction(result);
  const signerAddress =
    readString(pumpInstruction?.accounts?.[1]) ?? findSolanaRpcSignerAddress(result);
  const contractAddress =
    readString(pumpInstruction?.accounts?.[3]) ?? findSolanaRpcPrimaryTokenMint(result);
  const poolAddress = readString(pumpInstruction?.accounts?.[0]);
  const side =
    signerAddress === undefined || contractAddress === undefined
      ? undefined
      : inferSolanaRpcTradeSide(result, signerAddress, contractAddress);
  const blockTime = readNumber(result.blockTime);
  const transactionTime =
    blockTime === undefined ? undefined : new Date(blockTime * 1000).toISOString();
  const program = readString(pumpInstruction?.programId);

  if (
    contractAddress === undefined &&
    poolAddress === undefined &&
    signerAddress === undefined &&
    transactionTime === undefined &&
    program === undefined
  ) {
    return undefined;
  }

  return {
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(poolAddress === undefined ? {} : { poolAddress }),
    ...(program === undefined ? {} : { program }),
    ...(signerAddress === undefined ? {} : { signerAddress }),
    ...(side === undefined ? {} : { side }),
    ...(transactionTime === undefined ? {} : { transactionTime }),
  };
}

function findSolanaRpcPumpAmmInstruction(result: Record<string, unknown>):
  | {
      accounts: string[];
      programId: string;
    }
  | undefined {
  return solanaRpcInstructions(result).find(
    (instruction) =>
      instruction.programId === PUMP_AMM_PROGRAM_ID &&
      instruction.accounts.length >= 5 &&
      SOLANA_ADDRESS_PATTERN.test(instruction.accounts[0] ?? '') &&
      SOLANA_ADDRESS_PATTERN.test(instruction.accounts[1] ?? '') &&
      SOLANA_ADDRESS_PATTERN.test(instruction.accounts[3] ?? ''),
  );
}

function solanaRpcInstructions(
  result: Record<string, unknown>,
): Array<{ accounts: string[]; programId: string }> {
  const transaction = readRecord(result.transaction);
  const message = readRecord(transaction.message);
  const topLevelInstructions = readArray(message.instructions);
  const meta = readRecord(result.meta);
  const innerInstructionGroups = readArray(meta.innerInstructions);
  const innerInstructions = innerInstructionGroups.flatMap((group) =>
    readArray(readRecord(group).instructions),
  );

  return [...topLevelInstructions, ...innerInstructions].flatMap((instruction) => {
    const record = readRecord(instruction);
    const programId = readString(record.programId);
    const accounts = readArray(record.accounts).flatMap((account) => {
      const value = readString(account);
      return value === undefined ? [] : [value];
    });
    return programId === undefined ? [] : [{ accounts, programId }];
  });
}

function findSolanaRpcSignerAddress(result: Record<string, unknown>): string | undefined {
  const transaction = readRecord(result.transaction);
  const message = readRecord(transaction.message);
  return readArray(message.accountKeys)
    .map((account) => readRecord(account))
    .find((account) => account.signer === true)?.pubkey as string | undefined;
}

function findSolanaRpcPrimaryTokenMint(result: Record<string, unknown>): string | undefined {
  for (const balance of solanaRpcTokenBalances(result)) {
    const mint = readString(balance.mint);
    if (mint !== undefined && !STABLE_SOLANA_MINTS.has(mint)) {
      return mint;
    }
  }

  return undefined;
}

function inferSolanaRpcTradeSide(
  result: Record<string, unknown>,
  signerAddress: string,
  contractAddress: string,
): BrowserTradeSide | undefined {
  const preAmount = solanaRpcTokenAmount(
    result,
    'preTokenBalances',
    signerAddress,
    contractAddress,
  );
  const postAmount = solanaRpcTokenAmount(
    result,
    'postTokenBalances',
    signerAddress,
    contractAddress,
  );
  if (preAmount === undefined || postAmount === undefined) {
    return undefined;
  }

  const delta = postAmount - preAmount;
  if (delta > 0n) {
    return 'buy';
  }
  if (delta < 0n) {
    return 'sell';
  }

  return undefined;
}

function solanaRpcTokenAmount(
  result: Record<string, unknown>,
  field: 'postTokenBalances' | 'preTokenBalances',
  owner: string,
  mint: string,
): bigint | undefined {
  const balance = solanaRpcTokenBalances(result, field).find(
    (item) => readString(item.owner) === owner && readString(item.mint) === mint,
  );
  const amount = readString(readRecord(balance?.uiTokenAmount).amount);
  if (amount === undefined || !/^\d+$/u.test(amount)) {
    return undefined;
  }

  return BigInt(amount);
}

function solanaRpcTokenBalances(
  result: Record<string, unknown>,
  field?: 'postTokenBalances' | 'preTokenBalances',
): Record<string, unknown>[] {
  const meta = readRecord(result.meta);
  const balances =
    field === undefined
      ? [...readArray(meta.preTokenBalances), ...readArray(meta.postTokenBalances)]
      : readArray(meta[field]);
  return balances.map((balance) => readRecord(balance));
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function extractPublicSolanaTransactionFallback(
  page: Page,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
  cause: Error,
): Promise<SolscanExtraction> {
  const fallbackErrors: unknown[] = [];
  const explorer: Partial<SolscanExtraction> = await extractSolanaExplorerTransaction(
    page,
    txHash,
    options,
  ).catch((error: unknown): Partial<SolscanExtraction> => {
    if (isFinalTransactionStatusUnavailableError(error)) {
      throw error;
    }
    fallbackErrors.push(error);
    return {};
  });
  const solanaFm: Partial<SolscanExtraction> = await extractSolanaFmTransaction(
    page,
    txHash,
    options,
  ).catch((error: unknown): Partial<SolscanExtraction> => {
    if (isFinalTransactionStatusUnavailableError(error)) {
      throw error;
    }
    fallbackErrors.push(error);
    return {};
  });
  const poolCandidates = uniquePoolCandidates([
    ...(solanaFm.poolCandidates ?? []),
    ...(explorer.poolCandidates ?? []),
  ]);
  const poolAddress =
    firstString(solanaFm.poolAddress, explorer.poolAddress) ?? poolCandidates[0]?.address;
  const contractAddress = firstString(solanaFm.contractAddress, explorer.contractAddress);
  const signerAddress = firstString(explorer.signerAddress, solanaFm.signerAddress);
  const transactionTime = firstString(solanaFm.transactionTime, explorer.transactionTime);
  const program = firstString(solanaFm.program, explorer.program);

  if (poolAddress === undefined && contractAddress === undefined && signerAddress === undefined) {
    throw createSolanaPublicFallbackUnavailableError(cause, fallbackErrors);
  }

  return {
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(poolAddress === undefined ? {} : { poolAddress }),
    poolCandidates,
    ...(program === undefined ? {} : { program }),
    ...(signerAddress === undefined ? {} : { signerAddress }),
    side: 'unknown',
    solscanUrl: `https://solana.fm/tx/${txHash}`,
    ...(transactionTime === undefined ? {} : { transactionTime }),
  };
}

async function extractSolanaExplorerTransaction(
  page: Page,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<Partial<SolscanExtraction>> {
  await page.goto(`https://explorer.solana.com/tx/${txHash}`, {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(8000);

  const text = await page.locator('body').innerText();
  if (isBrowserVerificationPageText(text)) {
    throw new TxAnalysisProviderUnavailableError(
      'Solana Explorer 正在进行浏览器安全验证。请用可见 Chrome 完成验证后重试，或关闭 headless 模式。',
      'browser_verification_required',
    );
  }
  const solanaExplorerUrl = `https://explorer.solana.com/tx/${txHash}`;
  assertSolanaExplorerSignatureMatches(text, txHash, solanaExplorerUrl);
  const signerAddress = extractSigner(text);
  const transactionTime = extractSolanaExplorerTransactionTime(text);
  if (isSolanaTransactionFailedStatus(text)) {
    throw new TxAnalysisProviderUnavailableError(
      'Solana Explorer 显示这笔交易执行失败，无法把它当作成功成交继续做夹子判断。',
      'tx_failed',
      {
        metadata: createSolanaExplorerFailureMetadata({
          poolCandidates: [],
          ...(signerAddress === undefined ? {} : { signerAddress }),
          side: 'unknown',
          solscanUrl: solanaExplorerUrl,
          ...(transactionTime === undefined ? {} : { transactionTime }),
        }),
      },
    );
  }
  if (isSolanaTransactionPendingStatus(text)) {
    throw new TxAnalysisProviderUnavailableError(
      'Solana Explorer 显示这笔交易还未确认或仍在处理，无法把它当作成功成交继续做夹子判断。',
      'tx_pending',
      {
        metadata: createSolanaExplorerFailureMetadata({
          poolCandidates: [],
          ...(signerAddress === undefined ? {} : { signerAddress }),
          side: 'unknown',
          solscanUrl: solanaExplorerUrl,
          ...(transactionTime === undefined ? {} : { transactionTime }),
        }),
      },
    );
  }
  const contractAddress = extractLikelyTokenMint(text);
  const program = new RegExp(`Interacted with program\\s+(${SOLANA_ADDRESS_CAPTURE})`, 'u').exec(
    text,
  )?.[1];

  return {
    ...(contractAddress === undefined ? {} : { contractAddress }),
    poolCandidates: [],
    ...(program === undefined ? {} : { program }),
    ...(signerAddress === undefined ? {} : { signerAddress }),
    ...(transactionTime === undefined ? {} : { transactionTime }),
  };
}

async function extractSolanaFmTransaction(
  page: Page,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<Partial<SolscanExtraction>> {
  await page.goto(`https://solana.fm/tx/${txHash}`, {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(10000);

  const text = await page.locator('body').innerText();
  if (isBrowserVerificationPageText(text)) {
    throw new TxAnalysisProviderUnavailableError(
      'SolanaFM 正在进行浏览器安全验证。请用可见 Chrome 完成验证后重试，或关闭 headless 模式。',
      'browser_verification_required',
    );
  }
  const solanaFmUrl = `https://solana.fm/tx/${txHash}`;
  assertSolanaExplorerSignatureMatches(text, txHash, solanaFmUrl);
  const poolCandidates = extractSolanaFmPoolCandidates(text);
  const contractAddress = extractLikelyTokenMint(text);
  const transactionTime = extractSolanaFmTransactionTime(text);
  const program = new RegExp(`Interacted with program\\s+(${SOLANA_ADDRESS_CAPTURE})`, 'u').exec(
    text,
  )?.[1];
  const signerAddress = extractSigner(text) ?? extractSignerFromProgramLogs(text);
  if (isSolanaTransactionFailedStatus(text)) {
    throw new TxAnalysisProviderUnavailableError(
      'SolanaFM 显示这笔交易执行失败，无法把它当作成功成交继续做夹子判断。',
      'tx_failed',
      {
        metadata: createSolanaExplorerFailureMetadata({
          ...(contractAddress === undefined ? {} : { contractAddress }),
          ...(poolCandidates[0] === undefined ? {} : { poolAddress: poolCandidates[0].address }),
          poolCandidates,
          ...(program === undefined ? {} : { program }),
          ...(signerAddress === undefined ? {} : { signerAddress }),
          side: 'unknown',
          solscanUrl: solanaFmUrl,
          ...(transactionTime === undefined ? {} : { transactionTime }),
        }),
      },
    );
  }
  if (isSolanaTransactionPendingStatus(text)) {
    throw new TxAnalysisProviderUnavailableError(
      'SolanaFM 显示这笔交易还未确认或仍在处理，无法把它当作成功成交继续做夹子判断。',
      'tx_pending',
      {
        metadata: createSolanaExplorerFailureMetadata({
          ...(contractAddress === undefined ? {} : { contractAddress }),
          ...(poolCandidates[0] === undefined ? {} : { poolAddress: poolCandidates[0].address }),
          poolCandidates,
          ...(program === undefined ? {} : { program }),
          ...(signerAddress === undefined ? {} : { signerAddress }),
          side: 'unknown',
          solscanUrl: solanaFmUrl,
          ...(transactionTime === undefined ? {} : { transactionTime }),
        }),
      },
    );
  }

  return {
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(poolCandidates[0] === undefined ? {} : { poolAddress: poolCandidates[0].address }),
    poolCandidates,
    ...(program === undefined ? {} : { program }),
    ...(signerAddress === undefined ? {} : { signerAddress }),
    ...(transactionTime === undefined ? {} : { transactionTime }),
  };
}

export async function extractEvmTransaction(
  page: Page,
  chain: BrowserEvmChain,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<EvmExplorerExtraction> {
  const explorerUrls = buildEvmExplorerTxUrls(chain, txHash);
  const retryableErrors: unknown[] = [];

  for (const explorerUrl of explorerUrls) {
    try {
      return await extractEvmTransactionFromExplorerUrl(page, chain, txHash, options, explorerUrl);
    } catch (error) {
      if (!shouldTryNextEvmExplorer(error)) {
        throw error;
      }
      retryableErrors.push(error);
    }
  }

  throw selectEvmExplorerExtractionFailure(chain, retryableErrors);
}

async function extractEvmTransactionFromExplorerUrl(
  page: Page,
  chain: BrowserEvmChain,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
  explorerUrl: string,
): Promise<EvmExplorerExtraction> {
  await page.goto(explorerUrl, {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(5000);

  const bodyText = await page.locator('body').innerText();
  const explorerDisplayName = evmExplorerNameForUrl(chain, explorerUrl);
  if (isBrowserVerificationPageText(bodyText)) {
    throw new TxAnalysisProviderUnavailableError(
      'EVM 交易浏览器正在进行浏览器安全验证。请用可见 Chrome 完成验证后重试，或关闭 headless 模式。',
      'browser_verification_required',
    );
  }

  const displayedTxHash = extractEvmExplorerDisplayedTransactionHash(bodyText);
  if (displayedTxHash !== undefined && !xxyyTransactionHashMatches(displayedTxHash, txHash)) {
    throw new TxAnalysisProviderUnavailableError(
      `${explorerDisplayName} 返回的交易哈希与用户提交的交易哈希不一致，无法继续做夹子判断。`,
      'tx_not_found',
      {
        metadata: createEvmExplorerFailureMetadata({
          chain,
          explorerUrl,
          poolCandidates: [],
          side: 'unknown',
        }),
      },
    );
  }

  const isFailedTransaction = isEvmTransactionFailedStatus(bodyText);
  const isPendingTransaction = isEvmTransactionPendingStatus(bodyText);
  const links = await collectPageLinks(page).catch((): PageLink[] => []);
  const addressLinks = links
    .filter((link) => link.href.includes('/address/'))
    .map((link) => ({
      ...link,
      address: extractLastPathSegment(link.href),
    }))
    .filter((link) => EVM_ADDRESS_PATTERN.test(link.address));

  if (isFailedTransaction) {
    const signerAddress =
      extractEvmTransactionFromAddress(bodyText) ??
      extractEvmTransactionFromAddressLinks(bodyText, addressLinks);
    const transactionTime = extractEvmTransactionTime(bodyText);
    const failedExplorer: EvmExplorerExtraction = {
      chain,
      explorerUrl,
      poolCandidates: [],
      ...(signerAddress === undefined ? {} : { signerAddress }),
      side: 'unknown',
      ...(transactionTime === undefined ? {} : { transactionTime }),
    };
    throw new TxAnalysisProviderUnavailableError(
      `${explorerDisplayName} 显示这笔交易执行失败，无法把它当作成功成交继续做夹子判断。`,
      'tx_failed',
      { metadata: createEvmExplorerFailureMetadata(failedExplorer) },
    );
  }

  if (isPendingTransaction) {
    const signerAddress =
      extractEvmTransactionFromAddress(bodyText) ??
      extractEvmTransactionFromAddressLinks(bodyText, addressLinks);
    const transactionTime = extractEvmTransactionTime(bodyText);
    const pendingExplorer: EvmExplorerExtraction = {
      chain,
      explorerUrl,
      poolCandidates: [],
      ...(signerAddress === undefined ? {} : { signerAddress }),
      side: 'unknown',
      ...(transactionTime === undefined ? {} : { transactionTime }),
    };
    throw new TxAnalysisProviderUnavailableError(
      `${explorerDisplayName} 显示这笔交易还未确认或已被丢弃/替换，无法把它当作成功成交继续做夹子判断。`,
      'tx_pending',
      { metadata: createEvmExplorerFailureMetadata(pendingExplorer) },
    );
  }

  const tokenLinks = links
    .filter((link) => link.href.includes('/token/'))
    .map((link) => ({
      ...link,
      address: extractLastPathSegment(link.href),
    }))
    .filter((link) => EVM_ADDRESS_PATTERN.test(link.address));
  const poolTokenLinks = tokenLinks.filter((link) => isEvmPoolLabelText(link.text));
  const contractToken = selectEvmContractTokenCandidate(tokenLinks);
  const contractAddress =
    contractToken?.address ??
    extractEvmContractAddressFromExplorerLinks(bodyText, addressLinks) ??
    extractEvmContractAddress(bodyText);
  const contractTokenText =
    contractToken?.text ??
    extractEvmContractTokenTextFromExplorerLinks(bodyText, addressLinks) ??
    extractEvmContractTokenText(bodyText);
  const poolCandidates = uniqueEvmPoolCandidates([
    ...poolTokenLinks.map((link) => ({ address: link.address })),
    ...addressLinks
      .filter((link) => isEvmPoolLabelText(link.text))
      .map((link) => ({ address: link.address })),
    ...extractEvmPoolAddressesFromExplorerLinks(bodyText, addressLinks).map((address) => ({
      address,
    })),
    ...extractEvmPoolAddressesFromExplorerText(bodyText).map((address) => ({ address })),
  ]);
  const poolAddress = poolCandidates[0]?.address;
  const routerAddress =
    addressLinks.find((link) => /\bRouter\b/iu.test(link.text))?.address ??
    extractEvmRouterAddressFromExplorerLinks(bodyText, addressLinks) ??
    extractEvmRouterAddressFromExplorerText(bodyText);
  const signerAddress =
    extractEvmTransactionFromAddress(bodyText) ??
    extractEvmTransactionFromAddressLinks(bodyText, addressLinks);
  const transactionTime = extractEvmTransactionTime(bodyText);

  if (contractAddress === undefined && signerAddress === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      `${explorerDisplayName} 未能解析交易详情。请检查交易哈希和链是否正确。`,
      'tx_not_found',
    );
  }

  return {
    chain,
    ...(contractAddress === undefined ? {} : { contractAddress }),
    explorerUrl,
    ...(poolAddress === undefined ? {} : { poolAddress }),
    poolCandidates,
    ...(routerAddress === undefined ? {} : { routerAddress }),
    ...(signerAddress === undefined ? {} : { signerAddress }),
    side: inferEvmTradeSide(bodyText, contractTokenText, contractAddress, signerAddress, [
      ...poolCandidates.map((candidate) => candidate.address),
      ...(routerAddress === undefined ? [] : [routerAddress]),
    ]),
    ...(transactionTime === undefined ? {} : { transactionTime }),
  };
}

function isEvmTransactionFailedStatus(text: string): boolean {
  const compact = text.replace(/\s+/gu, ' ');
  return (
    /\bStatus\s*:?\s*(?:Fail|Failed|Failure|Reverted|Error|Unsuccessful)\b/iu.test(compact) ||
    /\bStatus\s*:?\s*(?:0|0x0|false)\b/iu.test(compact) ||
    /\bTransaction\s+(?:Receipt\s+)?Status\s*:?\s*(?:Fail|Failed|Failure|Reverted|Error|Unsuccessful)\b/iu.test(
      compact,
    ) ||
    /\bTransaction\s+Receipt\s+Status\s*:?\s*(?:0|0x0|false)\b/iu.test(compact) ||
    /\bResult\s*:?\s*(?:Fail|Failed|Failure|Reverted|Error|Unsuccessful|0|0x0|false)\b/iu.test(
      compact,
    ) ||
    /\bSuccess\s*:?\s*(?:false|0|0x0|no)\b/iu.test(compact) ||
    /\bis\s*Error\s*:?\s*(?:true|1|0x1|yes)\b/iu.test(compact) ||
    /\bTransaction\s+(?:Fail|Failed|Failure|Reverted)\b/iu.test(compact) ||
    /\b(?:Transaction|Txn)\s+has\s+been\s+reverted\b/iu.test(compact) ||
    /\b(?:Fail|Failed)\s+with\s+error\b/iu.test(compact) ||
    /\bexecution\s+reverted\b/iu.test(compact) ||
    /\bError\s+encountered\s+during\s+contract\s+execution\b/iu.test(compact) ||
    /\bError\s*:?\s*out\s+of\s+gas\b/iu.test(compact)
  );
}

function isEvmTransactionPendingStatus(text: string): boolean {
  const compact = text.replace(/\s+/gu, ' ');
  return (
    /\bStatus\s*:?\s*(?:Pending|Unconfirmed|Confirming|Processing|Awaiting\s+Confirmation|Awaiting\s+Mining|Awaiting\s+Inclusion|Dropped(?:\s*&\s*Replaced)?|Dropped|Replaced|Cancelled|Canceled)\b/iu.test(
      compact,
    ) ||
    /\bTransaction\s+(?:Receipt\s+)?Status\s*:?\s*(?:Pending|Unconfirmed|Confirming|Processing|Awaiting\s+Confirmation|Awaiting\s+Mining|Awaiting\s+Inclusion|Dropped(?:\s*&\s*Replaced)?|Dropped|Replaced|Cancelled|Canceled)\b/iu.test(
      compact,
    ) ||
    /\bResult\s*:?\s*(?:Pending|Unconfirmed|Confirming|Processing|Awaiting\s+Confirmation|Awaiting\s+Mining|Awaiting\s+Inclusion|Dropped(?:\s*&\s*Replaced)?|Dropped|Replaced|Cancelled|Canceled)\b/iu.test(
      compact,
    ) ||
    /\b(?:Transaction|Txn)\s+(?:is\s+)?(?:pending|unconfirmed|not\s+confirmed|not\s+finalized|awaiting\s+confirmation|confirming|processing)\b/iu.test(
      compact,
    ) ||
    /\b(?:Pending|Unconfirmed|Confirming|Processing)\s+(?:Transaction|Txn)\b/iu.test(compact) ||
    /\b(?:Transaction|Txn).{0,80}(?:mempool|not\s+yet\s+(?:mined|included|confirmed)|queued|awaiting\s+mining|awaiting\s+inclusion)\b/iu.test(
      compact,
    ) ||
    /\b(?:mempool|queued).{0,40}(?:Transaction|Txn)\b/iu.test(compact) ||
    /\b(?:Transaction|Txn).{0,40}(?:Dropped(?:\s*&\s*Replaced)?|Replaced|Cancelled|Canceled)\b/iu.test(
      compact,
    )
  );
}

function assertSolanaExplorerSignatureMatches(
  text: string,
  txHash: string,
  solscanUrl: string,
): void {
  const displayedSignature = extractSolanaExplorerDisplayedSignature(text);
  if (displayedSignature === undefined || xxyyTransactionHashMatches(displayedSignature, txHash)) {
    return;
  }

  throw new TxAnalysisProviderUnavailableError(
    '公开 Solana 交易浏览器返回的交易签名与用户提交的交易签名不一致，无法继续做夹子判断。',
    'tx_not_found',
    {
      metadata: createSolanaExplorerFailureMetadata({
        poolCandidates: [],
        side: 'unknown',
        solscanUrl,
      }),
    },
  );
}

function extractSolanaExplorerDisplayedSignature(text: string): string | undefined {
  const compact = text.replace(/\s+/gu, ' ');
  return new RegExp(
    `\\b(?:Transaction\\s+Signature|Tx\\s+Signature|Signature|Transaction\\s+Hash)\\b\\s*:?\\s*(${SOLANA_TX_SIGNATURE_CAPTURE})\\b`,
    'u',
  ).exec(compact)?.[1];
}

function extractEvmExplorerDisplayedTransactionHash(text: string): string | undefined {
  const compact = text.replace(/\s+/gu, ' ');
  const labeledHash =
    /\b(?:Transaction|Txn|Tx)\s*(?:Hash|ID)(?:\s+Details?)?\b\s*:?\s*(0x[a-fA-F0-9]{64})\b/iu.exec(
      compact,
    )?.[1];
  if (labeledHash !== undefined) {
    return labeledHash;
  }

  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const inlineHash = /^Hash\s*:?\s*(0x[a-fA-F0-9]{64})$/iu.exec(line)?.[1];
    if (inlineHash !== undefined) {
      return inlineHash;
    }

    if (/^Hash\s*:?$/iu.test(line)) {
      const nextLineHash = /^(0x[a-fA-F0-9]{64})$/iu.exec(lines[index + 1] ?? '')?.[1];
      if (nextLineHash !== undefined) {
        return nextLineHash;
      }
    }
  }

  return undefined;
}

function isTransactionFailureText(text: string): boolean {
  return isEvmTransactionFailedStatus(text) || isSolanaTransactionFailedStatus(text);
}

function isTransactionPendingText(text: string): boolean {
  return isEvmTransactionPendingStatus(text) || isSolanaTransactionPendingStatus(text);
}

function isSolanaTransactionFailedStatus(text: string): boolean {
  const compact = text.replace(/\s+/gu, ' ');
  return (
    /\bStatus\s*:?\s*(?:Fail|Failed|Error|Err)\b/iu.test(compact) ||
    /\bResult\s*:?\s*(?:Fail|Failed|Error|Err)\b/iu.test(compact) ||
    /\bTransaction\s+(?:Status\s*)?:?\s*(?:Fail|Failed|Error|Err)\b/iu.test(compact) ||
    /\bTransaction\s+Result\s*:?\s*(?:Fail|Failed|Error|Err)\b/iu.test(compact) ||
    /\b(?:Transaction\s+)?failed\s+with\s+error\b/iu.test(compact) ||
    /\bFailed\s+to\s+process\s+(?:the\s+)?transaction\b/iu.test(compact) ||
    /\bInstruction\s*(?:#\s*\d+\s*)?(?:Error|Failed)\b/iu.test(compact) ||
    /\bProgram\s+Error\b/iu.test(compact) ||
    /\bProgram\s+failed\b/iu.test(compact) ||
    /\bError\s+processing\s+instruction\b/iu.test(compact)
  );
}

function isSolanaTransactionPendingStatus(text: string): boolean {
  const compact = text.replace(/\s+/gu, ' ');
  return (
    /\bStatus\s*:?\s*(?:Pending|Unconfirmed|Confirming|Processing|Awaiting\s+Confirmation|Awaiting\s+Mining|Awaiting\s+Inclusion|Dropped(?:\s*&\s*Replaced)?|Dropped|Replaced)\b/iu.test(
      compact,
    ) ||
    /\bResult\s*:?\s*(?:Pending|Unconfirmed|Confirming|Processing|Awaiting\s+Confirmation|Awaiting\s+Mining|Awaiting\s+Inclusion|Dropped(?:\s*&\s*Replaced)?|Dropped|Replaced)\b/iu.test(
      compact,
    ) ||
    /\bTransaction\s+(?:Status\s*)?:?\s*(?:Pending|Unconfirmed|Confirming|Processing|Awaiting\s+Confirmation|Awaiting\s+Mining|Awaiting\s+Inclusion|Dropped(?:\s*&\s*Replaced)?|Dropped|Replaced)\b/iu.test(
      compact,
    ) ||
    /\b(?:Transaction|Signature)\s+(?:is\s+)?(?:pending|unconfirmed|not\s+confirmed|not\s+finalized|awaiting\s+confirmation|awaiting\s+mining|awaiting\s+inclusion|confirming|processing)\b/iu.test(
      compact,
    ) ||
    /\b(?:Pending|Unconfirmed|Confirming|Processing)\s+(?:Transaction|Signature)\b/iu.test(
      compact,
    ) ||
    /\b(?:Transaction|Signature).{0,80}(?:mempool|not\s+yet\s+(?:included|confirmed)|queued|awaiting\s+confirmation|awaiting\s+mining|awaiting\s+inclusion)\b/iu.test(
      compact,
    ) ||
    /\b(?:mempool|queued).{0,40}(?:Transaction|Signature)\b/iu.test(compact) ||
    /\b(?:Transaction|Signature).{0,40}(?:Dropped(?:\s*&\s*Replaced)?|Replaced)\b/iu.test(compact)
  );
}

async function collectPageLinks(page: Page): Promise<PageLink[]> {
  const anchors = await page.locator('a[href]').all();
  const links: PageLink[] = [];

  for (const anchor of anchors) {
    const href = await anchor.getAttribute('href');
    if (href === null || href.length === 0) {
      continue;
    }

    links.push({
      href: new URL(href, page.url()).toString(),
      text: (await anchor.innerText().catch(() => '')).trim().replace(/\s+/gu, ' '),
    });
  }

  return links;
}

export async function extractXxyyEvmPoolWindow(
  page: Page,
  txHash: string,
  explorer: EvmExplorerExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<XxyyExtraction> {
  const directExtraction = await extractXxyyEvmPoolPageFromCandidate(
    page,
    txHash,
    explorer,
    options,
  );
  if (directExtraction !== undefined) {
    return directExtraction;
  }

  if (explorer.contractAddress === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      `${evmExplorerName(explorer.chain)} 未解析出合约地址，无法通过 XXYY 搜索池子。`,
      'pool_not_found',
      { metadata: createEvmExplorerFailureMetadata(explorer) },
    );
  }

  let searchSelection: XxyyContractSearchSelection;
  try {
    searchSelection = await openXxyyPoolPageViaContractSearch(page, {
      chain: explorer.chain,
      contractAddress: explorer.contractAddress,
      ...(explorer.poolAddress === undefined ? {} : { expectedPoolAddress: explorer.poolAddress }),
      options,
    });
  } catch (error) {
    throw attachTxAnalysisFailureMetadata(error, createEvmExplorerFailureMetadata(explorer));
  }

  const routedPoolAddress = extractXxyyPoolAddressFromUrl(page.url());
  if (routedPoolAddress === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      'XXYY 搜索跳转后未进入池子页面。',
      'pool_not_found',
      { metadata: createEvmExplorerFailureMetadata(explorer) },
    );
  }
  if (!isExpectedXxyyEvmPoolUrl(page.url(), explorer.chain, routedPoolAddress)) {
    throw new TxAnalysisProviderUnavailableError(
      `XXYY 搜索跳转后的池子链与 ${evmExplorerName(explorer.chain)} 交易链不一致。`,
      'pool_not_found',
      {
        metadata: createEvmExplorerFailureMetadata({ ...explorer, poolAddress: routedPoolAddress }),
      },
    );
  }
  if (
    explorer.poolAddress !== undefined &&
    searchSelection.matchedExpectedPoolAddress &&
    routedPoolAddress.toLowerCase() !== explorer.poolAddress.toLowerCase()
  ) {
    throw new TxAnalysisProviderUnavailableError(
      `XXYY 搜索跳转后的池子地址与 ${evmExplorerName(explorer.chain)} 交易池子不一致：${
        explorer.poolAddress
      }`,
      'pool_not_found',
      {
        metadata: createEvmExplorerFailureMetadata(
          explorer,
          xxyyPoolUrlFailureMetadataFromPage(page),
        ),
      },
    );
  }
  const searchMetadata = createEvmExplorerFailureMetadata(
    { ...explorer, poolAddress: routedPoolAddress },
    xxyyPoolUrlFailureMetadataFromPage(page),
  );
  try {
    await requireXxyyPageNotBrowserVerification(page);
  } catch (error) {
    throw attachTxAnalysisFailureMetadata(error, searchMetadata);
  }
  const poolAddress = routedPoolAddress;
  const tradeContext = toXxyyTradeContext({ ...explorer, poolAddress }, poolAddress);

  return extractCurrentXxyyPoolPage(page, txHash, tradeContext, options, undefined, searchMetadata);
}

async function extractXxyyEvmPoolPageFromCandidate(
  page: Page,
  txHash: string,
  explorer: EvmExplorerExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<XxyyExtraction | undefined> {
  const candidates = evmPoolCandidates(explorer);
  if (candidates.length === 0) {
    return undefined;
  }

  for (const candidate of candidates) {
    const candidateExplorer = { ...explorer, poolAddress: candidate.address };
    let opened: boolean;
    try {
      opened = await openXxyyEvmPoolPage(page, explorer.chain, candidate.address, options);
    } catch (error) {
      throw attachTxAnalysisFailureMetadata(
        error,
        createEvmExplorerFailureMetadata(
          candidateExplorer,
          xxyyPoolUrlFailureMetadataFromPage(page),
        ),
      );
    }
    if (!opened) {
      continue;
    }

    const tradeContext = toXxyyTradeContext(candidateExplorer, candidate.address);
    const tradeWindow = await extractXxyyStructuredTradeWindow(page, txHash, tradeContext);
    if (tradeWindow === undefined) {
      continue;
    }

    return extractCurrentXxyyPoolPage(
      page,
      txHash,
      tradeContext,
      options,
      {
        ...tradeWindow,
        selectedPoolAddress: candidate.address,
      },
      createEvmExplorerFailureMetadata(candidateExplorer, xxyyPoolUrlFailureMetadataFromPage(page)),
    );
  }

  return undefined;
}

export async function extractXxyyPoolWindow(
  page: Page,
  txHash: string,
  solscan: SolscanExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<XxyyExtraction> {
  if (solscan.contractAddress === undefined && solscan.poolAddress === undefined) {
    return { text: '' };
  }

  const directExtraction = await extractXxyyPoolPageFromCandidates(page, txHash, solscan, options);
  if (directExtraction !== undefined) {
    return directExtraction;
  }

  if (solscan.contractAddress === undefined) {
    return { text: '' };
  }

  const poolAddress = await openXxyyPoolPageViaSearch(page, solscan, options);
  const searchedSolscan = { ...solscan, poolAddress };
  return extractCurrentXxyyPoolPage(
    page,
    txHash,
    searchedSolscan,
    options,
    undefined,
    createSolanaExplorerFailureMetadata(searchedSolscan, xxyyPoolUrlFailureMetadataFromPage(page)),
  );
}

async function extractXxyyPoolPageFromCandidates(
  page: Page,
  txHash: string,
  solscan: SolscanExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<XxyyExtraction | undefined> {
  const candidates = xxyyPoolCandidates(solscan);
  let firstMatchedExtraction: XxyyExtraction | undefined;

  for (const candidate of candidates) {
    const candidateSolscan = { ...solscan, poolAddress: candidate.address };
    let opened: boolean;
    try {
      opened = await openXxyyPoolPage(page, candidate.address, options);
    } catch (error) {
      throw attachTxAnalysisFailureMetadata(
        error,
        createSolanaExplorerFailureMetadata(
          candidateSolscan,
          xxyyPoolUrlFailureMetadataFromPage(page),
        ),
      );
    }
    if (!opened) {
      continue;
    }

    const tradeWindow = await extractXxyyStructuredTradeWindow(page, txHash, candidateSolscan);
    if (tradeWindow === undefined) {
      continue;
    }

    const bestCandidate = selectXxyyPoolCandidate(candidates, tradeWindow.targetTrade);
    const extraction = await extractCurrentXxyyPoolPage(
      page,
      txHash,
      candidateSolscan,
      options,
      {
        ...tradeWindow,
        selectedPoolAddress: candidate.address,
      },
      createSolanaExplorerFailureMetadata(
        candidateSolscan,
        xxyyPoolUrlFailureMetadataFromPage(page),
      ),
    );

    if (bestCandidate === undefined || bestCandidate.address === candidate.address) {
      return extraction;
    }

    firstMatchedExtraction ??= extraction;
  }

  return firstMatchedExtraction;
}

export async function openXxyyPoolPage(
  page: Page,
  poolAddress: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<boolean> {
  await page.goto(buildXxyySolPoolUrl(options.discoverUrl, poolAddress), {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(6000);
  if (!isExpectedXxyySolPoolUrl(page.url(), poolAddress)) {
    return false;
  }

  await requireXxyyPageNotBrowserVerification(page);
  return true;
}

export async function openXxyyEvmPoolPage(
  page: Page,
  chain: BrowserEvmChain,
  poolAddress: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<boolean> {
  await page.goto(buildXxyyEvmPoolUrl(options.discoverUrl, chain, poolAddress), {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(6000);
  if (!isExpectedXxyyEvmPoolUrl(page.url(), chain, poolAddress)) {
    return false;
  }

  await requireXxyyPageNotBrowserVerification(page);
  return true;
}

async function requireXxyyPageNotBrowserVerification(page: Page): Promise<void> {
  let bodyText: string;
  try {
    const body = page.locator('body') as Locator & { innerText?: () => Promise<string> };
    if (typeof body.innerText !== 'function') {
      return;
    }

    bodyText = await body.innerText().catch(() => '');
  } catch {
    return;
  }
  if (!isBrowserVerificationPageText(bodyText)) {
    return;
  }

  throw new TxAnalysisProviderUnavailableError(
    'XXYY 池子页面正在进行浏览器安全验证。请用可见 Chrome 完成验证后重试，或关闭 headless 模式。',
    'browser_verification_required',
  );
}

async function openXxyyPoolPageViaSearch(
  page: Page,
  solscan: SolscanExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<string> {
  if (solscan.contractAddress === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      'Solscan 未解析出合约地址，无法通过 XXYY 搜索兜底。',
      'pool_not_found',
      { metadata: createSolanaExplorerFailureMetadata(solscan) },
    );
  }

  try {
    await openXxyyPoolPageViaContractSearch(page, {
      chain: 'solana',
      contractAddress: solscan.contractAddress,
      ...(solscan.poolAddress === undefined ? {} : { expectedPoolAddress: solscan.poolAddress }),
      options,
    });
  } catch (error) {
    throw attachTxAnalysisFailureMetadata(error, createSolanaExplorerFailureMetadata(solscan));
  }

  const routedPoolAddress = extractXxyyPoolAddressFromUrl(page.url());
  if (routedPoolAddress === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      'XXYY 搜索跳转后未进入池子页面。',
      'pool_not_found',
      { metadata: createSolanaExplorerFailureMetadata(solscan) },
    );
  }
  if (
    solscan.poolAddress !== undefined &&
    !isExpectedXxyySolPoolUrl(page.url(), solscan.poolAddress)
  ) {
    throw new TxAnalysisProviderUnavailableError(
      `XXYY 搜索跳转后的池子地址与 Solscan 交易池子不一致：${solscan.poolAddress}`,
      'pool_not_found',
      { metadata: createSolanaExplorerFailureMetadata(solscan) },
    );
  }

  const searchSolscan = { ...solscan, poolAddress: routedPoolAddress };
  try {
    await requireXxyyPageNotBrowserVerification(page);
  } catch (error) {
    throw attachTxAnalysisFailureMetadata(
      error,
      createSolanaExplorerFailureMetadata(searchSolscan, xxyyPoolUrlFailureMetadataFromPage(page)),
    );
  }

  return routedPoolAddress;
}

type XxyyContractSearchSelection = {
  matchedExpectedPoolAddress: boolean;
};

async function openXxyyPoolPageViaContractSearch(
  page: Page,
  input: {
    chain: XxyySearchChain;
    contractAddress: string;
    expectedPoolAddress?: string;
    options: PlaywrightBrowserTxAnalysisDriverOptions;
  },
): Promise<XxyyContractSearchSelection> {
  await page.goto(input.options.discoverUrl ?? DEFAULT_DISCOVER_URL, {
    timeout: input.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(5000);
  await requireXxyyPageNotBrowserVerification(page);
  await selectXxyySearchChain(page, input.chain);
  await page.locator('.search-trigger').first().click({ force: true });
  await page.waitForTimeout(500);
  await setSearchInputValue(page.locator('input.ipt').first(), input.contractAddress);
  await page.waitForTimeout(5000);

  const searchItems = await page.locator('.search-token-item').all();
  if (searchItems.length > 0) {
    const selection = await findMatchingSearchItem(searchItems, input.expectedPoolAddress, {
      allowFirstOnMismatch: input.chain !== 'solana',
    });
    const matchingItem = selection.item;
    await dispatchSearchItemClick(matchingItem);
    await page.waitForTimeout(6000);
    return { matchedExpectedPoolAddress: selection.matchedPoolAddress };
  }

  return { matchedExpectedPoolAddress: true };
}

async function selectXxyySearchChain(page: Page, chain: XxyySearchChain): Promise<void> {
  const label = xxyySearchChainLabel(chain);
  let chainItems: Locator[];
  try {
    chainItems = await page.locator('.chain-menu .menu-item').all();
  } catch {
    return;
  }

  for (const item of chainItems) {
    const text = await item
      .innerText()
      .then((value) => value.trim().replace(/\s+/gu, ' '))
      .catch(() => '');
    if (!new RegExp(`^${escapeRegExp(label)}\\b`, 'iu').test(text)) {
      continue;
    }

    await dispatchSearchItemClick(item);
    await page.waitForTimeout(1000);
    return;
  }
}

function xxyySearchChainLabel(chain: XxyySearchChain): string {
  switch (chain) {
    case 'solana':
      return 'SOL';
    case 'base':
      return 'Base';
    case 'ethereum':
      return 'ETH';
    case 'bsc':
      return 'BSC';
  }
}

async function extractCurrentXxyyPoolPage(
  page: Page,
  txHash: string,
  solscan: XxyyTradeContext,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
  knownTradeWindow?: XxyyTradeWindow,
  failureMetadata?: TxAnalysisFailureMetadata,
): Promise<XxyyExtraction> {
  let locatedTradeWindow: XxyyTradeWindow | undefined;
  try {
    const tradeWindow = requireLocatedXxyyTradeWindow(
      knownTradeWindow ?? (await extractXxyyStructuredTradeWindow(page, txHash, solscan)),
      txHash,
    );
    locatedTradeWindow = tradeWindow;
    const screenshotUrl = await screenshotPage(page, solscan, options, tradeWindow);
    if (screenshotUrl === undefined) {
      throw new TxAnalysisProviderUnavailableError(
        '浏览器取证未生成带目标行标记的 XXYY 原页面截图。',
        'screenshot_unavailable',
      );
    }

    return {
      text: await page.locator('body').innerText(),
      tradeWindow,
      xxyyPoolUrl: page.url(),
      screenshotUrl,
      screenshotTargetRowMarked: true,
    };
  } catch (error) {
    if (failureMetadata !== undefined) {
      const metadata = addXxyyFailureRelatedTransactions(
        failureMetadata,
        locatedTradeWindow,
        solscan,
      );
      throw attachTxAnalysisFailureMetadata(
        error,
        await addFailureScreenshotMetadata(page, solscan, options, error, metadata),
      );
    }

    throw error;
  }
}

function addXxyyFailureRelatedTransactions(
  metadata: TxAnalysisFailureMetadata,
  tradeWindow: XxyyTradeWindow | undefined,
  context: XxyyTradeContext,
): TxAnalysisFailureMetadata {
  if (
    tradeWindow === undefined ||
    (metadata.relatedTransactions !== undefined && metadata.relatedTransactions.length > 0)
  ) {
    return metadata;
  }

  const relatedTransactions = xxyyFailureRelatedTransactionsFromWindow(tradeWindow, context);
  return relatedTransactions.length === 0 ? metadata : { ...metadata, relatedTransactions };
}

function xxyyFailureRelatedTransactionsFromWindow(
  tradeWindow: XxyyTradeWindow,
  context: XxyyTradeContext,
): TxAnalysisRelatedTransaction[] {
  return [
    ...tradeWindow.tradeWindow.before.map((trade) =>
      xxyyFailureRelatedTransaction(trade, 'related', context),
    ),
    xxyyFailureRelatedTransaction(tradeWindow.targetTrade, 'user', context),
    ...tradeWindow.tradeWindow.after.map((trade) =>
      xxyyFailureRelatedTransaction(trade, 'related', context),
    ),
  ].filter((trade): trade is TxAnalysisRelatedTransaction => trade !== undefined);
}

function xxyyFailureRelatedTransaction(
  trade: BrowserTxTrade,
  role: TxAnalysisRelatedTransaction['role'],
  context: XxyyTradeContext,
): TxAnalysisRelatedTransaction | undefined {
  const hash = normalizeXxyyTransactionHash(trade.hash);
  if (hash.length === 0) {
    return undefined;
  }

  const explorerUrl =
    nonBlankXxyyMetadataString(trade.explorerUrl) ??
    buildFailureRelatedExplorerUrl(context.solscanUrl, hash);
  const summary = nonBlankXxyyMetadataString(trade.summary) ?? txAnalysisRelatedRoleSummary(role);
  const timestamp = nonBlankXxyyMetadataString(trade.timestamp);
  const traderAddress = nonBlankXxyyMetadataString(trade.traderAddress);

  return {
    hash,
    role,
    summary,
    ...(explorerUrl === undefined ? {} : { explorerUrl }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(traderAddress === undefined ? {} : { traderAddress }),
  };
}

function buildFailureRelatedExplorerUrl(
  sourceExplorerUrl: string,
  txHash: string,
): string | undefined {
  try {
    const url = new URL(sourceExplorerUrl);
    const segments = url.pathname.split('/');
    const txSegmentIndex = segments.findIndex((segment) => /^(?:tx|transaction)$/iu.test(segment));
    if (txSegmentIndex < 0 || segments[txSegmentIndex + 1] === undefined) {
      return undefined;
    }

    segments[txSegmentIndex + 1] = txHash;
    url.pathname = segments.join('/');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function txAnalysisRelatedRoleSummary(role: TxAnalysisRelatedTransaction['role']): string {
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

function nonBlankXxyyMetadataString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

async function addFailureScreenshotMetadata(
  page: Page,
  context: XxyyTradeContext,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
  error: unknown,
  metadata: TxAnalysisFailureMetadata,
): Promise<TxAnalysisFailureMetadata> {
  if (!shouldCaptureXxyyFailureScreenshot(error) || metadata.screenshotUrl !== undefined) {
    return metadata;
  }

  const screenshotUrl = await screenshotPage(page, context, options).catch(() => undefined);
  return screenshotUrl === undefined
    ? metadata
    : {
        ...metadata,
        screenshotUrl,
      };
}

function shouldCaptureXxyyFailureScreenshot(error: unknown): boolean {
  return (
    error instanceof TxAnalysisProviderUnavailableError &&
    (error.reason === 'target_trade_not_found' || error.reason === 'screenshot_unavailable')
  );
}

export function buildXxyySolPoolUrl(discoverUrl: string | undefined, poolAddress: string): string {
  const url = new URL(discoverUrl ?? DEFAULT_DISCOVER_URL);
  return new URL(`/sol/${poolAddress}`, url.origin).toString();
}

export function buildXxyyEvmPoolUrl(
  discoverUrl: string | undefined,
  chain: BrowserEvmChain,
  poolAddress: string,
): string {
  const url = new URL(discoverUrl ?? DEFAULT_DISCOVER_URL);
  return new URL(`/${xxyyEvmChainPath(chain)}/${poolAddress.toLowerCase()}`, url.origin).toString();
}

export function buildEvmExplorerTxUrl(chain: BrowserEvmChain, txHash: string): string {
  switch (chain) {
    case 'base':
      return `https://basescan.org/tx/${txHash}`;
    case 'ethereum':
      return `https://etherscan.io/tx/${txHash}`;
    case 'bsc':
      return `https://bscscan.com/tx/${txHash}`;
  }
}

function buildEvmExplorerTxUrls(chain: BrowserEvmChain, txHash: string): string[] {
  const primaryUrl = buildEvmExplorerTxUrl(chain, txHash);
  switch (chain) {
    case 'base':
      return [primaryUrl, `https://base.blockscout.com/tx/${txHash}`];
    case 'ethereum':
      return [primaryUrl, `https://eth.blockscout.com/tx/${txHash}`];
    case 'bsc':
      return [primaryUrl, `https://bsctrace.com/tx/${txHash}`];
  }
}

function shouldTryNextEvmExplorer(error: unknown): boolean {
  if (error instanceof TxAnalysisProviderUnavailableError) {
    return (
      error.reason === 'timeout' ||
      error.reason === 'provider_unavailable' ||
      error.reason === 'browser_verification_required'
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    isBrowserTimeoutError(error) ||
    isTransientBrowserNetworkError(error) ||
    /(?:net::)?err_/iu.test(message)
  );
}

function selectEvmExplorerExtractionFailure(chain: BrowserEvmChain, errors: unknown[]): Error {
  let preferred: unknown;
  for (const candidate of errors) {
    if (
      preferred === undefined ||
      evmExplorerExtractionFailurePriority(candidate) >
        evmExplorerExtractionFailurePriority(preferred)
    ) {
      preferred = candidate;
    }
  }

  if (preferred === undefined) {
    return new Error(`${evmExplorerName(chain)} transaction extraction failed`);
  }

  if (preferred instanceof TxAnalysisProviderUnavailableError) {
    return preferred;
  }

  if (isBrowserTimeoutError(preferred)) {
    return new TxAnalysisProviderUnavailableError(
      `${evmExplorerName(chain)} 交易浏览器访问超时：${normalizeError(preferred).message}`,
      'timeout',
    );
  }

  if (isTransientBrowserNetworkError(preferred)) {
    return new TxAnalysisProviderUnavailableError(
      `${evmExplorerName(chain)} 交易浏览器临时不可用：${normalizeError(preferred).message}`,
      'provider_unavailable',
    );
  }

  return preferred instanceof Error
    ? preferred
    : new Error(
        `${evmExplorerName(chain)} transaction extraction failed: ${normalizeError(preferred).message}`,
      );
}

function evmExplorerExtractionFailurePriority(error: unknown): number {
  if (error instanceof TxAnalysisProviderUnavailableError) {
    switch (error.reason) {
      case 'browser_verification_required':
        return 4;
      case 'timeout':
        return 3;
      case 'provider_unavailable':
        return 2;
      default:
        return 1;
    }
  }

  if (isBrowserTimeoutError(error)) {
    return 3;
  }

  if (isTransientBrowserNetworkError(error)) {
    return 2;
  }

  return 1;
}

export function extractXxyyPoolAddressFromUrl(pageUrl: string): string | undefined {
  return parseXxyyPoolRoute(pageUrl)?.poolAddress;
}

function parseXxyyPoolRoute(
  pageUrl: string,
): { chainPath: 'base' | 'bsc' | 'eth' | 'ethereum' | 'sol'; poolAddress: string } | undefined {
  try {
    const pathParts = new URL(pageUrl).pathname.split('/').filter(Boolean);
    const chainIndex = pathParts.findIndex((part) =>
      ['sol', 'base', 'eth', 'ethereum', 'bsc'].includes(part.toLowerCase()),
    );
    const chainPath = pathParts[chainIndex]?.toLowerCase();
    const poolAddress = pathParts[chainIndex + 1];
    if (
      chainIndex < 0 ||
      poolAddress === undefined ||
      (chainPath !== 'sol' &&
        chainPath !== 'base' &&
        chainPath !== 'eth' &&
        chainPath !== 'ethereum' &&
        chainPath !== 'bsc')
    ) {
      return undefined;
    }

    return {
      chainPath,
      poolAddress: isXxyyEvmChainPath(chainPath) ? poolAddress.toLowerCase() : poolAddress,
    };
  } catch {
    return undefined;
  }
}

type XxyyPoolRouteChainPath = NonNullable<ReturnType<typeof parseXxyyPoolRoute>>['chainPath'];

function isExpectedXxyySolPoolUrl(pageUrl: string, poolAddress: string): boolean {
  const route = parseXxyyPoolRoute(pageUrl);
  return route?.chainPath === 'sol' && route.poolAddress === poolAddress;
}

export function isExpectedXxyyEvmPoolUrl(
  pageUrl: string,
  chain: BrowserEvmChain,
  poolAddress: string,
): boolean {
  const route = parseXxyyPoolRoute(pageUrl);
  return (
    route !== undefined &&
    xxyyEvmChainPathMatches(chain, route.chainPath) &&
    route.poolAddress === poolAddress.toLowerCase()
  );
}

function xxyyEvmChainPathMatches(
  chain: BrowserEvmChain,
  routePath: XxyyPoolRouteChainPath,
): boolean {
  if (chain === 'ethereum') {
    return routePath === 'eth' || routePath === 'ethereum';
  }

  return routePath === xxyyEvmChainPath(chain);
}

function toXxyyTradeContext(
  explorer: EvmExplorerExtraction,
  poolAddress: string,
): XxyyTradeContext {
  return {
    poolAddress,
    nativeSymbol: evmNativeSymbol(explorer.chain),
    ...(explorer.signerAddress === undefined ? {} : { signerAddress: explorer.signerAddress }),
    solscanUrl: explorer.explorerUrl,
    ...(explorer.transactionTime === undefined
      ? {}
      : { transactionTime: explorer.transactionTime }),
  };
}

export function createEvmExplorerFailureMetadata(
  explorer: EvmExplorerExtraction,
  extra: Partial<TxAnalysisFailureMetadata> = {},
): TxAnalysisFailureMetadata {
  return {
    ...(explorer.contractAddress === undefined
      ? {}
      : { contractAddress: explorer.contractAddress }),
    explorerUrl: explorer.explorerUrl,
    ...(explorer.poolAddress === undefined ? {} : { poolAddress: explorer.poolAddress }),
    ...(explorer.routerAddress === undefined ? {} : { routerAddress: explorer.routerAddress }),
    ...(explorer.signerAddress === undefined
      ? {}
      : { targetTraderAddress: explorer.signerAddress }),
    ...(explorer.transactionTime === undefined
      ? {}
      : { transactionTime: explorer.transactionTime }),
    ...extra,
  };
}

export function createSolanaExplorerFailureMetadata(
  solscan: SolscanExtraction,
  extra: Partial<TxAnalysisFailureMetadata> = {},
): TxAnalysisFailureMetadata {
  return {
    ...(solscan.contractAddress === undefined ? {} : { contractAddress: solscan.contractAddress }),
    explorerUrl: solscan.solscanUrl,
    ...(solscan.poolAddress === undefined ? {} : { poolAddress: solscan.poolAddress }),
    ...(solscan.signerAddress === undefined ? {} : { targetTraderAddress: solscan.signerAddress }),
    ...(solscan.transactionTime === undefined ? {} : { transactionTime: solscan.transactionTime }),
    ...extra,
  };
}

function attachTxAnalysisFailureMetadata(
  error: unknown,
  metadata: TxAnalysisFailureMetadata,
): unknown {
  if (!(error instanceof TxAnalysisProviderUnavailableError)) {
    return new TxAnalysisProviderUnavailableError(
      error instanceof Error ? error.message : String(error),
      inferAttachedTxAnalysisFailureReason(error),
      { metadata },
    );
  }

  return new TxAnalysisProviderUnavailableError(error.message, error.reason, {
    metadata: {
      ...metadata,
      ...(error.metadata ?? {}),
    },
    ...(error.reference === undefined ? {} : { reference: error.reference }),
    ...(error.reportUrl === undefined ? {} : { reportUrl: error.reportUrl }),
  });
}

function inferAttachedTxAnalysisFailureReason(error: unknown): TxAnalysisUnavailableReason {
  const message = error instanceof Error ? error.message : String(error);
  if (isBrowserVerificationText(message) || isBrowserVerificationStatusError(message)) {
    return 'browser_verification_required';
  }
  if (isTransactionFailureText(message)) {
    return 'tx_failed';
  }
  if (isTransactionPendingText(message)) {
    return 'tx_pending';
  }
  if (isBrowserTimeoutError(error)) {
    return 'timeout';
  }
  const specificReason = inferSpecificBrowserFailureReason(message);
  if (specificReason !== undefined) {
    return specificReason;
  }

  return 'provider_unavailable';
}

function inferSpecificBrowserFailureReason(
  message: string,
): TxAnalysisUnavailableReason | undefined {
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

  return undefined;
}

function xxyyPoolUrlFromPage(page: Page): string | undefined {
  const pageUrl = page.url();
  return extractXxyyPoolAddressFromUrl(pageUrl) === undefined ? undefined : pageUrl;
}

function xxyyPoolUrlFailureMetadataFromPage(page: Page): Partial<TxAnalysisFailureMetadata> {
  const xxyyPoolUrl = xxyyPoolUrlFromPage(page);
  return xxyyPoolUrl === undefined ? {} : { xxyyPoolUrl };
}

function xxyyEvmChainPath(chain: BrowserEvmChain): string {
  switch (chain) {
    case 'base':
      return 'base';
    case 'ethereum':
      return 'eth';
    case 'bsc':
      return 'bsc';
  }
}

function isXxyyEvmChainPath(pathPart: string): pathPart is 'base' | 'bsc' | 'eth' | 'ethereum' {
  return pathPart === 'base' || pathPart === 'bsc' || pathPart === 'eth' || pathPart === 'ethereum';
}

function xxyyPoolCandidates(solscan: SolscanExtraction): XxyyPoolCandidate[] {
  return uniquePoolCandidates([
    ...solscan.poolCandidates,
    ...(solscan.poolAddress === undefined ? [] : [{ address: solscan.poolAddress }]),
  ]);
}

export function evmPoolCandidates(input: {
  poolAddress?: string;
  poolCandidates?: XxyyPoolCandidate[];
}): XxyyPoolCandidate[] {
  return uniqueEvmPoolCandidates([
    ...(input.poolCandidates ?? []),
    ...(input.poolAddress === undefined ? [] : [{ address: input.poolAddress }]),
  ]);
}

function uniquePoolCandidates(candidates: XxyyPoolCandidate[]): XxyyPoolCandidate[] {
  const seen = new Set<string>();
  const unique: XxyyPoolCandidate[] = [];
  for (const candidate of candidates) {
    if (!SOLANA_ADDRESS_PATTERN.test(candidate.address) || seen.has(candidate.address)) {
      continue;
    }

    seen.add(candidate.address);
    unique.push(candidate);
  }

  return unique;
}

function uniqueEvmPoolCandidates(candidates: XxyyPoolCandidate[]): XxyyPoolCandidate[] {
  const seen = new Set<string>();
  const unique: XxyyPoolCandidate[] = [];
  for (const candidate of candidates) {
    const normalized = candidate.address.toLowerCase();
    if (!EVM_ADDRESS_PATTERN.test(candidate.address) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(candidate);
  }

  return unique;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => value !== undefined && value.length > 0);
}

export function extractSolanaFmPoolCandidates(text: string): XxyyPoolCandidate[] {
  const pattern = new RegExp(
    `(${SOLANA_ADDRESS_CAPTURE})\\s+sent\\s+([0-9][0-9,]*(?:\\.[0-9]+)?)\\s+Wrapped\\s+SOL`,
    'giu',
  );
  const candidates: XxyyPoolCandidate[] = [];

  for (const match of text.matchAll(pattern)) {
    const address = match[1];
    const nativeAmount = match[2];
    if (address === undefined || nativeAmount === undefined) {
      continue;
    }
    const normalizedNativeAmount = normalizeDecimal(nativeAmount);
    if (normalizedNativeAmount === undefined) {
      continue;
    }

    candidates.push({ address, nativeAmount: normalizedNativeAmount });
  }

  return uniquePoolCandidates(candidates);
}

export function selectXxyyPoolCandidate(
  candidates: XxyyPoolCandidate[],
  targetTrade: XxyyTradeRecord | BrowserTxTrade,
): XxyyPoolCandidate | undefined {
  const nativeAmount =
    'txHash' in targetTrade ? targetTrade.nativeAmount : nativeAmountFromSummary(targetTrade);
  if (nativeAmount === undefined) {
    return candidates[0];
  }

  return (
    candidates.find(
      (candidate) =>
        candidate.nativeAmount !== undefined &&
        decimalAmountsEqual(candidate.nativeAmount, nativeAmount),
    ) ?? candidates[0]
  );
}

function nativeAmountFromSummary(trade: BrowserTxTrade): string | undefined {
  const amount = /([0-9][0-9,]*(?:\.[0-9]+)?)\s+SOL/u.exec(trade.summary)?.[1];
  return amount === undefined ? undefined : normalizeDecimal(amount);
}

function decimalAmountsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeDecimal(left);
  const normalizedRight = normalizeDecimal(right);
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function normalizeDecimal(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u.test(trimmed)) {
    return undefined;
  }

  return trimmed
    .replace(/,/gu, '')
    .replace(/^0+(?=\d)/u, '')
    .replace(/(\.\d*?)0+$/u, '$1')
    .replace(/\.$/u, '');
}

function extractTradeWindowFromText(
  text: string,
  signerAddress: string | undefined,
): BrowserSolanaTxSnapshot['tradeWindow'] {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  const tradeLines = lines.filter((line) => /买入|卖出|Buy|Sell|buy|sell/u.test(line));
  const trades = tradeLines.slice(0, 10).map((line, index) => toWindowTrade(line, index));

  if (signerAddress !== undefined && trades.length > 0) {
    const targetIndex = trades.findIndex((trade) => trade.traderAddress === signerAddress);
    if (targetIndex >= 0) {
      return {
        after: trades.slice(targetIndex + 1, targetIndex + 6),
        before: trades.slice(Math.max(0, targetIndex - 5), targetIndex),
      };
    }
  }

  return {
    after: [],
    before: trades.slice(0, 5),
  };
}

async function extractXxyyStructuredTradeWindow(
  page: Page,
  txHash: string,
  solscan: XxyyTradeContext,
): Promise<XxyyTradeWindow | undefined> {
  if (solscan.poolAddress === undefined) {
    return undefined;
  }

  const targetTimeMs =
    solscan.transactionTime === undefined
      ? undefined
      : parseSolscanTransactionTime(solscan.transactionTime);
  const targetTimeWindow =
    targetTimeMs === undefined ? undefined : createXxyyTargetTimeSearchWindow(targetTimeMs);
  const queryResult = await queryXxyyTradeWindow(page, {
    poolAddress: solscan.poolAddress,
    ...(solscan.signerAddress === undefined ? {} : { signerAddress: solscan.signerAddress }),
    ...(targetTimeWindow === undefined ? {} : targetTimeWindow),
    txHash,
  }).catch((error: unknown) => {
    throw createXxyyTradeWindowQueryUnavailableError(error);
  });

  if (queryResult?.targetTrade === undefined) {
    return undefined;
  }

  return buildXxyyTradeWindow({
    afterTrades: queryResult.afterTrades,
    beforeTrades: queryResult.beforeTrades,
    ...(solscan.nativeSymbol === undefined ? {} : { nativeSymbol: solscan.nativeSymbol }),
    selectedPoolAddress: solscan.poolAddress,
    targetTrade: queryResult.targetTrade,
  });
}

export function createXxyyTradeWindowQueryUnavailableError(
  error: unknown,
): TxAnalysisProviderUnavailableError {
  return new TxAnalysisProviderUnavailableError(
    `XXYY 结构化交易窗口查询失败：${error instanceof Error ? error.message : String(error)}`,
    inferXxyyTradeWindowQueryUnavailableReason(error),
  );
}

function inferXxyyTradeWindowQueryUnavailableReason(error: unknown): TxAnalysisUnavailableReason {
  const message = error instanceof Error ? error.message : String(error);
  if (isBrowserVerificationText(message) || isBrowserVerificationStatusError(message)) {
    return 'browser_verification_required';
  }
  if (isTransactionFailureText(message)) {
    return 'tx_failed';
  }
  if (isTransactionPendingText(message)) {
    return 'tx_pending';
  }
  if (isBrowserTimeoutError(error)) {
    return 'timeout';
  }
  const specificReason = inferSpecificBrowserFailureReason(message);
  if (specificReason !== undefined) {
    return specificReason;
  }

  return 'provider_unavailable';
}

function isBrowserVerificationStatusError(message: string): boolean {
  return /\b(?:HTTP|status(?:\s+code)?)\s*:?\s*(?:401|403|1020)\b|(?:401\s+Unauthorized|403\s+Forbidden)\b/iu.test(
    message,
  );
}

export function createXxyyTargetTimeSearchWindow(targetTimeMs: number): {
  timeEnd: number;
  timeStart: number;
} {
  return {
    timeEnd: targetTimeMs + 30_000,
    timeStart: Math.max(0, targetTimeMs - 30_000),
  };
}

export async function queryXxyyTradeWindow(
  page: Page,
  input: XxyyTradeQueryInput,
): Promise<XxyyTradeQueryOutput> {
  const raw = await page.evaluate<unknown>(`
    (async () => {
      const queryInput = ${JSON.stringify(input)};
      const basePayload = {
        makerAddress: '',
        nativeAmountEnd: '',
        nativeAmountStart: '',
        pageSize: 50,
        pairAddress: queryInput.poolAddress,
        reverse: 0,
        timeEnd: '',
        timeStart: '',
        tokenAmountEnd: '',
        tokenAmountStart: '',
        type: 'all',
        usdAmountEnd: '',
        usdAmountStart: '',
      };
      const xxyyChainHeader = (() => {
        try {
          if (typeof globalThis.location === 'undefined') return undefined;
          const pathname =
            typeof globalThis.location.pathname === 'string'
              ? globalThis.location.pathname
              : new URL(String(globalThis.location.href)).pathname;
          const chainPath = pathname
            .split('/')
            .filter(Boolean)
            .map((part) => part.toLowerCase())
            .find((part) =>
              part === 'sol' ||
              part === 'base' ||
              part === 'eth' ||
              part === 'ethereum' ||
              part === 'bsc',
            );
          if (chainPath === undefined) return undefined;
          return chainPath === 'ethereum' ? 'eth' : chainPath;
        } catch {
          return undefined;
        }
      })();
      const firstTextValue = (...values) => {
        for (const value of values) {
          if (typeof value === 'string' && value.trim().length > 0) return value.trim();
          if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        }
        return undefined;
      };
      const normalizePoolAddressValue = (...values) => {
        const value = firstTextValue(...values);
        if (value === undefined) return undefined;
        const evmAddress = value.match(/\\b0x[a-fA-F0-9]{40}\\b/i)?.[0];
        if (evmAddress !== undefined) return evmAddress.toLowerCase();
        try {
          const pathSegments = new URL(value).pathname.split('/').filter(Boolean);
          return pathSegments[pathSegments.length - 1] ?? value;
        } catch {
          return value;
        }
      };
      const normalizeTraderAddressValue = (...values) => {
        const value = firstTextValue(...values);
        if (value === undefined) return undefined;
        try {
          const pathSegments = new URL(value).pathname.split('/').filter(Boolean);
          return pathSegments[pathSegments.length - 1] ?? value;
        } catch {
          return value;
        }
      };
      const nestedAddressValue = (value) => {
        if (value === null || typeof value !== 'object') return undefined;
        return normalizePoolAddressValue(
          value.address,
          value.poolAddress,
          value.pool_address,
          value.poolAddr,
          value.pool_addr,
          value.poolId,
          value.pool_id,
          value.poolID,
          value.poolContract,
          value.pool_contract,
          value.poolUrl,
          value.pool_url,
          value.poolLink,
          value.pool_link,
          value.pairAddress,
          value.pair_address,
          value.pairAddr,
          value.pair_addr,
          value.pairId,
          value.pair_id,
          value.pairID,
          value.pairContract,
          value.pair_contract,
          value.pairUrl,
          value.pair_url,
          value.pairLink,
          value.pair_link,
          value.marketAddress,
          value.market_address,
          value.marketAddr,
          value.market_addr,
          value.marketId,
          value.market_id,
          value.marketID,
          value.marketContract,
          value.market_contract,
          value.marketUrl,
          value.market_url,
          value.marketLink,
          value.market_link,
          value.ammId,
          value.amm_id,
          value.ammID,
          value.ammContract,
          value.amm_contract,
          value.ammAddress,
          value.amm_address,
          value.ammAddr,
          value.amm_addr,
          value.ammUrl,
          value.amm_url,
          value.ammLink,
          value.amm_link,
          value.lpAddress,
          value.lp_address,
          value.lpAddr,
          value.lp_addr,
          value.lpId,
          value.lp_id,
          value.lpID,
          value.lpContract,
          value.lp_contract,
          value.liquidityPoolAddress,
          value.liquidity_pool_address,
          value.liquidityPoolAddr,
          value.liquidity_pool_addr,
          value.liquidityPoolId,
          value.liquidity_pool_id,
          value.liquidityPoolID,
          value.liquidityPoolContract,
          value.liquidity_pool_contract,
          value.lpUrl,
          value.lp_url,
          value.lpLink,
          value.lp_link,
          value.url,
          value.link,
        );
      };
      const nestedTraderAddressValue = (value) => {
        if (value === null || typeof value !== 'object') return undefined;
        return normalizeTraderAddressValue(
          value.address,
          value.url,
          value.link,
          value.accountAddress,
          value.account_address,
          value.accountAddr,
          value.account_addr,
          value.accountWallet,
          value.account_wallet,
          value.accountUrl,
          value.account_url,
          value.accountLink,
          value.account_link,
          value.makerAddress,
          value.maker_address,
          value.makerAddr,
          value.maker_addr,
          value.makerWallet,
          value.maker_wallet,
          value.makerUrl,
          value.maker_url,
          value.makerLink,
          value.maker_link,
          value.traderAddress,
          value.trader_address,
          value.traderAddr,
          value.trader_addr,
          value.traderWallet,
          value.trader_wallet,
          value.traderUrl,
          value.trader_url,
          value.traderLink,
          value.trader_link,
          value.takerAddress,
          value.taker_address,
          value.takerAddr,
          value.taker_addr,
          value.takerWallet,
          value.taker_wallet,
          value.takerUrl,
          value.taker_url,
          value.takerLink,
          value.taker_link,
          value.signerAddress,
          value.signer_address,
          value.signerAddr,
          value.signer_addr,
          value.signerWallet,
          value.signer_wallet,
          value.signerUrl,
          value.signer_url,
          value.signerLink,
          value.signer_link,
          value.ownerAddress,
          value.owner_address,
          value.ownerAddr,
          value.owner_addr,
          value.ownerWallet,
          value.owner_wallet,
          value.ownerUrl,
          value.owner_url,
          value.ownerLink,
          value.owner_link,
          value.senderAddress,
          value.sender_address,
          value.senderAddr,
          value.sender_addr,
          value.senderWallet,
          value.sender_wallet,
          value.senderUrl,
          value.sender_url,
          value.senderLink,
          value.sender_link,
          value.initiatorAddress,
          value.initiator_address,
          value.initiatorAddr,
          value.initiator_addr,
          value.initiatorWallet,
          value.initiator_wallet,
          value.initiatorUrl,
          value.initiator_url,
          value.initiatorLink,
          value.initiator_link,
          value.fromAddress,
          value.from_address,
          value.fromAddr,
          value.from_addr,
          value.fromWallet,
          value.from_wallet,
          value.fromUrl,
          value.from_url,
          value.fromLink,
          value.from_link,
          value.payerAddress,
          value.payer_address,
          value.payerAddr,
          value.payer_addr,
          value.payerWallet,
          value.payer_wallet,
          value.payerUrl,
          value.payer_url,
          value.payerLink,
          value.payer_link,
          value.feePayerAddress,
          value.fee_payer_address,
          value.feePayerAddr,
          value.fee_payer_addr,
          value.feePayerWallet,
          value.fee_payer_wallet,
          value.feePayerUrl,
          value.fee_payer_url,
          value.feePayerLink,
          value.fee_payer_link,
          value.walletAddress,
          value.wallet_address,
          value.walletAddr,
          value.wallet_addr,
          value.walletUrl,
          value.wallet_url,
          value.walletLink,
          value.wallet_link,
          value.userAddress,
          value.user_address,
          value.userAddr,
          value.user_addr,
          value.userWallet,
          value.user_wallet,
          value.userUrl,
          value.user_url,
          value.userLink,
          value.user_link,
        );
      };
      const nestedTransactionHashValue = (value) => {
        if (value === null || typeof value !== 'object') return undefined;
        return firstTextValue(
          value.txHash,
          value.tx_hash,
          value.txHashUrl,
          value.tx_hash_url,
          value.txHashLink,
          value.tx_hash_link,
          value.txHashHref,
          value.tx_hash_href,
          value.txId,
          value.tx_id,
          value.txid,
          value.txID,
          value.txSignature,
          value.tx_signature,
          value.txUrl,
          value.tx_url,
          value.txLink,
          value.tx_link,
          value.txHref,
          value.tx_href,
          value.transactionHash,
          value.transaction_hash,
          value.transactionHashUrl,
          value.transaction_hash_url,
          value.transactionHashLink,
          value.transaction_hash_link,
          value.transactionHashHref,
          value.transaction_hash_href,
          value.transactionId,
          value.transaction_id,
          value.transactionID,
          value.transactionSignature,
          value.transaction_signature,
          value.transactionUrl,
          value.transaction_url,
          value.transactionLink,
          value.transaction_link,
          value.transactionHref,
          value.transaction_href,
          value.txnHash,
          value.txn_hash,
          value.txnHashUrl,
          value.txn_hash_url,
          value.txnHashLink,
          value.txn_hash_link,
          value.txnHashHref,
          value.txn_hash_href,
          value.txnId,
          value.txn_id,
          value.txnID,
          value.txnSignature,
          value.txn_signature,
          value.txnUrl,
          value.txn_url,
          value.txnLink,
          value.txn_link,
          value.txnHref,
          value.txn_href,
          value.signature,
          value.signatureHash,
          value.signature_hash,
          value.signatureHashUrl,
          value.signature_hash_url,
          value.signatureHashLink,
          value.signature_hash_link,
          value.signatureHashHref,
          value.signature_hash_href,
          value.signatureId,
          value.signature_id,
          value.signatureID,
          value.signatureUrl,
          value.signature_url,
          value.signatureLink,
          value.signature_link,
          value.signatureHref,
          value.signature_href,
          value.explorer,
          nestedTransactionHashValue(value.explorer),
          value.explorerUrl,
          value.explorer_url,
          value.explorerLink,
          value.explorer_link,
          value.explorerHref,
          value.explorer_href,
          value.scan,
          nestedTransactionHashValue(value.scan),
          value.scanUrl,
          value.scan_url,
          value.scanLink,
          value.scan_link,
          value.scanHref,
          value.scan_href,
          value.blockExplorer,
          nestedTransactionHashValue(value.blockExplorer),
          value.block_explorer,
          nestedTransactionHashValue(value.block_explorer),
          value.blockExplorerUrl,
          value.block_explorer_url,
          value.blockExplorerLink,
          value.block_explorer_link,
          value.blockExplorerHref,
          value.block_explorer_href,
          value.hashUrl,
          value.hash_url,
          value.hashLink,
          value.hash_link,
          value.hashHref,
          value.hash_href,
          value.idUrl,
          value.id_url,
          value.idLink,
          value.id_link,
          value.idHref,
          value.id_href,
          value.url,
          value.link,
          value.href,
          value.hash,
          value.id,
        );
      };
      const firstDefinedValue = (...values) =>
        values.find(
          (value) =>
            value !== undefined &&
            value !== null &&
            (typeof value !== 'string' || value.trim() !== ''),
        );
      const normalizeTradeSide = (...values) => {
        const value = firstTextValue(...values);
        if (value === undefined) return undefined;
        return normalizeTradeSideText(value) ?? value;
      };
      const normalizeTradeSideText = (value) => {
        const normalized = value.replace(/[_-]+/g, ' ');
        const isBuy =
          /(?:^|[^a-z0-9])(?:buy|buying|bought|bid|b)(?:[^a-z0-9]|$)/i.test(normalized) ||
          /买入|买进|买/u.test(value);
        const isSell =
          /(?:^|[^a-z0-9])(?:sell|selling|sold|ask|s)(?:[^a-z0-9]|$)/i.test(normalized) ||
          /卖出|卖/u.test(value);
        if (isBuy === isSell) return undefined;
        return isBuy ? 'buy' : 'sell';
      };
      const normalizeBooleanTradeSide = (value) => {
        if (value === null || typeof value !== 'object') return undefined;
        const isTruthyFlag = (flag) =>
          flag === true ||
          flag === 1 ||
          (typeof flag === 'string' && /^(?:true|1|yes)$/i.test(flag.trim()));
        const isFalseyFlag = (flag) =>
          flag === false ||
          flag === 0 ||
          (typeof flag === 'string' && /^(?:false|0|no)$/i.test(flag.trim()));
        const buyFlags = [
          value.isBuy,
          value.is_buy,
          value.buy,
          value.isBuyer,
          value.is_buyer,
          value.buyer,
        ];
        const sellFlags = [
          value.isSell,
          value.is_sell,
          value.sell,
          value.isSeller,
          value.is_seller,
          value.seller,
        ];
        const impliesBuy = buyFlags.some(isTruthyFlag) || sellFlags.some(isFalseyFlag);
        const impliesSell = sellFlags.some(isTruthyFlag) || buyFlags.some(isFalseyFlag);
        if (impliesBuy === impliesSell) return undefined;
        return impliesBuy ? 'buy' : 'sell';
      };
      const toTimestampMs = (value) => {
        const normalizeTimestampUnit = (timestamp) =>
          timestamp >= 1000000000 && timestamp < 100000000000 ? timestamp * 1000 : timestamp;
        if (typeof value === 'number' && Number.isFinite(value)) {
          return normalizeTimestampUnit(value);
        }
        if (typeof value !== 'string') {
          return undefined;
        }
        const trimmed = value.trim();
        if (/^\\d+(?:\\.\\d+)?$/.test(trimmed)) return normalizeTimestampUnit(Number(trimmed));
        const parsed = Date.parse(trimmed);
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      const normalizeTradeRecord = (value) => {
        if (value === null || typeof value !== 'object') return undefined;
        if (
          value.node !== undefined &&
          value.node !== null &&
          typeof value.node === 'object' &&
          value.node !== value
        ) {
          const nodeRecord = normalizeTradeRecord(value.node);
          if (nodeRecord !== undefined) return nodeRecord;
        }
        const maker = normalizeTraderAddressValue(
          value.maker,
          nestedTraderAddressValue(value.maker),
          value.makerAddress,
          value.maker_address,
          value.makerAddr,
          value.maker_addr,
          value.makerWallet,
          value.maker_wallet,
          value.makerUrl,
          value.maker_url,
          value.makerLink,
          value.maker_link,
          value.trader,
          nestedTraderAddressValue(value.trader),
          value.traderAddress,
          value.trader_address,
          value.traderAddr,
          value.trader_addr,
          value.traderWallet,
          value.trader_wallet,
          value.traderUrl,
          value.trader_url,
          value.traderLink,
          value.trader_link,
          value.taker,
          nestedTraderAddressValue(value.taker),
          value.takerAddress,
          value.taker_address,
          value.takerAddr,
          value.taker_addr,
          value.takerWallet,
          value.taker_wallet,
          value.takerUrl,
          value.taker_url,
          value.takerLink,
          value.taker_link,
          value.signer,
          nestedTraderAddressValue(value.signer),
          value.signerAddress,
          value.signer_address,
          value.signerAddr,
          value.signer_addr,
          value.signerWallet,
          value.signer_wallet,
          value.signerUrl,
          value.signer_url,
          value.signerLink,
          value.signer_link,
          value.wallet,
          nestedTraderAddressValue(value.wallet),
          value.walletAddress,
          value.wallet_address,
          value.walletAddr,
          value.wallet_addr,
          value.walletUrl,
          value.wallet_url,
          value.walletLink,
          value.wallet_link,
          value.user,
          nestedTraderAddressValue(value.user),
          value.userAddress,
          value.user_address,
          value.userAddr,
          value.user_addr,
          value.userWallet,
          value.user_wallet,
          value.userUrl,
          value.user_url,
          value.userLink,
          value.user_link,
          value.account,
          nestedTraderAddressValue(value.account),
          value.accountAddress,
          value.account_address,
          value.accountAddr,
          value.account_addr,
          value.accountWallet,
          value.account_wallet,
          value.accountUrl,
          value.account_url,
          value.accountLink,
          value.account_link,
          value.owner,
          nestedTraderAddressValue(value.owner),
          value.ownerAddress,
          value.owner_address,
          value.ownerAddr,
          value.owner_addr,
          value.ownerWallet,
          value.owner_wallet,
          value.ownerUrl,
          value.owner_url,
          value.ownerLink,
          value.owner_link,
          value.sender,
          nestedTraderAddressValue(value.sender),
          value.senderAddress,
          value.sender_address,
          value.senderAddr,
          value.sender_addr,
          value.senderWallet,
          value.sender_wallet,
          value.senderUrl,
          value.sender_url,
          value.senderLink,
          value.sender_link,
          value.initiator,
          nestedTraderAddressValue(value.initiator),
          value.initiatorAddress,
          value.initiator_address,
          value.initiatorAddr,
          value.initiator_addr,
          value.initiatorWallet,
          value.initiator_wallet,
          value.initiatorUrl,
          value.initiator_url,
          value.initiatorLink,
          value.initiator_link,
          value.from,
          nestedTraderAddressValue(value.from),
          value.fromAddress,
          value.from_address,
          value.fromAddr,
          value.from_addr,
          value.fromWallet,
          value.from_wallet,
          value.fromUrl,
          value.from_url,
          value.fromLink,
          value.from_link,
          value.payer,
          nestedTraderAddressValue(value.payer),
          value.payerAddress,
          value.payer_address,
          value.payerAddr,
          value.payer_addr,
          value.payerWallet,
          value.payer_wallet,
          value.payerUrl,
          value.payer_url,
          value.payerLink,
          value.payer_link,
          value.feePayer,
          nestedTraderAddressValue(value.feePayer),
          value.feePayerAddress,
          value.fee_payer_address,
          value.feePayerAddr,
          value.fee_payer_addr,
          value.feePayerWallet,
          value.fee_payer_wallet,
          value.feePayerUrl,
          value.fee_payer_url,
          value.feePayerLink,
          value.fee_payer_link,
        );
        const nativeAmount = firstTextValue(
          value.nativeAmount,
          value.native_amount,
          value.amountNative,
          value.amount_native,
          value.nativeValue,
          value.native_value,
          value.nativeTokenAmount,
          value.native_token_amount,
          value.solAmount,
          value.sol_amount,
          value.ethAmount,
          value.eth_amount,
          value.bnbAmount,
          value.bnb_amount,
        );
        const poolAddress = normalizePoolAddressValue(
          value.poolAddress,
          value.pool_address,
          value.poolAddr,
          value.pool_addr,
          value.poolId,
          value.pool_id,
          value.poolID,
          value.poolContract,
          value.pool_contract,
          value.poolUrl,
          value.pool_url,
          value.poolLink,
          value.pool_link,
          value.pairAddress,
          value.pair_address,
          value.pairAddr,
          value.pair_addr,
          value.pairId,
          value.pair_id,
          value.pairID,
          value.pairContract,
          value.pair_contract,
          value.pairUrl,
          value.pair_url,
          value.pairLink,
          value.pair_link,
          value.marketAddress,
          value.market_address,
          value.marketAddr,
          value.market_addr,
          value.marketId,
          value.market_id,
          value.marketID,
          value.marketContract,
          value.market_contract,
          value.marketUrl,
          value.market_url,
          value.marketLink,
          value.market_link,
          value.ammId,
          value.amm_id,
          value.ammID,
          value.ammContract,
          value.amm_contract,
          value.ammAddress,
          value.amm_address,
          value.ammAddr,
          value.amm_addr,
          value.ammUrl,
          value.amm_url,
          value.ammLink,
          value.amm_link,
          value.lpAddress,
          value.lp_address,
          value.lpAddr,
          value.lp_addr,
          value.lpId,
          value.lp_id,
          value.lpID,
          value.lpContract,
          value.lp_contract,
          value.liquidityPoolAddress,
          value.liquidity_pool_address,
          value.liquidityPoolAddr,
          value.liquidity_pool_addr,
          value.liquidityPoolId,
          value.liquidity_pool_id,
          value.liquidityPoolID,
          value.liquidityPoolContract,
          value.liquidity_pool_contract,
          value.lpUrl,
          value.lp_url,
          value.lpLink,
          value.lp_link,
          value.pair,
          value.pool,
          value.market,
          value.amm,
          value.lp,
          nestedAddressValue(value.pair),
          nestedAddressValue(value.pool),
          nestedAddressValue(value.market),
          nestedAddressValue(value.amm),
          nestedAddressValue(value.lp),
          nestedAddressValue(value.pairInfo),
          nestedAddressValue(value.pair_info),
          nestedAddressValue(value.poolInfo),
          nestedAddressValue(value.pool_info),
          nestedAddressValue(value.marketInfo),
          nestedAddressValue(value.market_info),
          nestedAddressValue(value.ammInfo),
          nestedAddressValue(value.amm_info),
          nestedAddressValue(value.lpInfo),
          nestedAddressValue(value.lp_info),
        );
        const priceUsd = firstTextValue(value.priceUsd, value.price_usd, value.priceUSD);
        const timestamp = firstDefinedValue(
          value.timestamp,
          value.timestampMs,
          value.timestamp_ms,
          value.time,
          value.timeMs,
          value.time_ms,
          value.dateTime,
          value.date_time,
          value.datetime,
          value.timeStamp,
          value.time_stamp,
          value.txTime,
          value.tx_time,
          value.txTimeMs,
          value.tx_time_ms,
          value.txnTime,
          value.txn_time,
          value.txnTimeMs,
          value.txn_time_ms,
          value.blockTime,
          value.block_time,
          value.blockTimeMs,
          value.block_time_ms,
          value.blockTimestamp,
          value.block_timestamp,
          value.blockTimestampMs,
          value.block_timestamp_ms,
          value.tradeTime,
          value.trade_time,
          value.tradeTimeMs,
          value.trade_time_ms,
          value.eventTime,
          value.event_time,
          value.eventTimeMs,
          value.event_time_ms,
          value.transactionTime,
          value.transaction_time,
          value.transactionTimeMs,
          value.transaction_time_ms,
          value.transactionAt,
          value.transaction_at,
          value.transactionAtMs,
          value.transaction_at_ms,
          value.transactedAt,
          value.transacted_at,
          value.transactedAtMs,
          value.transacted_at_ms,
          value.executedAt,
          value.executed_at,
          value.executedAtMs,
          value.executed_at_ms,
          value.createdAt,
          value.created_at,
          value.createdAtMs,
          value.created_at_ms,
          value.createdTime,
          value.created_time,
          value.createdTimeMs,
          value.created_time_ms,
        );
        const tokenAmount = firstTextValue(
          value.tokenAmount,
          value.token_amount,
          value.amountToken,
          value.amount_token,
          value.tokenValue,
          value.token_value,
          value.tokenQuantity,
          value.token_quantity,
          value.baseTokenAmount,
          value.base_token_amount,
          value.amountBaseToken,
          value.amount_base_token,
          value.baseAmount,
          value.base_amount,
          value.amountBase,
          value.amount_base,
        );
        const txHash = firstTextValue(
          value.tx,
          nestedTransactionHashValue(value.tx),
          value.txHash,
          value.tx_hash,
          value.txHashUrl,
          value.tx_hash_url,
          value.txHashLink,
          value.tx_hash_link,
          value.txHashHref,
          value.tx_hash_href,
          value.txId,
          value.tx_id,
          value.txid,
          value.txID,
          value.txSignature,
          value.tx_signature,
          value.txUrl,
          value.tx_url,
          value.txLink,
          value.tx_link,
          value.txHref,
          value.tx_href,
          value.transaction,
          nestedTransactionHashValue(value.transaction),
          value.transactionHash,
          value.transaction_hash,
          value.transactionHashUrl,
          value.transaction_hash_url,
          value.transactionHashLink,
          value.transaction_hash_link,
          value.transactionHashHref,
          value.transaction_hash_href,
          value.transactionId,
          value.transaction_id,
          value.transactionID,
          value.transactionSignature,
          value.transaction_signature,
          value.transactionUrl,
          value.transaction_url,
          value.transactionLink,
          value.transaction_link,
          value.transactionHref,
          value.transaction_href,
          value.txn,
          nestedTransactionHashValue(value.txn),
          value.txnHash,
          value.txn_hash,
          value.txnHashUrl,
          value.txn_hash_url,
          value.txnHashLink,
          value.txn_hash_link,
          value.txnHashHref,
          value.txn_hash_href,
          value.txnId,
          value.txn_id,
          value.txnID,
          value.txnSignature,
          value.txn_signature,
          value.txnUrl,
          value.txn_url,
          value.txnLink,
          value.txn_link,
          value.txnHref,
          value.txn_href,
          value.signature,
          nestedTransactionHashValue(value.signature),
          value.signatureHash,
          value.signature_hash,
          value.signatureHashUrl,
          value.signature_hash_url,
          value.signatureHashLink,
          value.signature_hash_link,
          value.signatureHashHref,
          value.signature_hash_href,
          value.signatureId,
          value.signature_id,
          value.signatureID,
          value.signatureUrl,
          value.signature_url,
          value.signatureLink,
          value.signature_link,
          value.signatureHref,
          value.signature_href,
          value.explorer,
          nestedTransactionHashValue(value.explorer),
          value.explorerUrl,
          value.explorer_url,
          value.explorerLink,
          value.explorer_link,
          value.explorerHref,
          value.explorer_href,
          value.scan,
          nestedTransactionHashValue(value.scan),
          value.scanUrl,
          value.scan_url,
          value.scanLink,
          value.scan_link,
          value.scanHref,
          value.scan_href,
          value.blockExplorer,
          nestedTransactionHashValue(value.blockExplorer),
          value.block_explorer,
          nestedTransactionHashValue(value.block_explorer),
          value.blockExplorerUrl,
          value.block_explorer_url,
          value.blockExplorerLink,
          value.block_explorer_link,
          value.blockExplorerHref,
          value.block_explorer_href,
          value.hashUrl,
          value.hash_url,
          value.hashLink,
          value.hash_link,
          value.hashHref,
          value.hash_href,
          value.idUrl,
          value.id_url,
          value.idLink,
          value.id_link,
          value.idHref,
          value.id_href,
          value.url,
          value.link,
          value.href,
          value.hash,
          value.id,
        );
        const type = normalizeTradeSide(
          value.type,
          value.side,
          value.sideText,
          value.side_text,
          value.direction,
          value.tradeDirection,
          value.trade_direction,
          value.orderDirection,
          value.order_direction,
          value.swapDirection,
          value.swap_direction,
          value.transactionDirection,
          value.transaction_direction,
          value.txDirection,
          value.tx_direction,
          value.directionText,
          value.direction_text,
          value.tradeSide,
          value.trade_side,
          value.tradeType,
          value.trade_type,
          value.transactionType,
          value.transaction_type,
          value.txType,
          value.tx_type,
          value.txSide,
          value.tx_side,
          value.buySell,
          value.buy_sell,
          value.orderSide,
          value.order_side,
          value.orderType,
          value.order_type,
          value.eventType,
          value.event_type,
          value.kind,
          value.typeName,
          value.type_name,
          value.action,
        ) ?? normalizeBooleanTradeSide(value);
        const usdAmount = firstTextValue(
          value.usdAmount,
          value.usd_amount,
          value.amountUsd,
          value.amount_usd,
          value.amountUSD,
          value.valueUsd,
          value.value_usd,
          value.valueUSD,
        );
        if (
          maker === undefined ||
          toTimestampMs(timestamp) === undefined ||
          txHash === undefined ||
          type === undefined
        ) {
          return undefined;
        }
        return {
          maker,
          ...(nativeAmount === undefined ? {} : { nativeAmount }),
          ...(poolAddress === undefined ? {} : { poolAddress }),
          ...(priceUsd === undefined ? {} : { priceUsd }),
          timestamp,
          ...(tokenAmount === undefined ? {} : { tokenAmount }),
          txHash: normalizeTxHash(txHash),
          type,
          ...(usdAmount === undefined ? {} : { usdAmount }),
        };
      };
      const normalizeTxHash = (value) => {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (normalized.length === 0) return '';
        const evmHash = normalized.match(/\\b0x[a-fA-F0-9]{64}\\b/i)?.[0];
        if (evmHash !== undefined) return evmHash.toLowerCase();
        const solanaHash = normalized.match(/\\b[1-9A-HJ-NP-Za-km-z]{64,96}\\b/)?.[0];
        if (solanaHash !== undefined) return solanaHash;
        return normalized;
      };
      const txHashMatches = (left, right) => {
        const normalizedLeft = normalizeTxHash(left);
        const normalizedRight = normalizeTxHash(right);
        if (normalizedLeft.length === 0 || normalizedRight.length === 0) return false;
        const evmHashPattern = /^0x[a-fA-F0-9]{64}$/i;
        if (evmHashPattern.test(normalizedLeft) && evmHashPattern.test(normalizedRight)) {
          return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
        }
        return normalizedLeft === normalizedRight;
      };
      const responseTradeRowArrays = (body) => {
        const rowArrays = [];
        const visit = (value) => {
          if (Array.isArray(value)) {
            rowArrays.push(value);
            return;
          }
          if (value === null || typeof value !== 'object') {
            return;
          }
          for (const key of [
            'data',
            'list',
            'records',
            'rows',
            'items',
            'payload',
            'result',
            'results',
            'page',
            'pageData',
            'page_data',
            'content',
            'activities',
            'activityList',
            'activity_list',
            'activityRows',
            'activity_rows',
            'dataList',
            'data_list',
            'dataRows',
            'data_rows',
            'edges',
            'events',
            'eventList',
            'event_list',
            'fills',
            'fillList',
            'fill_list',
            'histories',
            'history',
            'historyList',
            'history_list',
            'historyRows',
            'history_rows',
            'latestTrades',
            'latest_trades',
            'latestTransactions',
            'latest_transactions',
            'nodes',
            'tableData',
            'table_data',
            'tableRows',
            'table_rows',
            'orderList',
            'order_list',
            'orderRows',
            'order_rows',
            'resultList',
            'result_list',
            'recentTrades',
            'recent_trades',
            'recentTransactions',
            'recent_transactions',
            'tradeRows',
            'trade_rows',
            'tradeList',
            'trade_list',
            'trades',
            'swapList',
            'swap_list',
            'swaps',
            'transactionList',
            'transaction_list',
            'transactionRows',
            'transaction_rows',
            'transactions',
            'txList',
            'tx_list',
            'txRows',
            'tx_rows',
          ]) {
            visit(value[key]);
          }
        };
        visit(body);
        return rowArrays;
      };
      const searchTrades = async (extra) => {
        const response = await fetch('/api/data/trades/search', {
          body: JSON.stringify({ ...basePayload, ...extra }),
          headers: {
            'content-type': 'application/json',
            ...(xxyyChainHeader === undefined ? {} : { 'x-chain': xxyyChainHeader }),
          },
          method: 'POST',
        });
        if (response.ok === false) {
          throw new Error(\`XXYY trade search HTTP \${response.status}\`);
        }
        const body = await response.json();
        return responseTradeRowArrays(body)
          .flatMap((rows) => rows.map(normalizeTradeRecord))
          .filter((trade) => trade !== undefined);
      };
      const findTargetByMaker = async () => {
        if (queryInput.signerAddress === undefined) return undefined;
        let lastId;
        for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
          const trades = await searchTrades({
            makerAddress: queryInput.signerAddress,
            pageSize: 100,
            ...(lastId === undefined ? {} : { lastId }),
          });
          const target = trades.find((trade) => txHashMatches(trade.txHash, queryInput.txHash));
          if (target !== undefined || trades.length === 0) return target;
          lastId = toTimestampMs(trades.at(-1)?.timestamp);
          if (lastId === undefined) return undefined;
        }
        return undefined;
      };
      const findTargetNearSolscanTime = async () => {
        if (queryInput.timeStart === undefined || queryInput.timeEnd === undefined) return undefined;
        const trades = await searchTrades({
          pageSize: 100,
          timeEnd: queryInput.timeEnd,
          timeStart: queryInput.timeStart,
        });
        return trades.find((trade) => txHashMatches(trade.txHash, queryInput.txHash));
      };
      const tradeIdentity = (trade) => normalizeTxHash(trade?.txHash);
      const isTargetTrade = (trade) => txHashMatches(trade?.txHash, queryInput.txHash);
      const mergeWindowTrades = (primary, recovered) => {
        const seen = new Set();
        const merged = [];
        for (const trade of [...primary, ...recovered]) {
          if (isTargetTrade(trade)) continue;
          const key = tradeIdentity(trade);
          if (key.length > 0 && seen.has(key)) continue;
          if (key.length > 0) seen.add(key);
          merged.push(trade);
          if (merged.length >= 5) break;
        }
        return merged;
      };
      const recoverCenteredWindowAroundTarget = async (targetTimestamp) => {
        const trades = await searchTrades({
          pageSize: 100,
          timeEnd: targetTimestamp + 30000,
          timeStart: Math.max(0, targetTimestamp - 30000),
        });
        const targetIndex = trades.findIndex(isTargetTrade);
        if (targetIndex < 0) return { afterTrades: [], beforeTrades: [] };

        return {
          afterTrades: trades
            .slice(0, targetIndex)
            .reverse()
            .filter((trade) => !isTargetTrade(trade))
            .slice(0, 5),
          beforeTrades: trades
            .slice(targetIndex + 1)
            .filter((trade) => !isTargetTrade(trade))
            .slice(0, 5),
        };
      };
      const targetTrade = (await findTargetByMaker()) ?? (await findTargetNearSolscanTime());
      if (targetTrade === undefined) {
        return { afterTrades: [], beforeTrades: [] };
      }
      const targetTimestamp = toTimestampMs(targetTrade.timestamp);
      if (targetTimestamp === undefined) {
        return { afterTrades: [], beforeTrades: [], targetTrade };
      }
      let [beforeTrades, afterTrades] = await Promise.all([
        searchTrades({ pageSize: 5, timeEnd: targetTimestamp - 1 }),
        searchTrades({ pageSize: 5, reverse: 1, timeStart: targetTimestamp + 1 }),
      ]);
      if (beforeTrades.length < 5 || afterTrades.length < 5) {
        const recovered = await recoverCenteredWindowAroundTarget(targetTimestamp);
        beforeTrades = mergeWindowTrades(beforeTrades, recovered.beforeTrades);
        afterTrades = mergeWindowTrades(afterTrades, recovered.afterTrades);
      }
      return { afterTrades, beforeTrades, targetTrade };
    })()
  `);

  return normalizeXxyyTradeQueryOutput(raw);
}

export function buildXxyyTradeWindow(input: XxyyTradeWindowInput): XxyyTradeWindow {
  return {
    ...(input.selectedPoolAddress === undefined
      ? {}
      : { selectedPoolAddress: input.selectedPoolAddress }),
    targetTrade: toBrowserTrade(input.targetTrade, input.nativeSymbol),
    tradeWindow: {
      after: input.afterTrades
        .slice(0, 5)
        .map((trade) => toBrowserTrade(trade, input.nativeSymbol)),
      before: input.beforeTrades
        .slice(0, 5)
        .reverse()
        .map((trade) => toBrowserTrade(trade, input.nativeSymbol)),
    },
  };
}

export function requireLocatedXxyyTradeWindow(
  tradeWindow: XxyyTradeWindow | undefined,
  txHash: string,
): XxyyTradeWindow {
  if (tradeWindow === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      `未在 XXYY 池子成交列表中定位目标交易：${txHash}`,
      'target_trade_not_found',
    );
  }

  return tradeWindow;
}

export function xxyyTransactionHashMatches(left: string, right: string): boolean {
  const normalizedLeft = normalizeXxyyTransactionHash(left);
  const normalizedRight = normalizeXxyyTransactionHash(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return false;
  }

  if (EVM_TX_HASH_PATTERN.test(normalizedLeft) && EVM_TX_HASH_PATTERN.test(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

function normalizeXxyyTransactionHash(value: string): string {
  const normalized = parseTransactionReference(value.trim())?.txHash ?? value.trim();
  return EVM_TX_HASH_PATTERN.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function calculateXxyyOriginalTradeScrollTop(input: {
  clientHeight: number;
  rowHeight: number;
  targetIndex: number;
}): number {
  const centeredTop =
    input.targetIndex * input.rowHeight - input.clientHeight / 2 + input.rowHeight / 2;
  return Math.max(0, Math.round(centeredTop));
}

export function calculateXxyyOriginalTargetRowY(input: {
  rowHeight: number;
  scrollTop: number;
  targetIndex: number;
}): number {
  return Math.round(input.targetIndex * input.rowHeight - input.scrollTop + input.rowHeight / 2);
}

export function calculateInitialXxyyOriginalTargetPosition(input: {
  afterTradeCount: number;
  clientHeight: number;
  rowHeight: number;
  scrollTop: number;
}): XxyyOriginalTradeListTargetPosition | undefined {
  if (
    input.afterTradeCount >= 5 ||
    input.clientHeight <= 0 ||
    input.rowHeight <= 0 ||
    input.scrollTop !== 0
  ) {
    return undefined;
  }

  const targetIndex = input.afterTradeCount;
  const targetRowY = calculateXxyyOriginalTargetRowY({
    rowHeight: input.rowHeight,
    scrollTop: input.scrollTop,
    targetIndex,
  });
  if (targetRowY < 0 || targetRowY > input.clientHeight) {
    return undefined;
  }

  return {
    rowHeight: input.rowHeight,
    targetIndex,
    targetRowY,
  };
}

function xxyyOriginalTradeRowSelectors(): string[] {
  return [
    '.row.row-clickable',
    '.row',
    '.trade-row',
    '.transaction-row',
    '.ant-table-row',
    '.el-table__row',
    '.arco-table-tr',
    '.n-data-table-tr',
    '.v-data-table__tr',
    '.ag-row',
    '.MuiDataGrid-row',
    '.MuiTableRow-root',
    '.ReactVirtualized__Table__row',
    '[data-testid="trade-row"]',
    '[data-testid="transaction-row"]',
    '[data-role="trade-row"]',
    '[data-role="transaction-row"]',
    '[data-index]',
    '[data-rowindex]',
    '[data-row-index]',
    '[data-row-key]',
    '[data-record-key]',
    '.trade-table__row',
    '.transaction-table__row',
    '[role="row"]',
    'tr',
    '.vue-recycle-scroller__item-view',
  ];
}

export function createXxyyOriginalTradeRowSelector(): string {
  return xxyyOriginalTradeRowSelectors().join(', ');
}

export function createXxyyOriginalMetricRowSelector(): string {
  return createXxyyOriginalTradeRowSelector();
}

function xxyyOriginalTradeListContainerSelectors(): string[] {
  return [
    '.dashboard-bd-trades',
    '[data-testid="trades"]',
    '[data-testid="transactions"]',
    '[data-testid="trade-list"]',
    '[data-testid="transaction-list"]',
    '[data-testid="tx-list"]',
    '[data-testid="pool-trades"]',
    '[data-testid="trades-table"]',
    '[data-testid="transactions-table"]',
    '[data-role="trades"]',
    '[data-role="transactions"]',
    '.trade-list',
    '.transaction-list',
    '.trades-list',
    '.tx-list',
    '.trade-table',
    '.transactions-table',
    '.pool-transactions',
    '.latest-transactions',
    '.ant-table-body',
    '.el-table__body-wrapper',
    '.arco-table-body',
    '.n-data-table-base-table-body',
    '.v-table__wrapper',
    '.rc-virtual-list-holder',
    '.virtuoso-scroller',
    '.ag-body-viewport',
    '.ag-center-cols-viewport',
    '.MuiDataGrid-virtualScroller',
    '.MuiTableContainer-root',
    '.ReactVirtualized__Grid',
    '.ReactVirtualized__Grid__innerScrollContainer',
  ];
}

export function createXxyyOriginalTradeListContainerSelector(): string {
  return xxyyOriginalTradeListContainerSelectors().join(', ');
}

function xxyyOriginalTradeScrollerSelectors(): string[] {
  return [
    ...xxyyOriginalTradeListContainerSelectors().map(
      (selector) => `${selector} .vue-recycle-scroller`,
    ),
    ...xxyyOriginalTradeListContainerSelectors(),
  ];
}

export function createXxyyOriginalTradeScrollerSelector(): string {
  return xxyyOriginalTradeScrollerSelectors().join(', ');
}

export function selectXxyyOriginalTargetRowCandidate(input: {
  rowHeight: number;
  rows: XxyyOriginalTargetRowCandidate[];
  targetTxHash: string;
  targetY: number;
}): number {
  const candidates = input.rows.map((row, index) => ({
    distance: Math.abs(row.centerY - input.targetY),
    exposesTransactionReference: xxyyOriginalRowExposesTransactionReference(row),
    index,
    matchesTargetHash: xxyyOriginalRowContainsTargetHash(row, input.targetTxHash),
  }));
  const hashMatchedCandidates = candidates.filter((candidate) => candidate.matchesTargetHash);
  if (
    hashMatchedCandidates.length === 0 &&
    candidates.some((candidate) => candidate.exposesTransactionReference)
  ) {
    return -1;
  }

  const selectableCandidates =
    hashMatchedCandidates.length > 0 ? hashMatchedCandidates : candidates;
  const selected = selectableCandidates.sort((left, right) => left.distance - right.distance)[0];
  if (selected === undefined) {
    return -1;
  }
  if (hashMatchedCandidates.length === 0 && selected.distance > input.rowHeight * 1.5) {
    return -1;
  }

  return selected.index;
}

export function createXxyyOriginalTargetRowAttributeNames(): string[] {
  return [
    'title',
    'aria-label',
    'aria-description',
    'aria-describedby',
    'aria-labelledby',
    'href',
    'onclick',
    'data-tx',
    'data-tx_hash',
    'data-tx-hash',
    'data-txhash',
    'data-tx-id',
    'data-txid',
    'data-tx-href',
    'data-tx-link',
    'data-tx-url',
    'data-onclick',
    'data-key',
    'data-hash',
    'data-hash-url',
    'data-hash-link',
    'data-hash-href',
    'data-id',
    'data-id-url',
    'data-id-link',
    'data-id-href',
    'data-row-key',
    'data-row-id',
    'data-record-key',
    'data-record-id',
    'data-txn',
    'data-txn_hash',
    'data-txn-hash',
    'data-txn-id',
    'data-txnid',
    'data-txn-href',
    'data-txn-link',
    'data-txn-url',
    'data-transaction',
    'data-transaction_hash',
    'data-transaction-hash',
    'data-transactionhash',
    'data-transaction-id',
    'data-transactionid',
    'data-transaction-key',
    'data-transaction-href',
    'data-transaction-link',
    'data-transaction-url',
    'data-signature',
    'data-signature_hash',
    'data-signature-hash',
    'data-signaturehash',
    'data-signatureid',
    'data-signature-href',
    'data-signature-link',
    'data-signature-url',
    'data-action',
    'data-row-action',
    'data-click',
    'data-click-url',
    'data-explorer',
    'data-explorer-href',
    'data-explorer-link',
    'data-explorer-url',
    'data-scan',
    'data-scan-href',
    'data-scan-link',
    'data-scan-url',
    'data-block-explorer',
    'data-block-explorer-href',
    'data-block-explorer-link',
    'data-block-explorer-url',
    'data-clipboard',
    'data-clipboard-href',
    'data-clipboard-link',
    'data-clipboard-text',
    'data-clipboard-url',
    'data-clipboard-value',
    'data-copy',
    'data-copy-href',
    'data-copy-link',
    'data-copy-text',
    'data-copy-url',
    'data-copy-value',
    'data-tip',
    'data-title',
    'data-tooltip',
    'data-tooltip-content',
    'data-tooltip-title',
    'data-href',
    'data-link',
    'data-url',
    'data-value',
    'value',
  ];
}

export function shouldCollectXxyyOriginalTargetRowAttributeName(name: string): boolean {
  const normalized = name.trim();
  return (
    normalized.length > 0 &&
    (createXxyyOriginalTargetRowAttributeNames().includes(normalized) ||
      /^data-[a-z0-9_:-]+$/iu.test(normalized))
  );
}

function xxyyOriginalRowContainsTargetHash(
  row: XxyyOriginalTargetRowCandidate,
  targetTxHash: string,
): boolean {
  const needles = createXxyyTargetHashNeedles(targetTxHash);
  const haystackRaw = normalizeXxyyTargetHashHaystack(xxyyOriginalRowSearchText(row));
  if (isCaseInsensitiveXxyyTargetHash(targetTxHash)) {
    const haystack = haystackRaw.toLowerCase();
    return needles.some((needle) => haystack.includes(needle.toLowerCase()));
  }

  return needles.some((needle) => haystackRaw.includes(needle));
}

function xxyyOriginalRowExposesTransactionReference(row: XxyyOriginalTargetRowCandidate): boolean {
  return xxyyOriginalTextExposesTransactionReference(xxyyOriginalRowSearchText(row));
}

function xxyyOriginalRowSearchText(row: XxyyOriginalTargetRowCandidate): string {
  const values = [row.text, ...row.hrefs, ...(row.attributes ?? [])];
  return [...values, ...values.flatMap((value) => decodeXxyyOriginalRowSearchValue(value))].join(
    ' ',
  );
}

function decodeXxyyOriginalRowSearchValue(value: string): string[] {
  const decodedValues = new Set<string>();
  if (value.includes('+')) {
    decodedValues.add(value.replace(/\+/gu, ' '));
  }

  if (/%[0-9a-fA-F]{2}/u.test(value)) {
    try {
      decodedValues.add(decodeURIComponent(value));
    } catch {
      // Ignore malformed encoded values and keep the raw haystack.
    }
  }

  for (const candidate of [...decodedValues]) {
    if (!/%[0-9a-fA-F]{2}/u.test(candidate)) {
      continue;
    }
    try {
      decodedValues.add(decodeURIComponent(candidate));
    } catch {
      // Ignore malformed encoded values and keep the other candidates.
    }
  }

  decodedValues.delete(value);
  return [...decodedValues];
}

function xxyyOriginalTextExposesTransactionReference(value: string): boolean {
  return (
    EVM_TX_HASH_TEXT_PATTERN.test(value) ||
    EVM_ABBREVIATED_TX_HASH_TEXT_PATTERN.test(value) ||
    SOLANA_TX_SIGNATURE_TEXT_PATTERN.test(value) ||
    SOLANA_ABBREVIATED_TX_SIGNATURE_TEXT_PATTERN.test(value)
  );
}

function normalizeXxyyTargetHashHaystack(value: string): string {
  return value.replace(/\s*(?:\.{2,3}|…|⋯|[-–—])\s*/gu, (separator) => {
    if (separator.includes('…')) {
      return ' … ';
    }
    if (separator.includes('⋯')) {
      return ' ⋯ ';
    }
    if (/[-–—]/u.test(separator)) {
      return ' - ';
    }

    const dotCount = separator.replace(/[^.]/gu, '').length;
    return dotCount === 2 ? ' .. ' : ' ... ';
  });
}

function createXxyyTargetHashNeedles(txHash: string): string[] {
  const normalized = normalizeXxyyTransactionHash(txHash);
  if (normalized.length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      [
        normalized,
        ...abbreviatedHashNeedles(normalized, 4, 4),
        ...abbreviatedHashNeedles(normalized, 6, 4),
        ...abbreviatedHashNeedles(normalized, 6, 6),
        ...abbreviatedHashNeedles(normalized, 8, 6),
        ...abbreviatedHashNeedles(normalized, 10, 8),
        ...abbreviatedHashNeedles(normalized, 10, 10),
        ...abbreviatedHashNeedles(normalized, 12, 8),
        ...abbreviatedHashNeedles(normalized, 12, 12),
      ].filter((value): value is string => value !== undefined),
    ),
  );
}

function abbreviatedHashNeedles(
  hash: string,
  prefixLength: number,
  suffixLength: number,
): string[] {
  if (hash.length <= prefixLength + suffixLength) {
    return [];
  }

  const prefix = hash.slice(0, prefixLength);
  const suffix = hash.slice(-suffixLength);
  return [
    `${prefix}..${suffix}`,
    `${prefix} .. ${suffix}`,
    `${prefix}...${suffix}`,
    `${prefix} ... ${suffix}`,
    `${prefix}…${suffix}`,
    `${prefix} … ${suffix}`,
    `${prefix}⋯${suffix}`,
    `${prefix} ⋯ ${suffix}`,
    `${prefix} - ${suffix}`,
  ];
}

function isCaseInsensitiveXxyyTargetHash(txHash: string): boolean {
  return EVM_TX_HASH_PATTERN.test(normalizeXxyyTransactionHash(txHash));
}

function normalizeXxyyTradeQueryOutput(value: unknown): XxyyTradeQueryOutput {
  if (value === null || typeof value !== 'object') {
    return { afterTrades: [], beforeTrades: [] };
  }

  const record = value as Record<string, unknown>;
  const targetTrade = normalizeXxyyTradeRecord(record.targetTrade);
  return {
    afterTrades: Array.isArray(record.afterTrades)
      ? record.afterTrades
          .map(normalizeXxyyTradeRecord)
          .filter((trade): trade is XxyyTradeRecord => trade !== undefined)
      : [],
    beforeTrades: Array.isArray(record.beforeTrades)
      ? record.beforeTrades
          .map(normalizeXxyyTradeRecord)
          .filter((trade): trade is XxyyTradeRecord => trade !== undefined)
      : [],
    ...(targetTrade === undefined ? {} : { targetTrade }),
  };
}

function normalizeXxyyTradeRecord(value: unknown): XxyyTradeRecord | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.node !== undefined && record.node !== null && typeof record.node === 'object') {
    const nodeRecord = normalizeXxyyTradeRecord(record.node);
    if (nodeRecord !== undefined) {
      return nodeRecord;
    }
  }

  const maker = normalizeXxyyTraderAddress(
    record.maker,
    nestedXxyyTraderAddressValue(record.maker),
    record.makerAddress,
    record.maker_address,
    record.makerAddr,
    record.maker_addr,
    record.makerWallet,
    record.maker_wallet,
    record.makerUrl,
    record.maker_url,
    record.makerLink,
    record.maker_link,
    record.trader,
    nestedXxyyTraderAddressValue(record.trader),
    record.traderAddress,
    record.trader_address,
    record.traderAddr,
    record.trader_addr,
    record.traderWallet,
    record.trader_wallet,
    record.traderUrl,
    record.trader_url,
    record.traderLink,
    record.trader_link,
    record.taker,
    nestedXxyyTraderAddressValue(record.taker),
    record.takerAddress,
    record.taker_address,
    record.takerAddr,
    record.taker_addr,
    record.takerWallet,
    record.taker_wallet,
    record.takerUrl,
    record.taker_url,
    record.takerLink,
    record.taker_link,
    record.signer,
    nestedXxyyTraderAddressValue(record.signer),
    record.signerAddress,
    record.signer_address,
    record.signerAddr,
    record.signer_addr,
    record.signerWallet,
    record.signer_wallet,
    record.signerUrl,
    record.signer_url,
    record.signerLink,
    record.signer_link,
    record.wallet,
    nestedXxyyTraderAddressValue(record.wallet),
    record.walletAddress,
    record.wallet_address,
    record.walletAddr,
    record.wallet_addr,
    record.walletUrl,
    record.wallet_url,
    record.walletLink,
    record.wallet_link,
    record.user,
    nestedXxyyTraderAddressValue(record.user),
    record.userAddress,
    record.user_address,
    record.userAddr,
    record.user_addr,
    record.userWallet,
    record.user_wallet,
    record.userUrl,
    record.user_url,
    record.userLink,
    record.user_link,
    record.account,
    nestedXxyyTraderAddressValue(record.account),
    record.accountAddress,
    record.account_address,
    record.accountAddr,
    record.account_addr,
    record.accountWallet,
    record.account_wallet,
    record.accountUrl,
    record.account_url,
    record.accountLink,
    record.account_link,
    record.owner,
    nestedXxyyTraderAddressValue(record.owner),
    record.ownerAddress,
    record.owner_address,
    record.ownerAddr,
    record.owner_addr,
    record.ownerWallet,
    record.owner_wallet,
    record.ownerUrl,
    record.owner_url,
    record.ownerLink,
    record.owner_link,
    record.sender,
    nestedXxyyTraderAddressValue(record.sender),
    record.senderAddress,
    record.sender_address,
    record.senderAddr,
    record.sender_addr,
    record.senderWallet,
    record.sender_wallet,
    record.senderUrl,
    record.sender_url,
    record.senderLink,
    record.sender_link,
    record.initiator,
    nestedXxyyTraderAddressValue(record.initiator),
    record.initiatorAddress,
    record.initiator_address,
    record.initiatorAddr,
    record.initiator_addr,
    record.initiatorWallet,
    record.initiator_wallet,
    record.initiatorUrl,
    record.initiator_url,
    record.initiatorLink,
    record.initiator_link,
    record.from,
    nestedXxyyTraderAddressValue(record.from),
    record.fromAddress,
    record.from_address,
    record.fromAddr,
    record.from_addr,
    record.fromWallet,
    record.from_wallet,
    record.fromUrl,
    record.from_url,
    record.fromLink,
    record.from_link,
    record.payer,
    nestedXxyyTraderAddressValue(record.payer),
    record.payerAddress,
    record.payer_address,
    record.payerAddr,
    record.payer_addr,
    record.payerWallet,
    record.payer_wallet,
    record.payerUrl,
    record.payer_url,
    record.payerLink,
    record.payer_link,
    record.feePayer,
    nestedXxyyTraderAddressValue(record.feePayer),
    record.feePayerAddress,
    record.fee_payer_address,
    record.feePayerAddr,
    record.fee_payer_addr,
    record.feePayerWallet,
    record.fee_payer_wallet,
    record.feePayerUrl,
    record.fee_payer_url,
    record.feePayerLink,
    record.fee_payer_link,
  );
  const nativeAmount = firstXxyyTradeString(
    record.nativeAmount,
    record.native_amount,
    record.amountNative,
    record.amount_native,
    record.nativeValue,
    record.native_value,
    record.nativeTokenAmount,
    record.native_token_amount,
    record.solAmount,
    record.sol_amount,
    record.ethAmount,
    record.eth_amount,
    record.bnbAmount,
    record.bnb_amount,
  );
  const poolAddress = normalizeXxyyPoolAddress(
    record.poolAddress,
    record.pool_address,
    record.poolAddr,
    record.pool_addr,
    record.poolId,
    record.pool_id,
    record.poolID,
    record.poolContract,
    record.pool_contract,
    record.poolUrl,
    record.pool_url,
    record.poolLink,
    record.pool_link,
    record.pairAddress,
    record.pair_address,
    record.pairAddr,
    record.pair_addr,
    record.pairId,
    record.pair_id,
    record.pairID,
    record.pairContract,
    record.pair_contract,
    record.pairUrl,
    record.pair_url,
    record.pairLink,
    record.pair_link,
    record.marketAddress,
    record.market_address,
    record.marketAddr,
    record.market_addr,
    record.marketId,
    record.market_id,
    record.marketID,
    record.marketContract,
    record.market_contract,
    record.marketUrl,
    record.market_url,
    record.marketLink,
    record.market_link,
    record.ammId,
    record.amm_id,
    record.ammID,
    record.ammContract,
    record.amm_contract,
    record.ammAddress,
    record.amm_address,
    record.ammAddr,
    record.amm_addr,
    record.ammUrl,
    record.amm_url,
    record.ammLink,
    record.amm_link,
    record.lpAddress,
    record.lp_address,
    record.lpAddr,
    record.lp_addr,
    record.lpId,
    record.lp_id,
    record.lpID,
    record.lpContract,
    record.lp_contract,
    record.liquidityPoolAddress,
    record.liquidity_pool_address,
    record.liquidityPoolAddr,
    record.liquidity_pool_addr,
    record.liquidityPoolId,
    record.liquidity_pool_id,
    record.liquidityPoolID,
    record.liquidityPoolContract,
    record.liquidity_pool_contract,
    record.lpUrl,
    record.lp_url,
    record.lpLink,
    record.lp_link,
    record.pair,
    record.pool,
    record.market,
    record.amm,
    record.lp,
    nestedXxyyAddressValue(record.pair),
    nestedXxyyAddressValue(record.pool),
    nestedXxyyAddressValue(record.market),
    nestedXxyyAddressValue(record.amm),
    nestedXxyyAddressValue(record.lp),
    nestedXxyyAddressValue(record.pairInfo),
    nestedXxyyAddressValue(record.pair_info),
    nestedXxyyAddressValue(record.poolInfo),
    nestedXxyyAddressValue(record.pool_info),
    nestedXxyyAddressValue(record.marketInfo),
    nestedXxyyAddressValue(record.market_info),
    nestedXxyyAddressValue(record.ammInfo),
    nestedXxyyAddressValue(record.amm_info),
    nestedXxyyAddressValue(record.lpInfo),
    nestedXxyyAddressValue(record.lp_info),
  );
  const priceUsd = firstXxyyTradeString(record.priceUsd, record.price_usd, record.priceUSD);
  const timestamp = firstDefinedXxyyTradeValue(
    record.timestamp,
    record.timestampMs,
    record.timestamp_ms,
    record.time,
    record.timeMs,
    record.time_ms,
    record.dateTime,
    record.date_time,
    record.datetime,
    record.timeStamp,
    record.time_stamp,
    record.txTime,
    record.tx_time,
    record.txTimeMs,
    record.tx_time_ms,
    record.txnTime,
    record.txn_time,
    record.txnTimeMs,
    record.txn_time_ms,
    record.blockTime,
    record.block_time,
    record.blockTimeMs,
    record.block_time_ms,
    record.blockTimestamp,
    record.block_timestamp,
    record.blockTimestampMs,
    record.block_timestamp_ms,
    record.tradeTime,
    record.trade_time,
    record.tradeTimeMs,
    record.trade_time_ms,
    record.eventTime,
    record.event_time,
    record.eventTimeMs,
    record.event_time_ms,
    record.transactionTime,
    record.transaction_time,
    record.transactionTimeMs,
    record.transaction_time_ms,
    record.transactionAt,
    record.transaction_at,
    record.transactionAtMs,
    record.transaction_at_ms,
    record.transactedAt,
    record.transacted_at,
    record.transactedAtMs,
    record.transacted_at_ms,
    record.executedAt,
    record.executed_at,
    record.executedAtMs,
    record.executed_at_ms,
    record.createdAt,
    record.created_at,
    record.createdAtMs,
    record.created_at_ms,
    record.createdTime,
    record.created_time,
    record.createdTimeMs,
    record.created_time_ms,
  );
  const tokenAmount = firstXxyyTradeString(
    record.tokenAmount,
    record.token_amount,
    record.amountToken,
    record.amount_token,
    record.tokenValue,
    record.token_value,
    record.tokenQuantity,
    record.token_quantity,
    record.baseTokenAmount,
    record.base_token_amount,
    record.amountBaseToken,
    record.amount_base_token,
    record.baseAmount,
    record.base_amount,
    record.amountBase,
    record.amount_base,
  );
  const txHash = firstXxyyTradeString(
    record.tx,
    nestedXxyyTransactionHashValue(record.tx),
    record.txHash,
    record.tx_hash,
    record.txHashUrl,
    record.tx_hash_url,
    record.txHashLink,
    record.tx_hash_link,
    record.txHashHref,
    record.tx_hash_href,
    record.txId,
    record.tx_id,
    record.txid,
    record.txID,
    record.txSignature,
    record.tx_signature,
    record.txUrl,
    record.tx_url,
    record.txLink,
    record.tx_link,
    record.txHref,
    record.tx_href,
    record.transaction,
    nestedXxyyTransactionHashValue(record.transaction),
    record.transactionHash,
    record.transaction_hash,
    record.transactionHashUrl,
    record.transaction_hash_url,
    record.transactionHashLink,
    record.transaction_hash_link,
    record.transactionHashHref,
    record.transaction_hash_href,
    record.transactionId,
    record.transaction_id,
    record.transactionID,
    record.transactionSignature,
    record.transaction_signature,
    record.transactionUrl,
    record.transaction_url,
    record.transactionLink,
    record.transaction_link,
    record.transactionHref,
    record.transaction_href,
    record.txn,
    nestedXxyyTransactionHashValue(record.txn),
    record.txnHash,
    record.txn_hash,
    record.txnHashUrl,
    record.txn_hash_url,
    record.txnHashLink,
    record.txn_hash_link,
    record.txnHashHref,
    record.txn_hash_href,
    record.txnId,
    record.txn_id,
    record.txnID,
    record.txnSignature,
    record.txn_signature,
    record.txnUrl,
    record.txn_url,
    record.txnLink,
    record.txn_link,
    record.txnHref,
    record.txn_href,
    record.signature,
    nestedXxyyTransactionHashValue(record.signature),
    record.signatureHash,
    record.signature_hash,
    record.signatureHashUrl,
    record.signature_hash_url,
    record.signatureHashLink,
    record.signature_hash_link,
    record.signatureHashHref,
    record.signature_hash_href,
    record.signatureId,
    record.signature_id,
    record.signatureID,
    record.signatureUrl,
    record.signature_url,
    record.signatureLink,
    record.signature_link,
    record.signatureHref,
    record.signature_href,
    record.explorer,
    nestedXxyyTransactionHashValue(record.explorer),
    record.explorerUrl,
    record.explorer_url,
    record.explorerLink,
    record.explorer_link,
    record.explorerHref,
    record.explorer_href,
    record.scan,
    nestedXxyyTransactionHashValue(record.scan),
    record.scanUrl,
    record.scan_url,
    record.scanLink,
    record.scan_link,
    record.scanHref,
    record.scan_href,
    record.blockExplorer,
    nestedXxyyTransactionHashValue(record.blockExplorer),
    record.block_explorer,
    nestedXxyyTransactionHashValue(record.block_explorer),
    record.blockExplorerUrl,
    record.block_explorer_url,
    record.blockExplorerLink,
    record.block_explorer_link,
    record.blockExplorerHref,
    record.block_explorer_href,
    record.hashUrl,
    record.hash_url,
    record.hashLink,
    record.hash_link,
    record.hashHref,
    record.hash_href,
    record.idUrl,
    record.id_url,
    record.idLink,
    record.id_link,
    record.idHref,
    record.id_href,
    record.url,
    record.link,
    record.href,
    record.hash,
    record.id,
  );
  const type =
    normalizeXxyyTradeSide(
      record.type,
      record.side,
      record.sideText,
      record.side_text,
      record.direction,
      record.tradeDirection,
      record.trade_direction,
      record.orderDirection,
      record.order_direction,
      record.swapDirection,
      record.swap_direction,
      record.transactionDirection,
      record.transaction_direction,
      record.txDirection,
      record.tx_direction,
      record.directionText,
      record.direction_text,
      record.tradeSide,
      record.trade_side,
      record.tradeType,
      record.trade_type,
      record.transactionType,
      record.transaction_type,
      record.txType,
      record.tx_type,
      record.txSide,
      record.tx_side,
      record.buySell,
      record.buy_sell,
      record.orderSide,
      record.order_side,
      record.orderType,
      record.order_type,
      record.eventType,
      record.event_type,
      record.kind,
      record.typeName,
      record.type_name,
      record.action,
    ) ?? normalizeXxyyBooleanTradeSide(record);
  const usdAmount = firstXxyyTradeString(
    record.usdAmount,
    record.usd_amount,
    record.amountUsd,
    record.amount_usd,
    record.amountUSD,
    record.valueUsd,
    record.value_usd,
    record.valueUSD,
  );
  if (
    maker === undefined ||
    !isXxyyTradeTimestamp(timestamp) ||
    txHash === undefined ||
    type === undefined
  ) {
    return undefined;
  }

  return {
    maker,
    ...(nativeAmount === undefined ? {} : { nativeAmount }),
    ...(poolAddress === undefined ? {} : { poolAddress }),
    ...(priceUsd === undefined ? {} : { priceUsd }),
    timestamp,
    ...(tokenAmount === undefined ? {} : { tokenAmount }),
    txHash: normalizeXxyyTransactionHash(txHash),
    type,
    ...(usdAmount === undefined ? {} : { usdAmount }),
  };
}

function nestedXxyyAddressValue(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return normalizeXxyyPoolAddress(
    record.address,
    record.poolAddress,
    record.pool_address,
    record.poolAddr,
    record.pool_addr,
    record.poolId,
    record.pool_id,
    record.poolID,
    record.poolContract,
    record.pool_contract,
    record.poolUrl,
    record.pool_url,
    record.poolLink,
    record.pool_link,
    record.pairAddress,
    record.pair_address,
    record.pairAddr,
    record.pair_addr,
    record.pairId,
    record.pair_id,
    record.pairID,
    record.pairContract,
    record.pair_contract,
    record.pairUrl,
    record.pair_url,
    record.pairLink,
    record.pair_link,
    record.marketAddress,
    record.market_address,
    record.marketAddr,
    record.market_addr,
    record.marketId,
    record.market_id,
    record.marketID,
    record.marketContract,
    record.market_contract,
    record.marketUrl,
    record.market_url,
    record.marketLink,
    record.market_link,
    record.ammId,
    record.amm_id,
    record.ammID,
    record.ammContract,
    record.amm_contract,
    record.ammAddress,
    record.amm_address,
    record.ammAddr,
    record.amm_addr,
    record.ammUrl,
    record.amm_url,
    record.ammLink,
    record.amm_link,
    record.lpAddress,
    record.lp_address,
    record.lpAddr,
    record.lp_addr,
    record.lpId,
    record.lp_id,
    record.lpID,
    record.lpContract,
    record.lp_contract,
    record.liquidityPoolAddress,
    record.liquidity_pool_address,
    record.liquidityPoolAddr,
    record.liquidity_pool_addr,
    record.liquidityPoolId,
    record.liquidity_pool_id,
    record.liquidityPoolID,
    record.liquidityPoolContract,
    record.liquidity_pool_contract,
    record.lpUrl,
    record.lp_url,
    record.lpLink,
    record.lp_link,
    record.url,
    record.link,
  );
}

function normalizeXxyyPoolAddress(...values: unknown[]): string | undefined {
  const value = firstXxyyTradeString(...values);
  if (value === undefined) {
    return undefined;
  }

  const evmAddress = /\b0x[a-fA-F0-9]{40}\b/iu.exec(value)?.[0];
  if (evmAddress !== undefined) {
    return evmAddress.toLowerCase();
  }

  try {
    const pathSegments = new URL(value).pathname.split('/').filter(Boolean);
    return pathSegments[pathSegments.length - 1] ?? value;
  } catch {
    return value;
  }
}

function normalizeXxyyTraderAddress(...values: unknown[]): string | undefined {
  const value = firstXxyyTradeString(...values);
  if (value === undefined) {
    return undefined;
  }

  try {
    const pathSegments = new URL(value).pathname.split('/').filter(Boolean);
    return pathSegments[pathSegments.length - 1] ?? value;
  } catch {
    return value;
  }
}

function nestedXxyyTraderAddressValue(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return normalizeXxyyTraderAddress(
    record.address,
    record.url,
    record.link,
    record.accountAddress,
    record.account_address,
    record.accountAddr,
    record.account_addr,
    record.accountWallet,
    record.account_wallet,
    record.accountUrl,
    record.account_url,
    record.accountLink,
    record.account_link,
    record.makerAddress,
    record.maker_address,
    record.makerAddr,
    record.maker_addr,
    record.makerWallet,
    record.maker_wallet,
    record.makerUrl,
    record.maker_url,
    record.makerLink,
    record.maker_link,
    record.traderAddress,
    record.trader_address,
    record.traderAddr,
    record.trader_addr,
    record.traderWallet,
    record.trader_wallet,
    record.traderUrl,
    record.trader_url,
    record.traderLink,
    record.trader_link,
    record.takerAddress,
    record.taker_address,
    record.takerAddr,
    record.taker_addr,
    record.takerWallet,
    record.taker_wallet,
    record.takerUrl,
    record.taker_url,
    record.takerLink,
    record.taker_link,
    record.signerAddress,
    record.signer_address,
    record.signerAddr,
    record.signer_addr,
    record.signerWallet,
    record.signer_wallet,
    record.signerUrl,
    record.signer_url,
    record.signerLink,
    record.signer_link,
    record.ownerAddress,
    record.owner_address,
    record.ownerAddr,
    record.owner_addr,
    record.ownerWallet,
    record.owner_wallet,
    record.ownerUrl,
    record.owner_url,
    record.ownerLink,
    record.owner_link,
    record.senderAddress,
    record.sender_address,
    record.senderAddr,
    record.sender_addr,
    record.senderWallet,
    record.sender_wallet,
    record.senderUrl,
    record.sender_url,
    record.senderLink,
    record.sender_link,
    record.initiatorAddress,
    record.initiator_address,
    record.initiatorAddr,
    record.initiator_addr,
    record.initiatorWallet,
    record.initiator_wallet,
    record.initiatorUrl,
    record.initiator_url,
    record.initiatorLink,
    record.initiator_link,
    record.fromAddress,
    record.from_address,
    record.fromAddr,
    record.from_addr,
    record.fromWallet,
    record.from_wallet,
    record.fromUrl,
    record.from_url,
    record.fromLink,
    record.from_link,
    record.payerAddress,
    record.payer_address,
    record.payerAddr,
    record.payer_addr,
    record.payerWallet,
    record.payer_wallet,
    record.payerUrl,
    record.payer_url,
    record.payerLink,
    record.payer_link,
    record.feePayerAddress,
    record.fee_payer_address,
    record.feePayerAddr,
    record.fee_payer_addr,
    record.feePayerWallet,
    record.fee_payer_wallet,
    record.feePayerUrl,
    record.fee_payer_url,
    record.feePayerLink,
    record.fee_payer_link,
    record.walletAddress,
    record.wallet_address,
    record.walletAddr,
    record.wallet_addr,
    record.walletUrl,
    record.wallet_url,
    record.walletLink,
    record.wallet_link,
    record.userAddress,
    record.user_address,
    record.userAddr,
    record.user_addr,
    record.userWallet,
    record.user_wallet,
    record.userUrl,
    record.user_url,
    record.userLink,
    record.user_link,
  );
}

function nestedXxyyTransactionHashValue(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return firstXxyyTradeString(
    record.txHash,
    record.tx_hash,
    record.txHashUrl,
    record.tx_hash_url,
    record.txHashLink,
    record.tx_hash_link,
    record.txHashHref,
    record.tx_hash_href,
    record.txId,
    record.tx_id,
    record.txid,
    record.txID,
    record.txSignature,
    record.tx_signature,
    record.txUrl,
    record.tx_url,
    record.txLink,
    record.tx_link,
    record.txHref,
    record.tx_href,
    record.transactionHash,
    record.transaction_hash,
    record.transactionHashUrl,
    record.transaction_hash_url,
    record.transactionHashLink,
    record.transaction_hash_link,
    record.transactionHashHref,
    record.transaction_hash_href,
    record.transactionId,
    record.transaction_id,
    record.transactionID,
    record.transactionSignature,
    record.transaction_signature,
    record.transactionUrl,
    record.transaction_url,
    record.transactionLink,
    record.transaction_link,
    record.transactionHref,
    record.transaction_href,
    record.txnHash,
    record.txn_hash,
    record.txnHashUrl,
    record.txn_hash_url,
    record.txnHashLink,
    record.txn_hash_link,
    record.txnHashHref,
    record.txn_hash_href,
    record.txnId,
    record.txn_id,
    record.txnID,
    record.txnSignature,
    record.txn_signature,
    record.txnUrl,
    record.txn_url,
    record.txnLink,
    record.txn_link,
    record.txnHref,
    record.txn_href,
    record.signature,
    record.signatureHash,
    record.signature_hash,
    record.signatureHashUrl,
    record.signature_hash_url,
    record.signatureHashLink,
    record.signature_hash_link,
    record.signatureHashHref,
    record.signature_hash_href,
    record.signatureId,
    record.signature_id,
    record.signatureID,
    record.signatureUrl,
    record.signature_url,
    record.signatureLink,
    record.signature_link,
    record.signatureHref,
    record.signature_href,
    record.explorer,
    nestedXxyyTransactionHashValue(record.explorer),
    record.explorerUrl,
    record.explorer_url,
    record.explorerLink,
    record.explorer_link,
    record.explorerHref,
    record.explorer_href,
    record.scan,
    nestedXxyyTransactionHashValue(record.scan),
    record.scanUrl,
    record.scan_url,
    record.scanLink,
    record.scan_link,
    record.scanHref,
    record.scan_href,
    record.blockExplorer,
    nestedXxyyTransactionHashValue(record.blockExplorer),
    record.block_explorer,
    nestedXxyyTransactionHashValue(record.block_explorer),
    record.blockExplorerUrl,
    record.block_explorer_url,
    record.blockExplorerLink,
    record.block_explorer_link,
    record.blockExplorerHref,
    record.block_explorer_href,
    record.hashUrl,
    record.hash_url,
    record.hashLink,
    record.hash_link,
    record.hashHref,
    record.hash_href,
    record.idUrl,
    record.id_url,
    record.idLink,
    record.id_link,
    record.idHref,
    record.id_href,
    record.url,
    record.link,
    record.href,
    record.hash,
    record.id,
  );
}

function toWindowTrade(line: string, index: number): BrowserTxTrade {
  return {
    hash: `xxyy-window-${index + 1}`,
    side: /卖出|Sell|sell/u.test(line) ? 'sell' : /买入|Buy|buy/u.test(line) ? 'buy' : 'unknown',
    summary: line,
  };
}

function toBrowserTrade(record: XxyyTradeRecord, nativeSymbol = 'SOL'): BrowserTxTrade {
  const timestamp = xxyyTradeTimestampIso(record.timestamp);
  return {
    hash: normalizeXxyyTransactionHash(record.txHash),
    side: toBrowserTradeSide(record.type),
    summary: formatXxyyTradeSummary(record, nativeSymbol),
    ...(record.poolAddress === undefined ? {} : { poolAddress: record.poolAddress }),
    ...(timestamp === undefined ? {} : { timestamp }),
    traderAddress: record.maker,
  };
}

function isXxyyTradeTimestamp(value: unknown): value is number | string {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && xxyyTradeTimestampMs(value) !== undefined)
  );
}

function firstXxyyTradeString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function firstDefinedXxyyTradeValue(...values: unknown[]): unknown {
  return values.find(
    (value) =>
      value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== ''),
  );
}

function xxyyTradeTimestampIso(value: number | string): string | undefined {
  const timestamp = xxyyTradeTimestampMs(value);
  if (timestamp === undefined) {
    return undefined;
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function xxyyTradeTimestampMs(value: number | string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? normalizeXxyyTimestampUnit(value) : undefined;
  }

  const trimmed = value.trim();
  const timestamp = /^\d+(?:\.\d+)?$/u.test(trimmed)
    ? normalizeXxyyTimestampUnit(Number(trimmed))
    : Date.parse(trimmed);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeXxyyTimestampUnit(timestamp: number): number {
  return timestamp >= 1_000_000_000 && timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
}

function toBrowserTradeSide(side: string): BrowserTradeSide {
  return normalizeXxyyTradeSideText(side) ?? 'unknown';
}

function normalizeXxyyTradeSide(...values: unknown[]): string | undefined {
  const value = firstXxyyTradeString(...values);
  if (value === undefined) {
    return undefined;
  }
  return normalizeXxyyTradeSideText(value) ?? value;
}

function normalizeXxyyTradeSideText(value: string): BrowserTradeSide | undefined {
  const normalized = value.replace(/[_-]+/gu, ' ');
  const isBuy =
    /(?:^|[^a-z0-9])(?:buy|buying|bought|bid|b)(?:[^a-z0-9]|$)/iu.test(normalized) ||
    /买入|买进|买/u.test(value);
  const isSell =
    /(?:^|[^a-z0-9])(?:sell|selling|sold|ask|s)(?:[^a-z0-9]|$)/iu.test(normalized) ||
    /卖出|卖/u.test(value);
  if (isBuy === isSell) {
    return undefined;
  }

  return isBuy ? 'buy' : 'sell';
}

function normalizeXxyyBooleanTradeSide(record: Record<string, unknown>): string | undefined {
  const buyFlags = [
    record.isBuy,
    record.is_buy,
    record.buy,
    record.isBuyer,
    record.is_buyer,
    record.buyer,
  ];
  const sellFlags = [
    record.isSell,
    record.is_sell,
    record.sell,
    record.isSeller,
    record.is_seller,
    record.seller,
  ];
  const impliesBuy = buyFlags.some(isTruthyXxyyTradeFlag) || sellFlags.some(isFalseyXxyyTradeFlag);
  const impliesSell = sellFlags.some(isTruthyXxyyTradeFlag) || buyFlags.some(isFalseyXxyyTradeFlag);
  if (impliesBuy === impliesSell) {
    return undefined;
  }

  return impliesBuy ? 'buy' : 'sell';
}

function isTruthyXxyyTradeFlag(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    (typeof value === 'string' && /^(?:true|1|yes)$/iu.test(value.trim()))
  );
}

function isFalseyXxyyTradeFlag(value: unknown): boolean {
  return (
    value === false ||
    value === 0 ||
    (typeof value === 'string' && /^(?:false|0|no)$/iu.test(value.trim()))
  );
}

function formatXxyyTradeSummary(record: XxyyTradeRecord, nativeSymbol: string): string {
  const amountDetails = [
    record.usdAmount === undefined ? undefined : `$${record.usdAmount}`,
    record.tokenAmount === undefined ? undefined : `${record.tokenAmount} token`,
    record.nativeAmount === undefined ? undefined : `${record.nativeAmount} ${nativeSymbol}`,
  ].filter((item): item is string => item !== undefined);

  return [`XXYY ${record.type}`, ...amountDetails].join(' ');
}

function evmNativeSymbol(chain: BrowserEvmChain): string {
  switch (chain) {
    case 'base':
    case 'ethereum':
      return 'ETH';
    case 'bsc':
      return 'BNB';
  }
}

function createSolscanFallbackTargetTrade(
  txHash: string,
  solscan: SolscanExtraction,
): BrowserTxTrade {
  return {
    hash: txHash,
    side: solscan.side,
    summary: `Solscan signer ${solscan.signerAddress ?? 'unknown'}`,
    ...(solscan.transactionTime === undefined ? {} : { timestamp: solscan.transactionTime }),
    ...(solscan.signerAddress === undefined ? {} : { traderAddress: solscan.signerAddress }),
  };
}

function createEvmFallbackTargetTrade(
  txHash: string,
  explorer: EvmExplorerExtraction,
): BrowserTxTrade {
  return {
    hash: txHash,
    side: explorer.side,
    summary: `${evmExplorerName(explorer.chain)} signer ${explorer.signerAddress ?? 'unknown'}`,
    ...(explorer.transactionTime === undefined ? {} : { timestamp: explorer.transactionTime }),
    ...(explorer.signerAddress === undefined ? {} : { traderAddress: explorer.signerAddress }),
  };
}

async function findMatchingSearchItem(
  items: Locator[],
  poolAddress: string | undefined,
  options: { allowFirstOnMismatch?: boolean } = {},
) {
  const firstItem = items[0];
  if (firstItem === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      'XXYY 搜索结果为空，无法定位池子页面。',
      'pool_not_found',
    );
  }

  const candidates = await Promise.all(
    items.map(async (item) => ({
      text: await item.innerText().catch(() => ''),
    })),
  );
  const index = selectMatchingSearchItemIndex(candidates, poolAddress);
  if (index < 0) {
    if (options.allowFirstOnMismatch === true) {
      return { item: firstItem, matchedPoolAddress: false };
    }

    throw new TxAnalysisProviderUnavailableError(
      `XXYY 搜索结果未匹配到交易浏览器交易池子：${poolAddress}`,
      'pool_not_found',
    );
  }

  return { item: items[index] ?? firstItem, matchedPoolAddress: true };
}

export function selectMatchingSearchItemIndex(
  candidates: SearchItemCandidate[],
  poolAddress: string | undefined,
): number {
  if (candidates.length === 0) {
    return -1;
  }

  if (poolAddress === undefined) {
    return 0;
  }

  const needles = createAddressSearchNeedles(poolAddress);
  const index = candidates.findIndex((candidate) =>
    needles.some((needle) => candidate.text.toLowerCase().includes(needle)),
  );
  return index >= 0 ? index : -1;
}

function createAddressSearchNeedles(address: string): string[] {
  const prefixLengths = address.startsWith('0x') ? [4, 5, 6, 8] : [4];
  return Array.from(
    new Set(
      [
        address,
        abbreviateAddress(address),
        ...prefixLengths
          .filter((prefixLength) => address.length > prefixLength + 4)
          .flatMap((prefixLength) => abbreviatedHashNeedles(address, prefixLength, 4)),
      ].map((needle) => needle.toLowerCase()),
    ),
  );
}

async function setSearchInputValue(input: Locator, value: string): Promise<void> {
  await input.evaluate<void, string>((element, query) => {
    const browserGlobal = globalThis as unknown as BrowserGlobalLike;
    const inputElement = element as unknown as BrowserInputElementLike;
    inputElement.focus();

    const descriptor = Object.getOwnPropertyDescriptor(
      browserGlobal.HTMLInputElement.prototype,
      'value',
    );
    if (typeof descriptor?.set !== 'function') {
      inputElement.value = query;
    } else {
      const setNativeInputValue = descriptor.set.bind(inputElement) as (nextValue: string) => void;
      setNativeInputValue(query);
    }

    inputElement.dispatchEvent(new browserGlobal.Event('input', { bubbles: true }));
    inputElement.dispatchEvent(new browserGlobal.Event('change', { bubbles: true }));
  }, value);
}

async function dispatchSearchItemClick(item: Locator): Promise<void> {
  await item.evaluate<void>((element) => {
    const browserGlobal = globalThis as unknown as BrowserGlobalLike;
    const clickableElement = element as unknown as BrowserElementLike;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      clickableElement.dispatchEvent(
        new browserGlobal.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: browserGlobal,
        }),
      );
    }
  });
}

async function screenshotPage(
  page: Page,
  solscan: XxyyTradeContext,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
  tradeWindow?: XxyyTradeWindow,
): Promise<string | undefined> {
  const screenshotDir = resolveScreenshotDir(options);
  await mkdir(screenshotDir, { recursive: true });
  const fileName = `tx-analysis-${createHash('sha256')
    .update(solscan.solscanUrl)
    .digest('hex')
    .slice(0, 16)}.png`;
  const filePath = path.join(screenshotDir, fileName);
  if (tradeWindow !== undefined) {
    const capturedOriginalTradeList = await screenshotXxyyOriginalTradeList(
      page,
      tradeWindow,
      filePath,
      options,
    )
      .then(() => true)
      .catch(() => false);
    if (capturedOriginalTradeList) {
      return `${options.screenshotBaseUrl ?? '/assets'}/${fileName}`;
    }

    return undefined;
  }

  await page.screenshot({ fullPage: true, path: filePath });

  return `${options.screenshotBaseUrl ?? '/assets'}/${fileName}`;
}

async function screenshotXxyyOriginalTradeList(
  page: Page,
  tradeWindow: XxyyTradeWindow,
  filePath: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<void> {
  await expandViewportForXxyyOriginalTradeListScreenshot(page);
  await filterXxyyOriginalTradeListForTarget(page, tradeWindow, options);
  const position = await scrollXxyyOriginalTradeListToTarget(page, tradeWindow, options);
  if (position === undefined) {
    throw new Error('Unable to position XXYY original trade list on target transaction');
  }

  const marked = await markXxyyOriginalTargetTradeRow(page, tradeWindow.targetTrade.hash, position);
  if (!marked) {
    throw new Error('Unable to mark target transaction row in XXYY original trade list');
  }

  await page.locator(createXxyyOriginalTradeListContainerSelector()).first().screenshot({
    path: filePath,
  });
}

async function filterXxyyOriginalTradeListForTarget(
  page: Page,
  tradeWindow: XxyyTradeWindow,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<void> {
  let applied = false;
  const targetTimestampMs =
    tradeWindow.targetTrade.timestamp === undefined
      ? undefined
      : Date.parse(tradeWindow.targetTrade.timestamp);
  if (targetTimestampMs !== undefined && Number.isFinite(targetTimestampMs)) {
    applied =
      (await applyXxyyOriginalTradeTimeFilter(page, targetTimestampMs, options).catch(
        () => false,
      )) || applied;
  }

  const targetTraderAddress = tradeWindow.targetTrade.traderAddress?.trim();
  if (targetTraderAddress !== undefined && targetTraderAddress.length > 0) {
    applied =
      (await applyXxyyOriginalTraderFilter(page, targetTraderAddress, options).catch(
        () => false,
      )) || applied;
  }

  if (applied) {
    await page.waitForTimeout(1500);
  }
}

async function applyXxyyOriginalTradeTimeFilter(
  page: Page,
  targetTimestampMs: number,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<boolean> {
  const range = createXxyyOriginalTradeTimeFilterRange(targetTimestampMs);
  await clickOptionalXxyyOriginalFilter(page, '#btn-filterTradeTimePopup', options);
  await setXxyyOriginalInputValue(
    page,
    '#popup-filterTradeTimePopup input[placeholder=开始时间]',
    range.start,
  );
  await setXxyyOriginalInputValue(
    page,
    '#popup-filterTradeTimePopup input[placeholder=结束时间]',
    range.end,
  );
  await confirmXxyyOriginalFilterPopup(page, '#popup-filterTradeTimePopup', options);

  return true;
}

async function applyXxyyOriginalTraderFilter(
  page: Page,
  targetTraderAddress: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<boolean> {
  await clickOptionalXxyyOriginalFilter(page, '#btn-filterTraderPopup', options);
  await setXxyyOriginalInputValue(
    page,
    '#popup-filterTraderPopup input[placeholder=钱包地址]',
    targetTraderAddress,
  );
  await confirmXxyyOriginalFilterPopup(page, '#popup-filterTraderPopup', options);

  return true;
}

async function clickOptionalXxyyOriginalFilter(
  page: Page,
  selector: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<void> {
  await page.locator(selector).click({
    force: true,
    timeout: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5000),
  });
  await page.waitForTimeout(300);
}

async function confirmXxyyOriginalFilterPopup(
  page: Page,
  popupSelector: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<void> {
  await page
    .locator(popupSelector)
    .getByText('确定', { exact: true })
    .click({
      force: true,
      timeout: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 5000),
    });
  await page.waitForTimeout(800);
}

async function setXxyyOriginalInputValue(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  const input = page.locator(selector).first();
  await input.evaluate<void, string>((element, inputValue) => {
    const browserGlobal = globalThis as unknown as BrowserGlobalLike;
    const inputElement = element as unknown as BrowserInputElementLike;
    inputElement.focus();

    const descriptor = Object.getOwnPropertyDescriptor(
      browserGlobal.HTMLInputElement.prototype,
      'value',
    );
    if (typeof descriptor?.set !== 'function') {
      inputElement.value = inputValue;
    } else {
      const setNativeInputValue = descriptor.set.bind(inputElement) as (nextValue: string) => void;
      setNativeInputValue(inputValue);
    }

    inputElement.dispatchEvent(new browserGlobal.Event('input', { bubbles: true }));
    inputElement.dispatchEvent(new browserGlobal.Event('change', { bubbles: true }));
    inputElement.dispatchEvent(new browserGlobal.Event('blur', { bubbles: true }));
  }, value);
}

function createXxyyOriginalTradeTimeFilterRange(targetTimestampMs: number): {
  end: string;
  start: string;
} {
  return {
    end: formatXxyyOriginalFilterDateTime(targetTimestampMs + 30_000),
    start: formatXxyyOriginalFilterDateTime(targetTimestampMs - 30_000),
  };
}

function formatXxyyOriginalFilterDateTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ');
}

async function expandViewportForXxyyOriginalTradeListScreenshot(page: Page): Promise<void> {
  const current = page.viewportSize();
  const width = Math.max(current?.width ?? 0, XXYY_ORIGINAL_SCREENSHOT_MIN_WIDTH);
  const height = Math.max(current?.height ?? 0, XXYY_ORIGINAL_SCREENSHOT_MIN_HEIGHT);
  if (current?.width === width && current.height === height) {
    return;
  }

  await page.setViewportSize({ height, width });
  await page.waitForTimeout(500);
}

async function scrollXxyyOriginalTradeListToTarget(
  page: Page,
  tradeWindow: XxyyTradeWindow,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<XxyyOriginalTradeListTargetPosition | undefined> {
  const targetTimestamp =
    tradeWindow.targetTrade.timestamp === undefined
      ? undefined
      : Date.parse(tradeWindow.targetTrade.timestamp);
  const scrollerSelectors = xxyyOriginalTradeScrollerSelectors();
  const scrollerSelector = createXxyyOriginalTradeScrollerSelector();
  await page
    .locator(scrollerSelector)
    .first()
    .waitFor({
      state: 'visible',
      timeout: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15000),
    });

  const metrics = await readXxyyOriginalScrollerMetrics(page, scrollerSelectors);
  const initialPosition = calculateInitialXxyyOriginalTargetPosition({
    afterTradeCount: tradeWindow.tradeWindow.after.length,
    clientHeight: metrics.clientHeight,
    rowHeight: metrics.rowHeight,
    scrollTop: metrics.scrollTop,
  });
  if (initialPosition !== undefined) {
    return initialPosition;
  }

  const visiblePosition = await findVisibleXxyyOriginalTargetPosition(
    page,
    tradeWindow,
    scrollerSelectors,
  );
  if (visiblePosition !== undefined) {
    return visiblePosition;
  }

  let seenRows = metrics.loadedRows;
  let targetIndex = -1;
  let lastTimestamp = Number.POSITIVE_INFINITY;

  const responseListener = async (response: { json(): Promise<unknown>; url(): string }) => {
    if (!response.url().includes('/api/data/trades/search')) {
      return;
    }

    const body = await response.json().catch(() => undefined);
    const rows = extractXxyyResponseTradeRows(body);
    if (rows.length === 0) {
      return;
    }

    const startIndex = seenRows;
    const foundIndex = rows.findIndex((row) =>
      xxyyTransactionHashMatches(row.txHash, tradeWindow.targetTrade.hash),
    );
    if (foundIndex >= 0) {
      targetIndex = startIndex + foundIndex;
    }

    seenRows += rows.length;
    lastTimestamp = xxyyTradeTimestampMs(rows.at(-1)?.timestamp) ?? lastTimestamp;
  };

  page.on('response', responseListener);
  try {
    for (let attempt = 0; attempt < 80 && targetIndex < 0; attempt += 1) {
      if (targetTimestamp !== undefined && lastTimestamp <= targetTimestamp) {
        break;
      }

      const responsePromise = page
        .waitForResponse((response) => response.url().includes('/api/data/trades/search'), {
          timeout: 6000,
        })
        .catch(() => undefined);
      await scrollXxyyOriginalTradeListToBottom(page, scrollerSelectors);
      await responsePromise;
      await page.waitForTimeout(200);
    }
  } finally {
    page.off('response', responseListener);
  }

  if (targetIndex < 0) {
    return undefined;
  }

  const latestMetrics = await readXxyyOriginalScrollerMetrics(page, scrollerSelectors);
  await scrollXxyyOriginalTradeListTo(page, scrollerSelectors, {
    scrollTop: calculateXxyyOriginalTradeScrollTop({
      clientHeight: latestMetrics.clientHeight,
      rowHeight: latestMetrics.rowHeight,
      targetIndex,
    }),
  });
  await page.waitForTimeout(800);

  const positionedMetrics = await readXxyyOriginalScrollerMetrics(page, scrollerSelectors);
  return {
    rowHeight: positionedMetrics.rowHeight,
    targetIndex,
    targetRowY: calculateXxyyOriginalTargetRowY({
      rowHeight: positionedMetrics.rowHeight,
      scrollTop: positionedMetrics.scrollTop,
      targetIndex,
    }),
  };
}

async function findVisibleXxyyOriginalTargetPosition(
  page: Page,
  tradeWindow: XxyyTradeWindow,
  scrollerSelectors: string[],
): Promise<XxyyOriginalTradeListTargetPosition | undefined> {
  const targetTimestamp =
    tradeWindow.targetTrade.timestamp === undefined
      ? undefined
      : Date.parse(tradeWindow.targetTrade.timestamp);
  if (targetTimestamp === undefined || !Number.isFinite(targetTimestamp)) {
    return undefined;
  }

  const targetTraderAddress = tradeWindow.targetTrade.traderAddress?.trim();
  const payload = {
    rowSelectors: xxyyOriginalTradeRowSelectors(),
    scrollerSelectors,
    targetSide: tradeWindow.targetTrade.side,
    targetTimeText: formatXxyyOriginalVisibleTradeTime(targetTimestamp),
    targetTraderNeedle:
      targetTraderAddress === undefined || targetTraderAddress.length === 0
        ? undefined
        : targetTraderAddress.slice(-6),
  };
  const position = await page.evaluate<unknown>(
    `(() => {
      const payload = ${JSON.stringify(payload)};
      const scroller = payload.scrollerSelectors
        .map((selector) => document.querySelector(selector))
        .find((candidate) => candidate instanceof HTMLElement);
      if (!(scroller instanceof HTMLElement)) {
        return undefined;
      }

      const scrollerRect = scroller.getBoundingClientRect();
      const seenRows = new Set();
      const rows = [];
      for (const selector of payload.rowSelectors) {
        for (const row of scroller.querySelectorAll(selector)) {
          if (!seenRows.has(row)) {
            seenRows.add(row);
            rows.push(row);
          }
        }
      }

      const sideText = payload.targetSide === 'buy' ? 'Buy' : payload.targetSide === 'sell' ? 'Sell' : undefined;
      const candidates = [];
      for (const row of rows) {
        if (!(row instanceof HTMLElement)) {
          continue;
        }
        const rect = row.getBoundingClientRect();
        if (rect.bottom < scrollerRect.top || rect.top > scrollerRect.bottom) {
          continue;
        }

        const text = (row.innerText || row.textContent || '').replace(/\\s+/gu, ' ');
        if (!text.includes(payload.targetTimeText)) {
          continue;
        }
        if (sideText !== undefined && !text.includes(sideText)) {
          continue;
        }
        if (payload.targetTraderNeedle !== undefined && !text.includes(payload.targetTraderNeedle)) {
          continue;
        }

        const rowHeight = rect.height > 0 ? rect.height : 40;
        const targetRowY = rect.top + rect.height / 2 - scrollerRect.top;
        candidates.push({
          rowHeight,
          rowTop: rect.top,
          targetIndex: Math.max(0, Math.round((scroller.scrollTop + targetRowY - rowHeight / 2) / rowHeight)),
          targetRowY,
        });
      }

      candidates.sort((left, right) => left.rowTop - right.rowTop);
      return candidates[0];
    })()`,
  );

  if (position === undefined || position === null || typeof position !== 'object') {
    return undefined;
  }

  const record = position as Record<string, unknown>;
  const rowHeight =
    typeof record.rowHeight === 'number' && record.rowHeight > 0 ? record.rowHeight : 40;
  const targetIndex =
    typeof record.targetIndex === 'number' && record.targetIndex >= 0
      ? Math.round(record.targetIndex)
      : 0;
  const targetRowY =
    typeof record.targetRowY === 'number' && Number.isFinite(record.targetRowY)
      ? record.targetRowY
      : undefined;
  if (targetRowY === undefined) {
    return undefined;
  }

  return { rowHeight, targetIndex, targetRowY };
}

function formatXxyyOriginalVisibleTradeTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

async function readXxyyOriginalScrollerMetrics(
  page: Page,
  scrollerSelectors: string[],
): Promise<{ clientHeight: number; loadedRows: number; rowHeight: number; scrollTop: number }> {
  const metrics = await page.evaluate<unknown>(
    `(() => {
      const scroller = ${xxyyOriginalScrollerFinderScript(JSON.stringify(scrollerSelectors))};
      if (!(scroller instanceof HTMLElement)) {
        return { clientHeight: 0, loadedRows: 0, rowHeight: 40 };
      }

      const firstRow = scroller.querySelector(${JSON.stringify(createXxyyOriginalMetricRowSelector())});
      const rowHeight = firstRow instanceof HTMLElement ? firstRow.getBoundingClientRect().height : 40;
      const safeRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 40;
      return {
        clientHeight: scroller.clientHeight,
        loadedRows: Math.max(0, Math.round(scroller.scrollHeight / safeRowHeight)),
        rowHeight: safeRowHeight,
        scrollTop: scroller.scrollTop,
      };
    })()`,
  );

  if (metrics === null || typeof metrics !== 'object') {
    return { clientHeight: 0, loadedRows: 0, rowHeight: 40, scrollTop: 0 };
  }

  const record = metrics as Record<string, unknown>;
  return {
    clientHeight: typeof record.clientHeight === 'number' ? record.clientHeight : 0,
    loadedRows: typeof record.loadedRows === 'number' ? record.loadedRows : 0,
    rowHeight: typeof record.rowHeight === 'number' && record.rowHeight > 0 ? record.rowHeight : 40,
    scrollTop: typeof record.scrollTop === 'number' ? record.scrollTop : 0,
  };
}

function xxyyOriginalScrollerFinderScript(selectorsJson: string): string {
  return `(${selectorsJson})
        .map((selector) => document.querySelector(selector))
        .find((candidate) => candidate instanceof HTMLElement)`;
}

async function scrollXxyyOriginalTradeListToBottom(
  page: Page,
  scrollerSelectors: string[],
): Promise<void> {
  await page.evaluate<void>(
    `(() => {
      const scroller = ${xxyyOriginalScrollerFinderScript(JSON.stringify(scrollerSelectors))};
      if (scroller instanceof HTMLElement) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    })()`,
  );
}

async function scrollXxyyOriginalTradeListTo(
  page: Page,
  scrollerSelectors: string[],
  input: { scrollTop: number },
): Promise<void> {
  await page.evaluate<void>(
    `(() => {
      const scroller = ${xxyyOriginalScrollerFinderScript(JSON.stringify(scrollerSelectors))};
      if (scroller instanceof HTMLElement) {
        scroller.scrollTop = ${JSON.stringify(input.scrollTop)};
      }
    })()`,
  );
}

async function markXxyyOriginalTargetTradeRow(
  page: Page,
  targetTxHash: string,
  position: XxyyOriginalTradeListTargetPosition,
): Promise<boolean> {
  const payload = {
    rowHeight: position.rowHeight,
    scrollerSelectors: xxyyOriginalTradeScrollerSelectors(),
    rowSelectors: xxyyOriginalTradeRowSelectors(),
    targetHashCaseInsensitive: isCaseInsensitiveXxyyTargetHash(targetTxHash),
    targetHashNeedles: createXxyyTargetHashNeedles(targetTxHash),
    targetRowY: position.targetRowY,
  };

  return page.evaluate<boolean>(`
    (() => {
      const payload = ${JSON.stringify(payload)};
      const scroller = payload.scrollerSelectors
        .map((selector) => document.querySelector(selector))
        .find((candidate) => candidate instanceof HTMLElement);
      if (!(scroller instanceof HTMLElement)) {
        return false;
      }

      let style = document.querySelector('#xxyy-target-trade-marker-style');
      if (!(style instanceof HTMLStyleElement)) {
        style = document.createElement('style');
        style.id = 'xxyy-target-trade-marker-style';
        style.textContent = \`
          .xxyy-target-trade-marker {
            background: rgba(250, 204, 21, 0.12) !important;
            box-shadow:
              inset 0 0 0 9999px rgba(250, 204, 21, 0.08),
              inset 0 0 0 3px #facc15,
              0 0 0 2px rgba(17, 24, 39, 0.85) !important;
            outline: 3px solid #facc15 !important;
            outline-offset: -3px !important;
            position: relative !important;
            z-index: 20 !important;
          }
        \`;
        document.head.appendChild(style);
      }

      for (const row of document.querySelectorAll('.xxyy-target-trade-marker')) {
        row.classList.remove('xxyy-target-trade-marker');
      }

      const scrollerRect = scroller.getBoundingClientRect();
      const targetY = scrollerRect.top + payload.targetRowY;
      const seenRows = new Set();
      const rows = [];
      for (const selector of payload.rowSelectors) {
        for (const row of scroller.querySelectorAll(selector)) {
          if (!seenRows.has(row)) {
            seenRows.add(row);
            rows.push(row);
          }
        }
      }
      const candidates = [];
      const attributeNames = ${JSON.stringify(createXxyyOriginalTargetRowAttributeNames())};
      const decodeRowSearchValue = (value) => {
        const decodedValues = new Set();
        if (value.includes('+')) {
          const formEncodedValue = value.replace(/\\+/gu, ' ');
          decodedValues.add(formEncodedValue);
        }
        if (/%[0-9a-fA-F]{2}/u.test(value)) {
          try {
            decodedValues.add(decodeURIComponent(value));
          } catch {
            // Ignore malformed encoded values and keep the raw haystack.
          }
        }
        for (const candidate of Array.from(decodedValues)) {
          if (!/%[0-9a-fA-F]{2}/u.test(candidate)) {
            continue;
          }
          try {
            decodedValues.add(decodeURIComponent(candidate));
          } catch {
            // Ignore malformed encoded values and keep the other candidates.
          }
        }
        decodedValues.delete(value);
        return Array.from(decodedValues);
      };

      for (const row of rows) {
        if (!(row instanceof HTMLElement)) {
          continue;
        }

        const rect = row.getBoundingClientRect();
        if (rect.bottom < scrollerRect.top || rect.top > scrollerRect.bottom) {
          continue;
        }

        const distance = Math.abs(rect.top + rect.height / 2 - targetY);
        const hrefs = Array.from(row.querySelectorAll('a[href]'))
          .map((anchor) => anchor instanceof HTMLAnchorElement ? anchor.href : '')
          .filter(Boolean);
        const attributeValues = [];
        const attributeNameSet = new Set(attributeNames);
        const shouldCollectAttributeName = (name) =>
          attributeNameSet.has(name) || /^data-[a-z0-9_:-]+$/iu.test(name);
        for (const element of [row, ...Array.from(row.querySelectorAll('*'))]) {
          if (!(element instanceof Element)) {
            continue;
          }
          for (const name of element.getAttributeNames().filter(shouldCollectAttributeName)) {
            const value = element.getAttribute(name);
            if (value !== null && value.trim().length > 0) {
              attributeValues.push(value);
            }
          }
          for (const referenceAttribute of ['aria-describedby', 'aria-labelledby']) {
            const referenceValue = element.getAttribute(referenceAttribute);
            if (referenceValue === null) {
              continue;
            }
            for (const referenceId of referenceValue.split(/\\s+/u).filter(Boolean)) {
              const referencedElement = document.getElementById(referenceId);
              const referencedText = referencedElement?.textContent;
              if (referencedText !== undefined && referencedText !== null && referencedText.trim().length > 0) {
                attributeValues.push(referencedText);
              }
            }
          }
          if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLButtonElement
          ) {
            const value = element.value;
            if (value.trim().length > 0) {
              attributeValues.push(value);
            }
          }
        }
        const haystackParts = [row.textContent || '', ...hrefs, ...attributeValues];
        const haystackRaw = [
            ...haystackParts,
            ...haystackParts.flatMap((value) => decodeRowSearchValue(value)),
          ]
            .join(' ')
            .replace(/\\s*(?:\\.{2,3}|…|⋯|[-–—])\\s*/gu, (separator) => {
              if (separator.includes('…')) return ' … ';
              if (separator.includes('⋯')) return ' ⋯ ';
              if (/[-–—]/u.test(separator)) return ' - ';
              const dotCount = separator.replace(/[^.]/gu, '').length;
              return dotCount === 2 ? ' .. ' : ' ... ';
            });
        const haystack = payload.targetHashCaseInsensitive ? haystackRaw.toLowerCase() : haystackRaw;
        const matchesTargetHash = payload.targetHashNeedles.some((needle) =>
          haystack.includes(payload.targetHashCaseInsensitive ? needle.toLowerCase() : needle)
        );
        const exposesTransactionReference =
          /\\b0x[a-fA-F0-9]{64}\\b/iu.test(haystackRaw) ||
          /\\b0x[a-fA-F0-9]{2,12}\\s*(?:\\.{2,3}|…|⋯|[-–—])\\s*[a-fA-F0-9]{4,12}\\b/iu.test(haystackRaw) ||
          /\\b[1-9A-HJ-NP-Za-km-z]{64,96}\\b/u.test(haystackRaw) ||
          /\\b[1-9A-HJ-NP-Za-km-z]{4,12}\\s*(?:\\.{2,3}|…|⋯|[-–—])\\s*[1-9A-HJ-NP-Za-km-z]{4,12}\\b/u.test(haystackRaw);
        candidates.push({ distance, exposesTransactionReference, matchesTargetHash, row });
      }

      const matchedCandidates = candidates.filter((candidate) => candidate.matchesTargetHash);
      if (
        matchedCandidates.length === 0 &&
        candidates.some((candidate) => candidate.exposesTransactionReference)
      ) {
        return false;
      }

      const selectableCandidates = matchedCandidates.length > 0 ? matchedCandidates : candidates;
      selectableCandidates.sort((left, right) => left.distance - right.distance);
      const selected = selectableCandidates[0];

      if (selected === undefined) {
        return false;
      }
      if (matchedCandidates.length === 0 && selected.distance > payload.rowHeight * 1.5) {
        return false;
      }

      selected.row.classList.add('xxyy-target-trade-marker');
      return true;
    })()
  `);
}

function extractXxyyResponseTradeRows(value: unknown): XxyyTradeRecord[] {
  return extractXxyyResponseTradeRowValueArrays(value)
    .flatMap((rows) => rows.map(normalizeXxyyTradeRecord))
    .filter((record): record is XxyyTradeRecord => record !== undefined);
}

function extractXxyyResponseTradeRowValueArrays(value: unknown): unknown[][] {
  const rowArrays: unknown[][] = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      rowArrays.push(candidate);
      return;
    }
    if (candidate === null || typeof candidate !== 'object') {
      return;
    }

    const record = candidate as Record<string, unknown>;
    for (const key of [
      'data',
      'list',
      'records',
      'rows',
      'items',
      'payload',
      'result',
      'results',
      'page',
      'pageData',
      'page_data',
      'content',
      'activities',
      'activityList',
      'activity_list',
      'activityRows',
      'activity_rows',
      'dataList',
      'data_list',
      'dataRows',
      'data_rows',
      'edges',
      'events',
      'eventList',
      'event_list',
      'fills',
      'fillList',
      'fill_list',
      'histories',
      'history',
      'historyList',
      'history_list',
      'historyRows',
      'history_rows',
      'latestTrades',
      'latest_trades',
      'latestTransactions',
      'latest_transactions',
      'nodes',
      'tableData',
      'table_data',
      'tableRows',
      'table_rows',
      'orderList',
      'order_list',
      'orderRows',
      'order_rows',
      'resultList',
      'result_list',
      'recentTrades',
      'recent_trades',
      'recentTransactions',
      'recent_transactions',
      'tradeRows',
      'trade_rows',
      'tradeList',
      'trade_list',
      'trades',
      'swapList',
      'swap_list',
      'swaps',
      'transactionList',
      'transaction_list',
      'transactionRows',
      'transaction_rows',
      'transactions',
      'txList',
      'tx_list',
      'txRows',
      'tx_rows',
    ]) {
      visit(record[key]);
    }
  };

  visit(value);
  return rowArrays;
}

function resolveScreenshotDir(options: PlaywrightBrowserTxAnalysisDriverOptions): string {
  if (options.screenshotDir !== undefined) {
    return path.resolve(options.screenshotDir);
  }

  return path.join(
    resolveWorkspaceCwd(process.cwd(), process.env),
    'docs',
    'product-features',
    'assets',
  );
}

function resolveChromeExecutablePath(): string | undefined {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

export function extractLastPathSegment(url: string): string {
  const pathname = safeUrlPathname(url) ?? url.split(/[?#]/u, 1)[0] ?? '';
  return pathname.split('/').filter(Boolean).at(-1) ?? '';
}

function safeUrlPathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function extractProgram(text: string): string | undefined {
  const lines = text.split(/\r?\n/gu).map((line) => line.trim());
  const transactionDetailsIndex = lines.findIndex((line) => line === 'Transaction Details');
  const nextLine = lines[transactionDetailsIndex + 1];
  if (nextLine !== undefined && nextLine.length > 0) {
    return nextLine;
  }

  return lines.find((line) => /\bSwap\b|DEX|AMM|Meteora|Pump\.fun/iu.test(line));
}

function extractSigner(text: string): string | undefined {
  const match = /\b(?:Signer|Fee\s*Payer)\b\s*:?\s+([1-9A-HJ-NP-Za-km-z]{32,44})\b/iu.exec(
    text.replace(/\s+/gu, ' '),
  );
  return match?.[1];
}

function extractTransactionTime(text: string): string | undefined {
  const match = /(\d{2}:\d{2}:\d{2}\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\(UTC\))/u.exec(text);
  return match?.[1];
}

export function extractSolanaFmTransactionTime(text: string): string | undefined {
  const match =
    /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+(?:UTC|GMT)/u.exec(text);
  if (match === null) {
    return undefined;
  }

  const [, monthName, day, year, hour, minute, second] = match;
  const month = fullMonthToShort(monthName);
  if (
    month === undefined ||
    day === undefined ||
    year === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return undefined;
  }

  const monthNumber = monthIndex(month);
  if (monthNumber === undefined) {
    return undefined;
  }
  const timestamp = validUtcTimestamp({
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    month: monthNumber,
    second: Number(second),
    year: Number(year),
  });
  return timestamp === undefined ? undefined : formatUtcTimestamp(timestamp);
}

export function extractSolanaExplorerTransactionTime(text: string): string | undefined {
  const solscanLikeMatch =
    /Timestamp\s+(\d{2}:\d{2}:\d{2}\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\(UTC\))/u.exec(
      text.replace(/\s+/gu, ' '),
    );
  if (solscanLikeMatch?.[1] !== undefined) {
    const timestamp = parseSolscanTransactionTime(solscanLikeMatch[1]);
    if (timestamp !== undefined) {
      return formatUtcTimestamp(timestamp);
    }
  }

  const match =
    /Timestamp\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{2}):(\d{2}):(\d{2})\s+(UTC|GMT|[A-Za-z ]+ Time)/u.exec(
      text,
    );
  if (match === null) {
    return undefined;
  }

  const [, month, day, year, hour, minute, second, timezoneName] = match;
  if (
    month === undefined ||
    day === undefined ||
    year === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    timezoneName === undefined
  ) {
    return undefined;
  }

  const monthNumber = monthIndex(month);
  if (monthNumber === undefined) {
    return undefined;
  }

  const localTimestamp = validUtcTimestamp({
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    month: monthNumber,
    second: Number(second),
    year: Number(year),
  });
  if (localTimestamp === undefined) {
    return undefined;
  }

  const timezoneOffsetHours = solanaExplorerTimezoneOffsetHours(timezoneName);
  if (timezoneOffsetHours === undefined) {
    return undefined;
  }

  const timestamp = Date.UTC(
    Number(year),
    monthNumber,
    Number(day),
    Number(hour) + timezoneOffsetHours,
    Number(minute),
    Number(second),
  );
  const date = new Date(timestamp);
  const utcMonth = shortMonth(date.getUTCMonth());
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds(),
  )} ${utcMonth} ${date.getUTCDate()}, ${date.getUTCFullYear()} (UTC)`;
}

function solanaExplorerTimezoneOffsetHours(timezoneName: string): number | undefined {
  switch (timezoneName) {
    case 'China Standard Time':
      return -8;
    case 'Coordinated Universal Time':
    case 'Greenwich Mean Time':
    case 'GMT':
    case 'UTC':
      return 0;
  }

  return undefined;
}

export function extractEvmTransactionTime(text: string): string | undefined {
  const compact = text
    .replace(/\s+/gu, ' ')
    .replace(
      /\(((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT|Z|[+-]\d{1,2}(?::?\d{2})?)\)/gu,
      '$1',
    );
  const unixTimestampMatch =
    /\b(?:(?:Unix\s*)?(?:Block\s+)?Time\s*Stamp|Block\s+Time)\b\s*(?:\(\s*(?:Unix|\+?UTC|GMT|Z)\s*\)|\[\s*(?:Unix|\+?UTC|GMT|Z)\s*\]|(?:Unix|\+?UTC|GMT|Z))?\s*:?\s*(0x[a-fA-F0-9]{8,16}|\d{10}|\d{13})(?:\.\d+)?\b/iu.exec(
      compact,
    );
  if (unixTimestampMatch?.[1] !== undefined) {
    const timestampValue = unixTimestampMatch[1];
    const timestamp = evmUnixTimestampToMilliseconds(timestampValue);
    if (timestamp !== undefined) {
      return formatUtcTimestamp(timestamp);
    }
  }

  const isoMatch =
    /\b(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(AM|PM)?\s*((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT|Z|[+-]\d{1,2}(?::?\d{2})?)\b/iu.exec(
      compact,
    );
  if (isoMatch !== null) {
    const [, year, month, day, hour, minute, second, meridiem, timezone] = isoMatch;
    if (
      year !== undefined &&
      month !== undefined &&
      day !== undefined &&
      hour !== undefined &&
      minute !== undefined &&
      timezone !== undefined
    ) {
      const utcHour = toUtcHour(Number(hour), meridiem);
      const localTimestamp = validUtcTimestamp({
        day: Number(day),
        hour: utcHour,
        minute: Number(minute),
        month: Number(month) - 1,
        second: Number(second ?? '0'),
        year: Number(year),
      });
      const timezoneOffsetMinutes = evmTimestampOffsetMinutes(timezone);
      if (localTimestamp === undefined || timezoneOffsetMinutes === undefined) {
        return undefined;
      }
      return formatUtcTimestamp(localTimestamp - timezoneOffsetMinutes * 60_000);
    }
  }

  const labeledIsoMatch =
    /\b(?:Timestamp|Date|Time|Age|Txn\s+Date|Block\s+Time)\s*(?:\(((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT)\)|\[((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT)\]|((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT))\s*:?\s*(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(AM|PM)?\b/iu.exec(
      compact,
    );
  if (labeledIsoMatch !== null) {
    const [
      ,
      parenthesizedTimezone,
      bracketedTimezone,
      plainTimezone,
      year,
      month,
      day,
      hour,
      minute,
      second,
      meridiem,
    ] = labeledIsoMatch;
    const timezone = parenthesizedTimezone ?? bracketedTimezone ?? plainTimezone;
    if (
      year !== undefined &&
      month !== undefined &&
      day !== undefined &&
      hour !== undefined &&
      minute !== undefined &&
      timezone !== undefined
    ) {
      const utcHour = toUtcHour(Number(hour), meridiem);
      const localTimestamp = validUtcTimestamp({
        day: Number(day),
        hour: utcHour,
        minute: Number(minute),
        month: Number(month) - 1,
        second: Number(second ?? '0'),
        year: Number(year),
      });
      const timezoneOffsetMinutes = evmTimestampOffsetMinutes(timezone);
      if (localTimestamp === undefined || timezoneOffsetMinutes === undefined) {
        return undefined;
      }
      return formatUtcTimestamp(localTimestamp - timezoneOffsetMinutes * 60_000);
    }
  }

  const labeledNumericSlashMatch =
    /\b(?:Timestamp|Date|Time|Age|Txn\s+Date|Block\s+Time)\s*(?:\(((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT)\)|\[((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT)\]|((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT))\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*,\s*|[ T])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(AM|PM)?\b/iu.exec(
      compact,
    );
  if (labeledNumericSlashMatch !== null) {
    const [
      ,
      parenthesizedTimezone,
      bracketedTimezone,
      plainTimezone,
      firstDatePart,
      secondDatePart,
      year,
      hour,
      minute,
      second,
      meridiem,
    ] = labeledNumericSlashMatch;
    const timezone = parenthesizedTimezone ?? bracketedTimezone ?? plainTimezone;
    if (
      firstDatePart !== undefined &&
      secondDatePart !== undefined &&
      year !== undefined &&
      hour !== undefined &&
      minute !== undefined &&
      timezone !== undefined
    ) {
      const dateParts = unambiguousSlashDateParts(Number(firstDatePart), Number(secondDatePart));
      if (dateParts === undefined) {
        return undefined;
      }

      const utcHour = toUtcHour(Number(hour), meridiem);
      const localTimestamp = validUtcTimestamp({
        day: dateParts.day,
        hour: utcHour,
        minute: Number(minute),
        month: dateParts.month,
        second: Number(second ?? '0'),
        year: Number(year),
      });
      const timezoneOffsetMinutes = evmTimestampOffsetMinutes(timezone);
      if (localTimestamp === undefined || timezoneOffsetMinutes === undefined) {
        return undefined;
      }
      return formatUtcTimestamp(localTimestamp - timezoneOffsetMinutes * 60_000);
    }
  }

  const numericSlashMatch =
    /\b(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*,\s*|\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(AM|PM)?\s*((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT|Z|[+-]\d{1,2}(?::?\d{2})?)\b/iu.exec(
      compact,
    );
  if (numericSlashMatch !== null) {
    const [, firstDatePart, secondDatePart, year, hour, minute, second, meridiem, timezone] =
      numericSlashMatch;
    if (
      firstDatePart !== undefined &&
      secondDatePart !== undefined &&
      year !== undefined &&
      hour !== undefined &&
      minute !== undefined &&
      timezone !== undefined
    ) {
      const dateParts = unambiguousSlashDateParts(Number(firstDatePart), Number(secondDatePart));
      if (dateParts === undefined) {
        return undefined;
      }

      const utcHour = toUtcHour(Number(hour), meridiem);
      const localTimestamp = validUtcTimestamp({
        day: dateParts.day,
        hour: utcHour,
        minute: Number(minute),
        month: dateParts.month,
        second: Number(second ?? '0'),
        year: Number(year),
      });
      const timezoneOffsetMinutes = evmTimestampOffsetMinutes(timezone);
      if (localTimestamp === undefined || timezoneOffsetMinutes === undefined) {
        return undefined;
      }
      return formatUtcTimestamp(localTimestamp - timezoneOffsetMinutes * 60_000);
    }
  }

  const labeledMonthMatch =
    /\b(?:Timestamp|Date|Time|Age|Txn\s+Date|Block\s+Time)\s*(?:\(((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT)\)|\[((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT)\]|((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT))\s*:?\s*([A-Z][a-z]{2,8})[-\s]+(\d{1,2})[-,\s]+(\d{4}),?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\b/iu.exec(
      compact,
    );
  if (labeledMonthMatch !== null) {
    const [
      ,
      parenthesizedTimezone,
      bracketedTimezone,
      plainTimezone,
      month,
      day,
      year,
      hour,
      minute,
      second,
      meridiem,
    ] = labeledMonthMatch;
    const timezone = parenthesizedTimezone ?? bracketedTimezone ?? plainTimezone;
    if (
      month !== undefined &&
      day !== undefined &&
      year !== undefined &&
      hour !== undefined &&
      minute !== undefined &&
      timezone !== undefined
    ) {
      const monthNumber = monthIndex(fullMonthToShort(month) ?? month);
      if (monthNumber === undefined) {
        return undefined;
      }

      const utcHour = toUtcHour(Number(hour), meridiem);
      const localTimestamp = validUtcTimestamp({
        day: Number(day),
        hour: utcHour,
        minute: Number(minute),
        month: monthNumber,
        second: Number(second ?? '0'),
        year: Number(year),
      });
      const timezoneOffsetMinutes = evmTimestampOffsetMinutes(timezone);
      if (localTimestamp === undefined || timezoneOffsetMinutes === undefined) {
        return undefined;
      }
      return formatUtcTimestamp(localTimestamp - timezoneOffsetMinutes * 60_000);
    }
  }

  const labeledDayFirstMatch =
    /\b(?:Timestamp|Date|Time|Age|Txn\s+Date|Block\s+Time)\s*(?:\(((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT)\)|\[((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT)\]|((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT))\s*:?\s*(\d{1,2})[-\s]+([A-Z][a-z]{2,8})[-,\s]+(\d{4}),?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\b/iu.exec(
      compact,
    );
  if (labeledDayFirstMatch !== null) {
    const [
      ,
      parenthesizedTimezone,
      bracketedTimezone,
      plainTimezone,
      day,
      month,
      year,
      hour,
      minute,
      second,
      meridiem,
    ] = labeledDayFirstMatch;
    const timezone = parenthesizedTimezone ?? bracketedTimezone ?? plainTimezone;
    if (
      day !== undefined &&
      month !== undefined &&
      year !== undefined &&
      hour !== undefined &&
      minute !== undefined &&
      timezone !== undefined
    ) {
      const monthNumber = monthIndex(fullMonthToShort(month) ?? month);
      if (monthNumber === undefined) {
        return undefined;
      }

      const utcHour = toUtcHour(Number(hour), meridiem);
      const localTimestamp = validUtcTimestamp({
        day: Number(day),
        hour: utcHour,
        minute: Number(minute),
        month: monthNumber,
        second: Number(second ?? '0'),
        year: Number(year),
      });
      const timezoneOffsetMinutes = evmTimestampOffsetMinutes(timezone);
      if (localTimestamp === undefined || timezoneOffsetMinutes === undefined) {
        return undefined;
      }
      return formatUtcTimestamp(localTimestamp - timezoneOffsetMinutes * 60_000);
    }
  }

  const dayFirstMatch =
    /(\d{1,2})[-\s]+([A-Z][a-z]{2,8})[-,\s]+(\d{4}),?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT|[+-]\d{1,2}(?::?\d{2})?)\b/iu.exec(
      compact,
    );
  if (dayFirstMatch !== null) {
    const [, day, month, year, hour, minute, second, meridiem, timezone] = dayFirstMatch;
    if (
      day !== undefined &&
      month !== undefined &&
      year !== undefined &&
      hour !== undefined &&
      minute !== undefined &&
      timezone !== undefined
    ) {
      const monthNumber = monthIndex(fullMonthToShort(month) ?? month);
      if (monthNumber === undefined) {
        return undefined;
      }

      const utcHour = toUtcHour(Number(hour), meridiem);
      const localTimestamp = validUtcTimestamp({
        day: Number(day),
        hour: utcHour,
        minute: Number(minute),
        month: monthNumber,
        second: Number(second ?? '0'),
        year: Number(year),
      });
      const timezoneOffsetMinutes = evmTimestampOffsetMinutes(timezone);
      if (localTimestamp === undefined || timezoneOffsetMinutes === undefined) {
        return undefined;
      }
      return formatUtcTimestamp(localTimestamp - timezoneOffsetMinutes * 60_000);
    }
  }

  const match =
    /([A-Z][a-z]{2,8})[-\s]+(\d{1,2})[-,\s]+(\d{4}),?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*((?:UTC|GMT)\s*[+-]\d{1,2}(?::?\d{2})?|\+?UTC|GMT|[+-]\d{1,2}(?::?\d{2})?)\b/iu.exec(
      compact,
    );
  if (match === null) {
    return undefined;
  }

  const [, month, day, year, hour, minute, second, meridiem, timezone] = match;
  if (
    month === undefined ||
    day === undefined ||
    year === undefined ||
    hour === undefined ||
    minute === undefined ||
    timezone === undefined
  ) {
    return undefined;
  }

  const monthNumber = monthIndex(fullMonthToShort(month) ?? month);
  if (monthNumber === undefined) {
    return undefined;
  }

  const utcHour = toUtcHour(Number(hour), meridiem);
  const localTimestamp = validUtcTimestamp({
    day: Number(day),
    hour: utcHour,
    minute: Number(minute),
    month: monthNumber,
    second: Number(second ?? '0'),
    year: Number(year),
  });
  const timezoneOffsetMinutes = evmTimestampOffsetMinutes(timezone);
  if (localTimestamp === undefined || timezoneOffsetMinutes === undefined) {
    return undefined;
  }
  return formatUtcTimestamp(localTimestamp - timezoneOffsetMinutes * 60_000);
}

function unambiguousSlashDateParts(
  firstDatePart: number,
  secondDatePart: number,
): { day: number; month: number } | undefined {
  if (firstDatePart >= 1 && firstDatePart <= 12 && secondDatePart >= 13 && secondDatePart <= 31) {
    return { day: secondDatePart, month: firstDatePart - 1 };
  }

  if (firstDatePart >= 13 && firstDatePart <= 31 && secondDatePart >= 1 && secondDatePart <= 12) {
    return { day: firstDatePart, month: secondDatePart - 1 };
  }

  return undefined;
}

function evmUnixTimestampToMilliseconds(value: string): number | undefined {
  const numericValue = /^0x/iu.test(value) ? Number.parseInt(value.slice(2), 16) : Number(value);
  if (!Number.isSafeInteger(numericValue) || numericValue < 0) {
    return undefined;
  }

  return numericValue < 10_000_000_000 ? numericValue * 1000 : numericValue;
}

function evmTimestampOffsetMinutes(timezone: string): number | undefined {
  const normalizedTimezone = timezone.trim().toUpperCase();
  if (/^\+?UTC$|^GMT$|^Z$/u.test(normalizedTimezone)) {
    return 0;
  }

  const prefixedOffsetMatch = /^(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/u.exec(
    normalizedTimezone,
  );
  if (prefixedOffsetMatch !== null) {
    const [, sign, hours, minutes] = prefixedOffsetMatch;
    if (sign === undefined || hours === undefined) {
      return undefined;
    }
    const hourOffset = Number(hours);
    const minuteOffset = minutes === undefined ? 0 : Number(minutes);
    if (hourOffset > 23 || minuteOffset > 59) {
      return undefined;
    }

    const offsetMinutes = hourOffset * 60 + minuteOffset;
    return sign === '-' ? -offsetMinutes : offsetMinutes;
  }

  const match = /^([+-])(\d{1,2})(?::?(\d{2}))?$/u.exec(normalizedTimezone);
  if (match === null) {
    return undefined;
  }

  const [, sign, hours, minutes] = match;
  const hourOffset = Number(hours);
  const minuteOffset = minutes === undefined ? 0 : Number(minutes);
  if (hourOffset > 23 || minuteOffset > 59) {
    return undefined;
  }

  const offsetMinutes = hourOffset * 60 + minuteOffset;
  return sign === '-' ? -offsetMinutes : offsetMinutes;
}

function validUtcTimestamp(input: {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}): number | undefined {
  const timestamp = Date.UTC(
    input.year,
    input.month,
    input.day,
    input.hour,
    input.minute,
    input.second,
  );
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== input.year ||
    date.getUTCMonth() !== input.month ||
    date.getUTCDate() !== input.day ||
    date.getUTCHours() !== input.hour ||
    date.getUTCMinutes() !== input.minute ||
    date.getUTCSeconds() !== input.second
  ) {
    return undefined;
  }

  return timestamp;
}

function formatUtcTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds(),
  )} ${shortMonth(date.getUTCMonth())} ${date.getUTCDate()}, ${date.getUTCFullYear()} (UTC)`;
}

export function extractEvmContractAddress(text: string): string | undefined {
  const compact = text.replace(/\s+/gu, ' ');
  const abiWordTokenContractMatch = new RegExp(
    `Token\\s+(?:Contract|Address|Tracker)(?:\\s*\\([^)]{1,40}\\))?(?:\\s+Address)?\\s*:?\\s*.{0,160}?\\b${EVM_ABI_WORD_ADDRESS_CAPTURE}\\b`,
    'iu',
  ).exec(compact);
  if (abiWordTokenContractMatch?.[1] !== undefined) {
    return normalizeEvmAddress(`0x${abiWordTokenContractMatch[1]}`);
  }

  const tokenContractMatch = new RegExp(
    `Token\\s+(?:Contract|Address|Tracker)(?:\\s*\\([^)]{1,40}\\))?(?:\\s+Address)?\\s*:?\\s*.{0,160}?(${EVM_FLEXIBLE_ADDRESS_CAPTURE})`,
    'iu',
  ).exec(compact);
  if (tokenContractMatch?.[1] !== undefined) {
    return normalizeEvmAddress(tokenContractMatch[1]);
  }

  const abiWordGenericContractMatch = new RegExp(
    `Contract(?:\\s+Address)?\\s*:?\\s+\\b${EVM_ABI_WORD_ADDRESS_CAPTURE}\\b`,
    'iu',
  ).exec(compact);
  if (abiWordGenericContractMatch?.[1] !== undefined) {
    return normalizeEvmAddress(`0x${abiWordGenericContractMatch[1]}`);
  }

  const genericContractMatch = new RegExp(
    `Contract(?:\\s+Address)?\\s*:?\\s+(${EVM_FLEXIBLE_ADDRESS_CAPTURE})`,
    'iu',
  ).exec(compact);
  return normalizeEvmAddress(genericContractMatch?.[1]);
}

function extractEvmContractAddressFromExplorerLinks(
  text: string,
  links: Array<{ address: string; text?: string }>,
): string | undefined {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const candidateTexts = lines.flatMap((line, index) => {
    const nextLine = lines[index + 1];
    const nextNextLine = lines[index + 2];
    const nextNextNextLine = lines[index + 3];
    return [
      line,
      nextLine === undefined ? line : `${line} ${nextLine}`,
      nextLine === undefined || nextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine}`,
      nextLine === undefined || nextNextLine === undefined || nextNextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine} ${nextNextNextLine}`,
    ];
  });

  for (const textWindow of candidateTexts) {
    if (
      !/\bToken\s+(?:Contract|Address|Tracker)(?:\s*\([^)]{1,40}\))?(?:\s+Address)?\b/iu.test(
        textWindow,
      )
    ) {
      continue;
    }

    const matchingLink = links.find((link) => evmAddressLinkMatchesText(textWindow, link));
    if (matchingLink !== undefined) {
      return matchingLink.address;
    }
  }

  return undefined;
}

function extractEvmContractTokenText(text: string): string | undefined {
  const compact = text.replace(/\s+/gu, ' ');
  const tokenContractMatch = new RegExp(
    `Token\\s+(?:Contract|Address|Tracker)(?:\\s*\\([^)]{1,40}\\))?(?:\\s+Address)?\\s*:?\\s*(.{1,160}?)\\s*(${EVM_FLEXIBLE_ADDRESS_CAPTURE})`,
    'iu',
  ).exec(compact);
  const tokenText = tokenContractMatch?.[1]?.trim();
  if (tokenText === undefined || tokenText.length === 0 || !/[A-Za-z0-9]/u.test(tokenText)) {
    return undefined;
  }

  return tokenText;
}

function extractEvmContractTokenTextFromExplorerLinks(
  text: string,
  links: Array<{ address: string; text?: string }>,
): string | undefined {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const candidateTexts = lines.flatMap((line, index) => {
    const nextLine = lines[index + 1];
    const nextNextLine = lines[index + 2];
    const nextNextNextLine = lines[index + 3];
    return [
      line,
      nextLine === undefined ? line : `${line} ${nextLine}`,
      nextLine === undefined || nextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine}`,
      nextLine === undefined || nextNextLine === undefined || nextNextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine} ${nextNextNextLine}`,
    ];
  });

  for (const textWindow of candidateTexts) {
    const labelMatch =
      /\bToken\s+(?:Contract|Address|Tracker)(?:\s*\([^)]{1,40}\))?(?:\s+Address)?\b\s*:?/iu.exec(
        textWindow,
      );
    if (labelMatch === null) {
      continue;
    }

    const matchingLink = links.find((link) => evmAddressLinkMatchesText(textWindow, link));
    if (matchingLink === undefined) {
      continue;
    }

    const rawText = textWindow.slice(labelMatch.index + labelMatch[0].length).trim();
    const tokenText =
      splitBeforeEvmAddressLinkText(rawText, matchingLink) ?? stripKnownEvmAddressText(rawText);
    if (tokenText !== undefined && /[A-Za-z0-9]/u.test(tokenText)) {
      return tokenText;
    }
  }

  return undefined;
}

function splitBeforeEvmAddressLinkText(
  text: string,
  link: { address: string; text?: string },
): string | undefined {
  const candidates = [
    link.text,
    abbreviateAddress(link.address.toLowerCase()),
    `${link.address.toLowerCase().slice(0, 6)}...${link.address.toLowerCase().slice(-4)}`,
    `${link.address.toLowerCase().slice(0, 10)}...${link.address.toLowerCase().slice(-8)}`,
  ].filter((value): value is string => value !== undefined && value.length > 0);

  for (const candidate of candidates) {
    const index = text.toLowerCase().indexOf(candidate.toLowerCase());
    if (index < 0) {
      continue;
    }

    const before = text.slice(0, index).trim();
    return before.length === 0 ? undefined : before;
  }

  return undefined;
}

function stripKnownEvmAddressText(text: string): string | undefined {
  const stripped = text.replace(EVM_ABBREVIATED_ADDRESS_TEXT_PATTERN, '').trim();
  return stripped.length === 0 ? undefined : stripped;
}

export function extractEvmRouterAddressFromExplorerText(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const candidateTexts = lines.flatMap((line, index) => {
    const nextLine = lines[index + 1];
    const nextNextLine = lines[index + 2];
    return [
      line,
      nextLine === undefined ? line : `${line} ${nextLine}`,
      nextLine === undefined || nextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine}`,
    ];
  });

  for (const line of candidateTexts) {
    const abiWordAddressBeforeRouterLabel = new RegExp(
      `\\b${EVM_ABI_WORD_ADDRESS_CAPTURE}\\b[^\\n]{0,120}?\\b(?:${EVM_ROUTER_LABEL_PATTERN})\\b`,
      'iu',
    ).exec(line)?.[1];
    if (abiWordAddressBeforeRouterLabel !== undefined) {
      return normalizeEvmAddress(`0x${abiWordAddressBeforeRouterLabel}`);
    }

    const addressBeforeRouterLabel = new RegExp(
      `(?!(?:0x)?(?:0\\s*){24})(${EVM_FLEXIBLE_ADDRESS_CAPTURE})[^\\n]{0,120}?\\b(?:${EVM_ROUTER_LABEL_PATTERN})\\b`,
      'iu',
    ).exec(line)?.[1];
    if (addressBeforeRouterLabel !== undefined) {
      return normalizeEvmAddress(addressBeforeRouterLabel);
    }

    const abiWordAddressAfterRouterLabel = new RegExp(
      `\\b(?:${EVM_ROUTER_LABEL_PATTERN})\\b[^\\n]{0,120}?\\b${EVM_ABI_WORD_ADDRESS_CAPTURE}\\b`,
      'iu',
    ).exec(line)?.[1];
    if (abiWordAddressAfterRouterLabel !== undefined) {
      return normalizeEvmAddress(`0x${abiWordAddressAfterRouterLabel}`);
    }

    const addressAfterRouterLabel = new RegExp(
      `\\b(?:${EVM_ROUTER_LABEL_PATTERN})\\b[^\\n]{0,120}?(?!(?:0x)?(?:0\\s*){24})(${EVM_FLEXIBLE_ADDRESS_CAPTURE})`,
      'iu',
    ).exec(line)?.[1];
    if (addressAfterRouterLabel !== undefined) {
      return normalizeEvmAddress(addressAfterRouterLabel);
    }
  }

  return undefined;
}

function extractEvmRouterAddressFromExplorerLinks(
  text: string,
  links: Array<{ address: string; text?: string }>,
): string | undefined {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const candidateTexts = lines.flatMap((line, index) => {
    const nextLine = lines[index + 1];
    const nextNextLine = lines[index + 2];
    return [
      line,
      nextLine === undefined ? line : `${line} ${nextLine}`,
      nextLine === undefined || nextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine}`,
    ];
  });

  for (const textWindow of candidateTexts) {
    if (!new RegExp(`\\b(?:${EVM_ROUTER_LABEL_PATTERN})\\b`, 'iu').test(textWindow)) {
      continue;
    }

    const matchingLink = links.find((link) => evmAddressLinkMatchesText(textWindow, link));
    if (matchingLink !== undefined) {
      return matchingLink.address;
    }
  }

  return undefined;
}

export function selectEvmContractTokenCandidate<T extends EvmTokenCandidate>(
  candidates: T[],
): T | undefined {
  return (
    candidates.find(
      (candidate) => !isEvmPoolLabelText(candidate.text) && !isCommonEvmQuoteToken(candidate),
    ) ??
    candidates.find((candidate) => !isEvmPoolLabelText(candidate.text)) ??
    candidates[0]
  );
}

function isEvmPoolLabelText(text: string | undefined): boolean {
  return text === undefined
    ? false
    : new RegExp(`\\b(?:${EVM_POOL_LABEL_PATTERN})\\b`, 'iu').test(text);
}

function isCommonEvmQuoteToken(candidate: EvmTokenCandidate): boolean {
  return (
    COMMON_EVM_QUOTE_TOKEN_ADDRESSES.has(candidate.address.toLowerCase()) ||
    isCommonEvmQuoteTokenText(candidate.text)
  );
}

function isCommonEvmQuoteTokenText(text: string | undefined): boolean {
  return text === undefined
    ? false
    : COMMON_EVM_QUOTE_TOKEN_SYMBOL_PATTERN.test(text.toUpperCase());
}

export function extractEvmPoolAddressFromExplorerText(text: string): string | undefined {
  return extractEvmPoolAddressesFromExplorerText(text)[0];
}

export function extractEvmPoolAddressesFromExplorerText(text: string): string[] {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const addressesAfterPoolLabel: string[] = [];
  const addressesFromSwapEventEmitter: string[] = [];
  const addressesBeforePoolLabel: string[] = [];

  const candidateTexts = lines.flatMap((line, index) => {
    const nextLine = lines[index + 1];
    const nextNextLine = lines[index + 2];
    const nextNextNextLine = lines[index + 3];
    return [
      line,
      nextLine === undefined ? line : `${line} ${nextLine}`,
      nextLine === undefined || nextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine}`,
      nextLine === undefined || nextNextLine === undefined || nextNextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine} ${nextNextNextLine}`,
    ];
  });

  for (const line of candidateTexts) {
    const abiWordAddressAfterPoolLabel = new RegExp(
      `\\b(?:${EVM_POOL_LABEL_PATTERN})\\b[^\\n]{0,120}?\\b${EVM_ABI_WORD_ADDRESS_CAPTURE}\\b`,
      'iu',
    ).exec(line)?.[1];
    if (abiWordAddressAfterPoolLabel !== undefined) {
      addressesAfterPoolLabel.push(`0x${abiWordAddressAfterPoolLabel}`);
    }

    const addressAfterPoolLabelMatch = new RegExp(
      `\\b(?:${EVM_POOL_LABEL_PATTERN})\\b([^\\n]{0,120}?)(?!(?:0x)?(?:0\\s*){24})(${EVM_FLEXIBLE_ADDRESS_CAPTURE})`,
      'iu',
    ).exec(line);
    const textBetweenPoolLabelAndAddress = addressAfterPoolLabelMatch?.[1] ?? '';
    const addressAfterPoolLabel = addressAfterPoolLabelMatch?.[2];
    if (
      addressAfterPoolLabel !== undefined &&
      isLikelyEvmAddressAfterPoolLabelContext(textBetweenPoolLabelAndAddress)
    ) {
      addressesAfterPoolLabel.push(addressAfterPoolLabel);
    }

    const swapEventEmitterAddress = new RegExp(
      `\\bSwap\\b[^\\n]{0,80}?\\b(?:Address|Contract|Emitter|Emitted\\s+(?:by|from))\\b[^\\n]{0,80}?(${EVM_FLEXIBLE_ADDRESS_CAPTURE})`,
      'iu',
    ).exec(line)?.[1];
    if (swapEventEmitterAddress !== undefined && isLikelyEvmSwapEventEmitterText(line)) {
      addressesFromSwapEventEmitter.push(swapEventEmitterAddress);
    }

    const addressBeforePoolLabelMatch = new RegExp(
      `(${EVM_FLEXIBLE_ADDRESS_CAPTURE})([^\\n]{0,120}?)\\b(?:${EVM_POOL_LABEL_PATTERN})\\b`,
      'iu',
    ).exec(line);
    const addressBeforePoolLabel = addressBeforePoolLabelMatch?.[1];
    const textBetweenAddressAndPoolLabel = addressBeforePoolLabelMatch?.[2] ?? '';
    if (
      addressBeforePoolLabel !== undefined &&
      isLikelyEvmAddressBeforePoolLabelContext(textBetweenAddressAndPoolLabel)
    ) {
      addressesBeforePoolLabel.push(addressBeforePoolLabel);
    }
  }

  return uniqueEvmAddresses([
    ...addressesAfterPoolLabel,
    ...addressesFromSwapEventEmitter,
    ...addressesBeforePoolLabel,
  ]);
}

function extractEvmPoolAddressesFromExplorerLinks(
  text: string,
  links: Array<{ address: string; text?: string }>,
): string[] {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const candidateTexts = lines.flatMap((line, index) => {
    const nextLine = lines[index + 1];
    const nextNextLine = lines[index + 2];
    const nextNextNextLine = lines[index + 3];
    return [
      line,
      nextLine === undefined ? line : `${line} ${nextLine}`,
      nextLine === undefined || nextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine}`,
      nextLine === undefined || nextNextLine === undefined || nextNextNextLine === undefined
        ? line
        : `${line} ${nextLine} ${nextNextLine} ${nextNextNextLine}`,
    ];
  });
  const addresses: string[] = [];

  for (const line of candidateTexts) {
    const afterPoolLabel = new RegExp(
      `\\b(?:${EVM_POOL_LABEL_PATTERN})\\b([^\\n]{0,120})`,
      'iu',
    ).exec(line)?.[1];
    if (afterPoolLabel === undefined) {
      continue;
    }

    const matchingLink = links.find((link) => evmAddressLinkMatchesText(afterPoolLabel, link));
    if (matchingLink !== undefined) {
      addresses.push(matchingLink.address);
    }

    const beforePoolLabel = new RegExp(
      `([^\\n]{0,120})\\b(?:${EVM_POOL_LABEL_PATTERN})\\b`,
      'iu',
    ).exec(line)?.[1];
    if (beforePoolLabel === undefined) {
      continue;
    }

    const precedingLink = links.find((link) => evmAddressLinkMatchesText(beforePoolLabel, link));
    if (precedingLink !== undefined) {
      addresses.push(precedingLink.address);
    }
  }

  return uniqueEvmAddresses(addresses);
}

function isLikelyEvmAddressBeforePoolLabelContext(text: string): boolean {
  return !/\b(?:Transaction|Txn|Timestamp|Date|Time|Status|Tokens?\s+Transferred|Token\s+Transfers?|ERC[-\s]*20|BEP[-\s]*20|From|Sender|To|Recipient|Receiver)\b/iu.test(
    text,
  );
}

function isLikelyEvmAddressAfterPoolLabelContext(text: string): boolean {
  return (
    !new RegExp(EVM_ABBREVIATED_ADDRESS_TEXT_PATTERN.source, 'iu').test(text) &&
    !/\b(?:From|Sender|To|Recipient|Receiver)\b/iu.test(text)
  );
}

function isLikelyEvmSwapEventEmitterText(text: string): boolean {
  return (
    !/\bTransaction\s+Action\b/iu.test(text) &&
    /\b(?:Event\s+Logs?|Logs?|Topics?|Data|amount0|amount1|sender|recipient)\b/iu.test(text)
  );
}

function uniqueEvmAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const address of addresses) {
    const normalizedAddress = normalizeEvmAddress(address);
    if (normalizedAddress === undefined) {
      continue;
    }

    const normalized = normalizedAddress.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(normalizedAddress);
  }

  return unique;
}

export function extractEvmAddressAfterLabel(text: string, label: string): string | undefined {
  const compact = text.replace(/\s+/gu, ' ');
  const escapedLabel = escapeRegExp(label);
  const match = new RegExp(`${escapedLabel}\\s*:?\\s+(${EVM_FLEXIBLE_ADDRESS_CAPTURE})`, 'iu').exec(
    compact,
  );
  return normalizeEvmAddress(match?.[1]);
}

export function extractEvmTransactionFromAddress(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const candidates = lines
    .flatMap((line, index) => {
      const candidateText = [line, lines[index + 1] ?? '', lines[index + 2] ?? '']
        .filter(Boolean)
        .join(' ');
      const address = extractEvmTransactionFromAddressCandidate(candidateText);
      const normalizedAddress = normalizeEvmAddress(address);
      if (normalizedAddress === undefined) {
        return [];
      }

      const context = lines
        .slice(Math.max(0, index - 6), Math.min(lines.length, index + 3))
        .join(' ');
      return [
        {
          address: normalizedAddress,
          index,
          isTransactionContext: isEvmTransactionDetailsContext(context),
          isTransferContext: isEvmTokenTransferContext(context),
        },
      ];
    })
    .filter(
      (candidate, index, allCandidates) =>
        allCandidates.findIndex(
          (other) => other.address.toLowerCase() === candidate.address.toLowerCase(),
        ) === index,
    );

  return (
    candidates.find((candidate) => candidate.isTransactionContext)?.address ??
    candidates.find((candidate) => !candidate.isTransferContext)?.address
  );
}

function extractEvmTransactionFromAddressCandidate(candidateText: string): string | undefined {
  const boundedFromTail = extractBoundedEvmFromTail(candidateText);
  return boundedFromTail === undefined
    ? undefined
    : new RegExp(`(${EVM_FLEXIBLE_ADDRESS_CAPTURE})`, 'iu').exec(boundedFromTail)?.[1];
}

function extractEvmTransactionFromAddressLinks(
  text: string,
  links: Array<{ address: string; text?: string }>,
): string | undefined {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
  const candidates = lines
    .flatMap((line, index) => {
      const candidateText = [line, lines[index + 1] ?? '', lines[index + 2] ?? '']
        .filter(Boolean)
        .join(' ');
      const boundedFromTail = extractBoundedEvmFromTail(candidateText);
      if (boundedFromTail === undefined) {
        return [];
      }

      const matchingLink = links.find((link) =>
        evmAddressLinkMatchesFromTail(boundedFromTail, link),
      );
      if (matchingLink === undefined) {
        return [];
      }

      const normalizedAddress = normalizeEvmAddress(matchingLink.address);
      if (normalizedAddress === undefined) {
        return [];
      }

      const context = lines
        .slice(Math.max(0, index - 6), Math.min(lines.length, index + 3))
        .join(' ');
      return [
        {
          address: normalizedAddress,
          index,
          isTransactionContext: isEvmTransactionDetailsContext(context),
          isTransferContext: isEvmTokenTransferContext(context),
        },
      ];
    })
    .filter(
      (candidate, index, allCandidates) =>
        allCandidates.findIndex(
          (other) => other.address.toLowerCase() === candidate.address.toLowerCase(),
        ) === index,
    );

  return (
    candidates.find((candidate) => candidate.isTransactionContext)?.address ??
    candidates.find((candidate) => !candidate.isTransferContext)?.address
  );
}

function extractBoundedEvmFromTail(candidateText: string): string | undefined {
  const fromTail = new RegExp(
    `\\b${EVM_TRANSACTION_SENDER_LABEL_PATTERN}\\b\\s*:?\\s+(.+)$`,
    'iu',
  ).exec(candidateText)?.[1];
  if (fromTail === undefined) {
    return undefined;
  }

  return (
    fromTail.split(
      /\b(?:Interacted\s+With|To|Transaction\s+Action|Transaction\s+Fee|Gas\s+Price|Status|Block|Timestamp|Txn\s+Hash|Transaction\s+Hash|Tokens?\s+Transferred)\b/iu,
      1,
    )[0] ?? fromTail
  );
}

function evmAddressLinkMatchesFromTail(
  fromTail: string,
  link: { address: string; text?: string },
): boolean {
  return evmAddressLinkMatchesText(fromTail, link);
}

function evmAddressLinkMatchesText(
  text: string,
  link: { address: string; text?: string },
): boolean {
  const normalizedText = normalizeEvmExplorerAddressText(text);
  const normalizedLinkText = normalizeEvmExplorerAddressText(link.text ?? '');
  if (normalizedLinkText.length > 0 && normalizedText.includes(normalizedLinkText)) {
    return true;
  }

  const normalizedAddress = normalizeEvmAddress(link.address)?.toLowerCase();
  if (normalizedAddress === undefined) {
    return false;
  }

  return [
    abbreviateAddress(normalizedAddress),
    `${normalizedAddress.slice(0, 6)}...${normalizedAddress.slice(-4)}`,
    `${normalizedAddress.slice(0, 10)}...${normalizedAddress.slice(-8)}`,
  ].some((value) => normalizedText.includes(normalizeEvmExplorerAddressText(value)));
}

function normalizeEvmExplorerAddressText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*(?:\.{2,3}|…|⋯)\s*/gu, '...')
    .replace(/\s+/gu, ' ');
}

function normalizeEvmAddress(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.replace(/\s+/gu, '');
  return EVM_ADDRESS_PATTERN.test(normalized) ? normalized : undefined;
}

function isEvmTransactionDetailsContext(text: string): boolean {
  return /\b(?:Transaction\s+Details|Transaction\s+Hash|Txn\s+Hash|Status|Block|Timestamp|Interacted\s+With|Transaction\s+Action|Transaction\s+Fee|Gas\s+Price)\b/iu.test(
    text,
  );
}

function isEvmTokenTransferContext(text: string): boolean {
  return /\b(?:Tokens?\s+Transferred|Token\s+Transfers?|ERC-20|ERC-721|ERC-1155|Event\s+Logs?|Decoded\s+Input|Transfer\s+Event)\b/iu.test(
    text,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function toUtcHour(hour: number, meridiem: string | undefined): number {
  if (meridiem === undefined) {
    return hour;
  }

  const normalized = meridiem.toUpperCase();
  if (normalized === 'AM') {
    return hour === 12 ? 0 : hour;
  }
  if (normalized === 'PM') {
    return hour === 12 ? 12 : hour + 12;
  }

  return hour;
}

function extractLikelyTokenMint(text: string): string | undefined {
  const addresses = text.match(new RegExp(SOLANA_ADDRESS_CAPTURE, 'gu')) ?? [];
  return addresses.find(
    (address) =>
      SOLANA_ADDRESS_PATTERN.test(address) &&
      !STABLE_SOLANA_MINTS.has(address) &&
      /pump$/u.test(address),
  );
}

function extractSignerFromProgramLogs(text: string): string | undefined {
  const okxLogIndex = text.indexOf('Program logged: "order_id:');
  if (okxLogIndex < 0) {
    return undefined;
  }

  const afterOrderLog = text.slice(okxLogIndex);
  const addresses = afterOrderLog.match(new RegExp(SOLANA_ADDRESS_CAPTURE, 'gu')) ?? [];
  return addresses.find(
    (address) =>
      SOLANA_ADDRESS_PATTERN.test(address) &&
      !STABLE_SOLANA_MINTS.has(address) &&
      !/pump$/u.test(address) &&
      address !== 'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH',
  );
}

export function parseSolscanTransactionTime(value: string): number | undefined {
  const match =
    /^(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})\s+(?<month>[A-Z][a-z]{2})\s+(?<day>\d{1,2}),\s+(?<year>\d{4})\s+\(UTC\)$/u.exec(
      value,
    );
  const groups = match?.groups;
  if (groups === undefined) {
    return undefined;
  }

  const month = monthIndex(groups.month);
  if (month === undefined) {
    return undefined;
  }

  return validUtcTimestamp({
    day: Number(groups.day),
    hour: Number(groups.hour),
    minute: Number(groups.minute),
    month,
    second: Number(groups.second),
    year: Number(groups.year),
  });
}

function fullMonthToShort(month: string | undefined): string | undefined {
  if (month === undefined) {
    return undefined;
  }

  const normalizedMonth = normalizeMonthName(month);
  return {
    April: 'Apr',
    August: 'Aug',
    December: 'Dec',
    February: 'Feb',
    January: 'Jan',
    July: 'Jul',
    June: 'Jun',
    March: 'Mar',
    May: 'May',
    November: 'Nov',
    October: 'Oct',
    September: 'Sep',
  }[normalizedMonth];
}

function shortMonth(index: number): string {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    index
  ] as string;
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function monthIndex(month: string | undefined): number | undefined {
  if (month === undefined) {
    return undefined;
  }

  const normalizedMonth = normalizeMonthName(month);
  return {
    Apr: 3,
    Aug: 7,
    Dec: 11,
    Feb: 1,
    Jan: 0,
    Jul: 6,
    Jun: 5,
    Mar: 2,
    May: 4,
    Nov: 10,
    Oct: 9,
    Sep: 8,
  }[normalizedMonth];
}

function normalizeMonthName(month: string): string {
  const lower = month.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function inferEvmTradeSide(
  text: string,
  tokenText: string | undefined,
  tokenAddress?: string,
  signerAddress?: string,
  liquidityVenueAddresses: string[] = [],
): BrowserTradeSide {
  const tokenIdentifiers = evmTradeSideTokenIdentifiers(tokenText, tokenAddress);
  if (tokenIdentifiers.length === 0) {
    return 'unknown';
  }

  const compact = text.replace(/\s+/gu, ' ');
  const swapSide = inferEvmSwapActionSide(compact, tokenIdentifiers);
  if (swapSide !== 'unknown') {
    return swapSide;
  }

  const swapFunctionSide = inferEvmSwapFunctionSide(compact, tokenIdentifiers);
  if (swapFunctionSide !== 'unknown') {
    return swapFunctionSide;
  }

  const tokenInOutSide = inferEvmTokenInOutTradeSide(compact, tokenIdentifiers);
  if (tokenInOutSide !== 'unknown') {
    return tokenInOutSide;
  }

  const boughtAction =
    /\b(?:Bought|Buy|Purchased|Purchase)\s+(.+?)\s+(?:for|with)\s+(.+?)(?=\s+(?:on\b|via\b|using\b|through\b|at\b|from\b|Transaction\b|Txn\b|Swap\b|Swapped\b|Exchange\b|Exchanged\b|Trade\b|Traded\b|Convert\b|Converted\b|Redeem\b|Redeemed\b|Bought\b|Buy\b|Purchased\b|Purchase\b|Sold\b|Sell\b|Fee\b|Gas\b)|$)/iu.exec(
      compact,
    );
  if (boughtAction !== null) {
    const boughtSide = boughtAction[1] ?? '';
    const paidSide = boughtAction[2] ?? '';
    if (evmSwapSideContainsToken(boughtSide, tokenIdentifiers)) {
      return 'buy';
    }
    if (evmSwapSideContainsToken(paidSide, tokenIdentifiers)) {
      return 'sell';
    }
  }

  const soldAction =
    /\b(?:Sold|Sell)\s+(.+?)\s+(?:for|to)\s+(.+?)(?=\s+(?:on\b|via\b|using\b|through\b|at\b|from\b|Transaction\b|Txn\b|Swap\b|Swapped\b|Exchange\b|Exchanged\b|Trade\b|Traded\b|Convert\b|Converted\b|Redeem\b|Redeemed\b|Bought\b|Buy\b|Purchased\b|Purchase\b|Sold\b|Sell\b|Fee\b|Gas\b)|$)/iu.exec(
      compact,
    );
  if (soldAction !== null) {
    const soldSide = soldAction[1] ?? '';
    const receivedSide = soldAction[2] ?? '';
    if (evmSwapSideContainsToken(soldSide, tokenIdentifiers)) {
      return 'sell';
    }
    if (evmSwapSideContainsToken(receivedSide, tokenIdentifiers)) {
      return 'buy';
    }
  }

  const receivedInExchangeAction =
    /\b(?:Received|Receive)\s+(.+?)\s+in\s+exchange\s+for\s+(.+?)(?=\s+(?:on\b|via\b|using\b|through\b|at\b|from\b|Transaction\b|Txn\b|Swap\b|Swapped\b|(?<!0x\s)Exchange\b|Exchanged\b|Trade\b|Traded\b|Convert\b|Converted\b|Redeem\b|Redeemed\b|Bought\b|Buy\b|Purchased\b|Purchase\b|Sold\b|Sell\b|Paid\b|Pay\b|Fee\b|Gas\b)|$)/iu.exec(
      compact,
    );
  if (receivedInExchangeAction !== null) {
    const receivedSide = receivedInExchangeAction[1] ?? '';
    const paidSide = receivedInExchangeAction[2] ?? '';
    if (evmSwapSideContainsToken(receivedSide, tokenIdentifiers)) {
      return 'buy';
    }
    if (evmSwapSideContainsToken(paidSide, tokenIdentifiers)) {
      return 'sell';
    }
  }

  const paidToReceiveAction =
    /\b(?:Paid|Pay|Spent|Spend)\s+(.+?)\s+(?:to\s+receive|for)\s+(.+?)(?=\s+(?:on\b|via\b|using\b|through\b|at\b|from\b|Transaction\b|Txn\b|Swap\b|Swapped\b|(?<!0x\s)Exchange\b|Exchanged\b|Trade\b|Traded\b|Convert\b|Converted\b|Redeem\b|Redeemed\b|Bought\b|Buy\b|Purchased\b|Purchase\b|Sold\b|Sell\b|Received\b|Receive\b|Paid\b|Pay\b|Spent\b|Spend\b|Fee\b|Gas\b)|$)/iu.exec(
      compact,
    );
  if (paidToReceiveAction !== null) {
    const paidSide = paidToReceiveAction[1] ?? '';
    const receivedSide = paidToReceiveAction[2] ?? '';
    if (evmSwapSideContainsToken(paidSide, tokenIdentifiers)) {
      return 'sell';
    }
    if (evmSwapSideContainsToken(receivedSide, tokenIdentifiers)) {
      return 'buy';
    }
  }

  if (isEvmNonSwapAssetManagementAction(compact)) {
    return 'unknown';
  }

  const receivedAction =
    /\b(?:Received|Receive)\s+(.+?)\s+(?:from|via|on|using|through|at)\s+(.+?)(?=\s+(?:Transaction\b|Txn\b|Swap\b|Swapped\b|(?<!0x\s)Exchange\b|Exchanged\b|Trade\b|Traded\b|Convert\b|Converted\b|Redeem\b|Redeemed\b|Bought\b|Buy\b|Purchased\b|Purchase\b|Sold\b|Sell\b|Received\b|Receive\b|Sent\b|Send\b|Fee\b|Gas\b)|$)/iu.exec(
      compact,
    );
  if (
    receivedAction !== null &&
    evmSwapSideContainsToken(receivedAction[1] ?? '', tokenIdentifiers) &&
    isEvmKnownLiquidityVenueText(receivedAction[2] ?? '', liquidityVenueAddresses)
  ) {
    return 'buy';
  }

  const sentAction =
    /\b(?:Sent|Send)\s+(.+?)\s+(?:to|via|on|using|through|at|from)\s+(.+?)(?=\s+(?:Transaction\b|Txn\b|Swap\b|Swapped\b|(?<!0x\s)Exchange\b|Exchanged\b|Trade\b|Traded\b|Convert\b|Converted\b|Redeem\b|Redeemed\b|Bought\b|Buy\b|Purchased\b|Purchase\b|Sold\b|Sell\b|Received\b|Receive\b|Sent\b|Send\b|Fee\b|Gas\b)|$)/iu.exec(
      compact,
    );
  if (
    sentAction !== null &&
    evmSwapSideContainsToken(sentAction[1] ?? '', tokenIdentifiers) &&
    isEvmKnownLiquidityVenueText(sentAction[2] ?? '', liquidityVenueAddresses)
  ) {
    return 'sell';
  }

  const transferSide = inferEvmTokenTransferTradeSide(
    text,
    tokenIdentifiers,
    signerAddress,
    liquidityVenueAddresses,
  );
  if (transferSide !== 'unknown') {
    return transferSide;
  }

  return 'unknown';
}

function isEvmNonSwapAssetManagementAction(compactText: string): boolean {
  return (
    /\b(?:Add(?:ed)?|Remove(?:d)?|Increase(?:d)?|Decrease(?:d)?)\s+Liquidity\b/iu.test(
      compactText,
    ) ||
    /\b(?:add|remove|increase|decrease)Liquidity\b/u.test(compactText) ||
    /\b(?:Mint(?:ed)?|Burn(?:ed)?)\s+(?:Liquidity|LP|Position)\b/iu.test(compactText) ||
    /\b(?:Deposit(?:ed)?|Withdraw(?:n|ed)?|Wrap(?:ped)?|Unwrap(?:ped)?)\b/iu.test(compactText) ||
    /\b(?:Stake(?:d)?|Unstake(?:d)?|Restake(?:d)?|Harvest(?:ed)?|Claim(?:ed)?(?:\s+(?:Reward|Rewards))?|Reward(?:ed|s)?)\b/iu.test(
      compactText,
    ) ||
    /\b(?:Suppl(?:y|ied)|Borrow(?:ed)?|Repa(?:y|id)|Lend|Lent|Bridge(?:d)?)\b/iu.test(
      compactText,
    ) ||
    /\b(?:Approve(?:d)?|Permit(?:ted)?|Increase(?:d)?\s+Allowance|Decrease(?:d)?\s+Allowance|Set\s+Approval(?:\s+For\s+All)?)\b/iu.test(
      compactText,
    )
  );
}

function isEvmKnownLiquidityVenueText(text: string, liquidityVenueAddresses: string[]): boolean {
  if (isEvmLiquidityVenueText(text)) {
    return true;
  }

  const normalizedVenueAddresses = new Set(
    liquidityVenueAddresses
      .map((address) => normalizeEvmAddress(address)?.toLowerCase())
      .filter((address): address is string => address !== undefined),
  );
  return evmTextContainsAnyAddress(text, normalizedVenueAddresses);
}

function inferEvmSwapFunctionSide(
  compactText: string,
  tokenIdentifiers: string[],
): BrowserTradeSide {
  if (/\bswap\s*exact\s*(?:eth|bnb)\s*for\s*tokens\b/iu.test(compactText)) {
    return 'buy';
  }
  if (/\bswapExact(?:ETH|BNB)ForTokens/iu.test(compactText)) {
    return 'buy';
  }
  if (/\bswap\s*(?:eth|bnb)\s*for\s*exact\s*tokens\b/iu.test(compactText)) {
    return 'buy';
  }
  if (/\bswap(?:ETH|BNB)ForExactTokens/iu.test(compactText)) {
    return 'buy';
  }
  if (/\bswap\s*exact\s*tokens\s*for\s*(?:eth|bnb)\b/iu.test(compactText)) {
    return 'sell';
  }
  if (/\bswapExactTokensFor(?:ETH|BNB)/iu.test(compactText)) {
    return 'sell';
  }
  if (/\bswap\s*tokens\s*for\s*exact\s*(?:eth|bnb)\b/iu.test(compactText)) {
    return 'sell';
  }
  if (/\bswapTokensForExact(?:ETH|BNB)/iu.test(compactText)) {
    return 'sell';
  }

  if (/\bexactInput\b/iu.test(compactText)) {
    const packedPathSide = inferEvmPackedPathTradeSide(compactText, tokenIdentifiers, 'forward');
    if (packedPathSide !== 'unknown') {
      return packedPathSide;
    }
  }

  if (/\bexactOutput\b/iu.test(compactText)) {
    const packedPathSide = inferEvmPackedPathTradeSide(compactText, tokenIdentifiers, 'reversed');
    if (packedPathSide !== 'unknown') {
      return packedPathSide;
    }
  }

  if (
    /\bswap(?:Exact)?TokensFor(?:Exact)?Tokens(?:\b|SupportingFeeOnTransferTokens\b)/iu.test(
      compactText,
    )
  ) {
    const pathSide = inferEvmPathTradeSide(compactText, tokenIdentifiers);
    if (pathSide !== 'unknown') {
      return pathSide;
    }
  }

  return 'unknown';
}

function inferEvmPathTradeSide(compactText: string, tokenIdentifiers: string[]): BrowserTradeSide {
  const pathMatch = new RegExp(
    `\\b${EVM_ROUTE_PATH_LABEL_PATTERN}\\s*:?\\s*(.+?)\\s*${EVM_ROUTE_PATH_SEPARATOR_PATTERN}\\s*(.+?)(?=\\s+(?:Transaction|Txn|Method|Function|Fee|Gas)\\b|$)`,
    'iu',
  ).exec(compactText);
  if (pathMatch !== null) {
    return inferEvmPathEndpointSide(pathMatch[1] ?? '', pathMatch[2] ?? '', tokenIdentifiers);
  }

  const indexedPathSide = inferEvmIndexedPathTradeSide(compactText, tokenIdentifiers);
  if (indexedPathSide !== 'unknown') {
    return indexedPathSide;
  }

  const arrayPathSide = inferEvmArrayPathTradeSide(compactText, tokenIdentifiers);
  if (arrayPathSide !== 'unknown') {
    return arrayPathSide;
  }

  const whitespaceAddressPathSide = inferEvmWhitespaceAddressPathTradeSide(
    compactText,
    tokenIdentifiers,
  );
  if (whitespaceAddressPathSide !== 'unknown') {
    return whitespaceAddressPathSide;
  }

  const whitespaceTokenPathSide = inferEvmWhitespaceTokenPathTradeSide(
    compactText,
    tokenIdentifiers,
  );
  if (whitespaceTokenPathSide !== 'unknown') {
    return whitespaceTokenPathSide;
  }

  const listPathMatch = new RegExp(
    `\\b${EVM_ROUTE_PATH_LABEL_PATTERN}\\s*:?\\s*(?:\\[|\\()?\\s*(.+?)\\s*[\\])]?(?=\\s+(?:Transaction|Txn|Method|Function|Fee|Gas)\\b|$)`,
    'iu',
  ).exec(compactText);
  const listPath = listPathMatch?.[1];
  if (listPath === undefined) {
    return 'unknown';
  }

  const pathItems = listPath
    .split(/\s*,\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
  if (pathItems.length < 2) {
    return 'unknown';
  }

  return inferEvmPathEndpointSide(
    pathItems[0] ?? '',
    pathItems[pathItems.length - 1] ?? '',
    tokenIdentifiers,
  );
}

function inferEvmIndexedPathTradeSide(
  compactText: string,
  tokenIdentifiers: string[],
): BrowserTradeSide {
  const indexedItems = Array.from(
    compactText.matchAll(
      new RegExp(
        `\\b${EVM_ROUTE_PATH_LABEL_PATTERN}\\s*(?:\\[\\s*(\\d+)\\s*\\]|\\(\\s*(\\d+)\\s*\\)|\\.\\s*(\\d+))\\s*:?\\s*(.+?)(?=\\s+\\b${EVM_ROUTE_PATH_LABEL_PATTERN}\\s*(?:\\[\\s*\\d+\\s*\\]|\\(\\s*\\d+\\s*\\)|\\.\\s*\\d+)|\\s+(?:Transaction|Txn|Method|Function|Fee|Gas)\\b|$)`,
        'giu',
      ),
    ),
  )
    .map((match) => {
      const rawIndex = match[1] ?? match[2] ?? match[3];
      const value = match[4]?.trim();
      if (rawIndex === undefined || value === undefined || value.length === 0) {
        return undefined;
      }

      return { index: Number(rawIndex), value };
    })
    .filter((item): item is { index: number; value: string } => item !== undefined)
    .filter((item) => Number.isInteger(item.index))
    .sort((left, right) => left.index - right.index);

  if (indexedItems.length < 2) {
    return 'unknown';
  }

  return inferEvmPathEndpointSide(
    indexedItems[0]?.value ?? '',
    indexedItems[indexedItems.length - 1]?.value ?? '',
    tokenIdentifiers,
  );
}

function inferEvmWhitespaceAddressPathTradeSide(
  compactText: string,
  tokenIdentifiers: string[],
): BrowserTradeSide {
  const pathSectionMatch = new RegExp(
    `\\b${EVM_ROUTE_PATH_LABEL_PATTERN}\\b(?:\\s*\\([^)]{0,80}\\))?\\s*:?\\s*(.+?)(?=\\s+(?:recipient|receiver|dstReceiver|dst_receiver|recipientAddress|recipient_address|receiverAddress|receiver_address|beneficiary|beneficiaryAddress|beneficiary_address|refundReceiver|refund_receiver|refundAddress|refund_address|to|amount[A-Za-z0-9_]*|deadline|fee|sqrtPrice|Transaction|Txn|Method|Function|Gas)\\b|$)`,
    'iu',
  ).exec(compactText);
  const pathSection = pathSectionMatch?.[1];
  if (pathSection === undefined) {
    return 'unknown';
  }

  const addresses = Array.from(
    pathSection.matchAll(new RegExp(EVM_FLEXIBLE_ADDRESS_CAPTURE, 'giu')),
  )
    .map((match) => normalizeEvmAddress(match[0]))
    .filter((address): address is string => address !== undefined);
  if (addresses.length < 2) {
    return 'unknown';
  }

  return inferEvmPathEndpointSide(
    addresses[0] ?? '',
    addresses[addresses.length - 1] ?? '',
    tokenIdentifiers,
  );
}

function inferEvmWhitespaceTokenPathTradeSide(
  compactText: string,
  tokenIdentifiers: string[],
): BrowserTradeSide {
  const pathSectionMatch = new RegExp(
    `\\b${EVM_ROUTE_PATH_LABEL_PATTERN}\\b(?:\\s*\\([^)]{0,80}\\))?\\s*:?\\s*(.+?)(?=\\s+(?:recipient|receiver|dstReceiver|dst_receiver|recipientAddress|recipient_address|receiverAddress|receiver_address|beneficiary|beneficiaryAddress|beneficiary_address|refundReceiver|refund_receiver|refundAddress|refund_address|to|amount[A-Za-z0-9_]*|deadline|fee|sqrtPrice|Transaction|Txn|Method|Function|Gas)\\b|$)`,
    'iu',
  ).exec(compactText);
  const pathSection = pathSectionMatch?.[1];
  if (pathSection === undefined) {
    return 'unknown';
  }

  const pathItems = pathSection
    .replace(/[()[\],]/gu, ' ')
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/^(?:address|address\[\]|tuple|bytes)$/iu.test(item));
  if (pathItems.length < 2) {
    return 'unknown';
  }

  return inferEvmPathEndpointSide(
    pathItems[0] ?? '',
    pathItems[pathItems.length - 1] ?? '',
    tokenIdentifiers,
  );
}

function inferEvmPackedPathTradeSide(
  compactText: string,
  tokenIdentifiers: string[],
  direction: 'forward' | 'reversed',
): BrowserTradeSide {
  const packedPathMatch = new RegExp(
    `\\b${EVM_ROUTE_PATH_LABEL_PATTERN}\\b(?:\\s*\\([^)]{0,80}\\))?\\s*:?\\s*((?:0x)?(?:[a-fA-F0-9]\\s*){86,})\\b`,
    'iu',
  ).exec(compactText);
  const packedPath = packedPathMatch?.[1]?.replace(/\s+/gu, '');
  if (packedPath === undefined) {
    return 'unknown';
  }

  const pathHex =
    packedPath.startsWith('0x') || packedPath.startsWith('0X') ? packedPath.slice(2) : packedPath;
  if ((pathHex.length - 40) % 46 !== 0) {
    return 'unknown';
  }

  const addresses = [`0x${pathHex.slice(0, 40)}`];
  for (let index = 40; index < pathHex.length; index += 46) {
    addresses.push(`0x${pathHex.slice(index + 6, index + 46)}`);
  }

  if (!addresses.every((address) => EVM_ADDRESS_PATTERN.test(address))) {
    return 'unknown';
  }

  const firstAddress = addresses[0] ?? '';
  const lastAddress = addresses[addresses.length - 1] ?? '';
  return direction === 'reversed'
    ? inferEvmPathEndpointSide(lastAddress, firstAddress, tokenIdentifiers)
    : inferEvmPathEndpointSide(firstAddress, lastAddress, tokenIdentifiers);
}

function inferEvmArrayPathTradeSide(
  compactText: string,
  tokenIdentifiers: string[],
): BrowserTradeSide {
  const pathSectionMatch = new RegExp(
    `\\b${EVM_ROUTE_PATH_LABEL_PATTERN}\\b\\s*(.+?)(?=\\s+(?:Transaction|Txn|Method|Function|Fee|Gas)\\b|$)`,
    'iu',
  ).exec(compactText);
  const pathSection = pathSectionMatch?.[1];
  if (pathSection === undefined) {
    return 'unknown';
  }

  const indexedItems = Array.from(
    pathSection.matchAll(
      /(?:^|\s)(?:\[\s*(\d+)\s*\]|\(\s*(\d+)\s*\)|(?:index\s*)?(\d+)\s*:)\s*(.+?)(?=\s+(?:\[\s*\d+\s*\]|\(\s*\d+\s*\)|(?:index\s*)?\d+\s*:)|$)/giu,
    ),
  )
    .map((match) => {
      const rawIndex = match[1] ?? match[2] ?? match[3];
      const value = match[4]?.trim();
      if (rawIndex === undefined || value === undefined || value.length === 0) {
        return undefined;
      }

      return { index: Number(rawIndex), value };
    })
    .filter((item): item is { index: number; value: string } => item !== undefined)
    .filter((item) => Number.isInteger(item.index))
    .sort((left, right) => left.index - right.index);

  if (indexedItems.length < 2) {
    return 'unknown';
  }

  return inferEvmPathEndpointSide(
    indexedItems[0]?.value ?? '',
    indexedItems[indexedItems.length - 1]?.value ?? '',
    tokenIdentifiers,
  );
}

function inferEvmPathEndpointSide(
  inputSide: string,
  outputSide: string,
  tokenIdentifiers: string[],
): BrowserTradeSide {
  if (evmSwapSideContainsToken(inputSide, tokenIdentifiers)) {
    return 'sell';
  }
  if (evmSwapSideContainsToken(outputSide, tokenIdentifiers)) {
    return 'buy';
  }

  return 'unknown';
}

function inferEvmTokenInOutTradeSide(
  compactText: string,
  tokenIdentifiers: string[],
): BrowserTradeSide {
  const tokenPairFieldPatterns = [
    {
      input: '_?tokens?(?:[_\\s-]*in)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output: '_?tokens?(?:[_\\s-]*out)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input: '_?token(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))(?:[_\\s-]*in)',
      output: '_?token(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))(?:[_\\s-]*out)',
    },
    {
      input: '_?token(?:[_\\s-]*from)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output: '_?token(?:[_\\s-]*to)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input: '_?tokens?(?:[_\\s-]*sold)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output: '_?tokens?(?:[_\\s-]*bought)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input:
        '_?(?:sold|sell)(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output:
        '_?(?:bought|buy)(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input:
        '_?(?:pay|paid|spend|spent)(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output:
        '_?(?:receive|received)(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input: '_?taker(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output: '_?maker(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input:
        '_?(?:src|source)(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output:
        '_?(?:dst|dest|destination)(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input:
        '_?(?:from|input|in|sell)(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output:
        '_?(?:to|output|out|buy)(?:[_\\s-]*tokens?)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input:
        '_?(?:(?:src|source|from|input|sell|sold|pay|paid|spend|spent)(?:[_\\s-]*asset)|asset(?:[_\\s-]*(?:in|from|sold)))(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output:
        '_?(?:(?:dst|dest|destination|to|output|buy|bought|receive|received)(?:[_\\s-]*asset)|asset(?:[_\\s-]*(?:out|to|bought)))(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input: '_?taker(?:[_\\s-]*asset)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output: '_?maker(?:[_\\s-]*asset)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input: '_?asset(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))(?:[_\\s-]*(?:in|from))',
      output: '_?asset(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))(?:[_\\s-]*(?:out|to))',
    },
    {
      input:
        '_?(?:(?:src|source|from|input|sell|sold|pay|paid|spend|spent)(?:[_\\s-]*currenc(?:y|ies))|currenc(?:y|ies)(?:[_\\s-]*(?:in|sold)))(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output:
        '_?(?:(?:dst|dest|destination|to|output|buy|bought|receive|received)(?:[_\\s-]*currenc(?:y|ies))|currenc(?:y|ies)(?:[_\\s-]*(?:out|bought)))(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input:
        '_?currenc(?:y|ies)(?:[_\\s-]*(?:from|input|sell|pay|paid|spend|spent))(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
      output:
        '_?currenc(?:y|ies)(?:[_\\s-]*(?:to|output|buy|receive|received))(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))?',
    },
    {
      input:
        '_?currenc(?:y|ies)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))(?:[_\\s-]*(?:in|from))',
      output:
        '_?currenc(?:y|ies)(?:[_\\s-]*(?:address(?:es)?|addrs?|symbols?|names?))(?:[_\\s-]*(?:out|to))',
    },
  ];

  for (const pattern of tokenPairFieldPatterns) {
    const fieldOwnerPrefix = '(?:[A-Za-z0-9_]+\\.)*';
    const inputFirstMatch = new RegExp(
      `(?:^|\\s)${fieldOwnerPrefix}${pattern.input}\\b\\s*:?\\s*(.+?)\\s+${fieldOwnerPrefix}${pattern.output}\\b\\s*:?\\s*(.+?)(?=\\s+(?:fee|recipient|amount|sqrtPrice|Transaction|Txn|Method|Function|Deadline|Gas)\\b|$)`,
      'iu',
    ).exec(compactText);
    if (inputFirstMatch !== null) {
      return inferEvmPathEndpointSide(
        inputFirstMatch[1] ?? '',
        inputFirstMatch[2] ?? '',
        tokenIdentifiers,
      );
    }

    const outputFirstMatch = new RegExp(
      `(?:^|\\s)${fieldOwnerPrefix}${pattern.output}\\b\\s*:?\\s*(.+?)\\s+${fieldOwnerPrefix}${pattern.input}\\b\\s*:?\\s*(.+?)(?=\\s+(?:fee|recipient|amount|sqrtPrice|Transaction|Txn|Method|Function|Deadline|Gas)\\b|$)`,
      'iu',
    ).exec(compactText);
    if (outputFirstMatch !== null) {
      return inferEvmPathEndpointSide(
        outputFirstMatch[2] ?? '',
        outputFirstMatch[1] ?? '',
        tokenIdentifiers,
      );
    }
  }

  return 'unknown';
}

function inferEvmSwapActionSide(compactText: string, tokenIdentifiers: string[]): BrowserTradeSide {
  const swapActionPattern = new RegExp(
    `\\b(?:Swap|Swapped|Exchange|Exchanged|Trade|Traded|Convert|Converted|Redeem|Redeemed)\\s+(.+?)(?:(?:\\s+(?:for|to|into)\\s+)|(?:\\s*${EVM_ROUTE_PATH_SEPARATOR_PATTERN}\\s*))(.+?)(?=\\s+(?:on\\b|via\\b|using\\b|through\\b|at\\b|from\\b|Transaction\\b|Txn\\b|Swap\\b|Swapped\\b|Exchange\\b|Exchanged\\b|Trade\\b|Traded\\b|Convert\\b|Converted\\b|Redeem\\b|Redeemed\\b|Bought\\b|Buy\\b|Purchased\\b|Purchase\\b|Sold\\b|Sell\\b|Fee\\b|Gas\\b)|$)`,
    'giu',
  );
  for (const match of compactText.matchAll(swapActionPattern)) {
    const fromSide = match[1] ?? '';
    const toSide = match[2] ?? '';
    if (evmSwapSideContainsToken(fromSide, tokenIdentifiers)) {
      return 'sell';
    }
    if (evmSwapSideContainsToken(toSide, tokenIdentifiers)) {
      return 'buy';
    }
  }

  return 'unknown';
}

function inferEvmTokenTransferTradeSide(
  text: string,
  tokenIdentifiers: string[],
  signerAddress: string | undefined,
  liquidityVenueAddresses: string[],
): BrowserTradeSide {
  const normalizedSignerAddress = normalizeEvmAddress(signerAddress)?.toLowerCase();
  if (normalizedSignerAddress === undefined) {
    return 'unknown';
  }
  const normalizedVenueAddresses = new Set(
    liquidityVenueAddresses
      .map((address) => normalizeEvmAddress(address)?.toLowerCase())
      .filter((address): address is string => address !== undefined),
  );

  const sourceLabel = '(?:From|Sender)';
  const destinationLabel = '(?:To|Recipient|Receiver)';
  const transferPattern = new RegExp(
    `\\b${sourceLabel}\\s*:?\\s+(.+?)\\s+${destinationLabel}\\s*:?\\s+(.+?)\\s+(?:For|Amount|Value|Quantity|Qty)\\s*:?\\s+(.+?)(?=\\s+(?:${sourceLabel}\\b|Transaction\\b|Txn\\b|Token\\b|Tokens\\b|ERC[-\\s]*20\\b|Fee\\b|Gas\\b|Value\\b|Quantity\\b|Qty\\b|Status\\b|Logs?\\b|Input\\b)|$)`,
    'giu',
  );
  const destinationFirstTransferPattern = new RegExp(
    `\\b${destinationLabel}\\s*:?\\s+(.+?)\\s+${sourceLabel}\\s*:?\\s+(.+?)\\s+(?:For|Amount|Value|Quantity|Qty)\\s*:?\\s+(.+?)(?=\\s+(?:${destinationLabel}\\b|${sourceLabel}\\b|Transaction\\b|Txn\\b|Token\\b|Tokens\\b|ERC[-\\s]*20\\b|Fee\\b|Gas\\b|Value\\b|Quantity\\b|Qty\\b|Status\\b|Logs?\\b|Input\\b)|$)`,
    'giu',
  );
  const amountFirstTransferPattern = new RegExp(
    `\\b(?:Transferred|Transfer)\\s+(.+?)\\s+${sourceLabel}\\s*:?\\s+(.+?)\\s+${destinationLabel}\\s*:?\\s+(.+?)(?=\\s+(?:Transferred\\b|Transfer\\b|${sourceLabel}\\b|Transaction\\b|Txn\\b|Token\\b|Tokens\\b|ERC[-\\s]*20\\b|BEP[-\\s]*20\\b|Fee\\b|Gas\\b|Value\\b|Quantity\\b|Qty\\b|Status\\b|Logs?\\b|Input\\b)|$)`,
    'giu',
  );
  const bareAmountFirstTransferPattern = new RegExp(
    `(?:^|\\s)(.+?)\\s+${sourceLabel}\\s*:?\\s+(.+?)\\s+${destinationLabel}\\s*:?\\s+(.+?)(?=\\s+(?:Transferred\\b|Transfer\\b|${sourceLabel}\\b|Transaction\\b|Txn\\b|Token\\b|Tokens\\b|ERC[-\\s]*20\\b|BEP[-\\s]*20\\b|Fee\\b|Gas\\b|Value\\b|Quantity\\b|Qty\\b|Status\\b|Logs?\\b|Input\\b)|$)`,
    'giu',
  );
  for (const section of evmTokenTransferSections(text)) {
    const compactSection = section.replace(/\s+/gu, ' ');
    for (const match of compactSection.matchAll(transferPattern)) {
      const fromSide = match[1] ?? '';
      const toSide = match[2] ?? '';
      const amountSide = match[3] ?? '';
      const side = inferEvmTokenTransferMatchSide(
        fromSide,
        toSide,
        amountSide,
        tokenIdentifiers,
        normalizedSignerAddress,
        normalizedVenueAddresses,
      );
      if (side !== 'unknown') {
        return side;
      }
    }
    for (const match of compactSection.matchAll(destinationFirstTransferPattern)) {
      const toSide = match[1] ?? '';
      const fromSide = match[2] ?? '';
      const amountSide = match[3] ?? '';
      const side = inferEvmTokenTransferMatchSide(
        fromSide,
        toSide,
        amountSide,
        tokenIdentifiers,
        normalizedSignerAddress,
        normalizedVenueAddresses,
      );
      if (side !== 'unknown') {
        return side;
      }
    }
    for (const match of compactSection.matchAll(amountFirstTransferPattern)) {
      const amountSide = match[1] ?? '';
      const fromSide = match[2] ?? '';
      const toSide = match[3] ?? '';
      const side = inferEvmTokenTransferMatchSide(
        fromSide,
        toSide,
        amountSide,
        tokenIdentifiers,
        normalizedSignerAddress,
        normalizedVenueAddresses,
      );
      if (side !== 'unknown') {
        return side;
      }
    }
    for (const match of compactSection.matchAll(bareAmountFirstTransferPattern)) {
      const amountSide = match[1] ?? '';
      const fromSide = match[2] ?? '';
      const toSide = match[3] ?? '';
      const side = inferEvmTokenTransferMatchSide(
        fromSide,
        toSide,
        amountSide,
        tokenIdentifiers,
        normalizedSignerAddress,
        normalizedVenueAddresses,
      );
      if (side !== 'unknown') {
        return side;
      }
    }
  }

  return 'unknown';
}

function inferEvmTokenTransferMatchSide(
  fromSide: string,
  toSide: string,
  amountSide: string,
  tokenIdentifiers: string[],
  normalizedSignerAddress: string,
  normalizedVenueAddresses: Set<string>,
): BrowserTradeSide {
  if (!evmSwapSideContainsToken(amountSide, tokenIdentifiers)) {
    return 'unknown';
  }

  const fromSigner = evmTextContainsAddress(fromSide, normalizedSignerAddress);
  const toSigner = evmTextContainsAddress(toSide, normalizedSignerAddress);
  const fromVenue =
    isEvmLiquidityVenueText(fromSide) ||
    evmTextContainsAnyAddress(fromSide, normalizedVenueAddresses);
  const toVenue =
    isEvmLiquidityVenueText(toSide) || evmTextContainsAnyAddress(toSide, normalizedVenueAddresses);
  if (toSigner && fromVenue) {
    return 'buy';
  }
  if (fromSigner && toVenue) {
    return 'sell';
  }

  return 'unknown';
}

function evmTokenTransferSections(text: string): string[] {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);
  const sections: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (
      !/\b(?:(?:ERC[-\s]*20|BEP[-\s]*20)\s+)?(?:Tokens?\s+Transferred|Token\s+Transfers?)\b/iu.test(
        line,
      )
    ) {
      continue;
    }

    sections.push(lines.slice(index, index + 40).join(' '));
  }

  return sections;
}

function evmTextContainsAddress(text: string, normalizedAddress: string): boolean {
  return evmAddressTextNeedles(normalizedAddress).some((needle) =>
    normalizeEvmExplorerAddressText(text).includes(normalizeEvmExplorerAddressText(needle)),
  );
}

function evmTextContainsAnyAddress(text: string, normalizedAddresses: Set<string>): boolean {
  if (normalizedAddresses.size === 0) {
    return false;
  }

  return Array.from(normalizedAddresses).some((address) =>
    evmAddressTextNeedles(address).some((needle) =>
      normalizeEvmExplorerAddressText(text).includes(normalizeEvmExplorerAddressText(needle)),
    ),
  );
}

function evmAddressTextNeedles(normalizedAddress: string): string[] {
  return [
    normalizedAddress,
    abbreviateAddress(normalizedAddress),
    `${normalizedAddress.slice(0, 6)}...${normalizedAddress.slice(-4)}`,
    `${normalizedAddress.slice(0, 10)}...${normalizedAddress.slice(-8)}`,
  ];
}

function isEvmLiquidityVenueText(text: string): boolean {
  return new RegExp(
    `\\b(?:${EVM_POOL_LABEL_PATTERN}|${EVM_ROUTER_LABEL_PATTERN}|Uniswap|PancakeSwap|SushiSwap|Aerodrome|Curve|Balancer|Camelot|Trader\\s+Joe|DODO(?:\\s+V\\d+)?|1inch|KyberSwap|OpenOcean|Maverick|Odos|ParaSwap|Matcha|CowSwap|CoW\\s+Swap|OKX\\s+DEX|0x\\s+(?:Exchange|Protocol)(?:\\s+Proxy)?|DEX)\\b`,
    'iu',
  ).test(text);
}

function evmTradeSideTokenIdentifiers(
  tokenText: string | undefined,
  tokenAddress?: string,
): string[] {
  const compact = tokenText?.trim().replace(/\s+/gu, ' ') ?? '';
  const identifiers = [
    ...(compact.length === 0
      ? []
      : [
          compact,
          ...tokenNameWithoutTicker(compact),
          ...Array.from(compact.matchAll(/\(([A-Za-z0-9.$_-]{2,20})\)/gu))
            .map((match) => match[1])
            .filter((value): value is string => value !== undefined),
          ...uppercaseTickerIdentifiers(compact),
        ]),
    ...(tokenAddress === undefined ? [] : [tokenAddress]),
  ];
  return Array.from(new Set(identifiers.map((identifier) => identifier.toLowerCase())));
}

function tokenNameWithoutTicker(text: string): string[] {
  const tokenName = text.replace(/\s*\([A-Za-z0-9.$_-]{2,20}\)\s*$/u, '').trim();
  return tokenName.length === 0 || tokenName === text ? [] : [tokenName];
}

function uppercaseTickerIdentifiers(text: string): string[] {
  return Array.from(text.matchAll(/\b[A-Z0-9.$_-]{2,20}\b/gu))
    .map((match) => match[0])
    .filter((value) => /[A-Z]/u.test(value));
}

function evmSwapSideContainsToken(sideText: string, tokenIdentifiers: string[]): boolean {
  const normalizedSide = sideText.toLowerCase();
  return tokenIdentifiers.some((identifier) => {
    const normalizedAddress = normalizeEvmAddress(identifier)?.toLowerCase();
    if (normalizedAddress !== undefined) {
      const searchTexts = evmAddressSideSearchTexts(normalizedSide);
      const addressPattern = new RegExp(
        `(?:^|[^a-z0-9])${escapeRegExp(normalizedAddress)}(?:[^a-z0-9]|$)`,
        'u',
      );
      const paddedAddressPattern = new RegExp(
        `(?:^|[^a-f0-9])(?:0x)?0{24}${normalizedAddress.slice(2)}(?:[^a-f0-9]|$)`,
        'u',
      );
      if (
        searchTexts.some(
          (searchText) => addressPattern.test(searchText) || paddedAddressPattern.test(searchText),
        )
      ) {
        return true;
      }

      return false;
    }

    const escaped = escapeRegExp(identifier);
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'u').test(normalizedSide);
  });
}

function evmAddressSideSearchTexts(normalizedSide: string): string[] {
  const compactedHexRuns = normalizedSide.replace(/([a-f0-9])\s+(?=[a-f0-9])/giu, '$1');
  return compactedHexRuns === normalizedSide
    ? [normalizedSide]
    : [normalizedSide, compactedHexRuns];
}

function evmExplorerName(chain: BrowserEvmChain): string {
  switch (chain) {
    case 'base':
      return 'BaseScan';
    case 'ethereum':
      return 'Etherscan';
    case 'bsc':
      return 'BscScan';
  }
}

function evmExplorerNameForUrl(chain: BrowserEvmChain, explorerUrl: string): string {
  try {
    const host = new URL(explorerUrl).hostname.toLowerCase().replace(/^www\./u, '');
    switch (host) {
      case 'basescan.org':
        return 'BaseScan';
      case 'base.blockscout.com':
        return 'Base Blockscout';
      case 'etherscan.io':
        return 'Etherscan';
      case 'eth.blockscout.com':
        return 'Ethereum Blockscout';
      case 'bscscan.com':
        return 'BscScan';
      case 'bsctrace.com':
        return 'BSCTrace';
    }
  } catch {
    // Fall back to the chain-level explorer name when the URL is not parseable.
  }

  return evmExplorerName(chain);
}

function abbreviateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
