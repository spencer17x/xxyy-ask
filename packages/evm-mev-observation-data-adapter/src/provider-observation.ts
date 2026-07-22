import { createHash } from 'node:crypto';

import {
  UNISWAP_V2_SWAP_TOPIC,
  UNISWAP_V3_SWAP_TOPIC,
  enrichEvmExecution,
} from '@xxyy/evm-execution-enrichment-core';
import {
  evmPriceImpactSandwichInputSchema,
  type EvmActorAssetDelta,
  type EvmMevFactSource,
  type EvmMevSwapObservation,
  type EvmPriceImpactSandwichInput,
} from '@xxyy/evm-price-impact-sandwich-core';
import { ERC20_TRANSFER_TOPIC } from '@xxyy/transaction-analysis-core';

import {
  decodeTransferLog,
  decodeV2Reserves,
  decodeV3Liquidity,
  decodeV3Slot0,
  decodeV3TickBitmap,
  decodeV3TickInfo,
  decodeV3TickSpacing,
  findActiveTickRange,
  type ActiveTickRange,
} from './abi.js';
import {
  type EvmMevObservationDiagnostic,
  type EvmMevObservationDiagnosticCode,
  type EvmMevObservationProviderConfig,
  type EvmMevObservationUsage,
  type EvmMevPoolAllowlistEntry,
} from './contracts.js';
import { EvmMevObservationRequestError } from './errors.js';
import {
  createEnrichmentSnapshot,
  normalizeMevBlock,
  normalizeMevBlockHeader,
  normalizeMevLog,
  normalizeMevReceipt,
  normalizeMevTransaction,
  normalizedLogFingerprint,
  parseRpcQuantity,
  type NormalizedMevBlock,
  type NormalizedMevLog,
  type NormalizedMevReceipt,
  type NormalizedMevTransaction,
} from './normalize-rpc.js';
import {
  type ObservationJsonRpcClient,
  type ObservationRpcBatchResult,
  type ObservationRpcCallOutcome,
} from './observation-json-rpc-client.js';
import {
  V2_GET_RESERVES_SELECTOR,
  V3_LIQUIDITY_SELECTOR,
  V3_SLOT0_SELECTOR,
  V3_TICKS_SELECTOR,
  V3_TICK_BITMAP_SELECTOR,
  V3_TICK_SPACING_SELECTOR,
  createCanonicalBlockReference,
  encodeSignedWord,
  rpcMevPoolLogsSchema,
  type MevObservationRpcCall,
} from './rpc-contracts.js';
import {
  replayV2PoolStates,
  replayV3PoolStates,
  type ReplayStatePair,
  type ReplaySwap,
} from './state-replay.js';

const UNISWAP_V2_PAIR_SWAP_SELECTOR = '0x022c0d9f';
const UNISWAP_V3_POOL_SWAP_SELECTOR = '0x128acb08';

export interface ProviderComponentFingerprints {
  actorAssetDeltas: string;
  blockTransactions: string;
  poolState: string;
  swap: string;
}

export interface ProviderObservation {
  analysisInput?: EvmPriceImpactSandwichInput | undefined;
  blockHash?: string | undefined;
  components?: ProviderComponentFingerprints | undefined;
  diagnostics: EvmMevObservationDiagnostic[];
  fingerprint?: string | undefined;
  providerId: string;
  usage: EvmMevObservationUsage;
}

export interface ProviderObservationLimits {
  maxBlockTransactions: number;
  maxPoolLogs: number;
  maxReceiptLogs: number;
  maxRelevantTransactions: number;
  maxRpcBatchSize: number;
  maxTickBitmapWordsPerSide: number;
}

interface ProviderObservationInput {
  chainId: string;
  client: ObservationJsonRpcClient;
  limits: ProviderObservationLimits;
  observedAt: string;
  pool: EvmMevPoolAllowlistEntry;
  provider: EvmMevObservationProviderConfig;
  signal?: AbortSignal | undefined;
  targetTransactionHash: string;
}

interface RequestState {
  diagnostics: EvmMevObservationDiagnostic[];
  payloadHashes: string[];
  usage: EvmMevObservationUsage;
}

interface DecodedTransactionSwap {
  receipt: NormalizedMevReceipt;
  replay: ReplaySwap;
  transaction: NormalizedMevTransaction;
}

interface ActorDeltaResult {
  actorAssetDeltas?: EvmActorAssetDelta[] | undefined;
  complete: boolean;
  tokenBehavior: 'standard' | 'unknown';
}

