#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_BOUNDARY_QUESTION = '帮我查一下钱包余额';
const DEFAULT_PRODUCT_QUESTION = 'XXYY Pro 有哪些权益？';

export async function runAgentSmoke(options = {}) {
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const errorLog = options.error ?? ((message) => process.stderr.write(`${message}\n`));

  try {
    const baseUrl = normalizeBaseUrl(env.API_SMOKE_BASE_URL ?? DEFAULT_BASE_URL);

    await expectHealth(fetchFn, baseUrl);
    await expectChatRoute({
      baseUrl,
      expectedAgentRoute: 'product_answer',
      fetchFn,
      label: 'product question',
      message: env.API_SMOKE_PRODUCT_QUESTION ?? DEFAULT_PRODUCT_QUESTION,
      requireAnswer: true,
    });
    await expectChatRoute({
      baseUrl,
      expectedAgentRoute: 'boundary',
      fetchFn,
      label: 'boundary question',
      message: env.API_SMOKE_BOUNDARY_QUESTION ?? DEFAULT_BOUNDARY_QUESTION,
      requireAnswer: true,
    });

    if (env.API_SMOKE_TX_HASH !== undefined && env.API_SMOKE_TX_HASH.trim().length > 0) {
      await expectChatRoute({
        baseUrl,
        expectedAgentRoute: 'transaction_analysis',
        fetchFn,
        label: 'transaction analysis',
        message: env.API_SMOKE_TX_HASH,
        requireAnswer: true,
      });
    }

    log('agent smoke passed');
    return 0;
  } catch (error) {
    errorLog(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function expectHealth(fetchFn, baseUrl) {
  const response = await fetchFn(resolveUrl(baseUrl, '/health'));
  if (response.status !== 200) {
    throw new Error(`health returned HTTP ${response.status}`);
  }
}

async function expectChatRoute({
  baseUrl,
  expectedAgentRoute,
  fetchFn,
  label,
  message,
  requireAnswer,
}) {
  const payload = await postJson(fetchFn, resolveUrl(baseUrl, '/api/chat'), {
    channel: 'web',
    message,
  });

  if (payload.agentRoute !== expectedAgentRoute) {
    throw new Error(
      `${label} expected agentRoute ${expectedAgentRoute}, got ${formatValue(payload.agentRoute)}`,
    );
  }

  if (requireAnswer && !isNonEmptyString(payload.answer)) {
    throw new Error(`${label} returned an empty answer`);
  }
}

async function postJson(fetchFn, url, body) {
  const response = await fetchFn(url, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`chat returned HTTP ${response.status}: ${responseText}`);
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(`chat returned invalid JSON: ${responseText}`);
  }
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function resolveUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function formatValue(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function isDirectRun() {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  process.exitCode = await runAgentSmoke();
}
