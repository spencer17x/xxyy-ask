import { describe, expect, it } from 'vitest';

import {
  contractEvmHash,
  contractHash,
  createContractOnlySamplingHandoffFixture,
} from './fixtures/contract-fixtures.test-helper.js';
import {
  SAMPLING_CANDIDATE_SELECTION_POLICY,
  createSamplingCandidateHandoff,
  samplingCandidateHandoffSchema,
} from './sampling-candidate-handoff.js';

describe('sampling manifest to reviewed replay candidate handoff', () => {
  it('creates deterministic content-addressed lineage without extending retention', async () => {
    const { handoff, manifest, payload } = await createContractOnlySamplingHandoffFixture();
    const reproduced = createSamplingCandidateHandoff(manifest, {
      additionalSourcePayloadHashes: handoff.additionalSourcePayloadHashes,
      payload,
      scannedAt: handoff.candidate.scanner.scannedAt,
      scannerVersion: handoff.candidate.scanner.scannerVersion,
      submittedAt: handoff.candidate.submittedAt,
      submitterIdHash: handoff.candidate.submitterIdHash,
    });

    expect(reproduced).toEqual(handoff);
    expect(handoff.candidate.revision).toBe(1);
    expect(handoff.candidate.retainUntil).toBe(manifest.retainUntil);
    expect(handoff.candidate.retentionPolicyId).toBe(manifest.retentionPolicyId);
    expect(handoff.candidate.sourcePayloadHashes).toEqual(
      [...manifest.sourcePayloadHashes, ...handoff.additionalSourcePayloadHashes].sort(),
    );
    expect(handoff.selectionPolicy).toBe(SAMPLING_CANDIDATE_SELECTION_POLICY);
    expect(handoff.targetComparison).toEqual({
      disposition: 'matched',
      proposedGroundTruth: 'positive',
      samplingTargetLabel: 'positive',
    });
  });

  it('records target deviation and still creates the candidate', async () => {
    const { handoff } = await createContractOnlySamplingHandoffFixture({
      targetLabel: 'negative',
    });

    expect(handoff.targetComparison).toEqual({
      disposition: 'deviated',
      proposedGroundTruth: 'positive',
      samplingTargetLabel: 'negative',
    });
    expect(handoff.selectionPolicy).toBe('target_agnostic_no_exclusion');
    expect(handoff.candidate.status).toBe('pending_review');
  });

  it('rejects transaction, block, route, and data-state mismatches', async () => {
    const { handoff, manifest, payload } = await createContractOnlySamplingHandoffFixture();
    const mismatchedTransaction = structuredClone(payload);
    const otherTransaction = contractEvmHash('other-handoff-transaction');
    mismatchedTransaction.input.snapshot.requestedTransactionHash = otherTransaction;
    mismatchedTransaction.input.snapshot.transaction!.hash = otherTransaction;
    mismatchedTransaction.input.snapshot.receipt!.transactionHash = otherTransaction;
    for (const request of mismatchedTransaction.input.requests) {
      request.transactionHash = otherTransaction;
    }
    expectHandoffFailure(manifest, handoff, mismatchedTransaction, 'candidate_anchor_mismatch');

    const mismatchedBlock = structuredClone(payload);
    mismatchedBlock.input.snapshot.block!.hash = contractEvmHash('other-handoff-block');
    expectHandoffFailure(manifest, handoff, mismatchedBlock, 'candidate_anchor_mismatch');

    const mismatchedRoute = structuredClone(payload);
    mismatchedRoute.dimensions.router = 'allowlisted_router';
    expectHandoffFailure(manifest, handoff, mismatchedRoute, 'candidate_dimension_mismatch');

    const mismatchedDataState = structuredClone(payload);
    mismatchedDataState.dimensions.dataState = 'partial';
    expectHandoffFailure(manifest, handoff, mismatchedDataState, 'candidate_dimension_mismatch');
  });

  it('requires complete anchors, source hash continuity, and post-collection scanning', async () => {
    const { handoff, manifest, payload } = await createContractOnlySamplingHandoffFixture();
    const incomplete = structuredClone(payload);
    delete incomplete.input.snapshot.block;
    delete incomplete.input.snapshot.transaction!.blockNumber;
    delete incomplete.input.snapshot.transaction!.transactionIndex;
    delete incomplete.input.snapshot.receipt!.transactionIndex;
    expectHandoffFailure(manifest, handoff, incomplete, 'candidate_anchor_mismatch');

    const foreignSource = structuredClone(payload);
    foreignSource.input.snapshot.sources[0]!.payloadHash = contractHash('foreign-source');
    expectHandoffFailure(manifest, handoff, foreignSource, 'candidate_source_lineage_invalid');

    expect(() =>
      createSamplingCandidateHandoff(manifest, {
        additionalSourcePayloadHashes: handoff.additionalSourcePayloadHashes,
        payload,
        scannedAt: '2026-07-24T09:59:59.000Z',
        scannerVersion: handoff.candidate.scanner.scannerVersion,
        submittedAt: handoff.candidate.submittedAt,
        submitterIdHash: handoff.candidate.submitterIdHash,
      }),
    ).toThrow(expect.objectContaining({ code: 'candidate_time_lineage_invalid' }));
  });

  it('detects tampering in comparison, candidate, manifest, and handoff fingerprints', async () => {
    const { handoff } = await createContractOnlySamplingHandoffFixture();

    expect(
      samplingCandidateHandoffSchema.safeParse({
        ...handoff,
        targetComparison: { ...handoff.targetComparison, disposition: 'deviated' },
      }).success,
    ).toBe(false);
    expect(
      samplingCandidateHandoffSchema.safeParse({
        ...handoff,
        handoffFingerprint: contractHash('tampered-handoff'),
      }).success,
    ).toBe(false);
    expect(
      samplingCandidateHandoffSchema.safeParse({
        ...handoff,
        candidate: { ...handoff.candidate, retentionPolicyId: 'tampered-policy' },
      }).success,
    ).toBe(false);
  });
});

function expectHandoffFailure(
  manifest: Parameters<typeof createSamplingCandidateHandoff>[0],
  handoff: Awaited<ReturnType<typeof createContractOnlySamplingHandoffFixture>>['handoff'],
  payload: Awaited<ReturnType<typeof createContractOnlySamplingHandoffFixture>>['payload'],
  code: string,
): void {
  expect(() =>
    createSamplingCandidateHandoff(manifest, {
      additionalSourcePayloadHashes: handoff.additionalSourcePayloadHashes,
      payload,
      scannedAt: handoff.candidate.scanner.scannedAt,
      scannerVersion: handoff.candidate.scanner.scannerVersion,
      submittedAt: handoff.candidate.submittedAt,
      submitterIdHash: handoff.candidate.submitterIdHash,
    }),
  ).toThrow(expect.objectContaining({ code }));
}