export async function loadProviderObservation(
  input: ProviderObservationInput,
): Promise<ProviderObservation> {
  const requestState: RequestState = {
    diagnostics: [],
    payloadHashes: [],
    usage: zeroUsage(),
  };
  const discovery = await requestBatch(input, requestState, [
    { method: 'eth_chainId', operation: 'chain_id', params: [] },
    {
      method: 'eth_getTransactionByHash',
      operation: 'target_transaction',
      params: [input.targetTransactionHash],
      transactionHash: input.targetTransactionHash,
    },
  ]);
  if (discovery === undefined) {
    return failedObservation(input, requestState);
  }

  const chainOutcome = outcomeFor(discovery, 'chain_id');
  const actualChainId =
    chainOutcome?.ok === true ? parseRpcQuantity(chainOutcome.result) : undefined;
  if (actualChainId === undefined) {
    addOutcomeDiagnostic(requestState, chainOutcome, 'chain_id_unavailable', input, discovery);
    return failedObservation(input, requestState);
  }
  if (actualChainId !== input.chainId) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(discovery),
      code: 'chain_id_mismatch',
      operation: 'chain_id',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }

  const transactionOutcome = outcomeFor(discovery, 'target_transaction');
  if (transactionOutcome === undefined || !transactionOutcome.ok) {
    addOutcomeDiagnostic(requestState, transactionOutcome, 'target_not_found', input, discovery);
    return failedObservation(input, requestState);
  }
  if (transactionOutcome.result === null || transactionOutcome.result === undefined) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(discovery),
      code: 'target_not_found',
      operation: 'target_transaction',
      providerId: input.client.providerId,
      retryable: false,
      transactionHash: input.targetTransactionHash,
    });
    return failedObservation(input, requestState);
  }

  let target: NormalizedMevTransaction;
  try {
    target = normalizeMevTransaction(transactionOutcome.result);
  } catch {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(discovery),
      code: 'invalid_transaction_payload',
      operation: 'target_transaction',
      providerId: input.client.providerId,
      retryable: false,
      transactionHash: input.targetTransactionHash,
    });
    return failedObservation(input, requestState);
  }
  if (target.hash !== input.targetTransactionHash) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(discovery),
      code: 'block_transaction_mismatch',
      operation: 'target_transaction',
      providerId: input.client.providerId,
      retryable: false,
      transactionHash: input.targetTransactionHash,
    });
    return failedObservation(input, requestState);
  }

  const blockResponse = await requestBatch(input, requestState, [
    {
      blockHash: target.blockHash,
      method: 'eth_getBlockByHash',
      operation: 'block',
      params: [target.blockHash, true],
    },
  ]);
  if (blockResponse === undefined) {
    return failedObservation(input, requestState);
  }
  const blockOutcome = outcomeFor(blockResponse, 'block');
  if (blockOutcome === undefined || !blockOutcome.ok || blockOutcome.result == null) {
    addOutcomeDiagnostic(requestState, blockOutcome, 'block_not_found', input, blockResponse);
    return failedObservation(input, requestState);
  }
  const rawBlockTransactions = rawArrayLength(blockOutcome.result, 'transactions');
  if (
    rawBlockTransactions !== undefined &&
    rawBlockTransactions > input.limits.maxBlockTransactions
  ) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(blockResponse),
      code: 'block_transaction_limit_exceeded',
      operation: 'block',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }

  let block: NormalizedMevBlock;
  try {
    block = normalizeMevBlock(blockOutcome.result);
  } catch {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(blockResponse),
      code: 'invalid_block_payload',
      operation: 'block',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }
  if (!validateBlockAndTarget(block, target, input.limits.maxBlockTransactions)) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(blockResponse),
      code: 'block_transaction_mismatch',
      operation: 'block',
      providerId: input.client.providerId,
      retryable: false,
      transactionHash: input.targetTransactionHash,
    });
    return failedObservation(input, requestState);
  }
  if (BigInt(block.number) === 0n) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(blockResponse),
      code: 'block_parent_mismatch',
      operation: 'parent_block',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }

  const baseCalls = createBaseCalls(input.pool, block.hash, block.parentHash);
  const baseResponse = await requestBatch(input, requestState, baseCalls);
  if (baseResponse === undefined) {
    return failedObservation(input, requestState);
  }
  const parentOutcome = outcomeFor(baseResponse, 'parent_block');
  if (parentOutcome === undefined || !parentOutcome.ok || parentOutcome.result == null) {
    addOutcomeDiagnostic(requestState, parentOutcome, 'block_not_found', input, baseResponse);
    return failedObservation(input, requestState);
  }
  let parent;
  try {
    parent = normalizeMevBlockHeader(parentOutcome.result);
  } catch {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(baseResponse),
      code: 'invalid_block_payload',
      operation: 'parent_block',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }
  if (parent.hash !== block.parentHash || BigInt(parent.number) + 1n !== BigInt(block.number)) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(baseResponse),
      code: 'block_parent_mismatch',
      operation: 'parent_block',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }

  const poolLogsOutcome = outcomeFor(baseResponse, 'pool_logs');
  if (poolLogsOutcome === undefined || !poolLogsOutcome.ok || poolLogsOutcome.result == null) {
    addOutcomeDiagnostic(
      requestState,
      poolLogsOutcome,
      'invalid_pool_logs_payload',
      input,
      baseResponse,
    );
    return failedObservation(input, requestState);
  }
  const rawPoolLogCount = Array.isArray(poolLogsOutcome.result)
    ? poolLogsOutcome.result.length
    : undefined;
  if (rawPoolLogCount !== undefined && rawPoolLogCount > input.limits.maxPoolLogs) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(baseResponse),
      code: 'pool_logs_limit_exceeded',
      operation: 'pool_logs',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }
  let poolLogs: NormalizedMevLog[];
  try {
    poolLogs = rpcMevPoolLogsSchema.parse(poolLogsOutcome.result).map(normalizeMevLog);
  } catch {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(baseResponse),
      code: 'invalid_pool_logs_payload',
      operation: 'pool_logs',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }
  if (!validatePoolLogs(poolLogs, block, input.pool.poolAddress)) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(baseResponse),
      code: 'pool_log_block_mismatch',
      operation: 'pool_logs',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }

  const swapTopic =
    input.pool.protocol === 'uniswap_v2' ? UNISWAP_V2_SWAP_TOPIC : UNISWAP_V3_SWAP_TOPIC;
  const swapLogs = poolLogs.filter((log) => log.topics[0] === swapTopic);
  const swapTransactionHashes = swapLogs.map((log) => log.transactionHash);
  if (new Set(swapTransactionHashes).size !== swapTransactionHashes.length) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(baseResponse),
      code: 'multiple_pool_swaps_per_transaction',
      operation: 'pool_logs',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }
  if (swapLogs.length > input.limits.maxRelevantTransactions) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(baseResponse),
      code: 'pool_logs_limit_exceeded',
      operation: 'pool_logs',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }
  if (!swapTransactionHashes.includes(input.targetTransactionHash)) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(baseResponse),
      code: 'target_pool_swap_not_found',
      operation: 'pool_logs',
      providerId: input.client.providerId,
      retryable: false,
      transactionHash: input.targetTransactionHash,
    });
    return failedObservation(input, requestState);
  }

  const receipts = await loadReceipts(input, requestState, swapTransactionHashes, block, poolLogs);
  if (receipts === undefined) {
    return failedObservation(input, requestState);
  }

  const activeRange =
    input.pool.protocol === 'uniswap_v3'
      ? await loadActiveTickRange(input, requestState, baseResponse, block.parentHash)
      : undefined;
  if (input.pool.protocol === 'uniswap_v3' && activeRange === undefined) {
    return failedObservation(input, requestState);
  }

  const factSource = createFactSource(input, requestState.payloadHashes);
  const decoded = decodeTransactionSwaps({
    block,
    factSource,
    input,
    poolLogs,
    receipts,
    requestState,
    swapLogs,
  });
  if (decoded === undefined) {
    return failedObservation(input, requestState);
  }

  const statePairs = replayStates({
    activeRange,
    baseResponse,
    blockHash: block.hash,
    decoded,
    factSource,
    input,
    parentHash: block.parentHash,
    poolLogs,
    requestState,
  });
  if (statePairs === undefined) {
    return failedObservation(input, requestState);
  }

  const observations: EvmMevSwapObservation[] = [];
  let actorAssetDeltasComplete = true;
  for (const item of decoded) {
    const states = statePairs.get(item.transaction.hash);
    if (states === undefined) {
      addDiagnostic(requestState, {
        code: 'invalid_state_payload',
        operation: input.pool.protocol === 'uniswap_v2' ? 'v2_reserves' : 'v3_slot0',
        providerId: input.client.providerId,
        retryable: false,
        transactionHash: item.transaction.hash,
      });
      return failedObservation(input, requestState);
    }
    const deltas = actorDeltas(item, input.pool);
    if (!deltas.complete) {
      actorAssetDeltasComplete = false;
      addDiagnostic(requestState, {
        code: 'actor_delta_invalid',
        operation: 'receipt',
        providerId: input.client.providerId,
        retryable: false,
        transactionHash: item.transaction.hash,
      });
    }
    observations.push({
      actor: item.transaction.from,
      ...(deltas.actorAssetDeltas === undefined
        ? {}
        : { actorAssetDeltas: deltas.actorAssetDeltas }),
      blockNumber: block.number,
      routeKind: routeKind(item.receipt),
      source: factSource,
      stateAfter: states.stateAfter,
      stateBefore: states.stateBefore,
      swap: item.replay.swap,
      swapMode: swapMode(item.transaction, input.pool),
      tokenBehavior: deltas.tokenBehavior,
      transactionHash: item.transaction.hash,
      transactionIndex: item.transaction.transactionIndex,
    });
  }
  observations.sort((left, right) => left.transactionIndex - right.transactionIndex);

  let analysisInput: EvmPriceImpactSandwichInput;
  try {
    analysisInput = evmPriceImpactSandwichInputSchema.parse({
      neighborhood: {
        blockNumber: block.number,
        conflicts: [],
        coverage: {
          actorAssetDeltas: actorAssetDeltasComplete ? 'complete' : 'partial',
          blockTransactions: 'complete',
          poolStates: 'complete',
        },
        observations,
        source: factSource,
      },
      pool: {
        chainId: input.chainId,
        feePips: input.pool.feePips,
        poolAddress: input.pool.poolAddress,
        protocol: input.pool.protocol,
        source: factSource,
        token0: input.pool.token0,
        token1: input.pool.token1,
      },
      targetTransactionHash: input.targetTransactionHash,
    });
  } catch {
    addDiagnostic(requestState, {
      code: 'invalid_state_payload',
      providerId: input.client.providerId,
      retryable: false,
    });
    return failedObservation(input, requestState);
  }

  const components = componentFingerprints(block, analysisInput);
  return {
    analysisInput,
    blockHash: block.hash,
    components,
    diagnostics: requestState.diagnostics,
    fingerprint: sha256(JSON.stringify(components)),
    providerId: input.client.providerId,
    usage: requestState.usage,
  };
}

