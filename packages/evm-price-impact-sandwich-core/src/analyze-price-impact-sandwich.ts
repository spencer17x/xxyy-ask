import type {
  EvidenceItem,
  JsonValue,
  SkillDiagnostic,
  SkillFinding,
  SkillResultStatus,
} from '@xxyy/shared';

import {
  EVM_PRICE_IMPACT_SANDWICH_SKILL,
  EVM_PRICE_IMPACT_SANDWICH_VERSION,
  PARTS_PER_MILLION,
  evmPriceImpactSandwichInputSchema,
  evmPriceImpactSandwichResultSchema,
  type EvmMevPoolState,
  type EvmMevSwapObservation,
  type EvmPriceImpact,
  type EvmPriceImpactSandwichInput,
  type EvmPriceImpactSandwichResult,
  type EvmSandwichAssessment,
  type EvmSandwichReasonCode,
} from './contracts.js';
import {
  EvmAmmMathError,
  compareRationals,
  directionalSpotPrice,
  poolStatesEqual,
  quoteExactInput,
  swapDirectionIsOpposite,
  validateObservationQuote,
  type ExactInputQuote,
  type ValidatedObservationQuote,
} from './amm-math.js';

const findingIds = {
  priceImpact: 'target_price_impact',
  sandwich: 'sandwich_assessment',
} as const;

interface AnalysisState {
  diagnostics: SkillDiagnostic[];
  diagnosticIndexes: Map<string, number>;
  evidence: Map<string, EvidenceItem>;
  warnings: string[];
}

interface ObservationValidation {
  error?: EvmAmmMathError | undefined;
  quote?: ValidatedObservationQuote | undefined;
}

interface CandidateMetrics {
  attacker: string;
  attackerProfitRaw: string;
  back: EvmMevSwapObservation;
  counterfactualAmountOutRaw: string;
  evidenceIds: string[];
  front: EvmMevSwapObservation;
  intermediateRemainderRaw: string;
  profitToken: string;
  victimLossPpm: string;
  victimLossRaw: string;
}

interface SandwichDecision {
  assessment: EvmSandwichAssessment;
  diagnostic?: {
    code: string;
    evidenceIds: string[];
    stage: string;
  };
}

export function analyzeEvmPriceImpactAndSandwich(input: unknown): EvmPriceImpactSandwichResult {
  const parsed = evmPriceImpactSandwichInputSchema.parse(input);
  const state = createState();
  const observations = [...parsed.neighborhood.observations].sort(
    (left, right) => left.transactionIndex - right.transactionIndex,
  );
  const targetIndex = observations.findIndex(
    (observation) => observation.transactionHash === parsed.targetTransactionHash,
  );
  const target = observations[targetIndex];
  if (target === undefined) {
    throw new Error('Target observation disappeared after validated input parsing.');
  }

  const validations = new Map<string, ObservationValidation>();
  for (const observation of observations) {
    try {
      validations.set(observation.transactionHash, {
        quote: validateObservationQuote(parsed.pool, observation),
      });
    } catch (error) {
      if (!(error instanceof EvmAmmMathError)) {
        throw error;
      }
      validations.set(observation.transactionHash, { error });
      const evidenceId = ensureObservationEvidence(
        parsed,
        observation,
        [findingIds.sandwich],
        state,
      );
      addIssue(state, 'validate_observation', error.code, [evidenceId]);
    }
  }

  const targetValidation = validations.get(target.transactionHash);
  const priceImpact =
    targetValidation?.quote === undefined
      ? undefined
      : createPriceImpact(parsed, targetValidation.quote, state);
  const quoteCoverage =
    priceImpact !== undefined
      ? ('available' as const)
      : isUnsupportedError(targetValidation?.error)
        ? ('unsupported' as const)
        : ('invalid' as const);

  const sandwichDecision = assessSandwich({
    input: parsed,
    observations,
    state,
    target,
    targetIndex,
    validations,
  });
  if (sandwichDecision.diagnostic !== undefined) {
    addIssue(
      state,
      sandwichDecision.diagnostic.stage,
      sandwichDecision.diagnostic.code,
      sandwichDecision.diagnostic.evidenceIds,
    );
  }
  const sandwich = addSandwichFinding(parsed, sandwichDecision.assessment, state);
  const findings = createFindings(priceImpact, sandwich);
  const status = resultStatus(
    sandwich.verdict,
    priceImpact !== undefined,
    parsed,
    state.diagnostics.length,
  );

  return evmPriceImpactSandwichResultSchema.parse({
    coverage: {
      ...parsed.neighborhood.coverage,
      conflicts: parsed.neighborhood.conflicts.length,
      observations: observations.length,
      quote: quoteCoverage,
      supportedObservations: Array.from(validations.values()).filter(
        (validation) => validation.quote !== undefined,
      ).length,
    },
    diagnostics: state.diagnostics,
    evidence: Array.from(state.evidence.values()).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    findings,
    ...(priceImpact === undefined ? {} : { priceImpact }),
    sandwich,
    skill: EVM_PRICE_IMPACT_SANDWICH_SKILL,
    status,
    summary: createSummary(priceImpact, sandwich),
    target: {
      blockNumber: target.blockNumber,
      chainId: parsed.pool.chainId,
      poolAddress: parsed.pool.poolAddress,
      transactionHash: target.transactionHash,
      transactionIndex: target.transactionIndex,
    },
    version: EVM_PRICE_IMPACT_SANDWICH_VERSION,
    warnings: state.warnings,
  });
}

