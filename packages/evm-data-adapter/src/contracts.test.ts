import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  evmDataAdapterConfigSchema,
  evmRpcProviderConfigSchema,
  rpcHexQuantitySchema,
} from './contracts.js';
import {
  decimalToRpcQuantity,
  normalizeRpcReceipt,
  normalizeRpcTransaction,
  rpcQuantityToDecimal,
} from './normalize-rpc.js';

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown;
}

describe('EVM data adapter configuration contracts', () => {
  it('normalizes provider header names while preserving secret values only in configuration', () => {
    const provider = evmRpcProviderConfigSchema.parse({
      endpoint: 'https://rpc.example/v3/private-key?token=query-secret',
      headers: { Authorization: 'Bearer header-secret', 'X-API-Key': 'api-secret' },
      id: 'rpc_primary',
    });

    expect(provider.headers).toEqual({
      authorization: 'Bearer header-secret',
      'x-api-key': 'api-secret',
    });
  });

  it('rejects duplicate chains/providers and adapter-controlled or excessive headers', () => {
    expect(() =>
      evmDataAdapterConfigSchema.parse([
        {
          chainId: '1',
          providers: [
            { endpoint: 'https://rpc-a.example', id: 'rpc_a' },
            { endpoint: 'https://rpc-b.example', id: 'rpc_a' },
          ],
        },
      ]),
    ).toThrow(z.ZodError);
    expect(() =>
      evmDataAdapterConfigSchema.parse([
        { chainId: '1', providers: [{ endpoint: 'https://rpc-a.example', id: 'rpc_a' }] },
        { chainId: '1', providers: [{ endpoint: 'https://rpc-b.example', id: 'rpc_b' }] },
      ]),
    ).toThrow(z.ZodError);
    expect(() =>
      evmRpcProviderConfigSchema.parse({
        endpoint: 'https://rpc.example',
        headers: { Host: 'internal.example' },
        id: 'rpc_primary',
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      evmRpcProviderConfigSchema.parse({
        endpoint: 'https://rpc.example',
        headers: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`x-header-${index}`, 'value']),
        ),
        id: 'rpc_primary',
      }),
    ).toThrow(z.ZodError);
  });
});

describe('lossless RPC normalization', () => {
  it('converts canonical hex quantities without passing through JavaScript number', () => {
    expect(rpcQuantityToDecimal('0x20000000000001')).toBe('9007199254740993');
    expect(decimalToRpcQuantity('9007199254740993')).toBe('0x20000000000001');
    expect(rpcHexQuantitySchema.parse('0xABC')).toBe('0xabc');
    expect(() => rpcQuantityToDecimal('0x01')).toThrow(z.ZodError);
    expect(() => decimalToRpcQuantity('-1')).toThrow(z.ZodError);
  });

  it('normalizes standard transaction and receipt responses and ignores extra provider fields', async () => {
    const batch = await loadFixture('rpc-success-batch');
    if (!Array.isArray(batch)) {
      throw new Error('Expected batch fixture.');
    }
    const receiptItem = batch[0] as { result?: unknown };
    const transactionItem = batch[1] as { result?: unknown };

    expect(normalizeRpcTransaction(transactionItem.result, 'rpc_primary')).toMatchObject({
      blockNumber: '19000000',
      nonce: '42',
      sourceId: 'rpc_primary',
      transactionIndex: 12,
      value: '1000000000000000000',
    });
    expect(normalizeRpcReceipt(receiptItem.result, 'rpc_primary')).toMatchObject({
      blockNumber: '19000000',
      effectiveGasPrice: '2000000000',
      gasUsed: '21000',
      sourceId: 'rpc_primary',
      status: 'success',
      transactionIndex: 12,
    });
  });

  it('rejects out-of-contract indexes, receipt status, and overflowing fee products', async () => {
    const batch = await loadFixture('rpc-success-batch');
    if (!Array.isArray(batch)) {
      throw new Error('Expected batch fixture.');
    }
    const receipt = (batch[0] as { result?: Record<string, unknown> }).result;
    const transaction = (batch[1] as { result?: Record<string, unknown> }).result;
    if (receipt === undefined || transaction === undefined) {
      throw new Error('Expected fixture results.');
    }

    expect(() =>
      normalizeRpcTransaction({ ...transaction, transactionIndex: '0xf4241' }, 'rpc_primary'),
    ).toThrow(RangeError);
    expect(() => normalizeRpcReceipt({ ...receipt, status: '0x2' }, 'rpc_primary')).toThrow(
      RangeError,
    );
    expect(() =>
      normalizeRpcReceipt(
        {
          ...receipt,
          effectiveGasPrice: '0x2',
          gasUsed: `0x${'f'.repeat(64)}`,
        },
        'rpc_primary',
      ),
    ).toThrow(RangeError);
  });
});