function createBaseCalls(
  pool: EvmMevPoolAllowlistEntry,
  blockHash: string,
  parentHash: string,
): MevObservationRpcCall[] {
  const calls: MevObservationRpcCall[] = [
    {
      blockHash: parentHash,
      method: 'eth_getBlockByHash',
      operation: 'parent_block',
      params: [parentHash, false],
    },
    {
      blockHash,
      method: 'eth_getLogs',
      operation: 'pool_logs',
      params: [{ address: pool.poolAddress, blockHash }],
      poolAddress: pool.poolAddress,
    },
  ];
  if (pool.protocol === 'uniswap_v2') {
    calls.push(
      stateCall('v2_reserves', V2_GET_RESERVES_SELECTOR, pool.poolAddress, parentHash),
      stateCall('v2_reserves', V2_GET_RESERVES_SELECTOR, pool.poolAddress, blockHash),
    );
  } else {
    calls.push(
      stateCall('v3_slot0', V3_SLOT0_SELECTOR, pool.poolAddress, parentHash),
      stateCall('v3_liquidity', V3_LIQUIDITY_SELECTOR, pool.poolAddress, parentHash),
      stateCall('v3_tick_spacing', V3_TICK_SPACING_SELECTOR, pool.poolAddress, parentHash),
      stateCall('v3_slot0', V3_SLOT0_SELECTOR, pool.poolAddress, blockHash),
      stateCall('v3_liquidity', V3_LIQUIDITY_SELECTOR, pool.poolAddress, blockHash),
    );
  }
  return calls;
}