function createState(): AnalysisState {
  return {
    diagnostics: [],
    diagnosticIndexes: new Map(),
    evidence: new Map(),
    warnings: [],
  };
}

function createPriceImpact(
  input: EvmPriceImpactSandwichInput,
  validated: ValidatedObservationQuote,
  state: AnalysisState,
): EvmPriceImpact {
  const observation = validated.observation;
  const observationEvidenceId = ensureObservationEvidence(
    input,
    observation,
    [findingIds.priceImpact, findingIds.sandwich],
    state,
  );
  const beforeEvidenceId = ensureStateEvidence(
    input,
    observation,
    'before',
    [findingIds.priceImpact],
    state,
  );
  const calculationId = `calculation:price-impact:${observation.transactionHash}`;
  addEvidence(state, {
    blockNumber: observation.blockNumber,
    chainId: input.pool.chainId,
    confidence: 1,
    id: calculationId,
    kind: 'calculation',
    observedAt: input.neighborhood.source.observedAt,
    source: EVM_PRICE_IMPACT_SANDWICH_SKILL,
    structuredData: {
      amountInRaw: observation.swap.amountInRaw ?? null,
      amountOutRaw: observation.swap.amountOutRaw ?? null,
      expectedAmountOutRaw: validated.amountOutRaw,
      model: validated.model,
      priceImpactPpm: validated.priceImpactPpm,
    },
    supports: [findingIds.priceImpact],
    transactionHash: observation.transactionHash,
  });
  return {
    amountInRaw: requireSwapAmount(observation.swap.amountInRaw),
    amountOutRaw: requireSwapAmount(observation.swap.amountOutRaw),
    direction: requireSwapDirection(observation.swap.direction),
    evidenceIds: [observationEvidenceId, beforeEvidenceId, calculationId],
    executionPrice: validated.executionPrice,
    expectedAmountOutRaw: validated.amountOutRaw,
    model: validated.model,
    priceImpactPpm: validated.priceImpactPpm,
    spotPriceBefore: validated.spotPriceBefore,
  };
}

