import { readFile } from 'node:fs/promises';

import { analyzeEvmTransactionSnapshot } from '@xxyy/transaction-analysis-core';
import { describe, expect, it } from 'vitest';

import { createEvmDataAdapter } from './evm-data-adapter.js';
import { EvmDataAdapterConfigurationError } from './errors.js';

const transactionHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const fixedNow = () => new Date('2026-07-22T00:00:00.000Z');

interface CapturedRpcRequest {
  host: string;
  methods: string[];
}

async function loadFixtureText(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
}

function readRpcMethods(init: RequestInit | undefined): string[] {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected JSON-RPC request body.');
  }
  const payload = JSON.parse(init.body) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Expected JSON-RPC batch.');
  }
  return payload.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as Record<string, unknown>).method !== 'string'
    ) {
      throw new Error('Expected JSON-RPC method.');
    }
    return (item as { method: string }).method;
  });
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function transformBatchResult(
  payloadText: string,
  id: number,
  transform: (result: unknown) => unknown,
): string {
  const payload = JSON.parse(payloadText) as unknown;
  const items = Array.isArray(payload) ? (payload as unknown[]) : [payload];
  const response = items.find(
    (item) =>
      typeof item === 'object' && item !== null && (item as Record<string, unknown>).id === id,
  );
  if (typeof response !== 'object' || response === null) {
    throw new Error(`Expected JSON-RPC response ${id}.`);
  }
  const record = response as Record<string, unknown>;
  record.result = transform(record.result);
  return JSON.stringify(Array.isArray(payload) ? items : items[0]);
}

function patchObject(value: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected JSON object result.');
  }
  return { ...(value as Record<string, unknown>), ...patch };
}

function createSingleProviderAdapter(fetchImpl: typeof fetch) {
  return createEvmDataAdapter({
    chains: [
      {
        chainId: '1',
        providers: [
          {
            endpoint: 'https://rpc.example/v3/path-secret?token=query-secret',
            headers: { authorization: 'Bearer header-secret' },
            id: 'rpc_primary',
          },
        ],
      },
    ],
    fetchImpl,
    maxRetries: 0,
    now: fixedNow,
  });
}

