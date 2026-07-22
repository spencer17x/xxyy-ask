import {
  enrichEvmExecution,
  type EvmDecodedSwap,
  type EvmExecutionEnrichmentResult,
} from '@xxyy/evm-execution-enrichment-core';
import type { EvmMevObservationDataAdapterResult } from '@xxyy/evm-mev-observation-data-adapter';
import {
  analyzeEvmPriceImpactAndSandwich,
  type EvmMevSwapObservation,
  type EvmPriceImpactSandwichResult,
} from '@xxyy/evm-price-impact-sandwich-core';
import type { EvidenceItem, SkillDiagnostic, SkillFinding } from '@xxyy/shared';
import {
  analyzeEvmTransactionSnapshot,
  type TransactionAnalysisResult,
} from '@xxyy/transaction-analysis-core';

import { sha256Fingerprint } from './canonical-json.js';
import {
  EVM_CHAIN_ANALYSIS_HARNESS_SKILL,
  EVM_CHAIN_ANALYSIS_HARNESS_VERSION,
  chainAnalysisCompositionDiagnosticCodes,
  evmChainAnalysisPipelineInputSchema,
  evmChainAnalysisPipelineResultSchema,
  observationHasAnalysisInput,
  type ChainAnalysisCapabilityResult,
  type ChainAnalysisCompositionDiagnosticCode,
  type ChainAnalysisRefusalCode,
  type ChainAnalysisStage,
  type DetectSandwichCapabilityRequest,
  type EvmChainAnalysisPipelineInput,
  type EvmChainAnalysisPipelineResult,
  type InspectTransactionCapabilityRequest,
} from './contracts.js';

const compositionCodeOrder = new Map(
  chainAnalysisCompositionDiagnosticCodes.map((code, index) => [code, index]),
);

export function composeEvmChainAnalysis(input: unknown): EvmChainAnalysisPipelineResult {
  const parsed = evmChainAnalysisPipelineInputSchema.parse(input);
  const inputFingerprint = sha256Fingerprint(parsed);
  const transaction = analyzeEvmTransactionSnapshot(parsed.snapshot);
  const execution = runExecutionStage(parsed);
  const observation = parsed.observation;
  const detectRequest = parsed.requests.find(
    (request): request is DetectSandwichCapabilityRequest =>
      request.capability === 'chain.detect_sandwich',
  );
  const compositionCodes = validateCompositionAnchors({
    detectRequest,
    execution,
    input: parsed,
    observation,
  });
  const blockingCodes = compositionCodes.filter((code) => code !== 'observation_provider_conflict');
  const mev =
    detectRequest !== undefined &&
    blockingCodes.length === 0 &&
    observationHasAnalysisInput(observation)
      ? analyzeEvmPriceImpactAndSandwich(observation.analysisInput)
      : undefined;

  const stages = createStages({
    compositionCodes,
    detectRequested: detectRequest !== undefined,
    execution,
    input: parsed,
    mev,
    observation,
    transaction,
  });
  const replayFingerprint = sha256Fingerprint({
    compositionCodes,
    inputFingerprint,
    stages: stages.map((stage) => ({
      inputFingerprint: stage.inputFingerprint ?? null,
      name: stage.name,
      outputFingerprint: stage.outputFingerprint ?? null,
      state: stage.state,
      status: stage.status ?? null,
    })),
  });
  const capabilities = parsed.requests.map(
    (request): ChainAnalysisCapabilityResult =>
      request.capability === 'chain.inspect_transaction'
        ? projectInspection(request, transaction, execution)
        : projectSandwich({
            compositionCodes,
            execution,
            mev,
            observation,
            request,
            transaction,
          }),
  );
  const status = derivePipelineStatus(capabilities);
  const findings = createFindings(capabilities);
  const evidence = createEvidence({
    capabilities,
    findings,
    inputFingerprint,
    replayFingerprint,
    stages,
  });
  const diagnostics = compositionCodes.map(
    (code): SkillDiagnostic => ({
      code,
      evidenceIds: ['pipeline:input'],
      retryable: code === 'observation_missing' || code === 'observation_analysis_missing',
      stage: 'compose',
    }),
  );

  return evmChainAnalysisPipelineResultSchema.parse({
    capabilities,
    coverage: createCoverage({ execution, mev, observation, transaction, detectRequest }),
    diagnostics,
    evidence,
    ...(execution === undefined ? {} : { execution }),
    findings,
    inputFingerprint,
    ...(mev === undefined ? {} : { mev }),
    ...(observation === undefined ? {} : { observation }),
    replayFingerprint,
    requests: parsed.requests,
    skill: EVM_CHAIN_ANALYSIS_HARNESS_SKILL,
    stages,
    status,
    summary: createSummary(capabilities, status),
    transaction,
    version: EVM_CHAIN_ANALYSIS_HARNESS_VERSION,
    warnings: unique([
      ...compositionCodes,
      ...capabilities
        .filter((capability) => capability.status !== 'success')
        .map((capability) => `${capability.capability}:${capability.status}`),
    ]),
  });
}