function assessSandwich(input: {
  input: EvmPriceImpactSandwichInput;
  observations: EvmMevSwapObservation[];
  state: AnalysisState;
  target: EvmMevSwapObservation;
  targetIndex: number;
  validations: ReadonlyMap<string, ObservationValidation>;
}): SandwichDecision {
  const targetEvidenceId = ensureObservationEvidence(
    input.input,
    input.target,
    [findingIds.sandwich],
    input.state,
  );
  const neighborhoodEvidenceId = ensureNeighborhoodEvidence(input.input, input.state);
  const baseEvidenceIds = [targetEvidenceId, neighborhoodEvidenceId];

  if (input.input.neighborhood.conflicts.length > 0) {
    return insufficientAssessment(['source_conflict'], baseEvidenceIds, 'source_conflict');
  }
  if (input.validations.get(input.target.transactionHash)?.quote === undefined) {
    const targetError = input.validations.get(input.target.transactionHash)?.error;
    return insufficientAssessment(
      [reasonForMathError(targetError)],
      baseEvidenceIds,
      'target_quote_unavailable',
    );
  }

  const front = input.observations[input.targetIndex - 1];
  const back = input.observations[input.targetIndex + 1];
  if (front === undefined || back === undefined) {
    return coverageDependentNegativeDecision(
      input,
      ['no_adjacent_bracketing_transactions'],
      baseEvidenceIds,
    );
  }
  const frontEvidenceId = ensureObservationEvidence(
    input.input,
    front,
    [findingIds.sandwich],
    input.state,
  );
  const backEvidenceId = ensureObservationEvidence(
    input.input,
    back,
    [findingIds.sandwich],
    input.state,
  );
  const candidateEvidenceIds = [
    targetEvidenceId,
    frontEvidenceId,
    backEvidenceId,
    neighborhoodEvidenceId,
    ensureStateEvidence(input.input, front, 'before', [findingIds.sandwich], input.state),
    ensureStateEvidence(input.input, front, 'after', [findingIds.sandwich], input.state),
    ensureStateEvidence(input.input, input.target, 'before', [findingIds.sandwich], input.state),
    ensureStateEvidence(input.input, input.target, 'after', [findingIds.sandwich], input.state),
    ensureStateEvidence(input.input, back, 'before', [findingIds.sandwich], input.state),
    ensureStateEvidence(input.input, back, 'after', [findingIds.sandwich], input.state),
  ];
  const frontQuote = input.validations.get(front.transactionHash)?.quote;
  const backQuote = input.validations.get(back.transactionHash)?.quote;
  if (frontQuote === undefined || backQuote === undefined) {
    const candidateError =
      input.validations.get(front.transactionHash)?.error ??
      input.validations.get(back.transactionHash)?.error;
    return insufficientAssessment(
      [reasonForMathError(candidateError)],
      candidateEvidenceIds,
      'candidate_quote_unavailable',
    );
  }

  if (front.actor !== back.actor || front.actor === input.target.actor) {
    return coverageDependentNegativeDecision(input, ['actor_mismatch'], candidateEvidenceIds);
  }
  if (
    front.swap.direction !== input.target.swap.direction ||
    !swapDirectionIsOpposite(input.target.swap.direction, back.swap.direction)
  ) {
    return coverageDependentNegativeDecision(
      input,
      ['bracketing_direction_mismatch'],
      candidateEvidenceIds,
    );
  }
  if (
    !poolStatesEqual(front.stateAfter, input.target.stateBefore) ||
    !poolStatesEqual(input.target.stateAfter, back.stateBefore)
  ) {
    return coverageDependentNegativeDecision(
      input,
      ['pool_state_discontinuity'],
      candidateEvidenceIds,
    );
  }

  const targetDirection = requireSwapDirection(input.target.swap.direction);
  const targetAmountIn = requireSwapAmount(input.target.swap.amountInRaw);
  let counterfactual: ExactInputQuote;
  try {
    counterfactual = quoteExactInput(
      input.input.pool,
      front.stateBefore,
      targetAmountIn,
      targetDirection,
    );
  } catch (error) {
    if (!(error instanceof EvmAmmMathError)) {
      throw error;
    }
    return insufficientAssessment(['unsupported_observation'], candidateEvidenceIds, error.code);
  }
  const actualAmountOut = BigInt(requireSwapAmount(input.target.swap.amountOutRaw));
  const counterfactualAmountOut = BigInt(counterfactual.amountOutRaw);
  const victimLoss = counterfactualAmountOut - actualAmountOut;
  const pricesMoveAsSandwich = hasSandwichPriceMovement(
    targetDirection,
    front.stateBefore,
    input.target.stateBefore,
    input.target.stateAfter,
    back.stateAfter,
  );
  if (victimLoss <= 0n || !pricesMoveAsSandwich) {
    return coverageDependentNegativeDecision(
      input,
      ['target_not_adversely_affected'],
      candidateEvidenceIds,
    );
  }

  const frontAmountIn = BigInt(requireSwapAmount(front.swap.amountInRaw));
  const frontAmountOut = BigInt(requireSwapAmount(front.swap.amountOutRaw));
  const backAmountIn = BigInt(requireSwapAmount(back.swap.amountInRaw));
  const backAmountOut = BigInt(requireSwapAmount(back.swap.amountOutRaw));
  const attackerProfit = backAmountOut - frontAmountIn;
  const intermediateRemainder = frontAmountOut - backAmountIn;
  if (attackerProfit <= 0n || intermediateRemainder < 0n) {
    return coverageDependentNegativeDecision(
      input,
      ['attacker_not_profitable'],
      candidateEvidenceIds,
    );
  }

  const candidateCalculationId = `calculation:sandwich:${input.target.transactionHash}`;
  const metrics: CandidateMetrics = {
    attacker: front.actor,
    attackerProfitRaw: attackerProfit.toString(),
    back,
    counterfactualAmountOutRaw: counterfactualAmountOut.toString(),
    evidenceIds: [...candidateEvidenceIds, candidateCalculationId],
    front,
    intermediateRemainderRaw: intermediateRemainder.toString(),
    profitToken: requireSwapToken(input.target.swap.tokenIn),
    victimLossPpm: ((victimLoss * PARTS_PER_MILLION) / counterfactualAmountOut).toString(),
    victimLossRaw: victimLoss.toString(),
  };
  const assetLoop = verifyActorAssetLoop(front, back);
  addEvidence(input.state, {
    blockNumber: input.input.neighborhood.blockNumber,
    chainId: input.input.pool.chainId,
    confidence: assetLoop === 'verified' ? 1 : 0.75,
    id: candidateCalculationId,
    kind: 'calculation',
    observedAt: input.input.neighborhood.source.observedAt,
    source: EVM_PRICE_IMPACT_SANDWICH_SKILL,
    structuredData: {
      actorAssetLoop: assetLoop,
      attacker: metrics.attacker,
      attackerProfitRaw: metrics.attackerProfitRaw,
      backTransactionHash: back.transactionHash,
      counterfactualAmountOutRaw: metrics.counterfactualAmountOutRaw,
      frontTransactionHash: front.transactionHash,
      intermediateRemainderRaw: metrics.intermediateRemainderRaw,
      victimLossRaw: metrics.victimLossRaw,
    },
    supports: [findingIds.sandwich],
    transactionHash: input.target.transactionHash,
  });

  if (assetLoop === 'verified') {
    return {
      assessment: candidateAssessment(
        'confirmed',
        ['counterfactual_victim_loss', 'actor_asset_loop_verified'],
        metrics,
        true,
      ),
    };
  }
  if (assetLoop === 'missing') {
    return {
      assessment: candidateAssessment(
        'likely',
        ['counterfactual_victim_loss', 'implied_asset_loop_profitable', 'actor_deltas_missing'],
        metrics,
        false,
      ),
      diagnostic: {
        code: 'actor_deltas_missing',
        evidenceIds: metrics.evidenceIds,
        stage: 'verify_actor_asset_loop',
      },
    };
  }
  return coverageDependentNegativeDecision(
    input,
    ['actor_deltas_contradict_loop'],
    metrics.evidenceIds,
  );
}

