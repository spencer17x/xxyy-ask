import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import { createSyntheticChainAnalysisCorpus } from '@xxyy/evm-chain-analysis-harness/test-fixtures';
import type { ReviewedReplayCasePayload } from '../governance-contracts.js';
import {
  createProductionReadinessPolicy,
  createProviderBudgetPolicy,
  createProviderDeploymentDescriptor,
  createSharedProviderCircuitState,
} from '../operations-evidence.js';
import type {
  ProductionOperationsEvidenceBundle,
  ProductionReadinessPolicy,
} from '../operations-contracts.js';
import {
  buildReviewedReplayCorpus,
  createReviewedReplayCandidate,
  fingerprintReviewedReplayLabel,
  promoteReviewedReplayCandidate,
  recordReviewedReplayDecision,
  scanReviewedReplayPayload,
} from '../reviewed-corpus-governance.js';
import {
  createMainnetSamplingPolicy,
  createMainnetSamplingSourceApproval,
  createPublicChainSampleManifest,
  materializeMainnetSamplingPlan,
} from '../mainnet-sampling.js';
import { createSamplingCandidateHandoff } from '../sampling-candidate-handoff.js';
import type {
  MainnetSamplingChainCondition,
  MainnetSamplingPlan,
  MainnetSamplingTargetLabel,
} from '../sampling-contracts.js';

export const CONTRACT_FIXTURE_TIMES = {
  evaluatedAt: '2026-07-22T12:00:00.000Z',
  exportedAt: '2026-07-22T11:30:00.000Z',
  reportEvaluatedAt: '2026-07-22T11:45:00.000Z',
} as const;

export function contractHash(label: string): string {
  return sha256Fingerprint({ contractOnly: true, label });
}

export function contractEvmHash(label: string): `0x${string}` {
  return `0x${contractHash(label).slice(7)}`;
}

/**
 * Contract-only sampling artifacts. Hashes and chain dimensions are deliberately synthetic; this
 * helper is not source/legal approval, a mainnet sample set, or evidence that collection occurred.
 */
export function createContractOnlySamplingFixture(options?: {
  includeTargetDeviationStratum?: boolean;
}) {
  const approval = createMainnetSamplingSourceApproval({
    approvalName: 'contract-only-mainnet-sampling',
    approvedAt: '2026-06-30T00:00:00.000Z',
    approvedByHashes: [contractHash('sampling-approver-b'), contractHash('sampling-approver-a')],
    credentialsAllowed: false,
    legalReviewEvidenceHash: contractHash('contract-only-legal-review'),
    privateDataAllowed: false,
    publicChainDataOnly: true,
    retentionDays: 30,
    retentionPolicyId: 'contract-only-retention-30d',
    retentionReviewEvidenceHash: contractHash('contract-only-retention-review'),
    sourceApprovalEvidenceHashes: [contractHash('contract-only-source-review')],
    sourceKinds: ['public_rpc', 'official_explorer_export'],
    validFrom: '2026-07-01T00:00:00.000Z',
    validUntil: '2026-09-01T00:00:00.000Z',
  });
  const policy = createMainnetSamplingPolicy(approval, {
    createdAt: '2026-07-22T00:00:00.000Z',
    policyName: 'contract-only-baseline-v1',
    samplingEndsAt: '2026-07-30T00:00:00.000Z',
    samplingStartsAt: '2026-07-23T00:00:00.000Z',
    strata: [
      {
        chainCondition: 'canonical',
        chainId: '1',
        dataCompleteness: 'complete',
        protocol: 'uniswap_v2',
        routeClass: 'direct_pool',
        targetLabel: 'positive',
        targetSamples: 1,
        tokenBehavior: 'standard',
      },
      {
        chainCondition: 'provider_conflict',
        chainId: '1',
        dataCompleteness: 'partial',
        protocol: 'uniswap_v3',
        routeClass: 'allowlisted_router',
        targetLabel: 'negative',
        targetSamples: 1,
        tokenBehavior: 'fee_on_transfer',
      },
      {
        chainCondition: 'reorged',
        chainId: '137',
        dataCompleteness: 'unsupported',
        protocol: 'uniswap_v2',
        routeClass: 'complex_route',
        targetLabel: 'unsupported',
        targetSamples: 1,
        tokenBehavior: 'rebasing',
      },
      ...(options?.includeTargetDeviationStratum === true
        ? [
            {
              chainCondition: 'canonical' as const,
              chainId: '1',
              dataCompleteness: 'complete' as const,
              protocol: 'uniswap_v2' as const,
              routeClass: 'direct_pool' as const,
              targetLabel: 'negative' as const,
              targetSamples: 1,
              tokenBehavior: 'standard' as const,
            },
          ]
        : []),
    ],
  });
  const plan = materializeMainnetSamplingPlan(approval, policy, '2026-07-22T12:00:00.000Z');
  const manifests = plan.slots.map((slot, index) =>
    createContractOnlyManifestForSlot(plan, slot.slotId, index),
  );
  return { approval, manifests, plan, policy };
}