function runExecutionStage(
  input: EvmChainAnalysisPipelineInput,
): EvmExecutionEnrichmentResult | undefined {
  if (input.execution === undefined) {
    return undefined;
  }
  return enrichEvmExecution({
    ...(input.execution.poolMetadata === undefined
      ? {}
      : { poolMetadata: input.execution.poolMetadata }),
    snapshot: input.snapshot,
    ...(input.execution.trace === undefined ? {} : { trace: input.execution.trace }),
  });
}

function validateCompositionAnchors(input: {
  detectRequest: DetectSandwichCapabilityRequest | undefined;
  execution: EvmExecutionEnrichmentResult | undefined;
  input: EvmChainAnalysisPipelineInput;
  observation: EvmMevObservationDataAdapterResult | undefined;
}): ChainAnalysisCompositionDiagnosticCode[] {
  if (input.detectRequest === undefined) {
    return [];
  }
  const codes: ChainAnalysisCompositionDiagnosticCode[] = [];
  if (input.observation === undefined) {
    return ['observation_missing'];
  }
  if (!observationHasAnalysisInput(input.observation)) {
    return ['observation_analysis_missing'];
  }
  const analysisInput = input.observation.analysisInput;
  const transaction = input.input.snapshot.transaction;
  const block = input.input.snapshot.block;
  if (
    transaction === undefined ||
    transaction.blockNumber === undefined ||
    transaction.transactionIndex === undefined ||
    block === undefined
  ) {
    codes.push('transaction_anchor_missing');
  }
  if (analysisInput.pool.chainId !== input.detectRequest.chainId) {
    codes.push('observation_chain_mismatch');
  }
  if (analysisInput.targetTransactionHash !== input.detectRequest.transactionHash) {
    codes.push('observation_transaction_mismatch');
  }
  if (analysisInput.pool.poolAddress !== input.detectRequest.poolAddress) {
    codes.push('observation_pool_mismatch');
  }
  const target = analysisInput.neighborhood.observations.find(
    (observation) => observation.transactionHash === analysisInput.targetTransactionHash,
  );
  if (target !== undefined && transaction !== undefined) {
    if (transaction.hash !== target.transactionHash) {
      codes.push('observation_transaction_mismatch');
    }
    if (transaction.blockNumber !== target.blockNumber || block?.number !== target.blockNumber) {
      codes.push('observation_block_mismatch');
    }
    if (transaction.transactionIndex !== target.transactionIndex) {
      codes.push('observation_transaction_index_mismatch');
    }
  }
  const canonicalProvider = input.observation.providers.find(
    (provider) => provider.providerId === analysisInput.neighborhood.source.id,
  );
  if (
    canonicalProvider?.blockHash !== undefined &&
    block !== undefined &&
    canonicalProvider.blockHash !== block.hash
  ) {
    codes.push('observation_provider_block_mismatch');
  }
  if (input.observation.conflicts.length > 0) {
    codes.push('observation_provider_conflict');
  }
  if (input.execution !== undefined && target !== undefined) {
    codes.push(...validateExecutionSwap(input.execution, target, input.detectRequest.poolAddress));
  }
  return unique(codes).sort(
    (left, right) => (compositionCodeOrder.get(left) ?? 0) - (compositionCodeOrder.get(right) ?? 0),
  );
}

function validateExecutionSwap(
  execution: EvmExecutionEnrichmentResult,
  target: EvmMevSwapObservation,
  poolAddress: string,
): ChainAnalysisCompositionDiagnosticCode[] {
  const swaps = execution.swaps.filter((swap) => swap.poolAddress === poolAddress);
  if (swaps.length === 0) {
    return [];
  }
  if (swaps.length > 1) {
    return ['execution_observation_multiple_swaps'];
  }
  return swapsSemanticallyEqual(swaps[0]!, target.swap)
    ? []
    : ['execution_observation_swap_mismatch'];
}