function candidateAssessment(
  verdict: 'confirmed' | 'likely',
  reasonCodes: EvmSandwichReasonCode[],
  metrics: CandidateMetrics,
  assetLoopVerified: boolean,
): EvmSandwichAssessment {
  return {
    assetLoopVerified,
    attacker: metrics.attacker,
    attackerProfitRaw: metrics.attackerProfitRaw,
    backTransactionHash: metrics.back.transactionHash,
    counterfactualAmountOutRaw: metrics.counterfactualAmountOutRaw,
    evidenceIds: metrics.evidenceIds,
    frontTransactionHash: metrics.front.transactionHash,
    intermediateRemainderRaw: metrics.intermediateRemainderRaw,
    profitToken: metrics.profitToken,
    reasonCodes,
    verdict,
    victimLossPpm: metrics.victimLossPpm,
    victimLossRaw: metrics.victimLossRaw,
  };
}

function insufficientAssessment(
  reasonCodes: EvmSandwichReasonCode[],
  evidenceIds: string[],
  diagnosticCode: string,
): SandwichDecision {
  return {
    assessment: {
      assetLoopVerified: false,
      evidenceIds: uniqueSorted(evidenceIds),
      reasonCodes,
      verdict: 'insufficient_data',
    },
    diagnostic: {
      code: diagnosticCode,
      evidenceIds: uniqueSorted(evidenceIds),
      stage: 'assess_sandwich',
    },
  };
}