export function createContractOnlyManifestForSlot(
  plan: MainnetSamplingPlan,
  slotId: string,
  index: number,
  transactionHash = contractEvmHash(`sampling-transaction-${index}`),
) {
  const slot = plan.slots.find((candidate) => candidate.slotId === slotId)!;
  const stratum = plan.strata.find((candidate) => candidate.stratumId === slot.stratumId)!;
  const blockHash = contractEvmHash(`sampling-block-${index}`);
  return createPublicChainSampleManifest(plan, {
    blockHash,
    blockNumber: String(20_000_000 + index),
    collectedAt: `2026-07-24T0${index}:00:00.000Z`,
    credentialScan: 'passed',
    privateDataScan: 'passed',
    providerObservationHashes:
      stratum.chainCondition === 'provider_conflict'
        ? [contractHash(`provider-a-${index}`), contractHash(`provider-b-${index}`)]
        : [contractHash(`provider-a-${index}`)],
    ...(reorgEvidence(stratum.chainCondition, blockHash, index) ?? {}),
    scannedAt: `2026-07-24T0${index}:00:00.000Z`,
    scannerVersion: 'contract-only-scanner-v1',
    slotId,
    sourceKind: 'public_rpc',
    sourcePayloadHashes: [contractHash(`source-payload-${index}`)],
    transactionHash,
    transactionIndex: index,
  });
}

function reorgEvidence(
  condition: MainnetSamplingChainCondition,
  blockHash: `0x${string}`,
  index: number,
) {
  return condition === 'reorged'
    ? {
        reorgEvidence: {
          canonicalReplacementBlockHash: contractEvmHash(`replacement-block-${index}`),
          orphanedBlockHash: blockHash,
        },
      }
    : undefined;
}

/**
 * This reuses a synthetic pipeline input solely to exercise governance schemas. The public-chain
 * policy bit is a contract-test precondition, not an assertion that this is reviewed mainnet data.
 * Nothing returned by this helper is a repository corpus or production attestation.
 */
export async function createContractOnlyReviewedPayload(): Promise<ReviewedReplayCasePayload> {
  const corpus = await createSyntheticChainAnalysisCorpus();
  const source = corpus.cases[0]!;
  const { review: _review, ...payload } = source;
  return {
    ...payload,
    id: 'contract-only.reviewed-replay-schema',
    privacy: {
      addressPolicy: 'public_chain',
      containsCredentials: false,
      containsPrivateData: false,
      redactionVersion: 'contract-only-v1',
    },
  };
}

/**
 * Contract-only manifest-to-candidate lineage. The source case remains synthetic and this helper
 * is not proof that a public-chain sample was collected, reviewed, or approved.
 */
export async function createContractOnlySamplingHandoffFixture(options?: {
  targetLabel?: Extract<MainnetSamplingTargetLabel, 'negative' | 'positive'>;
}) {
  const targetLabel = options?.targetLabel ?? 'positive';
  const { approval, plan, policy } = createContractOnlySamplingFixture({
    includeTargetDeviationStratum: targetLabel === 'negative',
  });
  const payload = await createContractOnlyReviewedPayload();
  const stratum = plan.strata.find(
    (candidate) =>
      candidate.chainCondition === 'canonical' &&
      candidate.chainId === payload.dimensions.chainId &&
      candidate.dataCompleteness === payload.dimensions.dataState &&
      candidate.protocol === payload.dimensions.protocol &&
      candidate.routeClass === payload.dimensions.router &&
      candidate.targetLabel === targetLabel,
  );
  if (stratum === undefined) {
    throw new Error('Contract-only handoff fixture requires a matching sampling stratum.');
  }
  const slot = plan.slots.find((candidate) => candidate.stratumId === stratum.stratumId)!;
  const snapshot = payload.input.snapshot;
  const transactionIndex =
    snapshot.transaction?.transactionIndex ?? snapshot.receipt?.transactionIndex;
  if (snapshot.block === undefined || transactionIndex === undefined) {
    throw new Error(
      'Contract-only handoff fixture requires complete block and transaction anchors.',
    );
  }
  const sourcePayloadHashes = snapshot.sources.map((source) => {
    if (source.payloadHash === undefined) {
      throw new Error('Contract-only handoff fixture requires source payload hashes.');
    }
    return source.payloadHash.startsWith('0x')
      ? `sha256:${source.payloadHash.slice(2).toLowerCase()}`
      : source.payloadHash.toLowerCase();
  });
  const observedProviderHashes =
    payload.input.observation?.providers.flatMap((provider) =>
      provider.fingerprint === undefined ? [] : [provider.fingerprint],
    ) ?? [];
  const providerObservationHashes =
    observedProviderHashes.length === 0
      ? [contractHash('contract-only-provider-observation')]
      : observedProviderHashes;
  const manifest = createPublicChainSampleManifest(plan, {
    blockHash: snapshot.block.hash,
    blockNumber: snapshot.block.number,
    collectedAt: '2026-07-24T10:00:00.000Z',
    credentialScan: 'passed',
    privateDataScan: 'passed',
    providerObservationHashes,
    scannedAt: '2026-07-24T10:00:00.000Z',
    scannerVersion: 'contract-only-source-scanner-v1',
    slotId: slot.slotId,
    sourceKind: 'public_rpc',
    sourcePayloadHashes,
    transactionHash: snapshot.requestedTransactionHash,
    transactionIndex,
  });
  const handoff = createSamplingCandidateHandoff(manifest, {
    additionalSourcePayloadHashes: [contractHash('contract-only-normalized-replay')],
    payload,
    scannedAt: '2026-07-24T11:00:00.000Z',
    scannerVersion: 'contract-only-replay-scanner-v1',
    submittedAt: '2026-07-24T12:00:00.000Z',
    submitterIdHash: contractHash('sampling-candidate-submitter'),
  });
  return { approval, handoff, manifest, payload, plan, policy };
}