function stateCall(
  operation: 'v2_reserves' | 'v3_liquidity' | 'v3_slot0' | 'v3_tick_spacing',
  selector:
    | typeof V2_GET_RESERVES_SELECTOR
    | typeof V3_LIQUIDITY_SELECTOR
    | typeof V3_SLOT0_SELECTOR
    | typeof V3_TICK_SPACING_SELECTOR,
  poolAddress: string,
  blockHash: string,
): MevObservationRpcCall {
  return {
    blockHash,
    method: 'eth_call',
    operation,
    params: [{ data: selector, to: poolAddress }, createCanonicalBlockReference(blockHash)],
    poolAddress,
  };
}

async function loadReceipts(
  input: ProviderObservationInput,
  requestState: RequestState,
  transactionHashes: readonly string[],
  block: NormalizedMevBlock,
  poolLogs: readonly NormalizedMevLog[],
): Promise<Map<string, NormalizedMevReceipt> | undefined> {
  const receipts = new Map<string, NormalizedMevReceipt>();
  const calls: MevObservationRpcCall[] = transactionHashes.map((transactionHash) => ({
    method: 'eth_getTransactionReceipt',
    operation: 'receipt',
    params: [transactionHash],
    transactionHash,
  }));
  for (const batch of chunks(calls, input.limits.maxRpcBatchSize)) {
    const response = await requestBatch(input, requestState, batch);
    if (response === undefined) {
      return undefined;
    }
    for (const call of batch) {
      if (call.operation !== 'receipt') {
        continue;
      }
      const outcome = outcomeFor(response, 'receipt', call.transactionHash);
      if (outcome === undefined || !outcome.ok || outcome.result == null) {
        addOutcomeDiagnostic(requestState, outcome, 'receipt_not_found', input, response, {
          transactionHash: call.transactionHash,
        });
        return undefined;
      }
      const rawReceiptLogCount = rawArrayLength(outcome.result, 'logs');
      if (rawReceiptLogCount !== undefined && rawReceiptLogCount > input.limits.maxReceiptLogs) {
        addDiagnostic(requestState, {
          attempts: positiveAttempts(response),
          code: 'receipt_logs_limit_exceeded',
          operation: 'receipt',
          providerId: input.client.providerId,
          retryable: false,
          transactionHash: call.transactionHash,
        });
        return undefined;
      }
      let receipt: NormalizedMevReceipt;
      try {
        receipt = normalizeMevReceipt(outcome.result);
      } catch {
        addDiagnostic(requestState, {
          attempts: positiveAttempts(response),
          code: 'invalid_receipt_payload',
          operation: 'receipt',
          providerId: input.client.providerId,
          retryable: false,
          transactionHash: call.transactionHash,
        });
        return undefined;
      }
      const transaction = block.transactions[receipt.transactionIndex];
      if (
        transaction === undefined ||
        transaction.hash !== receipt.transactionHash ||
        receipt.transactionHash !== call.transactionHash ||
        receipt.blockHash !== block.hash ||
        receipt.blockNumber !== block.number ||
        !validateReceiptLogs(receipt, block)
      ) {
        addDiagnostic(requestState, {
          attempts: positiveAttempts(response),
          code: 'receipt_block_mismatch',
          operation: 'receipt',
          providerId: input.client.providerId,
          retryable: false,
          transactionHash: call.transactionHash,
        });
        return undefined;
      }
      if (receipt.status !== 'success') {
        addDiagnostic(requestState, {
          attempts: positiveAttempts(response),
          code: 'receipt_reverted',
          operation: 'receipt',
          providerId: input.client.providerId,
          retryable: false,
          transactionHash: call.transactionHash,
        });
        return undefined;
      }
      const expectedPoolLogs = poolLogs.filter(
        (log) => log.transactionHash === receipt.transactionHash,
      );
      const receiptPoolLogs = receipt.logs.filter((log) => log.address === input.pool.poolAddress);
      if (
        expectedPoolLogs.map(normalizedLogFingerprint).join('\n') !==
        receiptPoolLogs.map(normalizedLogFingerprint).join('\n')
      ) {
        addDiagnostic(requestState, {
          attempts: positiveAttempts(response),
          code: 'pool_logs_mismatch',
          operation: 'receipt',
          providerId: input.client.providerId,
          retryable: false,
          transactionHash: call.transactionHash,
        });
        return undefined;
      }
      receipts.set(call.transactionHash, receipt);
    }
  }
  return receipts;
}

