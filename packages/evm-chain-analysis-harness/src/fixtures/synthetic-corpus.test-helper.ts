import { readFile } from 'node:fs/promises';

import {
  evmCallTraceSchema,
  evmPoolMetadataSchema,
  type EvmCallTrace,
  type EvmPoolMetadata,
} from '@xxyy/evm-execution-enrichment-core';
import {
  EVM_MEV_OBSERVATION_DATA_ADAPTER_VERSION,
  evmMevObservationDataAdapterResultSchema,
  type EvmMevObservationDataAdapterResult,
} from '@xxyy/evm-mev-observation-data-adapter';
import {
  evmPriceImpactSandwichInputSchema,
  type EvmPriceImpactSandwichInput,
} from '@xxyy/evm-price-impact-sandwich-core';
import {
  evmTransactionSnapshotSchema,
  type EvmTransactionSnapshot,
} from '@xxyy/transaction-analysis-core';

import { sha256Fingerprint } from '../canonical-json.js';
import {
  EVM_CHAIN_ANALYSIS_CORPUS_VERSION,
  chainAnalysisCorpusSchema,
  type ChainAnalysisCorpus,
  type ChainAnalysisCorpusCase,
} from '../evaluation-contracts.js';

const CREATED_AT = '2026-07-22T00:00:00.000Z';
const V2_BLOCK_HASH = `0x${'b1'.repeat(32)}`;
const V3_BLOCK_HASH = `0x${'b2'.repeat(32)}`;

export async function createSyntheticChainAnalysisCorpus(): Promise<ChainAnalysisCorpus> {
  const [confirmedV2, unlikelyV3, executionFixture] = await Promise.all([
    loadMevFixture('confirmed-v2'),
    loadMevFixture('unlikely-v3'),
    loadExecutionFixture(),
  ]);
  const confirmedSnapshot = createSnapshot(confirmedV2, V2_BLOCK_HASH);
  const unlikelySnapshot = createSnapshot(unlikelyV3, V3_BLOCK_HASH);
  const conflictedV2 = createConflictedObservation(confirmedV2, V2_BLOCK_HASH);
  const unsupportedV3 = structuredClone(unlikelyV3);
  unsupportedV3.neighborhood.observations[0]!.routeKind = 'aggregator';

  const cases: ChainAnalysisCorpusCase[] = [
    createCase({
      dataState: 'complete',
      expected: {
        capabilities: [
          { capability: 'chain.inspect_transaction', status: 'success' },
          { capability: 'chain.detect_sandwich', status: 'success' },
        ],
        compositionDiagnosticCodes: [],
        pipelineStatus: 'success',
        sandwichVerdict: 'confirmed',
      },
      groundTruth: 'positive',
      id: 'synthetic.confirmed-v2',
      input: {
        observation: createObservation(confirmedV2, V2_BLOCK_HASH),
        requests: [
          inspectRequest(confirmedSnapshot),
          detectRequest(confirmedSnapshot, confirmedV2.pool.poolAddress),
        ],
        snapshot: confirmedSnapshot,
      },
      protocol: 'uniswap_v2',
      router: 'direct_pool',
    }),
    createCase({
      dataState: 'complete',
      expected: {
        capabilities: [{ capability: 'chain.detect_sandwich', status: 'success' }],
        compositionDiagnosticCodes: [],
        pipelineStatus: 'success',
        sandwichVerdict: 'unlikely',
      },
      groundTruth: 'negative',
      id: 'synthetic.unlikely-v3',
      input: {
        observation: createObservation(unlikelyV3, V3_BLOCK_HASH),
        requests: [detectRequest(unlikelySnapshot, unlikelyV3.pool.poolAddress)],
        snapshot: unlikelySnapshot,
      },
      protocol: 'uniswap_v3',
      router: 'direct_pool',
    }),
    createCase({
      dataState: 'provider_conflict',
      expected: {
        capabilities: [{ capability: 'chain.detect_sandwich', status: 'partial' }],
        compositionDiagnosticCodes: ['observation_provider_conflict'],
        pipelineStatus: 'partial',
        sandwichVerdict: 'insufficient_data',
      },
      groundTruth: 'positive',
      id: 'synthetic.provider-conflict-v2',
      input: {
        observation: conflictedV2,
        requests: [detectRequest(confirmedSnapshot, confirmedV2.pool.poolAddress)],
        snapshot: confirmedSnapshot,
      },
      protocol: 'uniswap_v2',
      router: 'direct_pool',
    }),
    createCase({
      dataState: 'unsupported',
      expected: {
        capabilities: [{ capability: 'chain.detect_sandwich', status: 'insufficient_data' }],
        compositionDiagnosticCodes: [],
        pipelineStatus: 'insufficient_data',
        sandwichVerdict: 'insufficient_data',
      },
      groundTruth: 'unsupported',
      id: 'synthetic.unsupported-route-v3',
      input: {
        observation: createObservation(unsupportedV3, V3_BLOCK_HASH),
        requests: [detectRequest(unlikelySnapshot, unsupportedV3.pool.poolAddress)],
        snapshot: unlikelySnapshot,
      },
      protocol: 'uniswap_v3',
      router: 'aggregator',
    }),
    createCase({
      dataState: 'partial',
      expected: {
        capabilities: [
          { capability: 'chain.inspect_transaction', status: 'success' },
          { capability: 'chain.detect_sandwich', status: 'insufficient_data' },
        ],
        compositionDiagnosticCodes: ['observation_missing'],
        pipelineStatus: 'partial',
      },
      groundTruth: 'positive',
      id: 'synthetic.missing-observation-v2',
      input: {
        requests: [
          inspectRequest(confirmedSnapshot),
          detectRequest(confirmedSnapshot, confirmedV2.pool.poolAddress),
        ],
        snapshot: confirmedSnapshot,
      },
      protocol: 'uniswap_v2',
      router: 'direct_pool',
    }),
    createCase({
      dataState: 'complete',
      expected: {
        capabilities: [{ capability: 'chain.inspect_transaction', status: 'success' }],
        compositionDiagnosticCodes: [],
        pipelineStatus: 'success',
      },
      groundTruth: 'not_applicable',
      id: 'synthetic.inspect-execution',
      input: {
        execution: {
          poolMetadata: executionFixture.poolMetadata,
          trace: executionFixture.trace,
        },
        requests: [inspectRequest(executionFixture.snapshot)],
        snapshot: executionFixture.snapshot,
      },
      protocol: 'other',
      router: 'unknown',
    }),
  ];

  return chainAnalysisCorpusSchema.parse({
    cases,
    corpusId: 'synthetic-regression-v1',
    createdAt: CREATED_AT,
    description:
      'Synthetic, privacy-safe replay cases for deterministic composition regressions only.',
    version: EVM_CHAIN_ANALYSIS_CORPUS_VERSION,
  });
}