describe('EVM data adapter provider contract', () => {
  it('replays RPC fixtures into a lossless snapshot with redacted provenance', async () => {
    const batchFixture = await loadFixtureText('rpc-success-batch');
    const blockFixture = await loadFixtureText('rpc-success-block');
    const requests: CapturedRpcRequest[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const methods = readRpcMethods(init);
      requests.push({ host: new URL(fetchInputUrl(input)).host, methods });
      return Promise.resolve(
        new Response(methods.includes('eth_getBlockByNumber') ? blockFixture : batchFixture, {
          status: 200,
        }),
      );
    };
    const adapter = createSingleProviderAdapter(fetchImpl);

    const first = await adapter.loadTransactionSnapshot({
      chainId: '1',
      transactionHash,
    });
    const second = await adapter.loadTransactionSnapshot({
      chainId: '1',
      transactionHash,
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first).toMatchObject({
      diagnostics: [],
      snapshot: {
        block: { number: '19000000', timestamp: '1700000000' },
        chainId: '1',
        observedAt: '2026-07-22T00:00:00.000Z',
        receipt: {
          effectiveGasPrice: '2000000000',
          gasUsed: '21000',
          status: 'success',
        },
        transaction: {
          nonce: '42',
          transactionIndex: 12,
          value: '1000000000000000000',
        },
      },
      status: 'success',
    });
    expect(first.snapshot.sources).toHaveLength(1);
    expect(first.snapshot.sources[0]).toMatchObject({
      id: 'rpc_primary',
      kind: 'rpc',
      observedAt: '2026-07-22T00:00:00.000Z',
      url: 'https://rpc.example',
    });
    expect(first.snapshot.sources[0]?.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(requests.map((request) => request.methods)).toEqual([
      ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_chainId'],
      ['eth_getBlockByNumber'],
      ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_chainId'],
      ['eth_getBlockByNumber'],
    ]);

    const analysis = analyzeEvmTransactionSnapshot(first.snapshot);
    expect(analysis).toMatchObject({
      status: 'success',
      transaction: { executionStatus: 'success', feeWei: '42000000000000' },
    });
    expect(analysis.tokenTransfers).toHaveLength(1);
  });

  it('returns insufficient_data with retryable diagnostics when transaction data is absent', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            { id: 2, jsonrpc: '2.0', result: null },
            { id: 1, jsonrpc: '2.0', result: null },
            { id: 3, jsonrpc: '2.0', result: '0x1' },
          ]),
          { status: 200 },
        ),
      );
    const adapter = createSingleProviderAdapter(fetchImpl);

    const result = await adapter.loadTransactionSnapshot({ chainId: '1', transactionHash });

    expect(result.status).toBe('insufficient_data');
    expect(result.snapshot).not.toHaveProperty('transaction');
    expect(result.snapshot).not.toHaveProperty('receipt');
    expect(result.diagnostics).toEqual([
      {
        attempts: 1,
        code: 'transaction_not_found',
        method: 'eth_getTransactionByHash',
        providerId: 'rpc_primary',
        retryable: true,
      },
      {
        attempts: 1,
        code: 'receipt_not_found',
        method: 'eth_getTransactionReceipt',
        providerId: 'rpc_primary',
        retryable: true,
      },
    ]);
    expect(analyzeEvmTransactionSnapshot(result.snapshot).status).toBe('insufficient_data');
  });

  it('fails closed when a provider reports a different chain id', async () => {
    const successBatch = await loadFixtureText('rpc-success-batch');
    const wrongChainBatch = transformBatchResult(successBatch, 3, () => '0x2105');
    let requests = 0;
    const adapter = createSingleProviderAdapter(() => {
      requests += 1;
      return Promise.resolve(new Response(wrongChainBatch, { status: 200 }));
    });

    const result = await adapter.loadTransactionSnapshot({ chainId: '1', transactionHash });

    expect(result.status).toBe('insufficient_data');
    expect(result.snapshot).not.toHaveProperty('transaction');
    expect(result.snapshot).not.toHaveProperty('receipt');
    expect(result.diagnostics).toEqual([
      {
        attempts: 1,
        code: 'chain_id_mismatch',
        method: 'eth_chainId',
        providerId: 'rpc_primary',
        retryable: false,
      },
    ]);
    expect(requests).toBe(1);
  });

  it('classifies transaction hash, index, and block inconsistencies before analysis', async () => {
    const successBatch = await loadFixtureText('rpc-success-batch');
    const successBlock = await loadFixtureText('rpc-success-block');
    const wrongHashBatch = transformBatchResult(successBatch, 1, (result) =>
      patchObject(result, {
        hash: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      }),
    );
    const hashAdapter = createSingleProviderAdapter((_input, init) =>
      Promise.resolve(
        new Response(
          readRpcMethods(init).includes('eth_getBlockByNumber') ? successBlock : wrongHashBatch,
          { status: 200 },
        ),
      ),
    );

    const hashResult = await hashAdapter.loadTransactionSnapshot({
      chainId: '1',
      transactionHash,
    });

    expect(hashResult.status).toBe('insufficient_data');
    expect(hashResult.snapshot).not.toHaveProperty('transaction');
    expect(hashResult.diagnostics).toContainEqual({
      attempts: 1,
      code: 'transaction_hash_mismatch',
      method: 'eth_getTransactionByHash',
      providerId: 'rpc_primary',
      retryable: false,
    });

    const wrongIndexBatch = transformBatchResult(successBatch, 2, (result) =>
      patchObject(result, { transactionIndex: '0xd' }),
    );
    const wrongBlock = transformBatchResult(successBlock, 1, (result) =>
      patchObject(result, { number: '0x121eac1' }),
    );
    const indexAndBlockAdapter = createSingleProviderAdapter((_input, init) =>
      Promise.resolve(
        new Response(
          readRpcMethods(init).includes('eth_getBlockByNumber') ? wrongBlock : wrongIndexBatch,
          { status: 200 },
        ),
      ),
    );

    const inconsistentResult = await indexAndBlockAdapter.loadTransactionSnapshot({
      chainId: '1',
      transactionHash,
    });

    expect(inconsistentResult.status).toBe('partial');
    expect(inconsistentResult.snapshot.transaction).toBeDefined();
    expect(inconsistentResult.snapshot.receipt).toBeDefined();
    expect(inconsistentResult.snapshot).not.toHaveProperty('block');
    expect(inconsistentResult.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'transaction_receipt_index_mismatch',
      'block_number_mismatch',
    ]);
  });

  it('preserves multi-provider conflicts while selecting a deterministic canonical snapshot', async () => {
    const successBatch = await loadFixtureText('rpc-success-batch');
    const successBlock = await loadFixtureText('rpc-success-block');
    const conflictBatch = await loadFixtureText('rpc-conflict-batch');
    const conflictBlock = await loadFixtureText('rpc-conflict-block');
    const fetchImpl: typeof fetch = (input, init) => {
      const host = new URL(fetchInputUrl(input)).host;
      const isBlock = readRpcMethods(init).includes('eth_getBlockByNumber');
      const body =
        host === 'rpc-a.example'
          ? isBlock
            ? successBlock
            : successBatch
          : isBlock
            ? conflictBlock
            : conflictBatch;
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const adapter = createEvmDataAdapter({
      chains: [
        {
          chainId: '1',
          providers: [
            { endpoint: 'https://rpc-a.example/private-a', id: 'rpc_a' },
            { endpoint: 'https://rpc-b.example/private-b', id: 'rpc_b' },
          ],
        },
      ],
      fetchImpl,
      maxRetries: 0,
      now: fixedNow,
    });

    const result = await adapter.loadTransactionSnapshot({ chainId: '1', transactionHash });

    expect(result.status).toBe('partial');
    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot.transaction).toMatchObject({
      sourceId: 'rpc_a',
      to: '0x2222222222222222222222222222222222222222',
      value: '1000000000000000000',
    });
    expect(result.snapshot.receipt).toMatchObject({ sourceId: 'rpc_a', status: 'success' });
    expect(result.snapshot.sources.map((source) => source.id)).toEqual(['rpc_a', 'rpc_b']);
    expect(result.snapshot.conflicts?.map((conflict) => conflict.field)).toEqual(
      expect.arrayContaining([
        'transaction.to',
        'transaction.value',
        'transaction.inputHash',
        'receipt.status',
        'receipt.effectiveGasPrice',
        'receipt.logsHash',
        'block.hash',
        'block.timestamp',
      ]),
    );
    expect(
      result.snapshot.conflicts?.find((conflict) => conflict.field === 'receipt.status')
        ?.observations,
    ).toEqual([
      { sourceId: 'rpc_a', value: 'success' },
      { sourceId: 'rpc_b', value: 'reverted' },
    ]);

    const analysis = analyzeEvmTransactionSnapshot(result.snapshot);
    expect(analysis.status).toBe('partial');
    expect(analysis.warnings).toContain(
      `unresolved_source_conflicts:${result.snapshot.conflicts?.length ?? 0}`,
    );
  });

  it('keeps a successful provider result while classifying another provider failure', async () => {
    const successBatch = await loadFixtureText('rpc-success-batch');
    const successBlock = await loadFixtureText('rpc-success-block');
    const fetchImpl: typeof fetch = (input, init) => {
      const host = new URL(fetchInputUrl(input)).host;
      if (host === 'rpc-a.example') {
        return Promise.reject(new TypeError('offline'));
      }
      return Promise.resolve(
        new Response(
          readRpcMethods(init).includes('eth_getBlockByNumber') ? successBlock : successBatch,
          { status: 200 },
        ),
      );
    };
    const adapter = createEvmDataAdapter({
      chains: [
        {
          chainId: '1',
          providers: [
            { endpoint: 'https://rpc-a.example', id: 'rpc_a' },
            { endpoint: 'https://rpc-b.example', id: 'rpc_b' },
          ],
        },
      ],
      fetchImpl,
      maxRetries: 0,
      now: fixedNow,
    });

    const result = await adapter.loadTransactionSnapshot({ chainId: '1', transactionHash });

    expect(result.status).toBe('partial');
    expect(result.snapshot.transaction?.sourceId).toBe('rpc_b');
    expect(result.snapshot.sources[0]).toEqual({
      id: 'rpc_a',
      kind: 'rpc',
      observedAt: '2026-07-22T00:00:00.000Z',
      url: 'https://rpc-a.example',
    });
    expect(result.snapshot.sources[1]).toMatchObject({ id: 'rpc_b' });
    expect(result.snapshot.sources[1]?.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.diagnostics).toEqual([
      {
        attempts: 1,
        code: 'transport_error',
        providerId: 'rpc_a',
        retryable: true,
      },
    ]);
    expect(result.snapshot.conflicts).toEqual([]);
  });

  it('retains invalid-vs-present provider state without accepting malformed quantities', async () => {
    const successBatch = await loadFixtureText('rpc-success-batch');
    const successBlock = await loadFixtureText('rpc-success-block');
    const malformedPayload = transformBatchResult(successBatch, 1, (result) =>
      patchObject(result, { value: '0x01' }),
    );

    const fetchImpl: typeof fetch = (input, init) => {
      const host = new URL(fetchInputUrl(input)).host;
      const isBlock = readRpcMethods(init).includes('eth_getBlockByNumber');
      return Promise.resolve(
        new Response(
          isBlock ? successBlock : host === 'rpc-a.example' ? malformedPayload : successBatch,
          { status: 200 },
        ),
      );
    };
    const adapter = createEvmDataAdapter({
      chains: [
        {
          chainId: '1',
          providers: [
            { endpoint: 'https://rpc-a.example', id: 'rpc_a' },
            { endpoint: 'https://rpc-b.example', id: 'rpc_b' },
          ],
        },
      ],
      fetchImpl,
      maxRetries: 0,
      now: fixedNow,
    });

    const result = await adapter.loadTransactionSnapshot({ chainId: '1', transactionHash });

    expect(result.status).toBe('partial');
    expect(result.snapshot.transaction?.sourceId).toBe('rpc_b');
    expect(result.diagnostics).toContainEqual({
      attempts: 1,
      code: 'invalid_transaction_payload',
      method: 'eth_getTransactionByHash',
      providerId: 'rpc_a',
      retryable: false,
    });
    expect(
      result.snapshot.conflicts?.find((conflict) => conflict.field === 'transaction.presence')
        ?.observations,
    ).toEqual([
      { sourceId: 'rpc_a', value: 'invalid' },
      { sourceId: 'rpc_b', value: 'present' },
    ]);
  });

  it('rejects chains and providers outside the startup allowlist', async () => {
    const adapter = createSingleProviderAdapter(() =>
      Promise.resolve(new Response('not used', { status: 500 })),
    );

    await expect(
      adapter.loadTransactionSnapshot({ chainId: '8453', transactionHash }),
    ).rejects.toMatchObject({ code: 'chain_not_configured' });
    await expect(
      adapter.loadTransactionSnapshot({
        chainId: '1',
        providerIds: ['rpc_unknown'],
        transactionHash,
      }),
    ).rejects.toMatchObject({ code: 'provider_not_configured' });
    expect(() =>
      createEvmDataAdapter({
        chains: [
          {
            chainId: '1',
            providers: [{ endpoint: 'http://metadata.internal', id: 'rpc_internal' }],
          },
        ],
      }),
    ).toThrow(EvmDataAdapterConfigurationError);
    expect(() =>
      createEvmDataAdapter({
        chains: [
          {
            chainId: '1',
            providers: [{ endpoint: 'https://rpc.example', id: 'rpc_primary' }],
          },
        ],
        maxBatchSize: 2,
      }),
    ).toThrow(EvmDataAdapterConfigurationError);
  });
});