async function loadActiveTickRange(
  input: ProviderObservationInput,
  requestState: RequestState,
  baseResponse: ObservationRpcBatchResult,
  parentHash: string,
): Promise<ActiveTickRange | undefined> {
  const slot0 = decodeV3Slot0(
    stateResult(baseResponse, 'v3_slot0', parentHash, requestState, input, true),
  );
  const tickSpacing = decodeV3TickSpacing(
    stateResult(baseResponse, 'v3_tick_spacing', parentHash, requestState, input, true),
  );
  if (slot0 === undefined || tickSpacing === undefined) {
    addDiagnostic(requestState, {
      attempts: positiveAttempts(baseResponse),
      code: 'invalid_state_payload',
      operation: slot0 === undefined ? 'v3_slot0' : 'v3_tick_spacing',
      providerId: input.client.providerId,
      retryable: false,
    });
    return undefined;
  }

  const compressed = Math.floor(slot0.tick / tickSpacing);
  const currentWord = Math.floor(compressed / 256);
  const positions = Array.from(
    { length: input.limits.maxTickBitmapWordsPerSide * 2 + 1 },
    (_, index) => currentWord - input.limits.maxTickBitmapWordsPerSide + index,
  );
  if (positions.some((position) => position < -32_768 || position > 32_767)) {
    addDiagnostic(requestState, {
      code: 'tick_bitmap_limit_exceeded',
      operation: 'v3_tick_bitmap',
      providerId: input.client.providerId,
      retryable: false,
    });
    return undefined;
  }

  const bitmapCalls: MevObservationRpcCall[] = positions.map((wordPosition) => ({
    blockHash: parentHash,
    method: 'eth_call',
    operation: 'v3_tick_bitmap',
    params: [
      {
        data: `${V3_TICK_BITMAP_SELECTOR}${encodeSignedWord(wordPosition, 16)}`,
        to: input.pool.poolAddress,
      },
      createCanonicalBlockReference(parentHash),
    ],
    poolAddress: input.pool.poolAddress,
    wordPosition,
  }));
  const bitmaps = new Map<number, bigint>();
  for (const batch of chunks(bitmapCalls, input.limits.maxRpcBatchSize)) {
    const response = await requestBatch(input, requestState, batch);
    if (response === undefined) {
      return undefined;
    }
    for (const call of batch) {
      if (call.operation !== 'v3_tick_bitmap') {
        continue;
      }
      const outcome = outcomeFor(response, 'v3_tick_bitmap', undefined, call.wordPosition);
      if (outcome === undefined || !outcome.ok) {
        addOutcomeDiagnostic(requestState, outcome, 'archive_state_unavailable', input, response);
        return undefined;
      }
      const bitmap = decodeV3TickBitmap(outcome.result);
      if (bitmap === undefined) {
        addDiagnostic(requestState, {
          attempts: positiveAttempts(response),
          code: 'invalid_state_payload',
          operation: 'v3_tick_bitmap',
          providerId: input.client.providerId,
          retryable: false,
        });
        return undefined;
      }
      bitmaps.set(call.wordPosition, bitmap);
    }
  }

  const range = findActiveTickRange(
    slot0.tick,
    tickSpacing,
    bitmaps,
    input.limits.maxTickBitmapWordsPerSide,
  );
  if (range === undefined) {
    addDiagnostic(requestState, {
      code: 'tick_range_unavailable',
      operation: 'v3_tick_bitmap',
      providerId: input.client.providerId,
      retryable: false,
    });
    return undefined;
  }

  const tickCalls: MevObservationRpcCall[] = [range.lowerTick, range.upperTick].map((tick) => ({
    blockHash: parentHash,
    method: 'eth_call',
    operation: 'v3_tick',
    params: [
      {
        data: `${V3_TICKS_SELECTOR}${encodeSignedWord(tick, 24)}`,
        to: input.pool.poolAddress,
      },
      createCanonicalBlockReference(parentHash),
    ],
    poolAddress: input.pool.poolAddress,
    tick,
  }));
  const tickResponse = await requestBatch(input, requestState, tickCalls);
  if (tickResponse === undefined) {
    return undefined;
  }
  for (const call of tickCalls) {
    if (call.operation !== 'v3_tick') {
      continue;
    }
    const outcome = outcomeFor(tickResponse, 'v3_tick', undefined, undefined, call.tick);
    if (outcome === undefined || !outcome.ok || decodeV3TickInfo(outcome.result) === undefined) {
      addOutcomeDiagnostic(requestState, outcome, 'tick_range_unavailable', input, tickResponse);
      return undefined;
    }
  }
  return range;
}

function decodeTransactionSwaps(input: {
  block: NormalizedMevBlock;
  factSource: EvmMevFactSource;
  input: ProviderObservationInput;
  poolLogs: readonly NormalizedMevLog[];
  receipts: ReadonlyMap<string, NormalizedMevReceipt>;
  requestState: RequestState;
  swapLogs: readonly NormalizedMevLog[];
}): DecodedTransactionSwap[] | undefined {
  const decoded: DecodedTransactionSwap[] = [];
  const sourcePayloadHash = input.factSource.payloadHash;
  if (sourcePayloadHash === undefined) {
    throw new Error('RPC fact source requires a payload hash.');
  }
  for (const swapLog of input.swapLogs) {
    const transaction = input.block.transactions[swapLog.transactionIndex];
    const receipt = input.receipts.get(swapLog.transactionHash);
    if (transaction === undefined || receipt === undefined) {
      addDiagnostic(input.requestState, {
        code: 'pool_log_transaction_mismatch',
        operation: 'receipt',
        providerId: input.input.client.providerId,
        retryable: false,
        transactionHash: swapLog.transactionHash,
      });
      return undefined;
    }
    const enrichment = enrichEvmExecution({
      poolMetadata: [
        {
          chainId: input.input.chainId,
          poolAddress: input.input.pool.poolAddress,
          protocol: input.input.pool.protocol,
          source: input.factSource,
          token0: input.input.pool.token0,
          token1: input.input.pool.token1,
        },
      ],
      snapshot: createEnrichmentSnapshot({
        block: input.block,
        chainId: input.input.chainId,
        observedAt: input.input.observedAt,
        payloadHash: sourcePayloadHash,
        providerId: input.input.client.providerId,
        provenanceUrl: input.input.client.provenanceUrl,
        receipt,
        transaction,
      }),
    });
    const swaps = enrichment.swaps.filter(
      (swap) =>
        swap.poolAddress === input.input.pool.poolAddress &&
        swap.protocol === input.input.pool.protocol &&
        swap.logIndex === swapLog.logIndex,
    );
    if (swaps.length !== 1) {
      addDiagnostic(input.requestState, {
        code: 'swap_decode_failed',
        operation: 'receipt',
        providerId: input.input.client.providerId,
        retryable: false,
        transactionHash: swapLog.transactionHash,
      });
      return undefined;
    }
    decoded.push({ receipt, replay: { log: swapLog, swap: swaps[0]! }, transaction });
  }
  return decoded;
}

