import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { type EvmRpcCall } from './contracts.js';
import { EvmDataAdapterConfigurationError, EvmRpcRequestError } from './errors.js';
import { createEvmJsonRpcClient } from './json-rpc-client.js';

const transactionHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const transactionCall: EvmRpcCall = {
  method: 'eth_getTransactionByHash',
  params: [transactionHash],
};
const receiptCall: EvmRpcCall = {
  method: 'eth_getTransactionReceipt',
  params: [transactionHash],
};
const chainCall: EvmRpcCall = { method: 'eth_chainId', params: [] };

async function loadFixtureText(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('createEvmJsonRpcClient security boundary', () => {
  it('uses only the configured endpoint, strips secrets from provenance, and blocks redirects', async () => {
    const fixture = await loadFixtureText('rpc-success-batch');
    const requests: Array<{
      body: unknown;
      headers: Headers;
      redirect?: RequestInit['redirect'];
      url: string;
    }> = [];
    const fetchImpl: typeof fetch = (input, init) => {
      requests.push({
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
        url: fetchInputUrl(input),
      });
      return Promise.resolve(new Response(fixture, { status: 200 }));
    };
    const client = createEvmJsonRpcClient({
      fetchImpl,
      maxRetries: 0,
      provider: {
        endpoint: 'https://rpc.example/v3/path-secret?apiKey=query-secret',
        headers: { authorization: 'Bearer header-secret' },
        id: 'rpc_primary',
      },
    });

    const result = await client.requestBatch([transactionCall, receiptCall, chainCall]);

    expect(client.provenanceUrl).toBe('https://rpc.example');
    expect(client.provenanceUrl).not.toContain('secret');
    expect(result.outcomes.map((outcome) => outcome.call.method)).toEqual([
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
      'eth_chainId',
    ]);
    expect(result.attempts).toBe(1);
    expect(result.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result).not.toHaveProperty('payloadText');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://rpc.example/v3/path-secret?apiKey=query-secret');
    expect(requests[0]?.redirect).toBe('error');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer header-secret');
    expect(requests[0]?.body).toEqual([
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_getTransactionByHash',
        params: [transactionHash],
      },
      {
        id: 2,
        jsonrpc: '2.0',
        method: 'eth_getTransactionReceipt',
        params: [transactionHash],
      },
      { id: 3, jsonrpc: '2.0', method: 'eth_chainId', params: [] },
    ]);
  });

  it('allows HTTPS and explicit loopback development HTTP but rejects other endpoints', () => {
    expect(() =>
      createEvmJsonRpcClient({
        provider: { endpoint: 'http://rpc.example', id: 'rpc_primary' },
      }),
    ).toThrow(EvmDataAdapterConfigurationError);
    expect(() =>
      createEvmJsonRpcClient({
        provider: { endpoint: 'http://localhost:8545', id: 'rpc_primary' },
      }),
    ).toThrow(EvmDataAdapterConfigurationError);
    expect(() =>
      createEvmJsonRpcClient({
        allowInsecureLocalhost: true,
        provider: { endpoint: 'http://localhost:8545', id: 'rpc_primary' },
      }),
    ).not.toThrow();
    expect(() =>
      createEvmJsonRpcClient({
        provider: { endpoint: 'https://user:password@rpc.example', id: 'rpc_primary' },
      }),
    ).toThrow(EvmDataAdapterConfigurationError);
    expect(() =>
      createEvmJsonRpcClient({
        provider: { endpoint: 'https://rpc.example/#secret', id: 'rpc_primary' },
      }),
    ).toThrow(EvmDataAdapterConfigurationError);
  });

  it('rejects oversized batches and methods outside the read-only allowlist', async () => {
    const client = createEvmJsonRpcClient({
      maxBatchSize: 1,
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
    });

    await expect(client.requestBatch([transactionCall, receiptCall])).rejects.toBeInstanceOf(
      EvmDataAdapterConfigurationError,
    );
    await expect(
      client.requestBatch([
        {
          method: 'eth_sendRawTransaction',
          params: ['0xdeadbeef'],
        } as unknown as EvmRpcCall,
      ]),
    ).rejects.toBeInstanceOf(EvmDataAdapterConfigurationError);
  });
});

