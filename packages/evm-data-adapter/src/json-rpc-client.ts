import { createHash } from 'node:crypto';

import {
  evmRpcCallSchema,
  evmRpcProviderConfigSchema,
  type EvmRpcCall,
  type EvmRpcProviderConfig,
} from './contracts.js';
import { EvmDataAdapterConfigurationError, EvmRpcRequestError } from './errors.js';

const DEFAULT_MAX_BATCH_SIZE = 4;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const ABSOLUTE_MAX_BATCH_SIZE = 20;
const ABSOLUTE_MAX_RESPONSE_BYTES = 5_242_880;
const ABSOLUTE_MAX_RETRIES = 3;
const ABSOLUTE_MAX_REQUEST_TIMEOUT_MS = 120_000;
const ABSOLUTE_MAX_RETRY_BASE_DELAY_MS = 2_000;

export interface EvmRpcCallSuccess {
  call: EvmRpcCall;
  ok: true;
  result: unknown;
}

export interface EvmRpcCallFailure {
  call: EvmRpcCall;
  error: { code: number };
  ok: false;
}

export type EvmRpcCallOutcome = EvmRpcCallSuccess | EvmRpcCallFailure;

export interface EvmRpcBatchResult {
  attempts: number;
  outcomes: EvmRpcCallOutcome[];
  payloadHash: string;
}

export interface EvmJsonRpcClient {
  readonly providerId: string;
  readonly provenanceUrl: string;
  requestBatch(
    calls: readonly EvmRpcCall[],
    options?: { signal?: AbortSignal | undefined },
  ): Promise<EvmRpcBatchResult>;
}

export interface CreateEvmJsonRpcClientOptions {
  allowInsecureLocalhost?: boolean;
  fetchImpl?: typeof fetch;
  maxBatchSize?: number;
  maxResponseBytes?: number;
  maxRetries?: number;
  provider: EvmRpcProviderConfig;
  requestTimeoutMs?: number;
  retryBaseDelayMs?: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface HttpAttemptResult {
  ok: boolean;
  status: number;
  text?: string | undefined;
}

interface JsonRpcWireResponse {
  error?: { code: number } | undefined;
  hasError: boolean;
  hasResult: boolean;
  id: number;
  result?: unknown;
}

export function createEvmJsonRpcClient(options: CreateEvmJsonRpcClientOptions): EvmJsonRpcClient {
  let provider: EvmRpcProviderConfig;
  try {
    provider = evmRpcProviderConfigSchema.parse(options.provider);
  } catch (cause) {
    throw new EvmDataAdapterConfigurationError(
      'invalid_configuration',
      'EVM RPC provider configuration is invalid.',
      { cause },
    );
  }

  const endpoint = parseAllowedEndpoint(
    provider.endpoint,
    options.allowInsecureLocalhost ?? false,
    provider.id,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBatchSize = boundedPositiveInteger(
    options.maxBatchSize,
    DEFAULT_MAX_BATCH_SIZE,
    ABSOLUTE_MAX_BATCH_SIZE,
    'maxBatchSize',
  );
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    ABSOLUTE_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  const maxRetries = boundedNonNegativeInteger(
    options.maxRetries,
    DEFAULT_MAX_RETRIES,
    ABSOLUTE_MAX_RETRIES,
    'maxRetries',
  );
  const requestTimeoutMs = boundedPositiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    ABSOLUTE_MAX_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  );
  const retryBaseDelayMs = boundedNonNegativeInteger(
    options.retryBaseDelayMs,
    DEFAULT_RETRY_BASE_DELAY_MS,
    ABSOLUTE_MAX_RETRY_BASE_DELAY_MS,
    'retryBaseDelayMs',
  );
  const sleep = options.sleep ?? abortableSleep;
  const headers = {
    accept: 'application/json',
    ...(provider.headers ?? {}),
    'content-type': 'application/json',
  };

  return {
    providerId: provider.id,
    provenanceUrl: endpoint.origin,

    async requestBatch(calls, requestOptions = {}) {
      if (calls.length === 0 || calls.length > maxBatchSize) {
        throw new EvmDataAdapterConfigurationError(
          'invalid_configuration',
          `EVM RPC batch size must be between 1 and ${maxBatchSize}.`,
        );
      }

      let parsedCalls: EvmRpcCall[];
      try {
        parsedCalls = calls.map((call) => evmRpcCallSchema.parse(call));
      } catch (cause) {
        throw new EvmDataAdapterConfigurationError(
          'invalid_configuration',
          'EVM RPC batch contains an unsupported or invalid call.',
          { cause },
        );
      }

      const requestBody = JSON.stringify(
        parsedCalls.map((call, index) => ({
          id: index + 1,
          jsonrpc: '2.0',
          method: call.method,
          params: call.params,
        })),
      );

      for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
        try {
          const response = await executeHttpAttempt({
            endpoint,
            fetchImpl,
            headers,
            maxResponseBytes,
            providerId: provider.id,
            requestBody,
            requestTimeoutMs,
            signal: requestOptions.signal,
            attempt,
          });
          if (!response.ok) {
            const retryable = isRetryableHttpStatus(response.status);
            throw new EvmRpcRequestError('http_error', provider.id, retryable, attempt, {
              httpStatus: response.status,
            });
          }
          if (response.text === undefined) {
            throw new EvmRpcRequestError('invalid_json', provider.id, false, attempt);
          }

          return {
            attempts: attempt,
            outcomes: parseJsonRpcResponse(response.text, parsedCalls, provider.id, attempt),
            payloadHash: `sha256:${createHash('sha256').update(response.text).digest('hex')}`,
          };
        } catch (error) {
          if (!(error instanceof EvmRpcRequestError)) {
            throw error;
          }
          if (!error.retryable || attempt > maxRetries) {
            throw error;
          }
          try {
            await sleep(retryDelayMs(retryBaseDelayMs, attempt), requestOptions.signal);
          } catch (cause) {
            if (requestOptions.signal?.aborted === true) {
              throw new EvmRpcRequestError('request_aborted', provider.id, false, attempt);
            }
            throw cause;
          }
          if (requestOptions.signal?.aborted === true) {
            throw new EvmRpcRequestError('request_aborted', provider.id, false, attempt);
          }
        }
      }

      throw new EvmRpcRequestError('transport_error', provider.id, true, maxRetries + 1);
    },
  };
}

