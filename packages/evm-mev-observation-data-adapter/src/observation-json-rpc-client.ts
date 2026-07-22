import { createHash } from 'node:crypto';

import {
  evmMevObservationProviderConfigSchema,
  type EvmMevObservationProviderConfig,
  type MevObservationRpcOperation,
} from './contracts.js';
import {
  EvmMevObservationConfigurationError,
  EvmMevObservationRequestError,
  type EvmMevObservationRequestErrorCode,
} from './errors.js';
import { mevObservationRpcCallSchema, type MevObservationRpcCall } from './rpc-contracts.js';

const DEFAULT_MAX_BATCH_SIZE = 32;
const DEFAULT_MAX_RESPONSE_BYTES = 8_388_608;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 100;
const DEFAULT_RATE_WINDOW_MS = 1_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_OPEN_MS = 30_000;

const ABSOLUTE_MAX_BATCH_SIZE = 256;
const ABSOLUTE_MAX_RESPONSE_BYTES = 33_554_432;
const ABSOLUTE_MAX_RETRIES = 3;
const ABSOLUTE_MAX_REQUEST_TIMEOUT_MS = 120_000;
const ABSOLUTE_MAX_RETRY_BASE_DELAY_MS = 2_000;
const ABSOLUTE_MAX_CACHE_TTL_MS = 3_600_000;
const ABSOLUTE_MAX_CACHE_ENTRIES = 4_096;
const ABSOLUTE_MAX_CONCURRENT_REQUESTS = 16;
const ABSOLUTE_MAX_REQUESTS_PER_WINDOW = 10_000;
const ABSOLUTE_MAX_RATE_WINDOW_MS = 60_000;
const ABSOLUTE_MAX_CIRCUIT_FAILURE_THRESHOLD = 100;
const ABSOLUTE_MAX_CIRCUIT_OPEN_MS = 600_000;

export interface ObservationRpcCallSuccess {
  call: MevObservationRpcCall;
  ok: true;
  result: unknown;
}

export interface ObservationRpcCallFailure {
  call: MevObservationRpcCall;
  error: { code: number };
  ok: false;
}

export type ObservationRpcCallOutcome = ObservationRpcCallSuccess | ObservationRpcCallFailure;

export interface ObservationRpcBatchResult {
  attempts: number;
  cacheHit: boolean;
  costUnits: number;
  outcomes: ObservationRpcCallOutcome[];
  payloadHash: string;
  responseBytes: number;
}

export interface ObservationRpcMetricEvent {
  cacheHit: boolean;
  costUnits: number;
  durationMs: number;
  operations: MevObservationRpcOperation[];
  providerId: string;
  requestFingerprint: string;
  result: 'success' | EvmMevObservationRequestErrorCode;
  rpcCalls: number;
}

