import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core';

import type {
  BrowserSolanaTxSnapshot,
  BrowserTradeSide,
  BrowserTxAnalysisDriver,
  BrowserTxTrade,
} from './browser-tx-analysis.js';
import { resolveWorkspaceCwd } from './env.js';
import { TxAnalysisProviderUnavailableError } from './tx-analysis.js';

export interface PlaywrightBrowserTxAnalysisDriverOptions {
  chromeExecutablePath?: string;
  discoverUrl?: string;
  headless?: boolean;
  screenshotBaseUrl?: string;
  screenshotDir?: string;
  timeoutMs?: number;
  userDataDir?: string;
}

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

interface XxyyExtraction {
  screenshotUrl?: string;
  text: string;
  tradeWindow?: XxyyTradeWindow;
  xxyyPoolUrl?: string;
}

interface PageLink {
  href: string;
  text: string;
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
  priceUsd?: string;
  timestamp: number;
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
  selectedPoolAddress?: string;
  targetTrade: XxyyTradeRecord;
}

interface XxyyTradeQueryInput {
  poolAddress: string;
  signerAddress?: string;
  targetTimeMs?: number;
  txHash: string;
}

interface XxyyTradeQueryOutput {
  afterTrades: XxyyTradeRecord[];
  beforeTrades: XxyyTradeRecord[];
  targetTrade?: XxyyTradeRecord;
}