async function executeHttpAttempt(input: {
  endpoint: URL;
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  maxResponseBytes: number;
  providerId: string;
  requestBody: string;
  requestTimeoutMs: number;
  signal?: AbortSignal | undefined;
  attempt: number;
}): Promise<HttpAttemptResult> {
  if (input.signal?.aborted === true) {
    throw new EvmRpcRequestError('request_aborted', input.providerId, false, input.attempt);
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new EvmRpcRequestError('request_timeout', input.providerId, true, input.attempt));
    }, input.requestTimeoutMs);

    if (input.signal !== undefined) {
      abortListener = () => {
        controller.abort();
        reject(new EvmRpcRequestError('request_aborted', input.providerId, false, input.attempt));
      };
      input.signal.addEventListener('abort', abortListener, { once: true });
    }
  });

  const operation = (async (): Promise<HttpAttemptResult> => {
    try {
      const response = await input.fetchImpl(input.endpoint, {
        body: input.requestBody,
        headers: input.headers,
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, status: response.status };
      }
      return {
        ok: true,
        status: response.status,
        text: await readBoundedResponse(
          response,
          input.maxResponseBytes,
          input.providerId,
          input.attempt,
        ),
      };
    } catch (error) {
      if (error instanceof EvmRpcRequestError) {
        throw error;
      }
      if (input.signal?.aborted === true) {
        throw new EvmRpcRequestError('request_aborted', input.providerId, false, input.attempt);
      }
      if (timedOut) {
        throw new EvmRpcRequestError('request_timeout', input.providerId, true, input.attempt);
      }
      throw new EvmRpcRequestError('transport_error', input.providerId, true, input.attempt);
    }
  })();

  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    controller.abort();
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (input.signal !== undefined && abortListener !== undefined) {
      input.signal.removeEventListener('abort', abortListener);
    }
  }
}

