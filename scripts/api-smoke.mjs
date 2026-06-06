#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_CHAT_QUESTION = 'XXYY Pro 有哪些权益？';

export function createApiSmokeChecks(args, env = process.env) {
  const options = parseApiSmokeArgs(args, env);
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

  if (options.chat) {
    checks.push(
      createCheck('chat', 'chat', options.baseUrl, '/api/chat', {
        body: JSON.stringify({ channel: 'cli', message: options.question }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
  }

  return checks;
}

export async function runApiSmoke(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  const checks = createApiSmokeChecks(args, env);

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
      return 1;
    }

    const validationError = validatePayload(check, payload);
    if (validationError !== undefined) {
      log(`Failed ${check.label}: ${validationError}`);
      log(formatPayload(payload));
      return 1;
    }

    log(`OK ${check.label}`);
  }

  log('API smoke passed.');
  return 0;
}

function parseApiSmokeArgs(args, env) {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  let baseUrl = normalizeBaseUrl(env.API_BASE_URL ?? DEFAULT_BASE_URL);
  let chat = false;
  let opsToken = normalizeOptionalText(env.API_OPS_TOKEN);
  let question = DEFAULT_CHAT_QUESTION;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const option = normalizedArgs[index];

    if (option === '--chat') {
      chat = true;
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

    throw new Error(`Unknown option: ${option}`);
  }

  return { baseUrl, chat, opsToken, question };
}

function createCheck(kind, label, baseUrl, pathname, options = {}) {
  return {
    body: options.body,
    headers: options.headers ?? {},
    kind,
    label,
    method: options.method ?? 'GET',
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

async function readPayload(response) {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}

function validatePayload(check, payload) {
  if (check.kind === 'chat') {
    if (payload === null || typeof payload !== 'object') {
      return 'chat response must be JSON.';
    }
    if (typeof payload.answer !== 'string' || payload.answer.trim().length === 0) {
      return 'chat response must include an answer.';
    }
    if (!Array.isArray(payload.citations) || payload.citations.length === 0) {
      return 'chat response must include citations.';
    }
  }

  return undefined;
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