function swapsSemanticallyEqual(left: EvmDecodedSwap, right: EvmDecodedSwap): boolean {
  return (
    left.protocol === right.protocol &&
    left.poolAddress === right.poolAddress &&
    left.token0 === right.token0 &&
    left.token1 === right.token1 &&
    left.amount0PoolDeltaRaw === right.amount0PoolDeltaRaw &&
    left.amount1PoolDeltaRaw === right.amount1PoolDeltaRaw &&
    left.direction === right.direction
  );
}

function createStages(input: {
  compositionCodes: readonly ChainAnalysisCompositionDiagnosticCode[];
  detectRequested: boolean;
  execution: EvmExecutionEnrichmentResult | undefined;
  input: EvmChainAnalysisPipelineInput;
  mev: EvmPriceImpactSandwichResult | undefined;
  observation: EvmMevObservationDataAdapterResult | undefined;
  transaction: TransactionAnalysisResult;
}): ChainAnalysisStage[] {
  const transactionStage: ChainAnalysisStage = {
    diagnosticCodes: unique(input.transaction.diagnostics.map((diagnostic) => diagnostic.code)),
    inputFingerprint: sha256Fingerprint(input.input.snapshot),
    name: 'transaction',
    outputFingerprint: sha256Fingerprint(input.transaction),
    state: 'completed',
    status: input.transaction.status,
  };
  const executionStage: ChainAnalysisStage =
    input.execution === undefined
      ? {
          diagnosticCodes: [],
          name: 'execution',
          state: 'not_provided',
        }
      : {
          diagnosticCodes: unique(input.execution.diagnostics.map((diagnostic) => diagnostic.code)),
          inputFingerprint: sha256Fingerprint({
            execution: input.input.execution,
            snapshot: input.input.snapshot,
          }),
          name: 'execution',
          outputFingerprint: sha256Fingerprint(input.execution),
          state: 'completed',
          status: input.execution.status,
        };
  const observationStage: ChainAnalysisStage =
    input.observation === undefined
      ? {
          diagnosticCodes: input.detectRequested ? ['observation_missing'] : [],
          name: 'observation',
          state: input.detectRequested ? 'not_provided' : 'not_requested',
        }
      : {
          diagnosticCodes: unique([
            ...input.observation.diagnostics.map((diagnostic) => diagnostic.code),
            ...input.observation.conflicts.map((conflict) => `conflict:${conflict.field}`),
          ]),
          inputFingerprint: sha256Fingerprint(input.observation),
          name: 'observation',
          outputFingerprint: sha256Fingerprint(input.observation),
          state: 'completed',
          status: input.observation.status,
        };
  const mevStage: ChainAnalysisStage = !input.detectRequested
    ? { diagnosticCodes: [], name: 'mev', state: 'not_requested' }
    : input.mev === undefined
      ? {
          diagnosticCodes: [...input.compositionCodes],
          ...(observationHasAnalysisInput(input.observation)
            ? { inputFingerprint: sha256Fingerprint(input.observation.analysisInput) }
            : {}),
          name: 'mev',
          state: 'blocked',
        }
      : {
          diagnosticCodes: unique(input.mev.diagnostics.map((diagnostic) => diagnostic.code)),
          inputFingerprint: sha256Fingerprint(input.observation?.analysisInput),
          name: 'mev',
          outputFingerprint: sha256Fingerprint(input.mev),
          state: 'completed',
          status: input.mev.status,
        };
  return [transactionStage, executionStage, observationStage, mevStage];
}

function projectInspection(
  request: InspectTransactionCapabilityRequest,
  transaction: TransactionAnalysisResult,
  execution: EvmExecutionEnrichmentResult | undefined,
): ChainAnalysisCapabilityResult {
  const refusalCodes: ChainAnalysisRefusalCode[] = [];
  let status: 'success' | 'partial' | 'insufficient_data';
  if (transaction.status === 'insufficient_data' || transaction.status === 'failed') {
    status = 'insufficient_data';
    refusalCodes.push('transaction_data_insufficient');
  } else if (
    transaction.status === 'partial' ||
    (execution !== undefined && execution.status !== 'success')
  ) {
    status = 'partial';
    if (execution !== undefined && execution.status !== 'success') {
      refusalCodes.push('execution_data_partial');
    }
  } else {
    status = 'success';
  }
  return {
    capability: request.capability,
    chainId: request.chainId,
    ...(execution === undefined ? {} : { executionEnrichmentStatus: execution.status }),
    executionStatus: transaction.transaction.executionStatus,
    internalTransferCount: execution?.internalTransfers.length ?? 0,
    refusalCodes,
    status,
    swapCount: execution?.swaps.length ?? 0,
    tokenTransferCount: transaction.tokenTransfers.length,
    traceCoverage: execution?.coverage.trace ?? 'not_provided',
    transactionAnalysisStatus: transaction.status,
    transactionHash: request.transactionHash,
  };
}