function coverageDependentNegativeDecision(
  input: {
    input: EvmPriceImpactSandwichInput;
    validations: ReadonlyMap<string, ObservationValidation>;
  },
  reasonCodes: EvmSandwichReasonCode[],
  evidenceIds: string[],
): SandwichDecision {
  if (!canReturnUnlikely(input.input, input.validations)) {
    return insufficientAssessment(
      ['neighborhood_incomplete', ...reasonCodes],
      evidenceIds,
      'neighborhood_incomplete',
    );
  }
  return {
    assessment: {
      assetLoopVerified: false,
      evidenceIds: uniqueSorted(evidenceIds),
      reasonCodes,
      verdict: 'unlikely',
    },
  };
}

function canReturnUnlikely(
  input: EvmPriceImpactSandwichInput,
  validations: ReadonlyMap<string, ObservationValidation>,
): boolean {
  return (
    input.neighborhood.coverage.actorAssetDeltas === 'complete' &&
    input.neighborhood.coverage.blockTransactions === 'complete' &&
    input.neighborhood.coverage.poolStates === 'complete' &&
    input.neighborhood.conflicts.length === 0 &&
    Array.from(validations.values()).every((validation) => validation.quote !== undefined)
  );
}

function verifyActorAssetLoop(
  front: EvmMevSwapObservation,
  back: EvmMevSwapObservation,
): 'contradicted' | 'missing' | 'verified' {
  if (front.actorAssetDeltas === undefined || back.actorAssetDeltas === undefined) {
    return 'missing';
  }
  const frontDeltas = new Map(
    front.actorAssetDeltas.map((delta) => [delta.tokenAddress, BigInt(delta.rawDelta)]),
  );
  const backDeltas = new Map(
    back.actorAssetDeltas.map((delta) => [delta.tokenAddress, BigInt(delta.rawDelta)]),
  );
  const frontTokenIn = requireSwapToken(front.swap.tokenIn);
  const frontTokenOut = requireSwapToken(front.swap.tokenOut);
  const backTokenIn = requireSwapToken(back.swap.tokenIn);
  const backTokenOut = requireSwapToken(back.swap.tokenOut);
  const matches =
    frontTokenIn === backTokenOut &&
    frontTokenOut === backTokenIn &&
    frontDeltas.get(frontTokenIn) === -BigInt(requireSwapAmount(front.swap.amountInRaw)) &&
    frontDeltas.get(frontTokenOut) === BigInt(requireSwapAmount(front.swap.amountOutRaw)) &&
    backDeltas.get(backTokenIn) === -BigInt(requireSwapAmount(back.swap.amountInRaw)) &&
    backDeltas.get(backTokenOut) === BigInt(requireSwapAmount(back.swap.amountOutRaw));
  return matches ? 'verified' : 'contradicted';
}

function hasSandwichPriceMovement(
  direction: 'token0_to_token1' | 'token1_to_token0',
  baseline: EvmMevPoolState,
  targetBefore: EvmMevPoolState,
  targetAfter: EvmMevPoolState,
  backAfter: EvmMevPoolState,
): boolean {
  const baselinePrice = directionalSpotPrice(baseline, direction);
  const targetBeforePrice = directionalSpotPrice(targetBefore, direction);
  const targetAfterPrice = directionalSpotPrice(targetAfter, direction);
  const backAfterPrice = directionalSpotPrice(backAfter, direction);
  return (
    compareRationals(baselinePrice, targetBeforePrice) > 0 &&
    compareRationals(targetBeforePrice, targetAfterPrice) > 0 &&
    compareRationals(backAfterPrice, targetAfterPrice) > 0
  );
}

function addSandwichFinding(
  input: EvmPriceImpactSandwichInput,
  assessment: EvmSandwichAssessment,
  state: AnalysisState,
): EvmSandwichAssessment {
  const calculationId = `calculation:sandwich-verdict:${input.targetTransactionHash}`;
  addEvidence(state, {
    blockNumber: input.neighborhood.blockNumber,
    chainId: input.pool.chainId,
    confidence: verdictConfidence(assessment.verdict),
    id: calculationId,
    kind: 'calculation',
    observedAt: input.neighborhood.source.observedAt,
    source: EVM_PRICE_IMPACT_SANDWICH_SKILL,
    structuredData: {
      reasonCodes: assessment.reasonCodes,
      verdict: assessment.verdict,
    },
    supports: [findingIds.sandwich],
    transactionHash: input.targetTransactionHash,
  });
  return {
    ...assessment,
    evidenceIds: uniqueSorted([...assessment.evidenceIds, calculationId]),
  };
}