interface XxyyOriginalTradeListTargetPosition {
  rowHeight: number;
  targetIndex: number;
  targetRowY: number;
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
const DEFAULT_TIMEOUT_MS = 60000;
const XXYY_ORIGINAL_SCREENSHOT_MIN_HEIGHT = 1800;
const XXYY_ORIGINAL_SCREENSHOT_MIN_WIDTH = 1440;
const SOLSCAN_CLOUDFLARE_TEXT = /安全验证|Cloudflare|verify you are human|checking your browser/iu;
const SOLANA_ADDRESS_CAPTURE = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const STABLE_SOLANA_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

export function createPlaywrightBrowserTxAnalysisDriver(
  options: PlaywrightBrowserTxAnalysisDriverOptions = {},
): BrowserTxAnalysisDriver {
  return {
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

async function extractSolanaTransaction(
  page: Page,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<SolscanExtraction> {
  try {
    return await extractSolscanTransaction(page, txHash, options);
  } catch (error) {
    if (!(error instanceof TxAnalysisProviderUnavailableError)) {
      throw error;
    }

    return extractPublicSolanaTransactionFallback(page, txHash, options, error);
  }
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
  if (SOLSCAN_CLOUDFLARE_TEXT.test(bodyText)) {
    throw new TxAnalysisProviderUnavailableError(
      'Solscan 正在进行浏览器安全验证。请用可见 Chrome 完成验证后重试，或关闭 headless 模式。',
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
        /\b(Market|Pool)\b/iu.test(link.text),
    )?.address;
  const poolCandidates = poolAddress === undefined ? [] : [{ address: poolAddress }];

  const program = extractProgram(bodyText);
  const signerAddress = extractSigner(bodyText);
  const transactionTime = extractTransactionTime(bodyText);

  return {
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(poolAddress === undefined ? {} : { poolAddress }),
    poolCandidates,
    ...(program === undefined ? {} : { program }),
    ...(signerAddress === undefined ? {} : { signerAddress }),
    side: inferTradeSide(bodyText, contractToken?.text),
    solscanUrl,
    ...(transactionTime === undefined ? {} : { transactionTime }),
  };
}

async function extractPublicSolanaTransactionFallback(
  page: Page,
  txHash: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
  cause: Error,
): Promise<SolscanExtraction> {
  const explorer: Partial<SolscanExtraction> = await extractSolanaExplorerTransaction(
    page,
    txHash,
    options,
  ).catch((): Partial<SolscanExtraction> => ({}));
  const solanaFm: Partial<SolscanExtraction> = await extractSolanaFmTransaction(
    page,
    txHash,
    options,
  ).catch((): Partial<SolscanExtraction> => ({}));
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
    throw new TxAnalysisProviderUnavailableError(
      `Solscan 不可用，且公开浏览器 fallback 未能解析交易：${cause.message}`,
    );
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
  const signerAddress = new RegExp(`Fee payer\\s+(${SOLANA_ADDRESS_CAPTURE})`, 'u').exec(text)?.[1];
  const transactionTime = extractSolanaExplorerTransactionTime(text);
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
  const poolCandidates = extractSolanaFmPoolCandidates(text);
  const contractAddress = extractLikelyTokenMint(text);
  const transactionTime = extractSolanaFmTransactionTime(text);
  const program = new RegExp(`Interacted with program\\s+(${SOLANA_ADDRESS_CAPTURE})`, 'u').exec(
    text,
  )?.[1];
  const signerAddress = extractSignerFromProgramLogs(text);

  return {
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(poolCandidates[0] === undefined ? {} : { poolAddress: poolCandidates[0].address }),
    poolCandidates,
    ...(program === undefined ? {} : { program }),
    ...(signerAddress === undefined ? {} : { signerAddress }),
    ...(transactionTime === undefined ? {} : { transactionTime }),
  };
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

async function extractXxyyPoolWindow(
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

  await openXxyyPoolPageViaSearch(page, solscan, options);
  return extractCurrentXxyyPoolPage(page, txHash, solscan, options);
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
    if (!(await openXxyyPoolPage(page, candidate.address, options))) {
      continue;
    }

    const candidateSolscan = { ...solscan, poolAddress: candidate.address };
    const tradeWindow = await extractXxyyStructuredTradeWindow(page, txHash, candidateSolscan);
    if (tradeWindow === undefined) {
      continue;
    }

    const bestCandidate = selectXxyyPoolCandidate(candidates, tradeWindow.targetTrade);
    const extraction = await extractCurrentXxyyPoolPage(page, txHash, candidateSolscan, options, {
      ...tradeWindow,
      selectedPoolAddress: candidate.address,
    });

    if (bestCandidate === undefined || bestCandidate.address === candidate.address) {
      return extraction;
    }

    firstMatchedExtraction ??= extraction;
  }

  return firstMatchedExtraction;
}

async function openXxyyPoolPage(
  page: Page,
  poolAddress: string,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<boolean> {
  try {
    await page.goto(buildXxyySolPoolUrl(options.discoverUrl, poolAddress), {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(6000);
  } catch {
    return false;
  }

  return isExpectedXxyySolPoolUrl(page.url(), poolAddress);
}

async function openXxyyPoolPageViaSearch(
  page: Page,
  solscan: SolscanExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<void> {
  if (solscan.contractAddress === undefined) {
    throw new TxAnalysisProviderUnavailableError(
      'Solscan 未解析出合约地址，无法通过 XXYY 搜索兜底。',
    );
  }

  await page.goto(options.discoverUrl ?? DEFAULT_DISCOVER_URL, {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(5000);
  await page.locator('.search-trigger').first().click({ force: true });
  await page.waitForTimeout(500);
  await setSearchInputValue(page.locator('input.ipt').first(), solscan.contractAddress);
  await page.waitForTimeout(5000);

  const searchItems = await page.locator('.search-token-item').all();
  if (searchItems.length > 0) {
    const matchingItem = await findMatchingSearchItem(searchItems, solscan.poolAddress);
    await dispatchSearchItemClick(matchingItem);
    await page.waitForTimeout(6000);
  }

  if (
    solscan.poolAddress !== undefined &&
    !isExpectedXxyySolPoolUrl(page.url(), solscan.poolAddress)
  ) {
    throw new TxAnalysisProviderUnavailableError(
      `XXYY 搜索跳转后的池子地址与 Solscan 交易池子不一致：${solscan.poolAddress}`,
    );
  }
}

async function extractCurrentXxyyPoolPage(
  page: Page,
  txHash: string,
  solscan: SolscanExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
  knownTradeWindow?: XxyyTradeWindow,
): Promise<XxyyExtraction> {
  const tradeWindow =
    knownTradeWindow ?? (await extractXxyyStructuredTradeWindow(page, txHash, solscan));
  const screenshotUrl = await screenshotPage(page, solscan, options, tradeWindow);
  return {
    text: await page.locator('body').innerText(),
    ...(tradeWindow === undefined ? {} : { tradeWindow }),
    xxyyPoolUrl: page.url(),
    ...(screenshotUrl === undefined ? {} : { screenshotUrl }),
  };
}

export function buildXxyySolPoolUrl(discoverUrl: string | undefined, poolAddress: string): string {
  const url = new URL(discoverUrl ?? DEFAULT_DISCOVER_URL);
  return new URL(`/sol/${poolAddress}`, url.origin).toString();
}

function isExpectedXxyySolPoolUrl(pageUrl: string, poolAddress: string): boolean {
  try {
    return new URL(pageUrl).pathname === `/sol/${poolAddress}`;
  } catch {
    return false;
  }
}

function xxyyPoolCandidates(solscan: SolscanExtraction): XxyyPoolCandidate[] {
  return uniquePoolCandidates([
    ...solscan.poolCandidates,
    ...(solscan.poolAddress === undefined ? [] : [{ address: solscan.poolAddress }]),
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

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => value !== undefined && value.length > 0);
}

export function extractSolanaFmPoolCandidates(text: string): XxyyPoolCandidate[] {
  const pattern = new RegExp(
    `(${SOLANA_ADDRESS_CAPTURE})\\s+sent\\s+([0-9]+(?:\\.[0-9]+)?)\\s+Wrapped\\s+SOL`,
    'giu',
  );
  const candidates: XxyyPoolCandidate[] = [];

  for (const match of text.matchAll(pattern)) {
    const address = match[1];
    const nativeAmount = match[2];
    if (address === undefined || nativeAmount === undefined) {
      continue;
    }

    candidates.push({ address, nativeAmount });
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
  return /([0-9]+(?:\.[0-9]+)?)\s+SOL/u.exec(trade.summary)?.[1];
}

function decimalAmountsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeDecimal(left);
  const normalizedRight = normalizeDecimal(right);
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function normalizeDecimal(value: string): string | undefined {
  if (!/^\d+(?:\.\d+)?$/u.test(value)) {
    return undefined;
  }

  return value
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
  solscan: SolscanExtraction,
): Promise<XxyyTradeWindow | undefined> {
  if (solscan.poolAddress === undefined) {
    return undefined;
  }

  const targetTimeMs =
    solscan.transactionTime === undefined
      ? undefined
      : parseSolscanTransactionTime(solscan.transactionTime);
  const queryResult = await queryXxyyTradeWindow(page, {
    poolAddress: solscan.poolAddress,
    ...(solscan.signerAddress === undefined ? {} : { signerAddress: solscan.signerAddress }),
    ...(targetTimeMs === undefined ? {} : { targetTimeMs }),
    txHash,
  }).catch((error: unknown) => {
    throw new TxAnalysisProviderUnavailableError(
      `XXYY 结构化交易窗口查询失败：${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (queryResult?.targetTrade === undefined) {
    return undefined;
  }

  return buildXxyyTradeWindow({
    afterTrades: queryResult.afterTrades,
    beforeTrades: queryResult.beforeTrades,
    selectedPoolAddress: solscan.poolAddress,
    targetTrade: queryResult.targetTrade,
  });
}

async function queryXxyyTradeWindow(
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
      const isTradeRecord = (value) => {
        if (value === null || typeof value !== 'object') return false;
        return typeof value.maker === 'string'
          && typeof value.timestamp === 'number'
          && typeof value.txHash === 'string'
          && typeof value.type === 'string';
      };
      const searchTrades = async (extra) => {
        const response = await fetch('/api/data/trades/search', {
          body: JSON.stringify({ ...basePayload, ...extra }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
        const body = await response.json();
        return Array.isArray(body.data) ? body.data.filter(isTradeRecord) : [];
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
          const target = trades.find((trade) => trade.txHash === queryInput.txHash);
          if (target !== undefined || trades.length === 0) return target;
          lastId = trades.at(-1)?.timestamp;
          if (lastId === undefined) return undefined;
        }
        return undefined;
      };
      const findTargetNearSolscanTime = async () => {
        if (queryInput.targetTimeMs === undefined) return undefined;
        const trades = await searchTrades({
          pageSize: 100,
          timeEnd: queryInput.targetTimeMs + 30000,
        });
        return trades.find((trade) => trade.txHash === queryInput.txHash);
      };
      const targetTrade = (await findTargetByMaker()) ?? (await findTargetNearSolscanTime());
      if (targetTrade === undefined) {
        return { afterTrades: [], beforeTrades: [] };
      }
      const [beforeTrades, afterTrades] = await Promise.all([
        searchTrades({ pageSize: 5, timeEnd: targetTrade.timestamp - 1 }),
        searchTrades({ pageSize: 5, reverse: 1, timeStart: targetTrade.timestamp + 1 }),
      ]);
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
    targetTrade: toBrowserTrade(input.targetTrade),
    tradeWindow: {
      after: input.afterTrades.slice(0, 5).map(toBrowserTrade),
      before: input.beforeTrades.slice(0, 5).reverse().map(toBrowserTrade),
    },
  };
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

function normalizeXxyyTradeQueryOutput(value: unknown): XxyyTradeQueryOutput {
  if (value === null || typeof value !== 'object') {
    return { afterTrades: [], beforeTrades: [] };
  }

  const record = value as Record<string, unknown>;
  return {
    afterTrades: Array.isArray(record.afterTrades)
      ? record.afterTrades.filter(isXxyyTradeRecord)
      : [],
    beforeTrades: Array.isArray(record.beforeTrades)
      ? record.beforeTrades.filter(isXxyyTradeRecord)
      : [],
    ...(isXxyyTradeRecord(record.targetTrade) ? { targetTrade: record.targetTrade } : {}),
  };
}

function isXxyyTradeRecord(value: unknown): value is XxyyTradeRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.maker === 'string' &&
    typeof record.timestamp === 'number' &&
    typeof record.txHash === 'string' &&
    typeof record.type === 'string'
  );
}

function toWindowTrade(line: string, index: number): BrowserTxTrade {
  return {
    hash: `xxyy-window-${index + 1}`,
    side: /卖出|Sell|sell/u.test(line) ? 'sell' : /买入|Buy|buy/u.test(line) ? 'buy' : 'unknown',
    summary: line,
  };
}

function toBrowserTrade(record: XxyyTradeRecord): BrowserTxTrade {
  return {
    hash: record.txHash,
    side: toBrowserTradeSide(record.type),
    summary: formatXxyyTradeSummary(record),
    timestamp: new Date(record.timestamp).toISOString(),
    traderAddress: record.maker,
  };
}

function toBrowserTradeSide(side: string): BrowserTradeSide {
  if (/^buy$/iu.test(side)) {
    return 'buy';
  }
  if (/^sell$/iu.test(side)) {
    return 'sell';
  }

  return 'unknown';
}

function formatXxyyTradeSummary(record: XxyyTradeRecord): string {
  const amountDetails = [
    record.usdAmount === undefined ? undefined : `$${record.usdAmount}`,
    record.tokenAmount === undefined ? undefined : `${record.tokenAmount} token`,
    record.nativeAmount === undefined ? undefined : `${record.nativeAmount} SOL`,
  ].filter((item): item is string => item !== undefined);

  return [`XXYY ${record.type}`, ...amountDetails].join(' ');
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

async function findMatchingSearchItem(items: Locator[], poolAddress: string | undefined) {
  const firstItem = items[0];
  if (firstItem === undefined) {
    throw new TxAnalysisProviderUnavailableError('XXYY 搜索结果为空，无法定位池子页面。');
  }

  const candidates = await Promise.all(
    items.map(async (item) => ({
      text: await item.innerText().catch(() => ''),
    })),
  );
  const index = selectMatchingSearchItemIndex(candidates, poolAddress);
  if (index < 0) {
    throw new TxAnalysisProviderUnavailableError(
      `XXYY 搜索结果未匹配到 Solscan 交易池子：${poolAddress}`,
    );
  }

  return items[index] ?? firstItem;
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

  const abbreviated = abbreviateAddress(poolAddress);
  const index = candidates.findIndex((candidate) => candidate.text.includes(abbreviated));
  return index >= 0 ? index : -1;
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
  solscan: SolscanExtraction,
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
  const position = await scrollXxyyOriginalTradeListToTarget(page, tradeWindow, options);
  if (position === undefined) {
    throw new Error('Unable to position XXYY original trade list on target transaction');
  }

  const marked = await markXxyyOriginalTargetTradeRow(page, position);
  if (!marked) {
    throw new Error('Unable to mark target transaction row in XXYY original trade list');
  }

  await page.locator('.dashboard-bd-trades').first().screenshot({ path: filePath });
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
  const scrollerSelector = '.dashboard-bd-trades .vue-recycle-scroller';
  await page
    .locator(scrollerSelector)
    .first()
    .waitFor({
      state: 'visible',
      timeout: Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15000),
    });

  const metrics = await readXxyyOriginalScrollerMetrics(page, scrollerSelector);
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
    const foundIndex = rows.findIndex((row) => row.txHash === tradeWindow.targetTrade.hash);
    if (foundIndex >= 0) {
      targetIndex = startIndex + foundIndex;
    }

    seenRows += rows.length;
    lastTimestamp = rows.at(-1)?.timestamp ?? lastTimestamp;
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
      await scrollXxyyOriginalTradeListToBottom(page, scrollerSelector);
      await responsePromise;
      await page.waitForTimeout(200);
    }
  } finally {
    page.off('response', responseListener);
  }

  if (targetIndex < 0) {
    return undefined;
  }

  const latestMetrics = await readXxyyOriginalScrollerMetrics(page, scrollerSelector);
  await scrollXxyyOriginalTradeListTo(page, scrollerSelector, {
    scrollTop: calculateXxyyOriginalTradeScrollTop({
      clientHeight: latestMetrics.clientHeight,
      rowHeight: latestMetrics.rowHeight,
      targetIndex,
    }),
  });
  await page.waitForTimeout(800);

  const positionedMetrics = await readXxyyOriginalScrollerMetrics(page, scrollerSelector);
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

async function readXxyyOriginalScrollerMetrics(
  page: Page,
  scrollerSelector: string,
): Promise<{ clientHeight: number; loadedRows: number; rowHeight: number; scrollTop: number }> {
  const metrics = await page.evaluate<unknown>(
    `(() => {
      const scroller = document.querySelector(${JSON.stringify(scrollerSelector)});
      if (!(scroller instanceof HTMLElement)) {
        return { clientHeight: 0, loadedRows: 0, rowHeight: 40 };
      }

      const firstRow = scroller.querySelector('.vue-recycle-scroller__item-view');
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

async function scrollXxyyOriginalTradeListToBottom(
  page: Page,
  scrollerSelector: string,
): Promise<void> {
  await page.evaluate<void>(
    `(() => {
      const scroller = document.querySelector(${JSON.stringify(scrollerSelector)});
      if (scroller instanceof HTMLElement) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    })()`,
  );
}

async function scrollXxyyOriginalTradeListTo(
  page: Page,
  scrollerSelector: string,
  input: { scrollTop: number },
): Promise<void> {
  await page.evaluate<void>(
    `(() => {
      const scroller = document.querySelector(${JSON.stringify(scrollerSelector)});
      if (scroller instanceof HTMLElement) {
        scroller.scrollTop = ${JSON.stringify(input.scrollTop)};
      }
    })()`,
  );
}

async function markXxyyOriginalTargetTradeRow(
  page: Page,
  position: XxyyOriginalTradeListTargetPosition,
): Promise<boolean> {
  const payload = {
    rowHeight: position.rowHeight,
    targetRowY: position.targetRowY,
  };

  return page.evaluate<boolean>(`
    (() => {
      const payload = ${JSON.stringify(payload)};
      const scroller = document.querySelector('.dashboard-bd-trades .vue-recycle-scroller');
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
      const rows = Array.from(scroller.querySelectorAll('.row.row-clickable'));
      let bestRow;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const row of rows) {
        if (!(row instanceof HTMLElement)) {
          continue;
        }

        const rect = row.getBoundingClientRect();
        if (rect.bottom < scrollerRect.top || rect.top > scrollerRect.bottom) {
          continue;
        }

        const distance = Math.abs(rect.top + rect.height / 2 - targetY);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestRow = row;
        }
      }

      if (!(bestRow instanceof HTMLElement) || bestDistance > payload.rowHeight * 1.5) {
        return false;
      }

      bestRow.classList.add('xxyy-target-trade-marker');
      return true;
    })()
  `);
}

function extractXxyyResponseTradeRows(value: unknown): XxyyTradeRecord[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }

  const data = (value as Record<string, unknown>).data;
  return Array.isArray(data) ? data.filter(isXxyyTradeRecord) : [];
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

function extractLastPathSegment(url: string): string {
  return url.split('/').filter(Boolean).at(-1) ?? '';
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
  const match = /Signer\s+([1-9A-HJ-NP-Za-km-z]{32,44})/u.exec(text.replace(/\s+/gu, ' '));
  return match?.[1];
}

function extractTransactionTime(text: string): string | undefined {
  const match = /(\d{2}:\d{2}:\d{2}\s+[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\(UTC\))/u.exec(text);
  return match?.[1];
}

function extractSolanaFmTransactionTime(text: string): string | undefined {
  const match = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+UTC/u.exec(text);
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

  return `${hour}:${minute}:${second} ${month} ${Number(day)}, ${year} (UTC)`;
}

function extractSolanaExplorerTransactionTime(text: string): string | undefined {
  const match =
    /Timestamp\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{2}):(\d{2}):(\d{2})\s+([A-Za-z ]+ Time)/u.exec(
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
    second === undefined
  ) {
    return undefined;
  }

  const monthNumber = monthIndex(month);
  if (monthNumber === undefined) {
    return undefined;
  }

  const timezoneOffsetHours = timezoneName === 'China Standard Time' ? -8 : 0;
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
  const afterOrderLog = okxLogIndex < 0 ? text : text.slice(okxLogIndex);
  const addresses = afterOrderLog.match(new RegExp(SOLANA_ADDRESS_CAPTURE, 'gu')) ?? [];
  return addresses.find(
    (address) =>
      SOLANA_ADDRESS_PATTERN.test(address) &&
      !STABLE_SOLANA_MINTS.has(address) &&
      !/pump$/u.test(address) &&
      address !== 'CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH',
  );
}

function parseSolscanTransactionTime(value: string): number | undefined {
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

  return Date.UTC(
    Number(groups.year),
    month,
    Number(groups.day),
    Number(groups.hour),
    Number(groups.minute),
    Number(groups.second),
  );
}

function fullMonthToShort(month: string | undefined): string | undefined {
  if (month === undefined) {
    return undefined;
  }

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
  }[month];
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
  }[month];
}

function inferTradeSide(text: string, tokenSymbol: string | undefined): BrowserTradeSide {
  if (tokenSymbol === undefined || tokenSymbol.length === 0) {
    return 'unknown';
  }

  const compact = text.replace(/\s+/gu, ' ');
  const firstSwap = /Swap\s+(.+?)\s+for\s+(.+?)\s+on\s+/iu.exec(compact);
  if (firstSwap === null) {
    return 'unknown';
  }

  const fromSide = firstSwap[1] ?? '';
  const toSide = firstSwap[2] ?? '';
  if (fromSide.includes(tokenSymbol)) {
    return 'sell';
  }
  if (toSide.includes(tokenSymbol)) {
    return 'buy';
  }

  return 'unknown';
}

function abbreviateAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