function projectSandwich(input: {
  compositionCodes: readonly ChainAnalysisCompositionDiagnosticCode[];
  execution: EvmExecutionEnrichmentResult | undefined;
  mev: EvmPriceImpactSandwichResult | undefined;
  observation: EvmMevObservationDataAdapterResult | undefined;
  request: DetectSandwichCapabilityRequest;
  transaction: TransactionAnalysisResult;
}): ChainAnalysisCapabilityResult {
  const refusalCodes: ChainAnalysisRefusalCode[] = [];
  if (input.observation === undefined) {
    refusalCodes.push('observation_missing');
  } else if (!observationHasAnalysisInput(input.observation)) {
    refusalCodes.push('observation_insufficient');
  }
  if (input.compositionCodes.some((code) => code !== 'observation_provider_conflict')) {
    refusalCodes.push('composition_conflict');
  }
  if (input.observation?.conflicts.length !== undefined && input.observation.conflicts.length > 0) {
    refusalCodes.push('provider_conflict');
  }
  if (input.transaction.status !== 'success') {
    refusalCodes.push('transaction_data_insufficient');
  }
  if (input.execution !== undefined && input.execution.status !== 'success') {
    refusalCodes.push('execution_data_partial');
  }
  if (input.mev?.coverage.quote === 'unsupported') {
    refusalCodes.push('unsupported_semantics');
  }
  if (
    input.mev !== undefined &&
    input.mev.status === 'insufficient_data' &&
    !refusalCodes.includes('unsupported_semantics') &&
    !refusalCodes.includes('provider_conflict')
  ) {
    refusalCodes.push('observation_insufficient');
  }

  const status = detectCapabilityStatus(input);
  if (status === 'success') {
    refusalCodes.length = 0;
  }
  if (status === 'insufficient_data' && refusalCodes.length === 0) {
    refusalCodes.push('observation_insufficient');
  }
  const coverage = input.observation?.analysisInput?.neighborhood.coverage;
  return {
    capability: input.request.capability,
    chainId: input.request.chainId,
    ...(input.mev === undefined ? {} : { coreStatus: input.mev.status }),
    ...(coverage === undefined ? {} : { observationCoverage: coverage }),
    ...(input.observation === undefined ? {} : { observationStatus: input.observation.status }),
    poolAddress: input.request.poolAddress,
    ...(input.mev?.priceImpact === undefined
      ? {}
      : { priceImpactPpm: input.mev.priceImpact.priceImpactPpm }),
    refusalCodes: unique(refusalCodes),
    status,
    transactionHash: input.request.transactionHash,
    ...(input.mev === undefined ? {} : { verdict: input.mev.sandwich.verdict }),
  };
}

function detectCapabilityStatus(input: {
  compositionCodes: readonly ChainAnalysisCompositionDiagnosticCode[];
  execution: EvmExecutionEnrichmentResult | undefined;
  mev: EvmPriceImpactSandwichResult | undefined;
  observation: EvmMevObservationDataAdapterResult | undefined;
  transaction: TransactionAnalysisResult;
}): 'success' | 'partial' | 'insufficient_data' {
  if (input.mev === undefined || input.mev.status === 'insufficient_data') {
    return 'insufficient_data';
  }
  return input.mev.status === 'success' &&
    input.observation?.status === 'success' &&
    input.transaction.status === 'success' &&
    (input.execution === undefined || input.execution.status === 'success') &&
    input.compositionCodes.length === 0
    ? 'success'
    : 'partial';
}

function createCoverage(input: {
  detectRequest: DetectSandwichCapabilityRequest | undefined;
  execution: EvmExecutionEnrichmentResult | undefined;
  mev: EvmPriceImpactSandwichResult | undefined;
  observation: EvmMevObservationDataAdapterResult | undefined;
  transaction: TransactionAnalysisResult;
}) {
  return {
    execution:
      input.execution === undefined
        ? ('not_provided' as const)
        : input.execution.status === 'success'
          ? ('complete' as const)
          : ('partial' as const),
    mev:
      input.detectRequest === undefined
        ? ('not_requested' as const)
        : input.mev === undefined
          ? ('blocked' as const)
          : input.mev.status === 'success'
            ? ('complete' as const)
            : ('partial' as const),
    observation:
      input.observation === undefined
        ? ('not_provided' as const)
        : input.observation.status === 'success'
          ? ('complete' as const)
          : ('partial' as const),
    providerCostUnits: input.observation?.usage.costUnits ?? 0,
    providerRequests: input.observation?.usage.requests ?? 0,
    transaction:
      input.transaction.status === 'success'
        ? ('complete' as const)
        : input.transaction.status === 'partial'
          ? ('partial' as const)
          : ('missing' as const),
  };
}

