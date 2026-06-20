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

    const txHash = env.API_SMOKE_TX_HASH?.trim();
    if (txHash !== undefined && txHash.length > 0) {
      await expectChatRoute({
        baseUrl,
        expectedAgentRoute: 'transaction_analysis',
        fetchFn,
        label: 'transaction analysis',
        message: txHash,
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
  const url = resolveUrl(baseUrl, '/health');
  let response;
  try {
    response = await fetchFn(url);
  } catch (error) {
    throw new Error(`GET ${url} failed: ${formatError(error)}`, { cause: error });
  }

  if (response.status !== 200) {
    throw new Error(`GET ${url} returned HTTP ${response.status}`);
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
  const payload = await postJson(
    fetchFn,
    resolveUrl(baseUrl, '/api/chat'),
    {
      channel: 'web',
      message,
    },
    label,
  );

  if (payload.agentRoute !== expectedAgentRoute) {
    throw new Error(
      `${label} expected agentRoute ${expectedAgentRoute}, got ${formatValue(payload.agentRoute)}`,
    );
  }

  if (requireAnswer && !isNonEmptyString(payload.answer)) {
    throw new Error(`${label} returned an empty answer`);
  }
}

async function postJson(fetchFn, url, body, label) {
  let response;
  try {
    response = await fetchFn(url, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  } catch (error) {
    throw new Error(`${label} POST ${url} failed: ${formatError(error)}`, { cause: error });
  }

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`${label} POST ${url} returned HTTP ${response.status}: ${responseText}`);
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`${label} POST ${url} returned invalid JSON: ${responseText}`);
  }

  if (!isRecord(payload)) {
    throw new Error(
      `${label} POST ${url} returned JSON ${describeJsonPayload(payload)}; expected object`,
    );
  }

  return payload;
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeJsonPayload(value) {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}

function formatValue(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function formatError(error) {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
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