describe('EVM JSON-RPC transport contract', () => {
  it('retries retryable HTTP status with bounded backoff', async () => {
    let requests = 0;
    const delays: number[] = [];
    const fetchImpl: typeof fetch = () => {
      requests += 1;
      return Promise.resolve(
        requests === 1
          ? jsonResponse({ error: 'rate limited' }, 429)
          : jsonResponse({ id: 1, jsonrpc: '2.0', result: null }),
      );
    };
    const client = createEvmJsonRpcClient({
      fetchImpl,
      maxRetries: 1,
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
      retryBaseDelayMs: 7,
      sleep: (delayMs) => {
        delays.push(delayMs);
        return Promise.resolve();
      },
    });

    const result = await client.requestBatch([transactionCall]);

    expect(result.attempts).toBe(2);
    expect(requests).toBe(2);
    expect(delays).toEqual([7]);
  });

  it('does not retry non-retryable HTTP status or leak endpoint secrets in errors', async () => {
    let requests = 0;
    const client = createEvmJsonRpcClient({
      fetchImpl: () => {
        requests += 1;
        return Promise.resolve(jsonResponse({ token: 'response-secret' }, 400));
      },
      maxRetries: 3,
      provider: {
        endpoint: 'https://rpc.example/path-secret?key=query-secret',
        id: 'rpc_primary',
      },
    });

    const error = await client.requestBatch([transactionCall]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvmRpcRequestError);
    expect(error).toMatchObject({
      attempts: 1,
      code: 'http_error',
      httpStatus: 400,
      retryable: false,
    });
    if (!(error instanceof EvmRpcRequestError)) {
      throw new Error('Expected EvmRpcRequestError.');
    }
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain('secret');
    expect(requests).toBe(1);
  });

  it('times out, aborts each attempt, and stops at the retry bound', async () => {
    let requests = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      requests += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('test abort')), {
          once: true,
        });
      });
    };
    const client = createEvmJsonRpcClient({
      fetchImpl,
      maxRetries: 1,
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
      requestTimeoutMs: 1,
      retryBaseDelayMs: 0,
    });

    await expect(client.requestBatch([transactionCall])).rejects.toMatchObject({
      attempts: 2,
      code: 'request_timeout',
      retryable: true,
    });
    expect(requests).toBe(2);
  });

  it('propagates caller cancellation without retrying', async () => {
    let requests = 0;
    const client = createEvmJsonRpcClient({
      fetchImpl: () => {
        requests += 1;
        return Promise.resolve(jsonResponse({ id: 1, jsonrpc: '2.0', result: null }));
      },
      maxRetries: 3,
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.requestBatch([transactionCall], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'request_aborted', retryable: false });
    expect(requests).toBe(0);
  });

  it('rejects streaming bodies beyond the configured response limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
        controller.close();
      },
    });
    const client = createEvmJsonRpcClient({
      fetchImpl: () => Promise.resolve(new Response(stream, { status: 200 })),
      maxResponseBytes: 16,
      maxRetries: 0,
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
    });

    await expect(client.requestBatch([transactionCall])).rejects.toMatchObject({
      code: 'response_too_large',
      maxResponseBytes: 16,
      retryable: false,
    });
  });

  it.each([
    { body: 'not-json', code: 'invalid_json', name: 'invalid JSON' },
    {
      body: JSON.stringify({ id: 2, jsonrpc: '2.0', result: null }),
      code: 'invalid_jsonrpc',
      name: 'unexpected response id',
    },
    {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0' }),
      code: 'invalid_jsonrpc',
      name: 'missing result and error',
    },
  ])('rejects $name without retrying', async ({ body, code }) => {
    let requests = 0;
    const client = createEvmJsonRpcClient({
      fetchImpl: () => {
        requests += 1;
        return Promise.resolve(new Response(body, { status: 200 }));
      },
      maxRetries: 3,
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
    });

    await expect(client.requestBatch([transactionCall])).rejects.toMatchObject({
      attempts: 1,
      code,
      retryable: false,
    });
    expect(requests).toBe(1);
  });

  it('returns per-call JSON-RPC errors without exposing provider messages', async () => {
    const client = createEvmJsonRpcClient({
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse({
            error: { code: -32_005, message: 'rate limit with private provider detail' },
            id: 1,
            jsonrpc: '2.0',
          }),
        ),
      maxRetries: 0,
      provider: { endpoint: 'https://rpc.example', id: 'rpc_primary' },
    });

    const result = await client.requestBatch([transactionCall]);

    expect(result.outcomes).toEqual([
      { call: transactionCall, error: { code: -32_005 }, ok: false },
    ]);
    expect(JSON.stringify(result.outcomes)).not.toContain('private provider detail');
  });
});