function replayStates(input: {
  activeRange: ActiveTickRange | undefined;
  baseResponse: ObservationRpcBatchResult;
  blockHash: string;
  decoded: readonly DecodedTransactionSwap[];
  factSource: EvmMevFactSource;
  input: ProviderObservationInput;
  parentHash: string;
  poolLogs: readonly NormalizedMevLog[];
  requestState: RequestState;
}): Map<string, ReplayStatePair> | undefined {
  const swaps = input.decoded.map((item) => item.replay);
  if (input.input.pool.protocol === 'uniswap_v2') {
    const decodedInitial = decodeV2Reserves(
      stateResult(
        input.baseResponse,
        'v2_reserves',
        input.parentHash,
        input.requestState,
        input.input,
        true,
      ),
    );
    const end = decodeV2Reserves(
      stateResult(
        input.baseResponse,
        'v2_reserves',
        input.blockHash,
        input.requestState,
        input.input,
        false,
      ),
    );
    if (decodedInitial === undefined || end === undefined) {
      addDiagnostic(input.requestState, {
        code: 'invalid_state_payload',
        operation: 'v2_reserves',
        providerId: input.input.client.providerId,
        retryable: false,
      });
      return undefined;
    }
    const replay = replayV2PoolStates({
      end,
      initial: decodedInitial,
      logs: input.poolLogs,
      source: input.factSource,
      swaps,
    });
    if (!replay.ok) {
      addDiagnostic(input.requestState, {
        code: replay.code,
        operation: 'v2_reserves',
        providerId: input.input.client.providerId,
        retryable: false,
      });
      return undefined;
    }
    return replay.states;
  }

  if (input.activeRange === undefined) {
    return undefined;
  }
  const initialSlot0 = decodeV3Slot0(
    stateResult(
      input.baseResponse,
      'v3_slot0',
      input.parentHash,
      input.requestState,
      input.input,
      true,
    ),
  );
  const initialLiquidity = decodeV3Liquidity(
    stateResult(
      input.baseResponse,
      'v3_liquidity',
      input.parentHash,
      input.requestState,
      input.input,
      true,
    ),
  );
  const endSlot0 = decodeV3Slot0(
    stateResult(
      input.baseResponse,
      'v3_slot0',
      input.blockHash,
      input.requestState,
      input.input,
      false,
    ),
  );
  const endLiquidity = decodeV3Liquidity(
    stateResult(
      input.baseResponse,
      'v3_liquidity',
      input.blockHash,
      input.requestState,
      input.input,
      false,
    ),
  );
  if (
    initialSlot0 === undefined ||
    initialLiquidity === undefined ||
    endSlot0 === undefined ||
    endLiquidity === undefined
  ) {
    addDiagnostic(input.requestState, {
      code: 'invalid_state_payload',
      operation: 'v3_slot0',
      providerId: input.input.client.providerId,
      retryable: false,
    });
    return undefined;
  }
  const replay = replayV3PoolStates({
    activeRange: input.activeRange,
    endLiquidity,
    endSlot0,
    initialLiquidity,
    initialSlot0,
    logs: input.poolLogs,
    source: input.factSource,
    swaps,
  });
  if (!replay.ok) {
    addDiagnostic(input.requestState, {
      code: replay.code,
      operation: 'v3_slot0',
      providerId: input.input.client.providerId,
      retryable: false,
    });
    return undefined;
  }
  return replay.states;
}

function actorDeltas(
  item: DecodedTransactionSwap,
  pool: EvmMevPoolAllowlistEntry,
): ActorDeltaResult {
  const actorDeltas = new Map<string, bigint>([
    [pool.token0, 0n],
    [pool.token1, 0n],
  ]);
  const poolDeltas = new Map<string, bigint>([
    [pool.token0, 0n],
    [pool.token1, 0n],
  ]);
  for (const log of item.receipt.logs) {
    if (log.address !== pool.token0 && log.address !== pool.token1) {
      continue;
    }
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) {
      continue;
    }
    const transfer = decodeTransferLog(log, ERC20_TRANSFER_TOPIC);
    if (transfer === undefined) {
      return { complete: false, tokenBehavior: 'unknown' };
    }
    const token = log.address;
    if (transfer.from === item.transaction.from) {
      actorDeltas.set(token, actorDeltas.get(token)! - transfer.amount);
    }
    if (transfer.to === item.transaction.from) {
      actorDeltas.set(token, actorDeltas.get(token)! + transfer.amount);
    }
    if (transfer.from === pool.poolAddress) {
      poolDeltas.set(token, poolDeltas.get(token)! - transfer.amount);
    }
    if (transfer.to === pool.poolAddress) {
      poolDeltas.set(token, poolDeltas.get(token)! + transfer.amount);
    }
  }

  const reconciled =
    poolDeltas.get(pool.token0) === BigInt(item.replay.swap.amount0PoolDeltaRaw) &&
    poolDeltas.get(pool.token1) === BigInt(item.replay.swap.amount1PoolDeltaRaw);
  const deltas = [...actorDeltas.entries()]
    .filter(([, delta]) => delta !== 0n)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tokenAddress, rawDelta]) => ({ rawDelta: rawDelta.toString(), tokenAddress }));
  return {
    actorAssetDeltas: deltas,
    complete: true,
    tokenBehavior: reconciled ? 'standard' : 'unknown',
  };
}

