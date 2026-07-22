import { createHash } from 'node:crypto';

import { rpcHexQuantitySchema, rpcQuantityToDecimal } from '@xxyy/evm-data-adapter';
import {
  evmTransactionSnapshotSchema,
  type EvmTransactionSnapshot,
} from '@xxyy/transaction-analysis-core';

import {
  rpcMevBlockHeaderSchema,
  rpcMevBlockSchema,
  rpcMevLogSchema,
  rpcMevReceiptSchema,
  rpcMevTransactionSchema,
} from './rpc-contracts.js';

export interface NormalizedMevTransaction {
  blockHash: string;
  blockNumber: string;
  from: string;
  hash: string;
  input: string;
  nonce: string;
  to: string | null;
  transactionIndex: number;
  value: string;
}

export interface NormalizedMevBlock {
  hash: string;
  number: string;
  parentHash: string;
  timestamp: string;
  transactions: NormalizedMevTransaction[];
}

export interface NormalizedMevBlockHeader {
  hash: string;
  number: string;
  parentHash: string;
  timestamp: string;
}

export interface NormalizedMevLog {
  address: string;
  blockHash: string;
  blockNumber: string;
  data: string;
  logIndex: number;
  removed: boolean;
  topics: string[];
  transactionHash: string;
  transactionIndex: number;
}

export interface NormalizedMevReceipt {
  blockHash: string;
  blockNumber: string;
  contractAddress: string | null;
  effectiveGasPrice: string;
  gasUsed: string;
  logs: NormalizedMevLog[];
  status: 'reverted' | 'success';
  transactionHash: string;
  transactionIndex: number;
}

export function normalizeMevTransaction(input: unknown): NormalizedMevTransaction {
  const transaction = rpcMevTransactionSchema.parse(input);
  if (
    transaction.blockHash === null ||
    transaction.blockNumber === null ||
    transaction.transactionIndex === null
  ) {
    throw new Error('Expected a mined transaction.');
  }
  return {
    blockHash: transaction.blockHash,
    blockNumber: rpcQuantityToDecimal(transaction.blockNumber),
    from: transaction.from,
    hash: transaction.hash,
    input: transaction.input,
    nonce: rpcQuantityToDecimal(transaction.nonce),
    to: transaction.to,
    transactionIndex: quantityToBoundedNumber(transaction.transactionIndex, 1_000_000),
    value: rpcQuantityToDecimal(transaction.value),
  };
}

export function normalizeMevBlock(input: unknown): NormalizedMevBlock {
  const block = rpcMevBlockSchema.parse(input);
  return {
    hash: block.hash,
    number: rpcQuantityToDecimal(block.number),
    parentHash: block.parentHash,
    timestamp: rpcQuantityToDecimal(block.timestamp),
    transactions: block.transactions.map(normalizeMevTransaction),
  };
}

export function normalizeMevBlockHeader(input: unknown): NormalizedMevBlockHeader {
  const block = rpcMevBlockHeaderSchema.parse(input);
  return {
    hash: block.hash,
    number: rpcQuantityToDecimal(block.number),
    parentHash: block.parentHash,
    timestamp: rpcQuantityToDecimal(block.timestamp),
  };
}

export function normalizeMevLog(input: unknown): NormalizedMevLog {
  const log = rpcMevLogSchema.parse(input);
  return {
    address: log.address,
    blockHash: log.blockHash,
    blockNumber: rpcQuantityToDecimal(log.blockNumber),
    data: log.data,
    logIndex: quantityToBoundedNumber(log.logIndex, 1_000_000),
    removed: log.removed ?? false,
    topics: log.topics,
    transactionHash: log.transactionHash,
    transactionIndex: quantityToBoundedNumber(log.transactionIndex, 1_000_000),
  };
}

export function normalizeMevReceipt(input: unknown): NormalizedMevReceipt {
  const receipt = rpcMevReceiptSchema.parse(input);
  const status = rpcQuantityToDecimal(receipt.status);
  if (status !== '0' && status !== '1') {
    throw new Error('Receipt status must be zero or one.');
  }
  return {
    blockHash: receipt.blockHash,
    blockNumber: rpcQuantityToDecimal(receipt.blockNumber),
    contractAddress: receipt.contractAddress,
    effectiveGasPrice: rpcQuantityToDecimal(receipt.effectiveGasPrice),
    gasUsed: rpcQuantityToDecimal(receipt.gasUsed),
    logs: receipt.logs.map(normalizeMevLog),
    status: status === '1' ? 'success' : 'reverted',
    transactionHash: receipt.transactionHash,
    transactionIndex: quantityToBoundedNumber(receipt.transactionIndex, 1_000_000),
  };
}

export function createEnrichmentSnapshot(input: {
  block: NormalizedMevBlock;
  chainId: string;
  observedAt: string;
  payloadHash: string;
  providerId: string;
  provenanceUrl: string;
  receipt: NormalizedMevReceipt;
  transaction: NormalizedMevTransaction;
}): EvmTransactionSnapshot {
  return evmTransactionSnapshotSchema.parse({
    block: {
      hash: input.block.hash,
      number: input.block.number,
      sourceId: input.providerId,
      timestamp: input.block.timestamp,
    },
    chainId: input.chainId,
    observedAt: input.observedAt,
    receipt: {
      blockNumber: input.receipt.blockNumber,
      contractAddress: input.receipt.contractAddress,
      effectiveGasPrice: input.receipt.effectiveGasPrice,
      gasUsed: input.receipt.gasUsed,
      logs: input.receipt.logs.map((log) => ({
        address: log.address,
        data: log.data,
        logIndex: log.logIndex,
        ...(log.removed ? { removed: true } : {}),
        sourceId: input.providerId,
        topics: log.topics,
      })),
      sourceId: input.providerId,
      status: input.receipt.status,
      transactionHash: input.receipt.transactionHash,
      transactionIndex: input.receipt.transactionIndex,
    },
    requestedTransactionHash: input.transaction.hash,
    sources: [
      {
        id: input.providerId,
        kind: 'rpc',
        observedAt: input.observedAt,
        payloadHash: input.payloadHash,
        url: input.provenanceUrl,
      },
    ],
    transaction: {
      blockNumber: input.transaction.blockNumber,
      from: input.transaction.from,
      hash: input.transaction.hash,
      input: input.transaction.input,
      nonce: input.transaction.nonce,
      sourceId: input.providerId,
      to: input.transaction.to,
      transactionIndex: input.transaction.transactionIndex,
      value: input.transaction.value,
    },
  });
}

export function normalizedLogFingerprint(log: NormalizedMevLog): string {
  return sha256(
    JSON.stringify({
      address: log.address,
      blockHash: log.blockHash,
      blockNumber: log.blockNumber,
      data: log.data,
      logIndex: log.logIndex,
      removed: log.removed,
      topics: log.topics,
      transactionHash: log.transactionHash,
      transactionIndex: log.transactionIndex,
    }),
  );
}

export function parseRpcQuantity(input: unknown): string | undefined {
  const parsed = rpcHexQuantitySchema.safeParse(input);
  return parsed.success ? rpcQuantityToDecimal(parsed.data) : undefined;
}

function quantityToBoundedNumber(quantity: string, maximum: number): number {
  const decimal = rpcQuantityToDecimal(rpcHexQuantitySchema.parse(quantity));
  const value = Number(decimal);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`RPC quantity exceeds the supported ${maximum} bound.`);
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
