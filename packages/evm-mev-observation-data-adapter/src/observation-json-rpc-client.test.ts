import { describe, expect, it } from 'vitest';

import { EvmMevObservationConfigurationError, EvmMevObservationRequestError } from './errors.js';
import {
  createObservationJsonRpcClient,
  type ObservationRpcMetricEvent,
} from './observation-json-rpc-client.js';
import type { MevObservationRpcCall } from './rpc-contracts.js';

const transactionHash = `0x${'aa'.repeat(32)}`;
const chainCall: MevObservationRpcCall = {
  method: 'eth_chainId',
  operation: 'chain_id',
  params: [],
};
const transactionCall: MevObservationRpcCall = {
  method: 'eth_getTransactionByHash',
  operation: 'target_transaction',
  params: [transactionHash],
  transactionHash,
};

function provider(endpoint = 'https://rpc.example') {
  return {
    archive: true as const,
    costUnitsPerRequest: 2,
    endpoint,
    id: 'rpc_primary',
  };
}

function responseFor(calls: readonly MevObservationRpcCall[], reverse = false): Response {
  const responses = calls.map((call, index) => ({
    id: index + 1,
    jsonrpc: '2.0',
    result: call.operation === 'chain_id' ? '0x1' : { hash: transactionHash },
  }));
  return new Response(JSON.stringify(reverse ? responses.reverse() : responses), { status: 200 });
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe('specialized MEV observation JSON-RPC security boundary', () => {
  it('sends only allowlisted wire fields, reorders responses, caches immutable calls, and sanitizes metrics', async () => {
    let fetchCount = 0;
    let captured:
      | { body: unknown; headers: Headers; redirect: RequestInit['redirect']; url: string }
      | undefined;
    const metrics: ObservationRpcMetricEvent[] = [];
    const client = createObservationJsonRpcClient({
      fetchImpl: (request, init) => {
        fetchCount += 1;
        captured = {
          body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
          url: fetchInputUrl(request),
        };
        return Promise.resolve(responseFor([chainCall, transactionCall], true));
      },
      onMetric: (metric) => metrics.push(metric),
      provider: {
        ...provider('https://rpc.example/private?token=query-secret'),
        headers: { authorization: 'Bearer header-secret' },
      },
    });

    const first = await client.requestBatch([chainCall, transactionCall]);
    const second = await client.requestBatch([chainCall, transactionCall]);

    expect(client.provenanceUrl).toBe('https://rpc.example');
    expect(captured?.url).toBe('https://rpc.example/private?token=query-secret');
    expect(captured?.redirect).toBe('error');
    expect(captured?.headers.get('authorization')).toBe('Bearer header-secret');
    expect(captured?.body).toEqual([
      { id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] },
      {
        id: 2,
        jsonrpc: '2.0',
        method: 'eth_getTransactionByHash',
        params: [transactionHash],
      },
    ]);
    expect(first.outcomes.map((outcome) => outcome.call.operation)).toEqual([
      'chain_id',
      'target_transaction',
    ]);
    expect(first.costUnits).toBe(2);
    expect(second).toMatchObject({ attempts: 0, cacheHit: true, costUnits: 0, responseBytes: 0 });
    expect(fetchCount).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain('query-secret');
    expect(JSON.stringify(metrics)).not.toContain('header-secret');
    expect(metrics).toHaveLength(2);
    expect(metrics[1]).toMatchObject({ cacheHit: true, costUnits: 0, rpcCalls: 0 });
  });

  it('allows explicit loopback HTTP only and rejects remote HTTP, credentials, and fragments', () => {
    expect(() =>
      createObservationJsonRpcClient({ provider: provider('http://rpc.example') }),
    ).toThrow(EvmMevObservationConfigurationError);
    expect(() =>
      createObservationJsonRpcClient({ provider: provider('http://localhost:8545') }),
    ).toThrow(EvmMevObservationConfigurationError);
    expect(() =>
      createObservationJsonRpcClient({
        allowInsecureLocalhost: true,
        provider: provider('http://127.0.0.1:8545'),
      }),
    ).not.toThrow();
    expect(() =>
      createObservationJsonRpcClient({ provider: provider('https://user:pass@rpc.example') }),
    ).toThrow(EvmMevObservationConfigurationError);
    expect(() =>
      createObservationJsonRpcClient({ provider: provider('https://rpc.example/#private') }),
    ).toThrow(EvmMevObservationConfigurationError);
  });

  it('rejects generic reads, writes, and arbitrary eth_call calldata before fetch', async () => {
    let requests = 0;
    const client = createObservationJsonRpcClient({
      fetchImpl: () => {
        requests += 1;
        return Promise.resolve(responseFor([chainCall]));
      },
      provider: provider(),
    });

    for (const call of [
      { method: 'eth_getBalance', operation: 'chain_id', params: [] },
      { method: 'eth_sendRawTransaction', operation: 'receipt', params: ['0x'] },
      {
        blockHash: `0x${'bb'.repeat(32)}`,
        method: 'eth_call',
        operation: 'v2_reserves',
        params: [
          { data: '0xdeadbeef', to: `0x${'33'.repeat(20)}` },
          { blockHash: `0x${'bb'.repeat(32)}`, requireCanonical: true },
        ],
        poolAddress: `0x${'33'.repeat(20)}`,
      },
    ]) {
      await expect(
        client.requestBatch([call as unknown as MevObservationRpcCall]),
      ).rejects.toBeInstanceOf(EvmMevObservationConfigurationError);
    }
    expect(requests).toBe(0);
  });
});