function createFindings(
  priceImpact: EvmPriceImpact | undefined,
  sandwich: EvmSandwichAssessment,
): SkillFinding[] {
  const findings: SkillFinding[] = [];
  if (priceImpact !== undefined) {
    findings.push({
      confidence: 1,
      evidenceIds: priceImpact.evidenceIds,
      id: findingIds.priceImpact,
      inference: true,
      statement: `The target swap has a deterministic ${priceImpact.priceImpactPpm} ppm execution price impact under the ${priceImpact.model} model.`,
    });
  }
  findings.push({
    confidence: verdictConfidence(sandwich.verdict),
    evidenceIds: sandwich.evidenceIds,
    id: findingIds.sandwich,
    inference: true,
    statement: `The bounded same-pool sandwich verdict is ${sandwich.verdict}.`,
  });
  return findings;
}

function ensureObservationEvidence(
  input: EvmPriceImpactSandwichInput,
  observation: EvmMevSwapObservation,
  supports: readonly string[],
  state: AnalysisState,
): string {
  const id = `transaction:${observation.transactionHash}`;
  addEvidence(state, {
    blockNumber: observation.blockNumber,
    chainId: input.pool.chainId,
    confidence: 1,
    id,
    kind: 'transaction',
    observedAt: observation.source.observedAt,
    ...(observation.source.payloadHash === undefined
      ? {}
      : { payloadHash: observation.source.payloadHash }),
    source: observation.source.id,
    structuredData: {
      actor: observation.actor,
      amountInRaw: observation.swap.amountInRaw ?? null,
      amountOutRaw: observation.swap.amountOutRaw ?? null,
      direction: observation.swap.direction,
      poolAddress: observation.swap.poolAddress,
      routeKind: observation.routeKind,
      swapMode: observation.swapMode,
      tokenBehavior: observation.tokenBehavior,
      transactionIndex: observation.transactionIndex,
    },
    supports: [...supports],
    transactionHash: observation.transactionHash,
  });
  return id;
}

function ensureStateEvidence(
  input: EvmPriceImpactSandwichInput,
  observation: EvmMevSwapObservation,
  position: 'after' | 'before',
  supports: readonly string[],
  state: AnalysisState,
): string {
  const poolState = position === 'before' ? observation.stateBefore : observation.stateAfter;
  const id = `pool-state:${observation.transactionHash}:${position}`;
  addEvidence(state, {
    blockNumber: observation.blockNumber,
    chainId: input.pool.chainId,
    confidence: 1,
    id,
    kind: 'metadata',
    observedAt: poolState.source.observedAt,
    ...(poolState.source.payloadHash === undefined
      ? {}
      : { payloadHash: poolState.source.payloadHash }),
    source: poolState.source.id,
    structuredData: stateStructuredData(poolState, position),
    supports: [...supports],
    transactionHash: observation.transactionHash,
  });
  return id;
}

function ensureNeighborhoodEvidence(
  input: EvmPriceImpactSandwichInput,
  state: AnalysisState,
): string {
  const id = `block:${input.pool.chainId}:${input.neighborhood.blockNumber}`;
  addEvidence(state, {
    blockNumber: input.neighborhood.blockNumber,
    chainId: input.pool.chainId,
    confidence: 1,
    id,
    kind: 'block',
    observedAt: input.neighborhood.source.observedAt,
    ...(input.neighborhood.source.payloadHash === undefined
      ? {}
      : { payloadHash: input.neighborhood.source.payloadHash }),
    source: input.neighborhood.source.id,
    structuredData: {
      conflicts: input.neighborhood.conflicts.map((conflict) => ({
        field: conflict.field,
        sourceIds: conflict.sourceIds,
        subject: conflict.subject,
      })),
      coverage: input.neighborhood.coverage,
      observedPoolTransactions: input.neighborhood.observations.length,
    },
    supports: [findingIds.sandwich],
    transactionHash: input.targetTransactionHash,
  });
  return id;
}