export interface ObservationJsonRpcClient {
  readonly providerId: string;
  readonly provenanceUrl: string;
  requestBatch(
    calls: readonly MevObservationRpcCall[],
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ObservationRpcBatchResult>;
}

export interface CreateObservationJsonRpcClientOptions {
  allowInsecureLocalhost?: boolean;
  cacheTtlMs?: number;
  circuitFailureThreshold?: number;
  circuitOpenMs?: number;
  fetchImpl?: typeof fetch;
  maxBatchSize?: number;
  maxCacheEntries?: number;
  maxConcurrentRequests?: number;
  maxRequestsPerWindow?: number;
  maxResponseBytes?: number;
  maxRetries?: number;
  nowMs?: () => number;
  onMetric?: (event: ObservationRpcMetricEvent) => void;
  provider: EvmMevObservationProviderConfig;
  rateWindowMs?: number;
  requestTimeoutMs?: number;
  retryBaseDelayMs?: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface CacheEntry {
  expiresAt: number;
  result: Pick<ObservationRpcBatchResult, 'outcomes' | 'payloadHash'>;
}

interface HttpAttemptResult {
  bytes: number;
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

export function createObservationJsonRpcClient(
  options: CreateObservationJsonRpcClientOptions,
): ObservationJsonRpcClient {
  let provider: EvmMevObservationProviderConfig;
  try {
    provider = evmMevObservationProviderConfigSchema.parse(options.provider);
  } catch (cause) {
    throw new EvmMevObservationConfigurationError(
      'invalid_configuration',
      'MEV observation provider configuration is invalid.',
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
  const cacheTtlMs = boundedNonNegativeInteger(
    options.cacheTtlMs,
    DEFAULT_CACHE_TTL_MS,
    ABSOLUTE_MAX_CACHE_TTL_MS,
    'cacheTtlMs',
  );
  const maxCacheEntries = boundedNonNegativeInteger(
    options.maxCacheEntries,
    DEFAULT_MAX_CACHE_ENTRIES,
    ABSOLUTE_MAX_CACHE_ENTRIES,
    'maxCacheEntries',
  );
  const maxConcurrentRequests = boundedPositiveInteger(
    options.maxConcurrentRequests,
    DEFAULT_MAX_CONCURRENT_REQUESTS,
    ABSOLUTE_MAX_CONCURRENT_REQUESTS,
    'maxConcurrentRequests',
  );
  const maxRequestsPerWindow = boundedPositiveInteger(
    options.maxRequestsPerWindow,
    DEFAULT_MAX_REQUESTS_PER_WINDOW,
    ABSOLUTE_MAX_REQUESTS_PER_WINDOW,
    'maxRequestsPerWindow',
  );
  const rateWindowMs = boundedPositiveInteger(
    options.rateWindowMs,
    DEFAULT_RATE_WINDOW_MS,
    ABSOLUTE_MAX_RATE_WINDOW_MS,
    'rateWindowMs',
  );
  const circuitFailureThreshold = boundedPositiveInteger(
    options.circuitFailureThreshold,
    DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
    ABSOLUTE_MAX_CIRCUIT_FAILURE_THRESHOLD,
    'circuitFailureThreshold',
  );
  const circuitOpenMs = boundedPositiveInteger(
    options.circuitOpenMs,
    DEFAULT_CIRCUIT_OPEN_MS,
    ABSOLUTE_MAX_CIRCUIT_OPEN_MS,
    'circuitOpenMs',
  );
  const sleep = options.sleep ?? abortableSleep;
  const nowMs = options.nowMs ?? Date.now;
  const onMetric = options.onMetric;
  const headers = {
    accept: 'application/json',
    ...(provider.headers ?? {}),
    'content-type': 'application/json',
  };

  let activeRequests = 0;
  let circuitOpenUntil = 0;
  let consecutiveFailures = 0;
  let rateWindowStartedAt = Number.NEGATIVE_INFINITY;
  let requestsInWindow = 0;
  const cache = new Map<string, CacheEntry>();

  const emitMetric = (event: ObservationRpcMetricEvent): void => {
    if (onMetric === undefined) {
      return;
    }
    try {
      onMetric(event);
    } catch {
      // Metrics are observational and cannot change the data result.
    }
  };

  const consumeRateBudget = (timestamp: number): void => {
    if (
      !Number.isFinite(rateWindowStartedAt) ||
      timestamp < rateWindowStartedAt ||
      timestamp - rateWindowStartedAt >= rateWindowMs
    ) {
      rateWindowStartedAt = timestamp;
      requestsInWindow = 0;
    }
    if (requestsInWindow >= maxRequestsPerWindow) {
      throw new EvmMevObservationRequestError('local_rate_limit', provider.id, true, 0);
    }
    requestsInWindow += 1;
  };

  return {
    providerId: provider.id,
    provenanceUrl: endpoint.origin,

    async requestBatch(calls, requestOptions = {}) {
      let parsedCalls: MevObservationRpcCall[];
      try {
        parsedCalls = calls.map((call) => mevObservationRpcCallSchema.parse(call));
      } catch (cause) {
        throw new EvmMevObservationConfigurationError(
          'invalid_configuration',
          'MEV observation RPC batch contains an unsupported or invalid call.',
          { cause },
        );
      }
      if (parsedCalls.length === 0 || parsedCalls.length > maxBatchSize) {
        throw new EvmMevObservationConfigurationError(
          'invalid_configuration',
          `MEV observation RPC batch size must be between 1 and ${maxBatchSize}.`,
        );
      }

      const operations = parsedCalls.map((call) => call.operation);
      const requestBody = JSON.stringify(
        parsedCalls.map((call, index) => ({
          id: index + 1,
          jsonrpc: '2.0',
          method: call.method,
          params: call.params,
        })),
      );
      const requestFingerprint = sha256(JSON.stringify(parsedCalls));
      const startedAt = validNow(nowMs);
      const cached = readCache(cache, requestFingerprint, startedAt);
      if (cached !== undefined) {
        const result: ObservationRpcBatchResult = {
          ...cached,
          attempts: 0,
          cacheHit: true,
          costUnits: 0,
          responseBytes: 0,
        };
        emitMetric({
          cacheHit: true,
          costUnits: 0,
          durationMs: 0,
          operations,
          providerId: provider.id,
          requestFingerprint,
          result: 'success',
          rpcCalls: 0,
        });
        return result;
      }

      const failLocally = (code: 'circuit_open' | 'local_concurrency_limit') => {
        emitMetric({
          cacheHit: false,
          costUnits: 0,
          durationMs: 0,
          operations,
          providerId: provider.id,
          requestFingerprint,
          result: code,
          rpcCalls: 0,
        });
        throw new EvmMevObservationRequestError(code, provider.id, true, 0);
      };
      if (startedAt < circuitOpenUntil) {
        return failLocally('circuit_open');
      }
      if (activeRequests >= maxConcurrentRequests) {
        return failLocally('local_concurrency_limit');
      }
      if (requestOptions.signal?.aborted === true) {
        throw new EvmMevObservationRequestError('request_aborted', provider.id, false, 0);
      }

      activeRequests += 1;
      let responseBytes = 0;
      try {
        for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
          try {
            consumeRateBudget(validNow(nowMs));
            const response = await executeHttpAttempt({
              attempt,
              endpoint,
              fetchImpl,
              headers,
              maxResponseBytes,
              providerId: provider.id,
              requestBody,
              requestTimeoutMs,
              signal: requestOptions.signal,
            });
            responseBytes += response.bytes;
            if (!response.ok) {
              const retryable = isRetryableHttpStatus(response.status);
              throw new EvmMevObservationRequestError(
                'http_error',
                provider.id,
                retryable,
                attempt,
                { httpStatus: response.status },
              );
            }
            if (response.text === undefined) {
              throw new EvmMevObservationRequestError('invalid_json', provider.id, false, attempt);
            }

            const result: ObservationRpcBatchResult = {
              attempts: attempt,
              cacheHit: false,
              costUnits: attempt * provider.costUnitsPerRequest,
              outcomes: parseJsonRpcResponse(response.text, parsedCalls, provider.id, attempt),
              payloadHash: sha256(response.text),
              responseBytes,
            };
            consecutiveFailures = 0;
            circuitOpenUntil = 0;
            if (cacheTtlMs > 0 && maxCacheEntries > 0) {
              writeCache(
                cache,
                requestFingerprint,
                {
                  expiresAt: validNow(nowMs) + cacheTtlMs,
                  result: {
                    outcomes: result.outcomes,
                    payloadHash: result.payloadHash,
                  },
                },
                maxCacheEntries,
              );
            }
            emitMetric({
              cacheHit: false,
              costUnits: result.costUnits,
              durationMs: elapsedMs(startedAt, validNow(nowMs)),
              operations,
              providerId: provider.id,
              requestFingerprint,
              result: 'success',
              rpcCalls: parsedCalls.length * attempt,
            });
            return result;
          } catch (error) {
            if (!(error instanceof EvmMevObservationRequestError)) {
              throw error;
            }
            if (!error.retryable || error.code === 'local_rate_limit' || attempt > maxRetries) {
              throw error;
            }
            try {
              await sleep(retryDelayMs(retryBaseDelayMs, attempt), requestOptions.signal);
            } catch (cause) {
              if (isSignalAborted(requestOptions.signal)) {
                throw new EvmMevObservationRequestError(
                  'request_aborted',
                  provider.id,
                  false,
                  attempt,
                );
              }
              throw cause;
            }
          }
        }
        throw new EvmMevObservationRequestError(
          'transport_error',
          provider.id,
          true,
          maxRetries + 1,
        );
      } catch (error) {
        if (error instanceof EvmMevObservationRequestError) {
          if (countsTowardCircuit(error.code)) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= circuitFailureThreshold) {
              circuitOpenUntil = validNow(nowMs) + circuitOpenMs;
            }
          }
          emitMetric({
            cacheHit: false,
            costUnits: error.attempts * provider.costUnitsPerRequest,
            durationMs: elapsedMs(startedAt, validNow(nowMs)),
            operations,
            providerId: provider.id,
            requestFingerprint,
            result: error.code,
            rpcCalls: parsedCalls.length * error.attempts,
          });
        }
        throw error;
      } finally {
        activeRequests -= 1;
      }
    },
  };
}

async function executeHttpAttempt(input: {
  attempt: number;
  endpoint: URL;
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  maxResponseBytes: number;
  providerId: string;
  requestBody: string;
  requestTimeoutMs: number;
  signal?: AbortSignal | undefined;
}): Promise<HttpAttemptResult> {
  if (input.signal?.aborted === true) {
    throw new EvmMevObservationRequestError(
      'request_aborted',
      input.providerId,
      false,
      input.attempt,
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        new EvmMevObservationRequestError('request_timeout', input.providerId, true, input.attempt),
      );
    }, input.requestTimeoutMs);
    if (input.signal !== undefined) {
      abortListener = () => {
        controller.abort();
        reject(
          new EvmMevObservationRequestError(
            'request_aborted',
            input.providerId,
            false,
            input.attempt,
          ),
        );
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
        return { bytes: 0, ok: false, status: response.status };
      }
      const body = await readBoundedResponse(
        response,
        input.maxResponseBytes,
        input.providerId,
        input.attempt,
      );
      return { bytes: body.bytes, ok: true, status: response.status, text: body.text };
    } catch (error) {
      if (error instanceof EvmMevObservationRequestError) {
        throw error;
      }
      if (input.signal?.aborted === true) {
        throw new EvmMevObservationRequestError(
          'request_aborted',
          input.providerId,
          false,
          input.attempt,
        );
      }
      if (timedOut) {
        throw new EvmMevObservationRequestError(
          'request_timeout',
          input.providerId,
          true,
          input.attempt,
        );
      }
      throw new EvmMevObservationRequestError(
        'transport_error',
        input.providerId,
        true,
        input.attempt,
      );
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
): Promise<{ bytes: number; text: string }> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxResponseBytes) {
      throw new EvmMevObservationRequestError('response_too_large', providerId, false, attempt, {
        maxResponseBytes,
      });
    }
  }
  if (response.body === null) {
    return { bytes: 0, text: '' };
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
      throw new EvmMevObservationRequestError('response_too_large', providerId, false, attempt, {
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
  return { bytes: totalBytes, text: new TextDecoder().decode(joined) };
}

function parseJsonRpcResponse(
  text: string,
  calls: readonly MevObservationRpcCall[],
  providerId: string,
  attempt: number,
): ObservationRpcCallOutcome[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new EvmMevObservationRequestError('invalid_json', providerId, false, attempt);
  }
  const items = Array.isArray(payload) ? payload : calls.length === 1 ? [payload] : undefined;
  if (items === undefined || items.length !== calls.length) {
    throw new EvmMevObservationRequestError('invalid_jsonrpc', providerId, false, attempt);
  }

  const responses = new Map<number, JsonRpcWireResponse>();
  for (const item of items) {
    const response = parseWireResponse(item, providerId, attempt);
    if (response.id < 1 || response.id > calls.length || responses.has(response.id)) {
      throw new EvmMevObservationRequestError('invalid_jsonrpc', providerId, false, attempt);
    }
    responses.set(response.id, response);
  }

  return calls.map((call, index): ObservationRpcCallOutcome => {
    const response = responses.get(index + 1);
    if (response === undefined) {
      throw new EvmMevObservationRequestError('invalid_jsonrpc', providerId, false, attempt);
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
    throw new EvmMevObservationRequestError('invalid_jsonrpc', providerId, false, attempt);
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
    throw new EvmMevObservationRequestError('invalid_jsonrpc', providerId, false, attempt);
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
      throw new EvmMevObservationRequestError('invalid_jsonrpc', providerId, false, attempt);
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
    throw new EvmMevObservationConfigurationError(
      'endpoint_not_allowed',
      `MEV observation endpoint is not allowed for provider ${providerId}.`,
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

function readCache(
  cache: Map<string, CacheEntry>,
  key: string,
  now: number,
): CacheEntry['result'] | undefined {
  const entry = cache.get(key);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function writeCache(
  cache: Map<string, CacheEntry>,
  key: string,
  entry: CacheEntry,
  maxEntries: number,
): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cache.delete(oldest);
  }
}

function countsTowardCircuit(code: EvmMevObservationRequestErrorCode): boolean {
  return (
    code === 'http_error' ||
    code === 'invalid_json' ||
    code === 'invalid_jsonrpc' ||
    code === 'request_timeout' ||
    code === 'response_too_large' ||
    code === 'transport_error'
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
    throw new EvmMevObservationConfigurationError(
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
    throw new EvmMevObservationConfigurationError(
      'invalid_limits',
      `${label} must be an integer between 0 and ${maximum}.`,
    );
  }
  return normalized;
}

function validNow(nowMs: () => number): number {
  const value = nowMs();
  if (!Number.isFinite(value) || value < 0) {
    throw new EvmMevObservationConfigurationError(
      'invalid_configuration',
      'MEV observation client clock returned an invalid timestamp.',
    );
  }
  return value;
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