describe('specialized MEV observation JSON-RPC transport controls', () => {
  it('retries only a bounded retryable HTTP failure and records request cost', async () => {
    let requests = 0;
    const delays: number[] = [];
    const client = createObservationJsonRpcClient({
      fetchImpl: () => {
        requests += 1;
        return Promise.resolve(
          requests === 1 ? new Response('{}', { status: 429 }) : responseFor([chainCall]),
        );
      },
      maxRetries: 1,
      provider: provider(),
      retryBaseDelayMs: 7,
      sleep: (delay) => {
        delays.push(delay);
        return Promise.resolve();
      },
    });

    const result = await client.requestBatch([chainCall]);
    expect(result).toMatchObject({ attempts: 2, costUnits: 4 });
    expect(requests).toBe(2);
    expect(delays).toEqual([7]);
  });

  it('enforces streamed byte limits without trusting response metadata', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
        controller.close();
      },
    });
    const client = createObservationJsonRpcClient({
      fetchImpl: () => Promise.resolve(new Response(stream, { status: 200 })),
      maxResponseBytes: 16,
      provider: provider(),
    });

    await expect(client.requestBatch([chainCall])).rejects.toMatchObject({
      code: 'response_too_large',
      maxResponseBytes: 16,
      retryable: false,
    });
  });

  it('fails closed on local rate and concurrency limits', async () => {
    let rateRequests = 0;
    const rateLimited = createObservationJsonRpcClient({
      cacheTtlMs: 0,
      fetchImpl: () => {
        rateRequests += 1;
        return Promise.resolve(responseFor([chainCall]));
      },
      maxRequestsPerWindow: 1,
      maxRetries: 0,
      nowMs: () => 1_000,
      provider: provider(),
      rateWindowMs: 1_000,
    });
    await rateLimited.requestBatch([chainCall]);
    const rateError = await rateLimited.requestBatch([chainCall]).catch((error: unknown) => error);
    expect(rateError).toMatchObject({
      attempts: 0,
      code: 'local_rate_limit',
    });
    expect(rateRequests).toBe(1);

    let resolveFetch: ((response: Response) => void) | undefined;
    const concurrencyLimited = createObservationJsonRpcClient({
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      maxConcurrentRequests: 1,
      provider: provider(),
    });
    const pending = concurrencyLimited.requestBatch([chainCall]);
    await Promise.resolve();
    await expect(concurrencyLimited.requestBatch([chainCall])).rejects.toMatchObject({
      code: 'local_concurrency_limit',
    });
    resolveFetch?.(responseFor([chainCall]));
    await expect(pending).resolves.toBeDefined();
  });

  it('opens a provider-local circuit after the configured failure threshold', async () => {
    let requests = 0;
    const client = createObservationJsonRpcClient({
      circuitFailureThreshold: 1,
      circuitOpenMs: 1_000,
      fetchImpl: () => {
        requests += 1;
        return Promise.reject(new TypeError('private provider detail'));
      },
      maxRetries: 0,
      nowMs: () => 100,
      provider: provider(),
    });

    await expect(client.requestBatch([chainCall])).rejects.toMatchObject({
      code: 'transport_error',
    });
    await expect(client.requestBatch([chainCall])).rejects.toMatchObject({
      code: 'circuit_open',
    });
    expect(requests).toBe(1);
  });

  it('times out, honors caller abort, and never exposes fetch errors', async () => {
    let requests = 0;
    const client = createObservationJsonRpcClient({
      fetchImpl: (_request, init) => {
        requests += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('private fetch error')), {
            once: true,
          });
        });
      },
      maxRetries: 0,
      provider: provider(),
      requestTimeoutMs: 1,
    });

    const timeout = await client.requestBatch([chainCall]).catch((error: unknown) => error);
    expect(timeout).toBeInstanceOf(EvmMevObservationRequestError);
    expect(timeout).toMatchObject({ code: 'request_timeout', retryable: true });
    expect(String(timeout)).not.toContain('private fetch error');

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.requestBatch([chainCall], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'request_aborted', retryable: false });
    expect(requests).toBe(1);
  });

  it('returns only JSON-RPC numeric error codes and drops provider messages', async () => {
    const client = createObservationJsonRpcClient({
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: -32_005, message: 'private provider quota message' },
              id: 1,
              jsonrpc: '2.0',
            }),
            { status: 200 },
          ),
        ),
      provider: provider(),
    });

    const result = await client.requestBatch([chainCall]);
    expect(result.outcomes).toEqual([{ call: chainCall, error: { code: -32_005 }, ok: false }]);
    expect(JSON.stringify(result)).not.toContain('private provider quota message');
  });
});
