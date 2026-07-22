import { z } from 'zod';

import { rpcHexQuantitySchema } from '@xxyy/evm-data-adapter';
import { evmAddressSchema, evmBytesSchema, evmHashSchema } from '@xxyy/transaction-analysis-core';

import {
  ABSOLUTE_MAX_BLOCK_TRANSACTIONS,
  ABSOLUTE_MAX_POOL_LOGS,
  ABSOLUTE_MAX_RECEIPT_LOGS,
} from './contracts.js';

export const V2_GET_RESERVES_SELECTOR = '0x0902f1ac' as const;
export const V3_SLOT0_SELECTOR = '0x3850c7bd' as const;
export const V3_LIQUIDITY_SELECTOR = '0x1a686502' as const;
export const V3_TICK_SPACING_SELECTOR = '0xd0c93a7c' as const;
export const V3_TICK_BITMAP_SELECTOR = '0x5339c296' as const;
export const V3_TICKS_SELECTOR = '0xf30dba93' as const;

export const canonicalBlockReferenceSchema = z
  .object({
    blockHash: evmHashSchema,
    requireCanonical: z.literal(true),
  })
  .strict();

const stateCallRequestSchema = z
  .object({
    data: evmBytesSchema,
    to: evmAddressSchema,
  })
  .strict();

const staticStateCalls = [
  ['v2_reserves', V2_GET_RESERVES_SELECTOR],
  ['v3_slot0', V3_SLOT0_SELECTOR],
  ['v3_liquidity', V3_LIQUIDITY_SELECTOR],
  ['v3_tick_spacing', V3_TICK_SPACING_SELECTOR],
] as const;

const staticStateCallSchemas = staticStateCalls.map(([operation, selector]) =>
  z
    .object({
      blockHash: evmHashSchema,
      method: z.literal('eth_call'),
      operation: z.literal(operation),
      params: z.tuple([
        z.object({ data: z.literal(selector), to: evmAddressSchema }).strict(),
        canonicalBlockReferenceSchema,
      ]),
      poolAddress: evmAddressSchema,
    })
    .strict()
    .superRefine((call, context) => {
      if (call.params[0].to !== call.poolAddress) {
        context.addIssue({
          code: 'custom',
          message: 'State call target must match poolAddress.',
          path: ['params', 0, 'to'],
        });
      }
      if (call.params[1].blockHash !== call.blockHash) {
        context.addIssue({
          code: 'custom',
          message: 'State call block reference must match blockHash.',
          path: ['params', 1, 'blockHash'],
        });
      }
    }),
);

export const mevObservationRpcCallSchema = z.discriminatedUnion('operation', [
  z
    .object({
      method: z.literal('eth_chainId'),
      operation: z.literal('chain_id'),
      params: z.tuple([]),
    })
    .strict(),
  z
    .object({
      method: z.literal('eth_getTransactionByHash'),
      operation: z.literal('target_transaction'),
      params: z.tuple([evmHashSchema]),
      transactionHash: evmHashSchema,
    })
    .strict()
    .refine((call) => call.params[0] === call.transactionHash, {
      message: 'Target transaction call must match transactionHash.',
      path: ['params', 0],
    }),
  z
    .object({
      blockHash: evmHashSchema,
      method: z.literal('eth_getBlockByHash'),
      operation: z.literal('block'),
      params: z.tuple([evmHashSchema, z.literal(true)]),
    })
    .strict()
    .refine((call) => call.params[0] === call.blockHash, {
      message: 'Block call must match blockHash.',
      path: ['params', 0],
    }),
  z
    .object({
      blockHash: evmHashSchema,
      method: z.literal('eth_getBlockByHash'),
      operation: z.literal('parent_block'),
      params: z.tuple([evmHashSchema, z.literal(false)]),
    })
    .strict()
    .refine((call) => call.params[0] === call.blockHash, {
      message: 'Parent block call must match blockHash.',
      path: ['params', 0],
    }),
  z
    .object({
      blockHash: evmHashSchema,
      method: z.literal('eth_getLogs'),
      operation: z.literal('pool_logs'),
      params: z.tuple([
        z
          .object({
            address: evmAddressSchema,
            blockHash: evmHashSchema,
          })
          .strict(),
      ]),
      poolAddress: evmAddressSchema,
    })
    .strict()
    .superRefine((call, context) => {
      if (call.params[0].address !== call.poolAddress) {
        context.addIssue({
          code: 'custom',
          message: 'Pool log filter address must match poolAddress.',
          path: ['params', 0, 'address'],
        });
      }
      if (call.params[0].blockHash !== call.blockHash) {
        context.addIssue({
          code: 'custom',
          message: 'Pool log filter must match blockHash.',
          path: ['params', 0, 'blockHash'],
        });
      }
    }),
  z
    .object({
      method: z.literal('eth_getTransactionReceipt'),
      operation: z.literal('receipt'),
      params: z.tuple([evmHashSchema]),
      transactionHash: evmHashSchema,
    })
    .strict()
    .refine((call) => call.params[0] === call.transactionHash, {
      message: 'Receipt call must match transactionHash.',
      path: ['params', 0],
    }),
  ...staticStateCallSchemas,
  z
    .object({
      blockHash: evmHashSchema,
      method: z.literal('eth_call'),
      operation: z.literal('v3_tick_bitmap'),
      params: z.tuple([stateCallRequestSchema, canonicalBlockReferenceSchema]),
      poolAddress: evmAddressSchema,
      wordPosition: z.number().int().min(-32_768).max(32_767),
    })
    .strict()
    .superRefine((call, context) => {
      if (
        call.params[0].to !== call.poolAddress ||
        call.params[0].data !==
          `${V3_TICK_BITMAP_SELECTOR}${encodeSignedWord(call.wordPosition, 16)}`
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Tick bitmap call target or calldata is not allowlisted.',
          path: ['params', 0],
        });
      }
      if (call.params[1].blockHash !== call.blockHash) {
        context.addIssue({
          code: 'custom',
          message: 'Tick bitmap call block reference must match blockHash.',
          path: ['params', 1, 'blockHash'],
        });
      }
    }),
  z
    .object({
      blockHash: evmHashSchema,
      method: z.literal('eth_call'),
      operation: z.literal('v3_tick'),
      params: z.tuple([stateCallRequestSchema, canonicalBlockReferenceSchema]),
      poolAddress: evmAddressSchema,
      tick: z.number().int().min(-8_388_608).max(8_388_607),
    })
    .strict()
    .superRefine((call, context) => {
      if (
        call.params[0].to !== call.poolAddress ||
        call.params[0].data !== `${V3_TICKS_SELECTOR}${encodeSignedWord(call.tick, 24)}`
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Tick call target or calldata is not allowlisted.',
          path: ['params', 0],
        });
      }
      if (call.params[1].blockHash !== call.blockHash) {
        context.addIssue({
          code: 'custom',
          message: 'Tick call block reference must match blockHash.',
          path: ['params', 1, 'blockHash'],
        });
      }
    }),
]);