function routeKind(receipt: NormalizedMevReceipt): EvmMevSwapObservation['routeKind'] {
  const swaps = receipt.logs.filter(
    (log) => log.topics[0] === UNISWAP_V2_SWAP_TOPIC || log.topics[0] === UNISWAP_V3_SWAP_TOPIC,
  ).length;
  return swaps === 1 ? 'single_pool' : swaps > 1 ? 'multi_hop' : 'unknown';
}

function swapMode(
  transaction: NormalizedMevTransaction,
  pool: EvmMevPoolAllowlistEntry,
): EvmMevSwapObservation['swapMode'] {
  const selector = transaction.input.length >= 10 ? transaction.input.slice(0, 10) : undefined;
  if (
    selector !== undefined &&
    transaction.to !== null &&
    pool.exactInputRoutes.some(
      (route) => route.to === transaction.to && route.selectors.includes(selector),
    )
  ) {
    return 'exact_input';
  }
  if (transaction.to !== pool.poolAddress || selector === undefined) {
    return 'unknown';
  }
  if (pool.protocol === 'uniswap_v2' && selector === UNISWAP_V2_PAIR_SWAP_SELECTOR) {
    return 'exact_output';
  }
  if (pool.protocol === 'uniswap_v3' && selector === UNISWAP_V3_POOL_SWAP_SELECTOR) {
    const amountSpecified = decodeV3DirectAmountSpecified(transaction.input);
    return amountSpecified === undefined
      ? 'unknown'
      : amountSpecified > 0n
        ? 'exact_input'
        : 'exact_output';
  }
  return 'unknown';
}

function decodeV3DirectAmountSpecified(input: string): bigint | undefined {
  const start = 2 + 8 + 64 * 2;
  const end = start + 64;
  if (input.length < end || !/^[0-9a-f]{64}$/u.test(input.slice(start, end))) {
    return undefined;
  }
  const raw = BigInt(`0x${input.slice(start, end)}`);
  const signed = raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  return signed === 0n ? undefined : signed;
}

async function requestBatch(
  input: ProviderObservationInput,
  state: RequestState,
  calls: readonly MevObservationRpcCall[],
): Promise<ObservationRpcBatchResult | undefined> {
  try {
    const result = await input.client.requestBatch(calls, { signal: input.signal });
    state.payloadHashes.push(result.payloadHash);
    state.usage.cacheHits += result.cacheHit ? 1 : 0;
    state.usage.costUnits += result.costUnits;
    state.usage.requests += result.cacheHit ? 0 : result.attempts;
    state.usage.responseBytes += result.responseBytes;
    state.usage.rpcCalls += result.cacheHit ? 0 : calls.length * result.attempts;
    return result;
  } catch (error) {
    if (!(error instanceof EvmMevObservationRequestError)) {
      throw error;
    }
    if (error.code === 'request_aborted') {
      throw error;
    }
    state.usage.costUnits += error.attempts * input.provider.costUnitsPerRequest;
    state.usage.requests += error.attempts;
    state.usage.rpcCalls += calls.length * error.attempts;
    addDiagnostic(state, {
      ...(error.attempts > 0 ? { attempts: error.attempts } : {}),
      code: error.code,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      providerId: input.client.providerId,
      retryable: error.retryable,
    });
    return undefined;
  }
}

function stateResult(
  response: ObservationRpcBatchResult,
  operation: 'v2_reserves' | 'v3_liquidity' | 'v3_slot0' | 'v3_tick_spacing',
  blockHash: string | undefined,
  requestState: RequestState,
  input: ProviderObservationInput,
  archive: boolean,
): unknown {
  if (blockHash === undefined || blockHash.length === 0) {
    return undefined;
  }
  const outcome = outcomeFor(response, operation, undefined, undefined, undefined, blockHash);
  if (outcome === undefined || !outcome.ok) {
    addOutcomeDiagnostic(
      requestState,
      outcome,
      archive ? 'archive_state_unavailable' : 'state_call_failed',
      input,
      response,
    );
    return undefined;
  }
  return outcome.result;
}

function outcomeFor(
  response: ObservationRpcBatchResult,
  operation: MevObservationRpcCall['operation'],
  transactionHash?: string,
  wordPosition?: number,
  tick?: number,
  blockHash?: string,
): ObservationRpcCallOutcome | undefined {
  return response.outcomes.find((outcome) => {
    const call = outcome.call;
    return (
      call.operation === operation &&
      (transactionHash === undefined ||
        ('transactionHash' in call && call.transactionHash === transactionHash)) &&
      (wordPosition === undefined ||
        ('wordPosition' in call && call.wordPosition === wordPosition)) &&
      (tick === undefined || ('tick' in call && call.tick === tick)) &&
      (blockHash === undefined || ('blockHash' in call && call.blockHash === blockHash))
    );
  });
}

