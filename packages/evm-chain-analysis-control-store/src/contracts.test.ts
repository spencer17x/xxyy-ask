import { describe, expect, it } from 'vitest';

import {
  createChainAnalysisControlAuditEvent,
  createGovernanceAuthorization,
  createGovernanceAuthorizationRevocation,
  governanceAuthorizationSchema,
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
});

function expectControlCode(code: string): ChainAnalysisControlStoreError {
  return expect.objectContaining({ code }) as ChainAnalysisControlStoreError;
}
