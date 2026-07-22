import { createHash } from 'node:crypto';

import {
  evmTransactionSnapshotSchema,
  type EvmSnapshotSource,
  type EvmTransaction,
  type EvmTransactionReceipt,
  type EvmTransactionSnapshot,
} from '@xxyy/transaction-analysis-core';

import {
  evmDataAdapterConfigSchema,
  evmDataAdapterResultSchema,
  loadEvmTransactionSnapshotInputSchema,
  rpcHexQuantitySchema,
  type EvmChainRpcConfig,
  type EvmDataAdapterDiagnostic,
  type EvmDataAdapterResult,
  type LoadEvmTransactionSnapshotInput,
} from './contracts.js';
import { EvmDataAdapterConfigurationError, EvmRpcRequestError } from './errors.js';
import {
  createEvmJsonRpcClient,
  type CreateEvmJsonRpcClientOptions,
  type EvmJsonRpcClient,
  type EvmRpcCallOutcome,
} from './json-rpc-client.js';
import {
  decimalToRpcQuantity,
  normalizeRpcBlock,
  normalizeRpcReceipt,
  normalizeRpcTransaction,
} from './normalize-rpc.js';

type ObservationState = 'invalid' | 'missing' | 'unavailable' | 'value';
type SourceConflict = NonNullable<EvmTransactionSnapshot['conflicts']>[number];

interface ConfiguredProvider {
  client: EvmJsonRpcClient;
  config: EvmChainRpcConfig['providers'][number];
}

interface ProviderObservation {
  block?: NonNullable<EvmTransactionSnapshot['block']> | undefined;
  blockState: ObservationState;
  diagnostics: EvmDataAdapterDiagnostic[];
  receipt?: EvmTransactionReceipt | undefined;
  receiptState: ObservationState;
  source: EvmSnapshotSource;
  transaction?: EvmTransaction | undefined;
  transactionState: ObservationState;
}

