import type {
  EvmTransaction,
  EvmTransactionReceipt,
  EvmTransactionLog,
  EvmTransactionSnapshot,
} from '@xxyy/transaction-analysis-core';
import { EVM_UINT256_MAX, evmUintSchema } from '@xxyy/transaction-analysis-core';

import {
  rpcBlockSchema,
  rpcHexQuantitySchema,
  rpcReceiptSchema,
  rpcTransactionSchema,
  type RpcBlock,
  type RpcReceipt,
  type RpcTransaction,
} from './contracts.js';

const MAX_NORMALIZED_INDEX = 1_000_000n;

export function rpcQuantityToDecimal(quantity: string): string {
  return BigInt(rpcHexQuantitySchema.parse(quantity)).toString(10);
}

export function decimalToRpcQuantity(decimal: string): string {
  return `0x${BigInt(evmUintSchema.parse(decimal)).toString(16)}`;
}

export function normalizeRpcTransaction(input: unknown, sourceId: string): EvmTransaction {
  const transaction = rpcTransactionSchema.parse(input);
  return {
    ...(transaction.blockNumber === null
      ? {}
      : { blockNumber: rpcQuantityToDecimal(transaction.blockNumber) }),
    from: transaction.from,
    hash: transaction.hash,
    input: transaction.input,
    nonce: rpcQuantityToDecimal(transaction.nonce),
    sourceId,
    to: transaction.to,
    ...(transaction.transactionIndex === null
      ? {}
      : { transactionIndex: normalizedIndex(transaction.transactionIndex) }),
    value: rpcQuantityToDecimal(transaction.value),
  };
}

export function normalizeRpcReceipt(input: unknown, sourceId: string): EvmTransactionReceipt {
  const receipt = rpcReceiptSchema.parse(input);
  if (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) > EVM_UINT256_MAX) {
    throw new RangeError('RPC receipt fee exceeds uint256.');
  }
  return {
    blockNumber: rpcQuantityToDecimal(receipt.blockNumber),
    contractAddress: receipt.contractAddress,
    effectiveGasPrice: rpcQuantityToDecimal(receipt.effectiveGasPrice),
    gasUsed: rpcQuantityToDecimal(receipt.gasUsed),
    logs: receipt.logs.map((log) => normalizeRpcLog(log, sourceId)),
    sourceId,
    status: normalizeReceiptStatus(receipt.status),
    transactionHash: receipt.transactionHash,
    transactionIndex: normalizedIndex(receipt.transactionIndex),
  };
}

export function normalizeRpcBlock(
  input: unknown,
  sourceId: string,
): NonNullable<EvmTransactionSnapshot['block']> {
  const block = rpcBlockSchema.parse(input);
  return {
    hash: block.hash,
    number: rpcQuantityToDecimal(block.number),
    sourceId,
    timestamp: rpcQuantityToDecimal(block.timestamp),
  };
}

export function parseRpcTransaction(input: unknown): RpcTransaction {
  return rpcTransactionSchema.parse(input);
}

export function parseRpcReceipt(input: unknown): RpcReceipt {
  return rpcReceiptSchema.parse(input);
}

export function parseRpcBlock(input: unknown): RpcBlock {
  return rpcBlockSchema.parse(input);
}

function normalizeRpcLog(log: RpcReceipt['logs'][number], sourceId: string): EvmTransactionLog {
  return {
    address: log.address,
    data: log.data,
    logIndex: normalizedIndex(log.logIndex),
    ...(log.removed === undefined ? {} : { removed: log.removed }),
    sourceId,
    topics: log.topics,
  };
}

function normalizedIndex(quantity: string): number {
  const value = BigInt(quantity);
  if (value > MAX_NORMALIZED_INDEX) {
    throw new RangeError('RPC index exceeds the normalized snapshot limit.');
  }
  return Number(value);
}

function normalizeReceiptStatus(status: string): EvmTransactionReceipt['status'] {
  if (status === '0x1') {
    return 'success';
  }
  if (status === '0x0') {
    return 'reverted';
  }
  throw new RangeError('RPC receipt status must be 0x0 or 0x1.');
}