export async function createGovernedContractCorpus() {
  const payload = await createContractOnlyReviewedPayload();
  const sourcePayloadHashes = [contractHash('source-payload-a')];
  const candidate = createReviewedReplayCandidate({
    payload,
    retainUntil: '2027-07-22T00:00:00.000Z',
    retentionPolicyId: 'reviewed-replay-365d',
    scanner: scanReviewedReplayPayload(payload, '2026-07-22T00:30:00.000Z', 'scanner-v1'),
    sourcePayloadHashes,
    submittedAt: '2026-07-22T01:00:00.000Z',
    submitterIdHash: contractHash('submitter'),
  });
  const labelFingerprint = fingerprintReviewedReplayLabel(payload);
  const reviewBase = {
    attestations: {
      independentReview: true,
      payloadReplayed: true,
      privacyVerified: true,
      sourceIntegrityVerified: true,
    },
    decision: 'approve' as const,
    evidencePayloadHashes: sourcePayloadHashes,
    labelFingerprint,
    reasonCodes: [],
  };
  const reviews = [
    recordReviewedReplayDecision(candidate, {
      ...reviewBase,
      reviewedAt: '2026-07-22T02:00:00.000Z',
      reviewerIdHash: contractHash('reviewer-a'),
    }),
    recordReviewedReplayDecision(candidate, {
      ...reviewBase,
      reviewedAt: '2026-07-22T03:00:00.000Z',
      reviewerIdHash: contractHash('reviewer-b'),
    }),
  ];
  const promotion = promoteReviewedReplayCandidate(candidate, reviews, '2026-07-22T04:00:00.000Z');
  const corpusExport = buildReviewedReplayCorpus({
    corpusId: 'contract-only-reviewed-replay',
    description:
      'Contract-test export only; this is not reviewed mainnet evidence or a production corpus.',
    exportedAt: CONTRACT_FIXTURE_TIMES.exportedAt,
    promotions: [promotion],
  });
  return { candidate, corpusExport, payload, promotion, reviews, sourcePayloadHashes };
}

export function createPassingReadinessPolicy(): ProductionReadinessPolicy {
  return createProductionReadinessPolicy({
    maxAverageCostUnits: 100,
    maxCircuitStateAgeSeconds: 7_200,
    maxCorpusAgeSeconds: 86_400,
    maxDrillAgeSeconds: 86_400,
    maxDrillRecoveryTimeMs: 60_000,
    maxErrorRatePpm: 10_000,
    maxOpenIncidents: 0,
    maxP95LatencyMs: 2_000,
    maxSloAgeSeconds: 7_200,
    minAuditRetentionDays: 90,
    minAvailabilityPpm: 990_000,
    minProvidersPerAdapterChain: 1,
    minSloSamples: 100,
    policyId: 'internal-production-readiness-v1',
    requiredAdapters: ['snapshot'],
    requiredChains: ['1'],
    requiredDrills: ['provider_timeout'],
  });
}