export interface EvmDataAdapter {
  listConfiguredChains(): Array<{ chainId: string; providerIds: string[] }>;
  loadTransactionSnapshot(
    input: LoadEvmTransactionSnapshotInput,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<EvmDataAdapterResult>;
}

export interface CreateEvmDataAdapterOptions extends Omit<
  CreateEvmJsonRpcClientOptions,
  'provider'
> {
  chains: readonly EvmChainRpcConfig[];
  now?: () => Date;
}

export function createEvmDataAdapter(options: CreateEvmDataAdapterOptions): EvmDataAdapter {
  let chainConfigs: EvmChainRpcConfig[];
  try {
    chainConfigs = evmDataAdapterConfigSchema.parse(options.chains);
  } catch (cause) {
    throw new EvmDataAdapterConfigurationError(
      'invalid_configuration',
      'EVM data adapter chain configuration is invalid.',
      { cause },
    );
  }
  if (options.maxBatchSize !== undefined && options.maxBatchSize < 3) {
    throw new EvmDataAdapterConfigurationError(
      'invalid_limits',
      'maxBatchSize must allow transaction, receipt, and chain verification in one batch.',
    );
  }

  const now = options.now ?? (() => new Date());
  const configuredChains = new Map<string, ConfiguredProvider[]>();
  for (const chain of chainConfigs) {
    configuredChains.set(
      chain.chainId,
      chain.providers.map((provider) => ({
        client: createEvmJsonRpcClient({
          ...(options.allowInsecureLocalhost === undefined
            ? {}
            : { allowInsecureLocalhost: options.allowInsecureLocalhost }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.maxBatchSize === undefined ? {} : { maxBatchSize: options.maxBatchSize }),
          ...(options.maxResponseBytes === undefined
            ? {}
            : { maxResponseBytes: options.maxResponseBytes }),
          ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
          provider,
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
          ...(options.retryBaseDelayMs === undefined
            ? {}
            : { retryBaseDelayMs: options.retryBaseDelayMs }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        }),
        config: provider,
      })),
    );
  }

  return {
    listConfiguredChains() {
      return chainConfigs.map((chain) => ({
        chainId: chain.chainId,
        providerIds: chain.providers.map((provider) => provider.id),
      }));
    },

    async loadTransactionSnapshot(input, loadOptions = {}) {
      let parsedInput: LoadEvmTransactionSnapshotInput;
      try {
        parsedInput = loadEvmTransactionSnapshotInputSchema.parse(input);
      } catch (cause) {
        throw new EvmDataAdapterConfigurationError(
          'invalid_configuration',
          'EVM transaction snapshot request is invalid.',
          { cause },
        );
      }

      const providers = configuredChains.get(parsedInput.chainId);
      if (providers === undefined) {
        throw new EvmDataAdapterConfigurationError(
          'chain_not_configured',
          `EVM chain ${parsedInput.chainId} is not configured.`,
        );
      }
      const selectedProviders = selectProviders(providers, parsedInput.providerIds);
      const observedAt = createObservedAt(now);
      const observations = await Promise.all(
        selectedProviders.map((provider) =>
          loadProviderObservation(
            provider.client,
            parsedInput.chainId,
            parsedInput.transactionHash,
            observedAt,
            loadOptions.signal,
          ),
        ),
      );
      const conflicts = collectSourceConflicts(observations);
      const diagnostics = observations.flatMap((observation) => observation.diagnostics);
      const transaction = firstDefined(observations.map((observation) => observation.transaction));
      const receipt = firstDefined(observations.map((observation) => observation.receipt));
      const block = firstDefined(observations.map((observation) => observation.block));

      const snapshot = evmTransactionSnapshotSchema.parse({
        ...(block === undefined ? {} : { block }),
        chainId: parsedInput.chainId,
        conflicts,
        observedAt,
        ...(receipt === undefined ? {} : { receipt }),
        requestedTransactionHash: parsedInput.transactionHash,
        sources: observations.map((observation) => observation.source),
        ...(transaction === undefined ? {} : { transaction }),
      });

      return evmDataAdapterResultSchema.parse({
        diagnostics,
        snapshot,
        status:
          transaction === undefined
            ? 'insufficient_data'
            : diagnostics.length > 0 || conflicts.length > 0
              ? 'partial'
              : 'success',
      });
    },
  };
}

function selectProviders(
  providers: readonly ConfiguredProvider[],
  providerIds: readonly string[] | undefined,
): ConfiguredProvider[] {
  if (providerIds === undefined) {
    return [...providers];
  }
  const selectedIds = new Set(providerIds);
  for (const providerId of selectedIds) {
    if (!providers.some((provider) => provider.config.id === providerId)) {
      throw new EvmDataAdapterConfigurationError(
        'provider_not_configured',
        `EVM RPC provider ${providerId} is not configured for the selected chain.`,
      );
    }
  }
  return providers.filter((provider) => selectedIds.has(provider.config.id));
}

async function loadProviderObservation(
  client: EvmJsonRpcClient,
  chainId: string,
  transactionHash: string,
  observedAt: string,
  signal?: AbortSignal,
): Promise<ProviderObservation> {
  const diagnostics: EvmDataAdapterDiagnostic[] = [];
  const payloadHashes: string[] = [];
  let transaction: EvmTransaction | undefined;
  let receipt: EvmTransactionReceipt | undefined;
  let block: NonNullable<EvmTransactionSnapshot['block']> | undefined;
  let transactionState: ObservationState = 'unavailable';
  let receiptState: ObservationState = 'unavailable';
  let blockState: ObservationState = 'unavailable';

  try {
    const initial = await client.requestBatch(
      [
        { method: 'eth_getTransactionByHash', params: [transactionHash] },
        { method: 'eth_getTransactionReceipt', params: [transactionHash] },
        { method: 'eth_chainId', params: [] },
      ],
      { signal },
    );
    payloadHashes.push(initial.payloadHash);

    const chainValidation = validateChainOutcome(
      initial.outcomes.find((outcome) => outcome.call.method === 'eth_chainId'),
      chainId,
      client.providerId,
      initial.attempts,
    );
    diagnostics.push(...chainValidation.diagnostics);

    if (chainValidation.valid) {
      const transactionOutcome = initial.outcomes.find(
        (outcome) => outcome.call.method === 'eth_getTransactionByHash',
      );
      const normalizedTransaction = normalizeOutcome(
        transactionOutcome,
        client.providerId,
        initial.attempts,
        'transaction',
        normalizeRpcTransaction,
      );
      transaction = normalizedTransaction.value;
      transactionState = normalizedTransaction.state;
      diagnostics.push(...normalizedTransaction.diagnostics);

      const receiptOutcome = initial.outcomes.find(
        (outcome) => outcome.call.method === 'eth_getTransactionReceipt',
      );
      const normalizedReceipt = normalizeOutcome(
        receiptOutcome,
        client.providerId,
        initial.attempts,
        'receipt',
        normalizeRpcReceipt,
      );
      receipt = normalizedReceipt.value;
      receiptState = normalizedReceipt.state;
      diagnostics.push(...normalizedReceipt.diagnostics);

      if (transaction !== undefined && transaction.hash !== transactionHash) {
        diagnostics.push(
          consistencyDiagnostic(
            'transaction_hash_mismatch',
            client.providerId,
            initial.attempts,
            'eth_getTransactionByHash',
          ),
        );
        transaction = undefined;
        transactionState = 'invalid';
      }
      if (receipt !== undefined && receipt.transactionHash !== transactionHash) {
        diagnostics.push(
          consistencyDiagnostic(
            'receipt_transaction_hash_mismatch',
            client.providerId,
            initial.attempts,
            'eth_getTransactionReceipt',
          ),
        );
        receipt = undefined;
        receiptState = 'invalid';
      }
      if (
        transaction?.blockNumber !== undefined &&
        receipt !== undefined &&
        transaction.blockNumber !== receipt.blockNumber
      ) {
        diagnostics.push(
          consistencyDiagnostic(
            'transaction_receipt_block_mismatch',
            client.providerId,
            initial.attempts,
            'eth_getTransactionReceipt',
          ),
        );
        receipt = undefined;
        receiptState = 'invalid';
      }
      if (
        transaction?.transactionIndex !== undefined &&
        receipt?.transactionIndex !== undefined &&
        transaction.transactionIndex !== receipt.transactionIndex
      ) {
        diagnostics.push(
          consistencyDiagnostic(
            'transaction_receipt_index_mismatch',
            client.providerId,
            initial.attempts,
            'eth_getTransactionReceipt',
          ),
        );
      }
    }
  } catch (error) {
    if (error instanceof EvmRpcRequestError) {
      if (error.code === 'request_aborted') {
        throw error;
      }
      diagnostics.push(requestDiagnostic(error, client.providerId));
    } else {
      throw error;
    }
  }

  const blockNumber = receipt?.blockNumber ?? transaction?.blockNumber;
  if (blockNumber !== undefined) {
    try {
      const blockResponse = await client.requestBatch(
        [
          {
            method: 'eth_getBlockByNumber',
            params: [decimalToRpcQuantity(blockNumber), false],
          },
        ],
        { signal },
      );
      payloadHashes.push(blockResponse.payloadHash);
      const normalizedBlock = normalizeOutcome(
        blockResponse.outcomes[0],
        client.providerId,
        blockResponse.attempts,
        'block',
        normalizeRpcBlock,
      );
      block = normalizedBlock.value;
      blockState = normalizedBlock.state;
      diagnostics.push(...normalizedBlock.diagnostics);
      if (block !== undefined && block.number !== blockNumber) {
        diagnostics.push(
          consistencyDiagnostic(
            'block_number_mismatch',
            client.providerId,
            blockResponse.attempts,
            'eth_getBlockByNumber',
          ),
        );
        block = undefined;
        blockState = 'invalid';
      }
    } catch (error) {
      if (error instanceof EvmRpcRequestError) {
        if (error.code === 'request_aborted') {
          throw error;
        }
        diagnostics.push(requestDiagnostic(error, client.providerId, 'eth_getBlockByNumber'));
      } else {
        throw error;
      }
    }
  }

  return {
    ...(block === undefined ? {} : { block }),
    blockState,
    diagnostics,
    ...(receipt === undefined ? {} : { receipt }),
    receiptState,
    source: {
      id: client.providerId,
      kind: 'rpc',
      observedAt,
      ...(payloadHashes.length === 0 ? {} : { payloadHash: combinePayloadHashes(payloadHashes) }),
      url: client.provenanceUrl,
    },
    ...(transaction === undefined ? {} : { transaction }),
    transactionState,
  };
}

function normalizeOutcome<Value>(
  outcome: EvmRpcCallOutcome | undefined,
  providerId: string,
  attempts: number,
  entity: 'block' | 'receipt' | 'transaction',
  normalize: (input: unknown, sourceId: string) => Value,
): {
  diagnostics: EvmDataAdapterDiagnostic[];
  state: ObservationState;
  value?: Value | undefined;
} {
  if (outcome === undefined) {
    return {
      diagnostics: [
        {
          attempts,
          code: 'invalid_jsonrpc',
          providerId,
          retryable: false,
        },
      ],
      state: 'unavailable',
    };
  }
  if (!outcome.ok) {
    return {
      diagnostics: [
        {
          attempts,
          code: 'rpc_error',
          method: outcome.call.method,
          providerId,
          retryable: isRetryableRpcCode(outcome.error.code),
          rpcCode: outcome.error.code,
        },
      ],
      state: 'unavailable',
    };
  }
  if (outcome.result === null) {
    return {
      diagnostics: [
        {
          attempts,
          code: `${entity}_not_found`,
          method: outcome.call.method,
          providerId,
          retryable: true,
        },
      ],
      state: 'missing',
    };
  }

  try {
    return { diagnostics: [], state: 'value', value: normalize(outcome.result, providerId) };
  } catch {
    return {
      diagnostics: [
        {
          attempts,
          code: `invalid_${entity}_payload`,
          method: outcome.call.method,
          providerId,
          retryable: false,
        },
      ],
      state: 'invalid',
    };
  }
}

function validateChainOutcome(
  outcome: EvmRpcCallOutcome | undefined,
  expectedChainId: string,
  providerId: string,
  attempts: number,
): { diagnostics: EvmDataAdapterDiagnostic[]; valid: boolean } {
  if (outcome === undefined) {
    return {
      diagnostics: [
        {
          attempts,
          code: 'invalid_jsonrpc',
          method: 'eth_chainId',
          providerId,
          retryable: false,
        },
      ],
      valid: false,
    };
  }
  if (!outcome.ok) {
    return {
      diagnostics: [
        {
          attempts,
          code: 'chain_id_unavailable',
          method: 'eth_chainId',
          providerId,
          retryable: isRetryableRpcCode(outcome.error.code),
          rpcCode: outcome.error.code,
        },
      ],
      valid: false,
    };
  }

  const parsedChainId = rpcHexQuantitySchema.safeParse(outcome.result);
  if (!parsedChainId.success) {
    return {
      diagnostics: [
        {
          attempts,
          code: 'invalid_chain_id_payload',
          method: 'eth_chainId',
          providerId,
          retryable: false,
        },
      ],
      valid: false,
    };
  }
  if (BigInt(parsedChainId.data).toString(10) !== expectedChainId) {
    return {
      diagnostics: [
        {
          attempts,
          code: 'chain_id_mismatch',
          method: 'eth_chainId',
          providerId,
          retryable: false,
        },
      ],
      valid: false,
    };
  }
  return { diagnostics: [], valid: true };
}

function consistencyDiagnostic(
  code:
    | 'block_number_mismatch'
    | 'receipt_transaction_hash_mismatch'
    | 'transaction_hash_mismatch'
    | 'transaction_receipt_block_mismatch'
    | 'transaction_receipt_index_mismatch',
  providerId: string,
  attempts: number,
  method: 'eth_getBlockByNumber' | 'eth_getTransactionByHash' | 'eth_getTransactionReceipt',
): EvmDataAdapterDiagnostic {
  return { attempts, code, method, providerId, retryable: false };
}

function requestDiagnostic(
  error: EvmRpcRequestError,
  providerId: string,
  method?: 'eth_getBlockByNumber',
): EvmDataAdapterDiagnostic {
  if (error.code === 'request_aborted') {
    throw error;
  }
  return {
    attempts: error.attempts,
    code: error.code,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(method === undefined ? {} : { method }),
    providerId,
    retryable: error.retryable,
  };
}

function collectSourceConflicts(observations: readonly ProviderObservation[]): SourceConflict[] {
  const conflicts: SourceConflict[] = [];
  addStateConflict(conflicts, 'transaction.presence', observations, 'transactionState');
  addValueConflicts(
    conflicts,
    observations.flatMap((observation) =>
      observation.transaction === undefined
        ? []
        : [{ sourceId: observation.source.id, value: observation.transaction }],
    ),
    [
      ['transaction.hash', (value) => value.hash],
      ['transaction.from', (value) => value.from],
      ['transaction.to', (value) => value.to ?? '<null>'],
      ['transaction.nonce', (value) => value.nonce],
      ['transaction.value', (value) => value.value],
      ['transaction.blockNumber', (value) => value.blockNumber ?? '<missing>'],
      [
        'transaction.transactionIndex',
        (value) => value.transactionIndex?.toString() ?? '<missing>',
      ],
      ['transaction.inputHash', (value) => hashString(value.input)],
    ],
  );

  addStateConflict(conflicts, 'receipt.presence', observations, 'receiptState');
  addValueConflicts(
    conflicts,
    observations.flatMap((observation) =>
      observation.receipt === undefined
        ? []
        : [{ sourceId: observation.source.id, value: observation.receipt }],
    ),
    [
      ['receipt.transactionHash', (value) => value.transactionHash],
      ['receipt.status', (value) => value.status],
      ['receipt.blockNumber', (value) => value.blockNumber],
      ['receipt.transactionIndex', (value) => value.transactionIndex?.toString() ?? '<missing>'],
      ['receipt.gasUsed', (value) => value.gasUsed],
      ['receipt.effectiveGasPrice', (value) => value.effectiveGasPrice],
      ['receipt.contractAddress', (value) => value.contractAddress ?? '<null>'],
      ['receipt.logsHash', (value) => hashString(JSON.stringify(value.logs))],
    ],
  );

  addStateConflict(conflicts, 'block.presence', observations, 'blockState');
  addValueConflicts(
    conflicts,
    observations.flatMap((observation) =>
      observation.block === undefined
        ? []
        : [{ sourceId: observation.source.id, value: observation.block }],
    ),
    [
      ['block.hash', (value) => value.hash],
      ['block.number', (value) => value.number],
      ['block.timestamp', (value) => value.timestamp],
    ],
  );
  return conflicts;
}

function addStateConflict(
  conflicts: SourceConflict[],
  field: string,
  observations: readonly ProviderObservation[],
  stateKey: 'blockState' | 'receiptState' | 'transactionState',
): void {
  addConflict(
    conflicts,
    field,
    observations.flatMap((observation) => {
      const state = observation[stateKey];
      return state === 'unavailable'
        ? []
        : [{ sourceId: observation.source.id, value: state === 'value' ? 'present' : state }];
    }),
  );
}

function addValueConflicts<Value>(
  conflicts: SourceConflict[],
  observations: Array<{ sourceId: string; value: Value }>,
  fields: Array<readonly [string, (value: Value) => string]>,
): void {
  for (const [field, select] of fields) {
    addConflict(
      conflicts,
      field,
      observations.map((observation) => ({
        sourceId: observation.sourceId,
        value: select(observation.value),
      })),
    );
  }
}

function addConflict(
  conflicts: SourceConflict[],
  field: string,
  observations: Array<{ sourceId: string; value: string }>,
): void {
  if (
    new Set(observations.map((observation) => observation.sourceId)).size < 2 ||
    new Set(observations.map((observation) => observation.value)).size < 2
  ) {
    return;
  }
  conflicts.push({ field, observations });
}

function firstDefined<Value>(values: readonly (Value | undefined)[]): Value | undefined {
  return values.find((value): value is Value => value !== undefined);
}

function combinePayloadHashes(payloadHashes: readonly string[]): string {
  if (payloadHashes.length === 1 && payloadHashes[0] !== undefined) {
    return payloadHashes[0];
  }
  const hash = createHash('sha256');
  for (const payloadHash of payloadHashes) {
    hash.update(payloadHash);
  }
  return `sha256:${hash.digest('hex')}`;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRetryableRpcCode(code: number): boolean {
  return code === -32_603 || code === -32_005;
}

function createObservedAt(now: () => Date): string {
  const observedAt = now();
  if (Number.isNaN(observedAt.getTime())) {
    throw new EvmDataAdapterConfigurationError(
      'invalid_configuration',
      'EVM data adapter clock returned an invalid date.',
    );
  }
  return observedAt.toISOString();
}