function addOutcomeDiagnostic(
  state: RequestState,
  outcome: ObservationRpcCallOutcome | undefined,
  code: EvmMevObservationDiagnosticCode,
  input: ProviderObservationInput,
  response: ObservationRpcBatchResult,
  extra: { transactionHash?: string } = {},
): void {
  addDiagnostic(state, {
    attempts: positiveAttempts(response),
    code,
    ...(outcome === undefined ? {} : { operation: outcome.call.operation }),
    providerId: input.client.providerId,
    retryable: false,
    ...(outcome?.ok === false ? { rpcCode: outcome.error.code } : {}),
    ...extra,
  });
}

function addDiagnostic(state: RequestState, diagnostic: EvmMevObservationDiagnostic): void {
  const key = JSON.stringify(diagnostic);
  if (!state.diagnostics.some((item) => JSON.stringify(item) === key)) {
    state.diagnostics.push(diagnostic);
  }
}

function validateBlockAndTarget(
  block: NormalizedMevBlock,
  target: NormalizedMevTransaction,
  maxTransactions: number,
): boolean {
  if (
    block.hash !== target.blockHash ||
    block.number !== target.blockNumber ||
    block.transactions.length > maxTransactions
  ) {
    return false;
  }
  const hashes = new Set<string>();
  for (const [index, transaction] of block.transactions.entries()) {
    if (
      transaction.blockHash !== block.hash ||
      transaction.blockNumber !== block.number ||
      transaction.transactionIndex !== index ||
      hashes.has(transaction.hash)
    ) {
      return false;
    }
    hashes.add(transaction.hash);
  }
  const inBlock = block.transactions[target.transactionIndex];
  return (
    inBlock !== undefined &&
    inBlock.hash === target.hash &&
    inBlock.from === target.from &&
    inBlock.to === target.to &&
    inBlock.input === target.input &&
    inBlock.nonce === target.nonce &&
    inBlock.value === target.value
  );
}

function validatePoolLogs(
  logs: readonly NormalizedMevLog[],
  block: NormalizedMevBlock,
  poolAddress: string,
): boolean {
  const indexes = new Set<number>();
  let priorIndex = -1;
  for (const log of logs) {
    const transaction = block.transactions[log.transactionIndex];
    if (
      log.address !== poolAddress ||
      log.blockHash !== block.hash ||
      log.blockNumber !== block.number ||
      log.removed ||
      transaction === undefined ||
      transaction.hash !== log.transactionHash ||
      indexes.has(log.logIndex) ||
      log.logIndex <= priorIndex
    ) {
      return false;
    }
    indexes.add(log.logIndex);
    priorIndex = log.logIndex;
  }
  return true;
}

function validateReceiptLogs(receipt: NormalizedMevReceipt, block: NormalizedMevBlock): boolean {
  const indexes = new Set<number>();
  let priorIndex = -1;
  for (const log of receipt.logs) {
    if (
      log.blockHash !== block.hash ||
      log.blockNumber !== block.number ||
      log.transactionHash !== receipt.transactionHash ||
      log.transactionIndex !== receipt.transactionIndex ||
      log.removed ||
      indexes.has(log.logIndex) ||
      log.logIndex <= priorIndex
    ) {
      return false;
    }
    indexes.add(log.logIndex);
    priorIndex = log.logIndex;
  }
  return true;
}

function componentFingerprints(
  block: NormalizedMevBlock,
  analysisInput: EvmPriceImpactSandwichInput,
): ProviderComponentFingerprints {
  const observations = analysisInput.neighborhood.observations;
  return {
    actorAssetDeltas: sha256(
      JSON.stringify(
        observations.map((observation) => ({
          actor: observation.actor,
          actorAssetDeltas: observation.actorAssetDeltas ?? null,
          transactionHash: observation.transactionHash,
        })),
      ),
    ),
    blockTransactions: sha256(
      JSON.stringify({
        blockHash: block.hash,
        blockNumber: block.number,
        transactions: block.transactions.map((transaction) => transaction.hash),
      }),
    ),
    poolState: sha256(
      JSON.stringify(
        observations.map((observation) => ({
          stateAfter: stripStateSource(observation.stateAfter),
          stateBefore: stripStateSource(observation.stateBefore),
          transactionHash: observation.transactionHash,
        })),
      ),
    ),
    swap: sha256(
      JSON.stringify(
        observations.map((observation) => ({
          routeKind: observation.routeKind,
          swap: { ...observation.swap, evidenceIds: [] },
          swapMode: observation.swapMode,
          tokenBehavior: observation.tokenBehavior,
          transactionHash: observation.transactionHash,
          transactionIndex: observation.transactionIndex,
        })),
      ),
    ),
  };
}

function stripStateSource(state: EvmMevSwapObservation['stateBefore']): Record<string, unknown> {
  const { source: _source, ...withoutSource } = state;
  return withoutSource;
}

function createFactSource(
  input: ProviderObservationInput,
  payloadHashes: readonly string[],
): EvmMevFactSource {
  return {
    id: input.client.providerId,
    kind: 'rpc',
    observedAt: input.observedAt,
    payloadHash: combinePayloadHashes(payloadHashes),
  };
}

function combinePayloadHashes(hashes: readonly string[]): string {
  return sha256([...hashes].join('\n'));
}

function failedObservation(
  input: ProviderObservationInput,
  state: RequestState,
): ProviderObservation {
  return {
    diagnostics: state.diagnostics,
    providerId: input.client.providerId,
    usage: state.usage,
  };
}

function zeroUsage(): EvmMevObservationUsage {
  return { cacheHits: 0, costUnits: 0, requests: 0, responseBytes: 0, rpcCalls: 0 };
}

function positiveAttempts(response: ObservationRpcBatchResult): number {
  return Math.max(1, response.attempts);
}

function rawArrayLength(input: unknown, field: string): number | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[field];
  return Array.isArray(value) ? value.length : undefined;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