export function createPassingOperationsEvidence(): ProductionOperationsEvidenceBundle {
  const provider = createProviderDeploymentDescriptor({
    adapter: 'snapshot',
    approvedAt: '2026-07-21T00:00:00.000Z',
    approvedByHashes: [contractHash('provider-approver-b'), contractHash('provider-approver-a')],
    archiveRequired: false,
    chainId: '1',
    configurationFingerprint: contractHash('provider-configuration'),
    credentialSecretRefs: ['secretref:providers/rpc-primary/api-key'],
    enabled: true,
    endpointSecretRef: 'secretref:providers/rpc-primary/endpoint',
    providerId: 'rpc_primary',
    region: 'global.primary',
  });
  const budgetPolicy = createProviderBudgetPolicy({
    adapter: 'snapshot',
    budgetId: 'budget.mainnet.snapshot.rpc_primary',
    chainId: '1',
    leaseTtlSeconds: 60,
    maxConcurrentLeases: 20,
    maxCostUnits: 1_000,
    maxRequests: 100,
    maxResponseBytes: 1_000_000,
    maxRpcCalls: 200,
    providerId: 'rpc_primary',
    windowSeconds: 60,
  });
  const circuit = createSharedProviderCircuitState({
    adapter: 'snapshot',
    chainId: '1',
    consecutiveFailures: 0,
    generation: 7,
    lastTransitionReason: 'probe_succeeded',
    providerId: 'rpc_primary',
    state: 'closed',
    updatedAt: '2026-07-22T11:00:00.000Z',
  });
  const timeBound = {
    testedAt: '2026-07-22T10:00:00.000Z',
    validUntil: '2026-08-22T00:00:00.000Z',
  };
  return {
    alertingControl: {
      ...timeBound,
      auditSinkAlertsConfigured: true,
      budgetAlertsConfigured: true,
      circuitAlertsConfigured: true,
      evidenceHash: contractHash('alerting-control'),
      notificationTestPassed: true,
      onCallRouteHash: contractHash('on-call-route'),
      providerSloAlertsConfigured: true,
    },
    auditControl: {
      ...timeBound,
      accessReviewPassed: true,
      appendOnly: true,
      backendKind: 'postgresql',
      deletionTestPassed: true,
      encryptedAtRest: true,
      evidenceHash: contractHash('audit-control'),
      retentionDays: 365,
      unavailableFailsClosed: true,
    },
    budgetControl: {
      ...timeBound,
      atomicReservation: true,
      backendKind: 'redis',
      evidenceHash: contractHash('budget-control'),
      globalConcurrency: true,
      idempotentSettlement: true,
      leaseExpiry: true,
      unavailableFailsClosed: true,
      usageReconciliation: true,
    },
    budgetPolicies: [budgetPolicy],
    circuitControl: {
      ...timeBound,
      atomicTransitions: true,
      backendKind: 'redis',
      evidenceHash: contractHash('circuit-control'),
      halfOpenProbeControlled: true,
      providerIsolation: true,
      staleStateRecovery: true,
      unavailableFailsClosed: true,
    },
    circuitStates: [circuit],
    drills: [
      {
        completedAt: '2026-07-22T11:00:00.000Z',
        drill: 'provider_timeout',
        evidenceHash: contractHash('provider-timeout-drill'),
        outcome: 'passed',
        recoveryTimeMs: 15_000,
        runbookHash: contractHash('runbook'),
      },
    ],
    providers: [provider],
    runbook: {
      approvedByHashes: [contractHash('runbook-approver-a'), contractHash('runbook-approver-b')],
      escalationTestPassed: true,
      evidenceHash: contractHash('runbook-evidence'),
      reviewedAt: '2026-07-22T10:00:00.000Z',
      rollbackTestPassed: true,
      runbookHash: contractHash('runbook'),
      validUntil: '2026-08-22T00:00:00.000Z',
    },
    security: {
      approvedByHashes: [contractHash('security-approver-a'), contractHash('security-approver-b')],
      credentialRotationTestPassed: true,
      dataRetentionPolicyHash: contractHash('retention-policy'),
      evidenceHash: contractHash('security-evidence'),
      noLlmSecretExposureTestPassed: true,
      providerRiskReviewHash: contractHash('provider-risk-review'),
      reviewedAt: '2026-07-22T10:00:00.000Z',
      threatModelHash: contractHash('threat-model'),
      validUntil: '2026-08-22T00:00:00.000Z',
    },
    sloReports: [
      {
        adapter: 'snapshot',
        availabilityPpm: 999_000,
        averageCostUnits: 10,
        chainId: '1',
        errorRatePpm: 1_000,
        evidenceHash: contractHash('provider-slo'),
        openIncidentCount: 0,
        p95LatencyMs: 500,
        providerId: 'rpc_primary',
        sampleCount: 1_000,
        windowEndedAt: '2026-07-22T11:00:00.000Z',
        windowStartedAt: '2026-07-22T10:00:00.000Z',
      },
    ],
  };
}
