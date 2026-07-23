import { describe, expect, it } from 'vitest';

import {
  createChainAnalysisControlAuditEvent,
  createGovernanceAuthorization,
  createGovernanceAuthorizationRevocation,
  governanceAuthorizationSchema,
  reviewWorkJobId,
  reviewWorkJobSchema,
  samplingIntakeJobSchema,
  verifyChainAnalysisControlAuditEvents,
  type ChainAnalysisControlStoreError,
} from './index.js';
import { testHash } from './fixtures.test-helper.js';

describe('chain-analysis control-store contracts', () => {
  it('content-addresses canonical authorization and revocation records', () => {
    const authorization = createGovernanceAuthorization({
      grantedAt: '2026-07-22T00:00:00.000Z',
      grantedByHash: testHash('grantor'),
      principalIdHash: testHash('reviewer'),
      roles: ['retention_worker', 'independent_reviewer'],
      validUntil: '2027-07-22T00:00:00.000Z',
    });
    const revocation = createGovernanceAuthorizationRevocation({
      authorizationId: authorization.authorizationId,
      reasonCode: 'role_changed',
      revokedAt: '2026-08-22T00:00:00.000Z',
      revokedByHash: testHash('publisher'),
    });

    expect(authorization.roles).toEqual(['independent_reviewer', 'retention_worker']);
    expect(authorization.authorizationId).toBe(
      `authorization_${authorization.authorizationFingerprint.slice(7)}`,
    );
    expect(revocation.revocationId).toBe(`revocation_${revocation.revocationFingerprint.slice(7)}`);
    expect(
      governanceAuthorizationSchema.safeParse({
        ...authorization,
        principalIdHash: testHash('tampered'),
      }).success,
    ).toBe(false);
  });

  it('verifies ordered, hash-linked audit streams and rejects missing links', () => {
    const first = createChainAnalysisControlAuditEvent({
      actorIdHash: testHash('actor'),
      entityFingerprint: testHash('candidate'),
      entityId: 'reviewed_candidate',
      entityType: 'replay_candidate',
      eventAt: '2026-07-22T01:00:00.000Z',
      eventKind: 'candidate_recorded',
      payloadFingerprint: testHash('payload-a'),
      sequence: 1,
      stream: 'governance',
    });
    const second = createChainAnalysisControlAuditEvent({
      actorIdHash: testHash('actor'),
      entityFingerprint: testHash('review'),
      entityId: 'review_review',
      entityType: 'replay_review',
      eventAt: '2026-07-22T02:00:00.000Z',
      eventKind: 'review_recorded',
      payloadFingerprint: testHash('payload-b'),
      previousEventFingerprint: first.eventFingerprint,
      sequence: 2,
      stream: 'governance',
    });

    expect(verifyChainAnalysisControlAuditEvents([first, second])).toEqual([first, second]);
    expect(() => verifyChainAnalysisControlAuditEvents([second, first])).toThrowError(
      expectControlCode('invalid_audit_chain'),
    );
  });

  it('enforces mutually exclusive sampling job lease, success, and failure states', () => {
    const base = {
      attemptCount: 1,
      expiresAt: '2026-07-30T00:00:00.000Z',
      jobId: `sampling_job_${testHash('sampling-job').slice(7)}`,
      maxAttempts: 3,
      notBefore: '2026-07-23T00:00:00.000Z',
      planFingerprint: testHash('sampling-plan'),
      planId: `sampling_plan_${testHash('sampling-plan-id').slice(7)}`,
      slotId: `sampling_slot_${testHash('sampling-slot').slice(7)}`,
      stratumId: `sampling_stratum_${testHash('sampling-stratum').slice(7)}`,
    };

    expect(
      samplingIntakeJobSchema.parse({
        ...base,
        leaseExpiresAt: '2026-07-24T00:05:00.000Z',
        status: 'running',
        workerIdHash: testHash('sampling-worker'),
      }).status,
    ).toBe('running');
    expect(
      samplingIntakeJobSchema.safeParse({
        ...base,
        failureCodeHash: testHash('failure'),
        status: 'queued',
      }).success,
    ).toBe(false);
  });

  it('content-addresses one-slot owner review work and enforces fenced state shapes', () => {
    const candidateFingerprint = testHash('review-work-candidate');
    const candidateId = `reviewed_${candidateFingerprint.slice(7)}`;
    const base = {
      attemptCount: 1,
      candidateFingerprint,
      candidateId,
      expiresAt: '2026-08-24T12:00:00.000Z',
      jobId: reviewWorkJobId({ candidateFingerprint, candidateId, slotOrdinal: 1 }),
      maxAttempts: 3,
      notBefore: '2026-07-24T12:00:00.000Z',
      slotOrdinal: 1,
    };
    const reviewerIdHash = testHash('review-work-reviewer');

    expect(
      reviewWorkJobSchema.parse({
        ...base,
        leaseExpiresAt: '2026-07-24T12:05:00.000Z',
        reviewerIdHash,
        status: 'running',
      }).status,
    ).toBe('running');
    expect(
      reviewWorkJobSchema.safeParse({
        ...base,
        reviewerIdHash,
        status: 'succeeded',
      }).success,
    ).toBe(false);
    expect(
      reviewWorkJobSchema.safeParse({
        ...base,
        jobId: reviewWorkJobId({ candidateFingerprint, candidateId, slotOrdinal: 2 }),
        leaseExpiresAt: '2026-07-24T12:05:00.000Z',
        reviewerIdHash,
        status: 'running',
      }).success,
    ).toBe(false);
    expect(
      reviewWorkJobSchema.safeParse({
        ...base,
        leaseExpiresAt: '2026-09-24T12:05:00.000Z',
        reviewerIdHash,
        status: 'running',
      }).success,
    ).toBe(false);
  });
});

function expectControlCode(code: string): ChainAnalysisControlStoreError {
  return expect.objectContaining({ code }) as ChainAnalysisControlStoreError;
}