function stateStructuredData(state: EvmMevPoolState, position: 'after' | 'before'): JsonValue {
  return state.protocol === 'uniswap_v2'
    ? {
        position,
        protocol: state.protocol,
        reserve0Raw: state.reserve0Raw,
        reserve1Raw: state.reserve1Raw,
      }
    : {
        activeRangeLowerSqrtPriceX96: state.activeRangeLowerSqrtPriceX96,
        activeRangeUpperSqrtPriceX96: state.activeRangeUpperSqrtPriceX96,
        liquidity: state.liquidity,
        position,
        protocol: state.protocol,
        sqrtPriceX96: state.sqrtPriceX96,
        tick: state.tick,
      };
}

function addEvidence(state: AnalysisState, evidence: EvidenceItem): void {
  const existing = state.evidence.get(evidence.id);
  if (existing === undefined) {
    state.evidence.set(evidence.id, evidence);
    return;
  }
  state.evidence.set(evidence.id, {
    ...existing,
    supports: uniqueSorted([...existing.supports, ...evidence.supports]),
  });
}

function addIssue(
  state: AnalysisState,
  stage: string,
  code: string,
  evidenceIds: readonly string[],
): void {
  if (!state.warnings.includes(code)) {
    state.warnings.push(code);
  }
  const key = `${stage}:${code}`;
  const index = state.diagnosticIndexes.get(key);
  if (index === undefined) {
    state.diagnosticIndexes.set(key, state.diagnostics.length);
    state.diagnostics.push({
      code,
      ...(evidenceIds.length === 0 ? {} : { evidenceIds: uniqueSorted(evidenceIds) }),
      retryable: false,
      stage,
    });
    return;
  }
  const existing = state.diagnostics[index];
  if (existing === undefined) {
    return;
  }
  state.diagnostics[index] = {
    ...existing,
    evidenceIds: uniqueSorted([...(existing.evidenceIds ?? []), ...evidenceIds]),
  };
}

function resultStatus(
  verdict: EvmSandwichAssessment['verdict'],
  hasPriceImpact: boolean,
  input: EvmPriceImpactSandwichInput,
  diagnosticCount: number,
): SkillResultStatus {
  if (verdict === 'confirmed') {
    const coverage = input.neighborhood.coverage;
    return diagnosticCount === 0 &&
      coverage.actorAssetDeltas === 'complete' &&
      coverage.blockTransactions === 'complete' &&
      coverage.poolStates === 'complete'
      ? 'success'
      : 'partial';
  }
  if (verdict === 'unlikely') {
    return 'success';
  }
  if (verdict === 'likely' || hasPriceImpact) {
    return 'partial';
  }
  return 'insufficient_data';
}

function createSummary(
  priceImpact: EvmPriceImpact | undefined,
  sandwich: EvmSandwichAssessment,
): string {
  const impact =
    priceImpact === undefined
      ? 'Target price impact is unavailable'
      : `Target execution price impact is ${priceImpact.priceImpactPpm} ppm`;
  return `${impact}; bounded same-pool sandwich verdict: ${sandwich.verdict}.`;
}

function verdictConfidence(verdict: EvmSandwichAssessment['verdict']): number {
  if (verdict === 'confirmed') {
    return 1;
  }
  if (verdict === 'likely') {
    return 0.75;
  }
  if (verdict === 'unlikely') {
    return 0.9;
  }
  return 0;
}

function isUnsupportedError(error: EvmAmmMathError | undefined): boolean {
  return (
    error?.code === 'unsupported_active_tick_crossing' ||
    error?.code === 'unsupported_ambiguous_swap' ||
    error?.code === 'unsupported_exact_output' ||
    error?.code === 'unsupported_route' ||
    error?.code === 'unsupported_token_behavior'
  );
}

function requireSwapAmount(value: string | undefined): string {
  if (value === undefined || BigInt(value) <= 0n) {
    throw new Error('Validated directional swap is missing a positive amount.');
  }
  return value;
}

function requireSwapDirection(
  value: EvmMevSwapObservation['swap']['direction'],
): 'token0_to_token1' | 'token1_to_token0' {
  if (value === 'ambiguous') {
    throw new Error('Validated directional swap is ambiguous.');
  }
  return value;
}

function requireSwapToken(value: string | undefined): string {
  if (value === undefined) {
    throw new Error('Validated directional swap is missing a token.');
  }
  return value;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function reasonForMathError(error: EvmAmmMathError | undefined): EvmSandwichReasonCode {
  return error?.code === 'quote_mismatch' || error?.code === 'pool_state_transition_mismatch'
    ? 'quote_mismatch'
    : 'unsupported_observation';
}
