import { z } from 'zod';

import {
  EVM_UINT256_MAX,
  evmAddressSchema,
  evmBytesSchema,
  evmChainIdSchema,
  evmHashSchema,
  evmTransactionSnapshotSchema,
} from '@xxyy/transaction-analysis-core';

export const evmRpcMethods = [
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_chainId',
  'eth_getBlockByNumber',
] as const;

export const evmDataAdapterDiagnosticCodes = [
  'block_number_mismatch',
  'block_not_found',
  'chain_id_mismatch',
  'chain_id_unavailable',
  'http_error',
  'invalid_block_payload',
  'invalid_chain_id_payload',
  'invalid_json',
  'invalid_jsonrpc',
  'invalid_receipt_payload',
  'invalid_transaction_payload',
  'receipt_not_found',
  'request_timeout',
  'response_too_large',
  'rpc_error',
  'receipt_transaction_hash_mismatch',
  'transaction_not_found',
  'transaction_hash_mismatch',
  'transaction_receipt_block_mismatch',
  'transaction_receipt_index_mismatch',
  'transport_error',
] as const;

export type EvmRpcMethod = (typeof evmRpcMethods)[number];
export type EvmDataAdapterDiagnosticCode = (typeof evmDataAdapterDiagnosticCodes)[number];

export const evmRpcProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/u, 'Expected a stable lower-case provider id.');

const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u, 'Expected a valid HTTP header name.');

const headerValueSchema = z
  .string()
  .max(8_192)
  .refine((value) => !/[\r\n]/u.test(value), 'Header values cannot contain line breaks.');

const forbiddenProviderHeaders = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'proxy-authorization',
  'transfer-encoding',
]);

const providerHeadersSchema = z
  .record(headerNameSchema, headerValueSchema)
  .superRefine((headers, context) => {
    if (Object.keys(headers).length > 32) {
      context.addIssue({
        code: 'custom',
        message: 'A provider can define at most 32 headers.',
        path: [],
      });
    }
    const normalizedNames = new Set<string>();
    for (const name of Object.keys(headers)) {
      const normalizedName = name.toLowerCase();
      if (normalizedNames.has(normalizedName)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate case-insensitive header: ${name}`,
          path: [name],
        });
      }
      if (forbiddenProviderHeaders.has(normalizedName)) {
        context.addIssue({
          code: 'custom',
          message: `Header is controlled by the adapter: ${name}`,
          path: [name],
        });
      }
      normalizedNames.add(normalizedName);
    }
  })
  .transform((headers) =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
  );

export const evmRpcProviderConfigSchema = z
  .object({
    endpoint: z.string().trim().max(2_048).url(),
    headers: providerHeadersSchema.optional(),
    id: evmRpcProviderIdSchema,
  })
  .strict();

export const evmChainRpcConfigSchema = z
  .object({
    chainId: evmChainIdSchema,
    providers: z
      .array(evmRpcProviderConfigSchema)
      .min(1)
      .max(8)
      .refine(
        (providers) => new Set(providers.map((provider) => provider.id)).size === providers.length,
        { message: 'Provider ids must be unique within a chain.' },
      ),
  })
  .strict();

export const evmDataAdapterConfigSchema = z
  .array(evmChainRpcConfigSchema)
  .min(1)
  .max(64)
  .refine((chains) => new Set(chains.map((chain) => chain.chainId)).size === chains.length, {
    message: 'Chain ids must be unique.',
  });

export const loadEvmTransactionSnapshotInputSchema = z
  .object({
    chainId: evmChainIdSchema,
    providerIds: z
      .array(evmRpcProviderIdSchema)
      .min(1)
      .max(8)
      .refine((providerIds) => new Set(providerIds).size === providerIds.length, {
        message: 'Provider ids must be unique.',
      })
      .optional(),
    transactionHash: evmHashSchema,
  })
  .strict();

export const rpcHexQuantitySchema = z
  .string()
  .regex(/^(?:0x0|0x[1-9a-fA-F][0-9a-fA-F]{0,63})$/u, 'Expected a canonical hex quantity.')
  .refine((value) => BigInt(value) <= EVM_UINT256_MAX, 'Hex quantity exceeds uint256.')
  .transform((value) => value.toLowerCase());

export const evmRpcCallSchema = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('eth_getTransactionByHash'),
      params: z.tuple([evmHashSchema]),
    })
    .strict(),
  z
    .object({
      method: z.literal('eth_getTransactionReceipt'),
      params: z.tuple([evmHashSchema]),
    })
    .strict(),
  z
    .object({
      method: z.literal('eth_chainId'),
      params: z.tuple([]),
    })
    .strict(),
  z
    .object({
      method: z.literal('eth_getBlockByNumber'),
      params: z.tuple([rpcHexQuantitySchema, z.literal(false)]),
    })
    .strict(),
]);

export const rpcTransactionSchema = z.object({
  blockNumber: rpcHexQuantitySchema.nullable(),
  from: evmAddressSchema,
  hash: evmHashSchema,
  input: evmBytesSchema,
  nonce: rpcHexQuantitySchema,
  to: evmAddressSchema.nullable(),
  transactionIndex: rpcHexQuantitySchema.nullable(),
  value: rpcHexQuantitySchema,
});

export const rpcLogSchema = z.object({
  address: evmAddressSchema,
  data: evmBytesSchema,
  logIndex: rpcHexQuantitySchema,
  removed: z.boolean().optional(),
  topics: z.array(evmHashSchema).max(4),
});

export const rpcReceiptSchema = z.object({
  blockNumber: rpcHexQuantitySchema,
  contractAddress: evmAddressSchema.nullable(),
  effectiveGasPrice: rpcHexQuantitySchema,
  gasUsed: rpcHexQuantitySchema,
  logs: z.array(rpcLogSchema).max(500),
  status: rpcHexQuantitySchema,
  transactionHash: evmHashSchema,
  transactionIndex: rpcHexQuantitySchema,
});

export const rpcBlockSchema = z.object({
  hash: evmHashSchema,
  number: rpcHexQuantitySchema,
  timestamp: rpcHexQuantitySchema,
});

export const evmDataAdapterDiagnosticSchema = z
  .object({
    attempts: z.number().int().positive().max(4).optional(),
    code: z.enum(evmDataAdapterDiagnosticCodes),
    httpStatus: z.number().int().min(100).max(599).optional(),
    method: z.enum(evmRpcMethods).optional(),
    providerId: evmRpcProviderIdSchema,
    retryable: z.boolean(),
    rpcCode: z.number().int().optional(),
  })
  .strict();

export const evmDataAdapterResultSchema = z
  .object({
    diagnostics: z.array(evmDataAdapterDiagnosticSchema).max(100),
    snapshot: evmTransactionSnapshotSchema,
    status: z.enum(['success', 'partial', 'insufficient_data']),
  })
  .strict();

export type EvmRpcProviderConfig = z.output<typeof evmRpcProviderConfigSchema>;
export type EvmChainRpcConfig = z.output<typeof evmChainRpcConfigSchema>;
export type LoadEvmTransactionSnapshotInput = z.output<
  typeof loadEvmTransactionSnapshotInputSchema
>;
export type EvmRpcCall = z.output<typeof evmRpcCallSchema>;
export type RpcTransaction = z.output<typeof rpcTransactionSchema>;
export type RpcReceipt = z.output<typeof rpcReceiptSchema>;
export type RpcBlock = z.output<typeof rpcBlockSchema>;
export type EvmDataAdapterDiagnostic = z.output<typeof evmDataAdapterDiagnosticSchema>;
export type EvmDataAdapterResult = z.output<typeof evmDataAdapterResultSchema>;