async function loadMevFixture(name: string): Promise<EvmPriceImpactSandwichInput> {
  const raw = await readJson(
    new URL(`../../../evm-price-impact-sandwich-core/src/fixtures/${name}.json`, import.meta.url),
  );
  return evmPriceImpactSandwichInputSchema.parse(raw);
}

async function loadExecutionFixture(): Promise<{
  poolMetadata: EvmPoolMetadata;
  snapshot: EvmTransactionSnapshot;
  trace: EvmCallTrace;
}> {
  const raw = (await readJson(
    new URL(
      '../../../evm-execution-enrichment-core/src/fixtures/success-internal-swaps.json',
      import.meta.url,
    ),
  )) as Record<string, unknown>;
  return {
    poolMetadata: evmPoolMetadataSchema.parse(raw.poolMetadata),
    snapshot: evmTransactionSnapshotSchema.parse(raw.snapshot),
    trace: evmCallTraceSchema.parse(raw.trace),
  };
}

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, 'utf8')) as unknown;
}

function createSnapshot(
  input: EvmPriceImpactSandwichInput,
  blockHash: string,
): EvmTransactionSnapshot {
  const target = input.neighborhood.observations.find(
    (observation) => observation.transactionHash === input.targetTransactionHash,
  );
  if (target === undefined) {
    throw new Error('Synthetic MEV fixture requires one target observation.');
  }
  const sourceId = input.neighborhood.source.id;
  return evmTransactionSnapshotSchema.parse({
    block: {
      hash: blockHash,
      number: target.blockNumber,
      sourceId,
      timestamp: '1',
    },
    chainId: input.pool.chainId,
    observedAt: input.neighborhood.source.observedAt,
    receipt: {
      blockNumber: target.blockNumber,
      effectiveGasPrice: '1',
      gasUsed: '21000',
      logs: [],
      sourceId,
      status: 'success',
      transactionHash: target.transactionHash,
      transactionIndex: target.transactionIndex,
    },
    requestedTransactionHash: target.transactionHash,
    sources: [
      {
        id: sourceId,
        kind: 'fixture',
        observedAt: input.neighborhood.source.observedAt,
        payloadHash: sha256Fingerprint(input),
      },
    ],
    transaction: {
      blockNumber: target.blockNumber,
      from: target.actor,
      hash: target.transactionHash,
      input: '0x12345678',
      nonce: '1',
      sourceId,
      to: input.pool.poolAddress,
      transactionIndex: target.transactionIndex,
      value: '0',
    },
  });
}

