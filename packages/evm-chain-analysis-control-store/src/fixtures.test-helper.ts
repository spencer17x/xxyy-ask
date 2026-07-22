import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import { createSyntheticChainAnalysisCorpus } from '@xxyy/evm-chain-analysis-harness/test-fixtures';
import {
  createProviderBudgetPolicy,
  createProviderBudgetReservation,
  createReviewedReplayCandidate,
  createSharedProviderCircuitState,
  evaluateReviewedReplayGovernance,
  fingerprintReviewedReplayLabel,
  promoteReviewedReplayCandidate,
  recordReviewedReplayDecision,
  scanReviewedReplayPayload,
} from '@xxyy/evm-chain-analysis-readiness';

export function testHash(label: string): string {
  return sha256Fingerprint({ contractOnly: true, label });
}

export async function createGovernanceStoreFixture() {
  const corpus = await createSyntheticChainAnalysisCorpus();
  const source = corpus.cases[0]!;
  const { review: _review, ...sourcePayload } = source;
  const payload = {
    ...sourcePayload,
    id: 'contract-only.control-store-replay',
    privacy: {
      addressPolicy: 'public_chain' as const,
      containsCredentials: false as const,
      containsPrivateData: false as const,
      redactionVersion: 'contract-only-v1',
    },
  };
  const sourcePayloadHashes = [testHash('source')];
  const candidate = createReviewedReplayCandidate({
    payload,
    retainUntil: '2027-07-22T00:00:00.000Z',
    retentionPolicyId: 'reviewed-replay-365d',
    scanner: scanReviewedReplayPayload(payload, '2026-07-22T00:30:00.000Z', 'scanner-v1'),
    sourcePayloadHashes,
    submittedAt: '2026-07-22T01:00:00.000Z',
    submitterIdHash: testHash('submitter'),
  });
  const baseReview = {
    attestations: {
      independentReview: true,
      payloadReplayed: true,
      privacyVerified: true,
      sourceIntegrityVerified: true,
    },
    decision: 'approve' as const,
    evidencePayloadHashes: sourcePayloadHashes,
    labelFingerprint: fingerprintReviewedReplayLabel(payload),
    reasonCodes: [],
  };
  const reviews = [
    recordReviewedReplayDecision(candidate, {
      ...baseReview,
      reviewedAt: '2026-07-22T02:00:00.000Z',
      reviewerIdHash: testHash('reviewer-a'),
    }),
    recordReviewedReplayDecision(candidate, {
      ...baseReview,
      reviewedAt: '2026-07-22T03:00:00.000Z',
      reviewerIdHash: testHash('reviewer-b'),
    }),
  ];
  const decision = evaluateReviewedReplayGovernance(candidate, reviews, '2026-07-22T03:30:00.000Z');
  const promotion = promoteReviewedReplayCandidate(candidate, reviews, '2026-07-22T04:00:00.000Z');
  return { candidate, decision, payload, promotion, reviews };
}

export function createProviderControlFixture() {
  const policy = createProviderBudgetPolicy({
    adapter: 'snapshot',
    budgetId: 'budget.mainnet.snapshot.rpc_primary',
    chainId: '1',
    leaseTtlSeconds: 60,
    maxConcurrentLeases: 2,
    maxCostUnits: 100,
    maxRequests: 10,
    maxResponseBytes: 1_000,
    maxRpcCalls: 20,
    providerId: 'rpc_primary',
    windowSeconds: 60,
  });
  const instanceIdHash = testHash('provider-instance');
  const reservation = createProviderBudgetReservation({
    budgetId: policy.budgetId,
    instanceIdHash,
    policyFingerprint: policy.policyFingerprint,
    requestedAt: '2026-07-22T10:00:00.000Z',
    reserve: { costUnits: 50, requests: 5, responseBytes: 500, rpcCalls: 10 },
  });
  const circuit = createSharedProviderCircuitState({
    adapter: 'snapshot',
    chainId: '1',
    consecutiveFailures: 0,
    generation: 0,
    lastTransitionReason: 'initialized',
    providerId: 'rpc_primary',
    state: 'closed',
    updatedAt: '2026-07-22T10:00:00.000Z',
  });
  return { circuit, instanceIdHash, policy, reservation };
}