export const rpcMevTransactionSchema = z.object({
  blockHash: evmHashSchema.nullable(),
  blockNumber: rpcHexQuantitySchema.nullable(),
  from: evmAddressSchema,
  hash: evmHashSchema,
  input: evmBytesSchema,
  nonce: rpcHexQuantitySchema,
  to: evmAddressSchema.nullable(),
  transactionIndex: rpcHexQuantitySchema.nullable(),
  value: rpcHexQuantitySchema,
});

export const rpcMevBlockSchema = z.object({
  hash: evmHashSchema,
  number: rpcHexQuantitySchema,
  parentHash: evmHashSchema,
  timestamp: rpcHexQuantitySchema,
  transactions: z.array(rpcMevTransactionSchema).max(ABSOLUTE_MAX_BLOCK_TRANSACTIONS),
});

export const rpcMevBlockHeaderSchema = z.object({
  hash: evmHashSchema,
  number: rpcHexQuantitySchema,
  parentHash: evmHashSchema,
  timestamp: rpcHexQuantitySchema,
});

export const rpcMevLogSchema = z.object({
  address: evmAddressSchema,
  blockHash: evmHashSchema,
  blockNumber: rpcHexQuantitySchema,
  data: evmBytesSchema,
  logIndex: rpcHexQuantitySchema,
  removed: z.boolean().optional(),
  topics: z.array(evmHashSchema).max(4),
  transactionHash: evmHashSchema,
  transactionIndex: rpcHexQuantitySchema,
});

export const rpcMevPoolLogsSchema = z.array(rpcMevLogSchema).max(ABSOLUTE_MAX_POOL_LOGS);

export const rpcMevReceiptSchema = z.object({
  blockHash: evmHashSchema,
  blockNumber: rpcHexQuantitySchema,
  contractAddress: evmAddressSchema.nullable(),
  effectiveGasPrice: rpcHexQuantitySchema,
  gasUsed: rpcHexQuantitySchema,
  logs: z.array(rpcMevLogSchema).max(ABSOLUTE_MAX_RECEIPT_LOGS),
  status: rpcHexQuantitySchema,
  transactionHash: evmHashSchema,
  transactionIndex: rpcHexQuantitySchema,
});

export function encodeSignedWord(value: number, bits: 16 | 24): string {
  if (!Number.isInteger(value)) {
    throw new Error('Signed ABI word requires an integer.');
  }
  const parsed = BigInt(value);
  const minimum = -(1n << (BigInt(bits) - 1n));
  const maximum = (1n << (BigInt(bits) - 1n)) - 1n;
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`Signed ABI value exceeds int${bits}.`);
  }
  const encoded = parsed < 0n ? (1n << 256n) + parsed : parsed;
  return encoded.toString(16).padStart(64, '0');
}

export function createCanonicalBlockReference(blockHash: string): {
  blockHash: string;
  requireCanonical: true;
} {
  return canonicalBlockReferenceSchema.parse({ blockHash, requireCanonical: true });
}

export type MevObservationRpcCall = z.output<typeof mevObservationRpcCallSchema>;
export type CanonicalBlockReference = z.output<typeof canonicalBlockReferenceSchema>;
export type RpcMevTransaction = z.output<typeof rpcMevTransactionSchema>;
export type RpcMevBlock = z.output<typeof rpcMevBlockSchema>;
export type RpcMevBlockHeader = z.output<typeof rpcMevBlockHeaderSchema>;
export type RpcMevLog = z.output<typeof rpcMevLogSchema>;
export type RpcMevReceipt = z.output<typeof rpcMevReceiptSchema>;