function createObservation(
  analysisInput: EvmPriceImpactSandwichInput,
  blockHash: string,
): EvmMevObservationDataAdapterResult {
  const providerId = analysisInput.neighborhood.source.id;
  const usage = createUsage(7);
  return evmMevObservationDataAdapterResultSchema.parse({
    analysisInput,
    conflicts: [],
    coverage: {
      ...analysisInput.neighborhood.coverage,
      providersRequested: 1,
      providersSucceeded: 1,
    },
    diagnostics: [],
    providers: [
      {
        blockHash,
        fingerprint: sha256Fingerprint({ analysisInput, providerId }),
        providerId,
        status: 'success',
        usage,
      },
    ],
    status: 'success',
    usage,
    version: EVM_MEV_OBSERVATION_DATA_ADAPTER_VERSION,
  });
}

function createConflictedObservation(
  input: EvmPriceImpactSandwichInput,
  blockHash: string,
): EvmMevObservationDataAdapterResult {
  const primary = input.neighborhood.source.id;
  const secondary = 'fixture_secondary';
  const analysisInput = structuredClone(input);
  analysisInput.neighborhood.conflicts = [
    {
      field: 'pool_state',
      sourceIds: [primary, secondary],
      subject: input.pool.poolAddress,
    },
  ];
  const primaryUsage = createUsage(7);
  const secondaryUsage = createUsage(9);
  const primaryFingerprint = sha256Fingerprint({ analysisInput, providerId: primary });
  const secondaryFingerprint = sha256Fingerprint({ analysisInput, providerId: secondary });
  return evmMevObservationDataAdapterResultSchema.parse({
    analysisInput,
    conflicts: [
      {
        field: 'pool_state',
        observations: [
          { fingerprint: primaryFingerprint, providerId: primary },
          { fingerprint: secondaryFingerprint, providerId: secondary },
        ],
        subject: input.pool.poolAddress,
      },
    ],
    coverage: {
      ...analysisInput.neighborhood.coverage,
      providersRequested: 2,
      providersSucceeded: 2,
    },
    diagnostics: [],
    providers: [
      {
        blockHash,
        fingerprint: primaryFingerprint,
        providerId: primary,
        status: 'success',
        usage: primaryUsage,
      },
      {
        blockHash,
        fingerprint: secondaryFingerprint,
        providerId: secondary,
        status: 'success',
        usage: secondaryUsage,
      },
    ],
    status: 'partial',
    usage: createUsage(16),
    version: EVM_MEV_OBSERVATION_DATA_ADAPTER_VERSION,
  });
}

function createUsage(costUnits: number) {
  return {
    cacheHits: 0,
    costUnits,
    requests: costUnits,
    responseBytes: costUnits * 100,
    rpcCalls: costUnits,
  };
}

function inspectRequest(snapshot: EvmTransactionSnapshot) {
  return {
    capability: 'chain.inspect_transaction' as const,
    chainId: snapshot.chainId,
    transactionHash: snapshot.requestedTransactionHash,
  };
}

function detectRequest(snapshot: EvmTransactionSnapshot, poolAddress: string) {
  return {
    capability: 'chain.detect_sandwich' as const,
    chainId: snapshot.chainId,
    poolAddress,
    transactionHash: snapshot.requestedTransactionHash,
  };
}

function createCase(input: {
  dataState: ChainAnalysisCorpusCase['dimensions']['dataState'];
  expected: ChainAnalysisCorpusCase['expected'];
  groundTruth: ChainAnalysisCorpusCase['groundTruth'];
  id: string;
  input: ChainAnalysisCorpusCase['input'];
  protocol: ChainAnalysisCorpusCase['dimensions']['protocol'];
  router: ChainAnalysisCorpusCase['dimensions']['router'];
}): ChainAnalysisCorpusCase {
  return {
    dimensions: {
      chainId: input.input.snapshot.chainId,
      dataState: input.dataState,
      protocol: input.protocol,
      router: input.router,
    },
    expected: input.expected,
    groundTruth: input.groundTruth,
    id: input.id,
    input: input.input,
    privacy: {
      addressPolicy: 'synthetic',
      containsCredentials: false,
      containsPrivateData: false,
      redactionVersion: 'synthetic-v1',
    },
    review: {
      generatorVersion: 'synthetic-corpus-v1',
      tier: 'synthetic',
    },
  };
}