function createFindings(capabilities: readonly ChainAnalysisCapabilityResult[]): SkillFinding[] {
  return capabilities.map((capability) => ({
    confidence: capability.status === 'success' ? 1 : capability.status === 'partial' ? 0.7 : 0,
    evidenceIds: capabilityEvidenceIds(capability),
    id: capabilityFindingId(capability.capability),
    inference: false,
    statement:
      capability.capability === 'chain.inspect_transaction'
        ? `Transaction inspection completed with ${capability.status} status.`
        : `Sandwich detection completed with ${capability.status} status${capability.verdict === undefined ? '' : ` and ${capability.verdict} verdict`}.`,
  }));
}

function createEvidence(input: {
  capabilities: readonly ChainAnalysisCapabilityResult[];
  findings: readonly SkillFinding[];
  inputFingerprint: string;
  replayFingerprint: string;
  stages: readonly ChainAnalysisStage[];
}): EvidenceItem[] {
  const allFindingIds = input.findings.map((finding) => finding.id);
  const evidence: EvidenceItem[] = [
    {
      confidence: 1,
      id: 'pipeline:input',
      kind: 'metadata',
      payloadHash: input.inputFingerprint,
      source: EVM_CHAIN_ANALYSIS_HARNESS_SKILL,
      structuredData: {
        replayFingerprint: input.replayFingerprint,
        stages: input.stages.map((stage) => ({
          name: stage.name,
          state: stage.state,
          status: stage.status ?? null,
        })),
      },
      supports: allFindingIds,
    },
  ];
  for (const stage of input.stages) {
    if (stage.state !== 'completed' || stage.outputFingerprint === undefined) {
      continue;
    }
    const supports = input.capabilities
      .filter((capability) => stageSupportsCapability(stage.name, capability.capability))
      .map((capability) => capabilityFindingId(capability.capability));
    if (supports.length === 0) {
      continue;
    }
    evidence.push({
      confidence: stage.status === 'success' ? 1 : 0.7,
      id: `pipeline:stage:${stage.name}`,
      kind: 'metadata',
      payloadHash: stage.outputFingerprint,
      source: stage.name,
      structuredData: {
        diagnostics: stage.diagnosticCodes,
        state: stage.state,
        status: stage.status ?? null,
      },
      supports,
    });
  }
  return evidence;
}

function capabilityEvidenceIds(capability: ChainAnalysisCapabilityResult): string[] {
  const ids = ['pipeline:input', 'pipeline:stage:transaction'];
  if (capability.capability === 'chain.inspect_transaction') {
    if (capability.executionEnrichmentStatus !== undefined) {
      ids.push('pipeline:stage:execution');
    }
    return ids;
  }
  if (capability.observationStatus !== undefined) {
    ids.push('pipeline:stage:observation');
  }
  if (capability.coreStatus !== undefined) {
    ids.push('pipeline:stage:mev');
  }
  return ids;
}

function stageSupportsCapability(
  stage: ChainAnalysisStage['name'],
  capability: ChainAnalysisCapabilityResult['capability'],
): boolean {
  if (stage === 'transaction') {
    return true;
  }
  if (stage === 'execution') {
    return capability === 'chain.inspect_transaction' || capability === 'chain.detect_sandwich';
  }
  return capability === 'chain.detect_sandwich';
}

function capabilityFindingId(capability: ChainAnalysisCapabilityResult['capability']): string {
  return `capability:${capability}`;
}

function derivePipelineStatus(
  capabilities: readonly ChainAnalysisCapabilityResult[],
): 'success' | 'partial' | 'insufficient_data' {
  if (capabilities.every((capability) => capability.status === 'success')) {
    return 'success';
  }
  return capabilities.some((capability) => capability.status !== 'insufficient_data')
    ? 'partial'
    : 'insufficient_data';
}

function createSummary(
  capabilities: readonly ChainAnalysisCapabilityResult[],
  status: 'success' | 'partial' | 'insufficient_data',
): string {
  const rendered = capabilities
    .map((capability) => `${capability.capability}=${capability.status}`)
    .join(', ');
  return `Offline EVM chain analysis pipeline completed with ${status} status: ${rendered}.`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
