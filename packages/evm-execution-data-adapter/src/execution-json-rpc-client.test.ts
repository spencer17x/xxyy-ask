import { describe, expect, it } from 'vitest';

import {
  EvmExecutionDataAdapterConfigurationError,
  EvmExecutionRpcRequestError,
} from './errors.js';
import { createExecutionJsonRpcClient } from './execution-json-rpc-client.js';
import type { ExecutionRpcCall } from './rpc-contracts.js';

const transactionHash = `0x${'a'.repeat(64)}`;
const chainCall: ExecutionRpcCall = {
  method: 'eth_chainId',
  operation: 'chain_id',
  params: [],
};
const traceCall: ExecutionRpcCall = {
  method: 'debug_traceTransaction',
  operation: 'trace',
  params: [
    transactionHash,
    {
      timeout: '10s',
      tracer: 'callTracer',
      tracerConfig: { onlyTopCall: false, withLog: false },
    },
  ],
};

function responseFor(calls: readonly ExecutionRpcCall[]): Response {
  return new Response(
    JSON.stringify(
      calls.map((call, index) => ({
        id: index + 1,
        jsonrpc: '2.0',
        result: call.operation === 'chain_id' ? '0x1' : null,
      })),
    ),
    { status: 200 },
  );
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe('specialized execution JSON-RPC security boundary', () => {
  it('sends only wire method/params to the configured endpoint and redacts provenance', async () => {
    let captured:
      | { body: unknown; headers: Headers; redirect: RequestInit['redirect']; url: string }
      | undefined;
    const client = createExecutionJsonRpcClient({
      fetchImpl: (request, init) => {
        captured = {
          body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
          url: fetchInputUrl(request),
        };
        return Promise.resolve(responseFor([chainCall, traceCall]));
      },
      provider: {
        endpoint: 'https://rpc.example/private-path?token=query-secret',
        headers: { authorization: 'Bearer header-secret' },
        id: 'rpc_primary',
      },
    });

    const result = await client.requestBatch([chainCall, traceCall]);

    expect(client.provenanceUrl).toBe('https://rpc.example');
    expect(client.provenanceUrl).not.toContain('secret');
    expect(captured?.url).toBe('https://rpc.example/private-path?token=query-secret');
    expect(captured?.redirect).toBe('error');
    expect(captured?.headers.get('authorization')).toBe('Bearer header-secret');
    expect(captured?.body).toEqual([
      { id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] },
      {
        id: 2,
        jsonrpc: '2.0',
        method: 'debug_traceTransaction',
        params: [
          transactionHash,
          {
            timeout: '10s',
            tracer: 'callTracer',
            tracerConfig: { onlyTopCall: false, withLog: false },
          },
        ],
      },
    ]);
    expect(JSON.stringify(captured?.body)).not.toContain('operation');
    expect(result.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('allows explicit loopback HTTP only and rejects credentials, fragments, and remote HTTP', () => {
    expect(() =>
      createExecutionJsonRpcClient({
        provider: { endpoint: 'http://rpc.example', id: 'rpc_primary' },
      }),
    ).toThrow(EvmExecutionDataAdapterConfigurationError);
    expect(() =>
      createExecutionJsonRpcClient({
        provider: { endpoint: 'http://localhost:8545', id: 'rpc_primary' },
      }),
    ).toThrow(EvmExecutionDataAdapterConfigurationError);
    expect(() =>
      createExecutionJsonRpcClient({
        allowInsecureLocalhost: true,
        provider: { endpoint: 'http://127.0.0.1:8545', id: 'rpc_primary' },
      }),
    ).not.toThrow();
    expect(() =>
      createExecutionJsonRpcClient({
        provider: { endpoint: 'https://user:pass@rpc.example', id: 'rpc_primary' },
      }),
    ).toThrow(EvmExecutionDataAdapterConfigurationError);
    expect(() =>
      createExecutionJsonRpcClient({
        provider: { endpoint: 'https://rpc.example/#private', id: 'rpc_primary' },
      }),
    ).toThrow(EvmExecutionDataAdapterConfigurationError);
  });

  it('rejects generic debug, write, and eth_call payloads at the low-level boundary', async () => {
    const client = createExecutionJsonRpcClient({
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
    });

    for (const call of [
      { method: 'debug_traceCall', operation: 'trace', params: [] },
      { method: 'eth_sendRawTransaction', operation: 'trace', params: ['0x'] },
      {
        method: 'eth_call',
        operation: 'pool_token0',
        params: [{ data: '0xdeadbeef', to: '0x1111111111111111111111111111111111111111' }, '0x1'],
        poolAddress: '0x1111111111111111111111111111111111111111',
      },
    ]) {
      await expect(
        client.requestBatch([call as unknown as ExecutionRpcCall]),
      ).rejects.toBeInstanceOf(EvmExecutionDataAdapterConfigurationError);
    }
  });
});

describe('specialized execution JSON-RPC transport', () => {
  it('retries only bounded retryable HTTP failures', async () => {
    let requests = 0;
    const delays: number[] = [];
    const client = createExecutionJsonRpcClient({
      fetchImpl: () => {
        requests += 1;
        return Promise.resolve(
          requests === 1 ? new Response('{}', { status: 429 }) : responseFor([chainCall]),
        );
      },
      maxRetries: 1,
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
      retryBaseDelayMs: 7,
      sleep: (delay) => {
        delays.push(delay);
        return Promise.resolve();
      },
    });

    const result = await client.requestBatch([chainCall]);

    expect(result.attempts).toBe(2);
    expect(requests).toBe(2);
    expect(delays).toEqual([7]);
  });

  it('enforces streamed response byte limits without trusting Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
        controller.close();
      },
    });
    const client = createExecutionJsonRpcClient({
      fetchImpl: () => Promise.resolve(new Response(stream, { status: 200 })),
      maxResponseBytes: 16,
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
    });

    await expect(client.requestBatch([chainCall])).rejects.toMatchObject({
      code: 'response_too_large',
      maxResponseBytes: 16,
      retryable: false,
    });
  });

  it('times out and propagates caller abort without exposing fetch errors', async () => {
    let requests = 0;
    const client = createExecutionJsonRpcClient({
      fetchImpl: (_request, init) => {
        requests += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('private fetch error')), {
            once: true,
          });
        });
      },
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
      requestTimeoutMs: 1,
    });

    await expect(client.requestBatch([chainCall])).rejects.toMatchObject({
      code: 'request_timeout',
      retryable: true,
    });
    expect(requests).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.requestBatch([chainCall], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'request_aborted', retryable: false });
    expect(requests).toBe(1);
  });

  it('returns only JSON-RPC numeric codes and never provider messages', async () => {
    const client = createExecutionJsonRpcClient({
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
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
    });

    const result = await client.requestBatch([chainCall]);

    expect(result.outcomes).toEqual([{ call: chainCall, error: { code: -32_005 }, ok: false }]);
    expect(JSON.stringify(result)).not.toContain('private provider quota message');
  });

  it('sanitizes HTTP failures and does not retain response bodies or endpoint secrets', async () => {
    const client = createExecutionJsonRpcClient({
      fetchImpl: () => Promise.resolve(new Response('private response body', { status: 400 })),
      provider: {
        endpoint: 'https://rpc.example/private?key=query-secret',
        id: 'rpc_primary',
      },
    });

    const error = await client.requestBatch([chainCall]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvmExecutionRpcRequestError);
    expect(error).toMatchObject({ code: 'http_error', httpStatus: 400, retryable: false });
    expect(String(error)).not.toContain('private');
    expect(String(error)).not.toContain('secret');
  });
});