async function readBoundedResponse(
  response: Response,
  maxResponseBytes: number,
  providerId: string,
  attempt: number,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxResponseBytes) {
      throw new EvmRpcRequestError('response_too_large', providerId, false, attempt, {
        maxResponseBytes,
      });
    }
  }

  if (response.body === null) {
    return '';
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel();
      throw new EvmRpcRequestError('response_too_large', providerId, false, attempt, {
        maxResponseBytes,
      });
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function parseJsonRpcResponse(
  text: string,
  calls: readonly EvmRpcCall[],
  providerId: string,
  attempt: number,
): EvmRpcCallOutcome[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new EvmRpcRequestError('invalid_json', providerId, false, attempt);
  }

  const items = Array.isArray(payload) ? payload : calls.length === 1 ? [payload] : undefined;
  if (items === undefined || items.length !== calls.length) {
    throw new EvmRpcRequestError('invalid_jsonrpc', providerId, false, attempt);
  }

  const responses = new Map<number, JsonRpcWireResponse>();
  for (const item of items) {
    const response = parseWireResponse(item, providerId, attempt);
    if (response.id < 1 || response.id > calls.length || responses.has(response.id)) {
      throw new EvmRpcRequestError('invalid_jsonrpc', providerId, false, attempt);
    }
    responses.set(response.id, response);
  }

  return calls.map((call, index): EvmRpcCallOutcome => {
    const response = responses.get(index + 1);
    if (response === undefined) {
      throw new EvmRpcRequestError('invalid_jsonrpc', providerId, false, attempt);
    }
    if (response.hasError && response.error !== undefined) {
      return { call, error: response.error, ok: false };
    }
    return { call, ok: true, result: response.result };
  });
}

function parseWireResponse(
  input: unknown,
  providerId: string,
  attempt: number,
): JsonRpcWireResponse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new EvmRpcRequestError('invalid_jsonrpc', providerId, false, attempt);
  }
  const record = input as Record<string, unknown>;
  const hasResult = Object.hasOwn(record, 'result');
  const hasError = Object.hasOwn(record, 'error');
  if (
    record.jsonrpc !== '2.0' ||
    typeof record.id !== 'number' ||
    !Number.isSafeInteger(record.id) ||
    hasResult === hasError
  ) {
    throw new EvmRpcRequestError('invalid_jsonrpc', providerId, false, attempt);
  }

  if (hasError) {
    const error = record.error;
    if (
      typeof error !== 'object' ||
      error === null ||
      Array.isArray(error) ||
      typeof (error as Record<string, unknown>).code !== 'number' ||
      !Number.isSafeInteger((error as Record<string, unknown>).code) ||
      typeof (error as Record<string, unknown>).message !== 'string'
    ) {
      throw new EvmRpcRequestError('invalid_jsonrpc', providerId, false, attempt);
    }
    return {
      error: { code: (error as { code: number }).code },
      hasError,
      hasResult,
      id: record.id,
    };
  }

  return { hasError, hasResult, id: record.id, result: record.result };
}

function parseAllowedEndpoint(
  endpoint: string,
  allowInsecureLocalhost: boolean,
  providerId: string,
): URL {
  const url = new URL(endpoint);
  const isHttps = url.protocol === 'https:';
  const isAllowedLocalHttp =
    url.protocol === 'http:' && allowInsecureLocalhost && isLoopbackHostname(url.hostname);
  if (
    (!isHttps && !isAllowedLocalHttp) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new EvmDataAdapterConfigurationError(
      'endpoint_not_allowed',
      `EVM RPC endpoint is not allowed for provider ${providerId}.`,
    );
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') {
    return true;
  }
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function retryDelayMs(baseDelayMs: number, attempt: number): number {
  return Math.min(ABSOLUTE_MAX_RETRY_BASE_DELAY_MS, baseDelayMs * 2 ** (attempt - 1));
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new EvmDataAdapterConfigurationError(
      'invalid_limits',
      `${label} must be an integer between 1 and ${maximum}.`,
    );
  }
  return normalized;
}

function boundedNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > maximum) {
    throw new EvmDataAdapterConfigurationError(
      'invalid_limits',
      `${label} must be an integer between 0 and ${maximum}.`,
    );
  }
  return normalized;
}

async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  if (delayMs === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abortListener);
    const abortListener = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abortListener, { once: true });
  });
}
