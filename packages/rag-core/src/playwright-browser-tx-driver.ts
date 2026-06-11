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
  program?: string;
  signerAddress?: string;
  side: BrowserTradeSide;
  solscanUrl: string;
  transactionTime?: string;
}

interface XxyyExtraction {
  screenshotUrl?: string;
  text: string;
  xxyyPoolUrl?: string;
}

interface PageLink {
  href: string;
  text: string;
}

interface SearchItemCandidate {
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
const DEFAULT_TIMEOUT_MS = 60000;
const SOLSCAN_CLOUDFLARE_TEXT = /安全验证|Cloudflare|verify you are human|checking your browser/iu;
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
        const solscan = await extractSolscanTransaction(page, input.txHash, options);
        const xxyy = await extractXxyyPoolWindow(page, solscan, options);
        const tradeWindow = extractTradeWindowFromText(xxyy.text, solscan.signerAddress);

        return {
          ...(solscan.contractAddress === undefined
            ? {}
            : { contractAddress: solscan.contractAddress }),
          ...(solscan.poolAddress === undefined ? {} : { poolAddress: solscan.poolAddress }),
          ...(solscan.program === undefined ? {} : { program: solscan.program }),
          ...(xxyy.screenshotUrl === undefined ? {} : { screenshotUrl: xxyy.screenshotUrl }),
          solscanUrl: solscan.solscanUrl,
          targetTrade: {
            hash: input.txHash,
            side: solscan.side,
            summary: `Solscan signer ${solscan.signerAddress ?? 'unknown'}`,
            ...(solscan.transactionTime === undefined
              ? {}
              : { timestamp: solscan.transactionTime }),
            ...(solscan.signerAddress === undefined
              ? {}
              : { traderAddress: solscan.signerAddress }),
          },
          ...(solscan.transactionTime === undefined
            ? {}
            : { transactionTime: solscan.transactionTime }),
          tradeWindow,
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

  const program = extractProgram(bodyText);
  const signerAddress = extractSigner(bodyText);
  const transactionTime = extractTransactionTime(bodyText);

  return {
    ...(contractAddress === undefined ? {} : { contractAddress }),
    ...(poolAddress === undefined ? {} : { poolAddress }),
    ...(program === undefined ? {} : { program }),
    ...(signerAddress === undefined ? {} : { signerAddress }),
    side: inferTradeSide(bodyText, contractToken?.text),
    solscanUrl,
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
  solscan: SolscanExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<XxyyExtraction> {
  if (solscan.contractAddress === undefined && solscan.poolAddress === undefined) {
    return { text: '' };
  }

  if (await openXxyyPoolPageFromSolscan(page, solscan, options)) {
    return extractCurrentXxyyPoolPage(page, solscan, options);
  }

  if (solscan.contractAddress === undefined) {
    return { text: '' };
  }

  await openXxyyPoolPageViaSearch(page, solscan, options);
  return extractCurrentXxyyPoolPage(page, solscan, options);
}

async function openXxyyPoolPageFromSolscan(
  page: Page,
  solscan: SolscanExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<boolean> {
  if (solscan.poolAddress === undefined) {
    return false;
  }

  try {
    await page.goto(buildXxyySolPoolUrl(options.discoverUrl, solscan.poolAddress), {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(6000);
  } catch {
    return false;
  }

  return isExpectedXxyySolPoolUrl(page.url(), solscan.poolAddress);
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
  solscan: SolscanExtraction,
  options: PlaywrightBrowserTxAnalysisDriverOptions,
): Promise<XxyyExtraction> {
  const screenshotUrl = await screenshotPage(page, solscan, options);
  return {
    text: await page.locator('body').innerText(),
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

function toWindowTrade(line: string, index: number): BrowserTxTrade {
  return {
    hash: `xxyy-window-${index + 1}`,
    side: /卖出|Sell|sell/u.test(line) ? 'sell' : /买入|Buy|buy/u.test(line) ? 'buy' : 'unknown',
    summary: line,
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
): Promise<string | undefined> {
  const screenshotDir = resolveScreenshotDir(options);
  await mkdir(screenshotDir, { recursive: true });
  const fileName = `tx-analysis-${createHash('sha256')
    .update(solscan.solscanUrl)
    .digest('hex')
    .slice(0, 16)}.png`;
  const filePath = path.join(screenshotDir, fileName);
  await page.screenshot({ fullPage: true, path: filePath });

  return `${options.screenshotBaseUrl ?? '/assets'}/${fileName}`;
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
