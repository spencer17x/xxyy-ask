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

export const CONTRACT_FIXTURE_TIMES = {
  evaluatedAt: '2026-07-22T12:00:00.000Z',
  exportedAt: '2026-07-22T11:30:00.000Z',
  reportEvaluatedAt: '2026-07-22T11:45:00.000Z',
} as const;

export function contractHash(label: string): string {
  return sha256Fingerprint({ contractOnly: true, label });
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
