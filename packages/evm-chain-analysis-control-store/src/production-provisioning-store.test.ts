import { describe, expect, it } from 'vitest';

import {
  createGovernanceAuthorization,
  createGovernanceAuthorizationRevocation,
  createPgEvmChainAnalysisProductionProvisioningStore,
  type ProductionProvisioningAuthorityVerifier,
  type ProductionProvisioningReceipt,
} from './index.js';
import { testHash } from './fixtures.test-helper.js';
import {
  materializeProductionProvisioningReceipt,
  type ProductionProvisioningApplication,
} from './production-provisioning-contracts.js';
import {
  createContractOnlyProductionApproval,
  createContractOnlyProductionProvisioningFixture,
} from './production-provisioning.test-helper.js';
import { ScriptedPgClient } from './scripted-pg.test-helper.js';

describe('PostgreSQL production approval and identity provisioning store', () => {
  it('verifies and atomically persists the single-owner approval, eight grants, receipt, and audit', async () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    const verified: ProductionProvisioningApplication[] = [];
    const authorityVerifier: ProductionProvisioningAuthorityVerifier = {
      async verify(input) {
        await Promise.resolve();
        verified.push(structuredClone(input));
        input.plan.identities.splice(0);
      },
    };
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisProductionProvisioningStore({
      authorityVerifier,
      client,
      clock: applicationClock,
    });

    const receipt = await store.apply({
      plan: fixture.plan,
      verification: fixture.verification,
    });

    expect(verified).toHaveLength(1);
    expect(receipt.plan.identities).toHaveLength(8);
    expect(receipt.authorizationIds).toHaveLength(8);
    expect(receipt.status).toBe('applied');
    expect(client.queries.filter((query) => query.tag === 'authorization-insert')).toHaveLength(8);
    expect(client.queries.filter((query) => query.tag === 'sampling-approval-insert')).toHaveLength(
      1,
    );
    expect(
      client.queries.filter((query) => query.tag === 'production-provisioning-receipt-insert'),
    ).toHaveLength(1);
    expect(
      client.queries.filter(
        (query) => query.tag === 'production-provisioning-receipt-authorization-insert',
      ),
    ).toHaveLength(8);
    expect(client.auditEvents.map(eventKind)).toEqual([
      'sampling_approval_recorded',
      ...Array.from({ length: 8 }, () => 'authorization_recorded'),
      'production_provisioning_recorded',
    ]);
    const lockKeys = client.queries
      .filter((query) => query.tag === 'advisory-lock')
      .map((query) => query.values[0]);
    expect(lockKeys).toContain('sampling-approval-schedule');
    for (const authorization of fixture.plan.authorizations) {
      expect(lockKeys).toContain(`authorization-role-schedule:${authorization.roles[0]}`);
    }
    expect(client.transactionEvents).toEqual(['begin', 'commit']);
    expect(JSON.stringify(receipt)).not.toMatch(/\b(?:https?|wss?):|secretref:|endpoint/iu);
    expect(receipt.plan.approval.credentialsAllowed).toBe(false);
  });

  it('does not touch PostgreSQL when external authority verification fails', async () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    const client = new ScriptedPgClient();
    const store = createPgEvmChainAnalysisProductionProvisioningStore({
      authorityVerifier: {
        async verify() {
          await Promise.resolve();
          throw new Error('external approval rejected');
        },
      },
      client,
    });

    await expect(
      store.apply({ plan: fixture.plan, verification: fixture.verification }),
    ).rejects.toMatchObject({ code: 'provisioning_verification_failed' });
    expect(client.queries).toHaveLength(0);
    expect(client.transactionEvents).toHaveLength(0);
  });

  it('rejects active approval or authorization drift and rolls back without a receipt', async () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    const conflictingApprovalClient = new ScriptedPgClient();
    conflictingApprovalClient.enqueue('production-provisioning-active-approval', [
      {
        payload: createContractOnlyProductionApproval({
          approvalName: 'production_mainnet_sources_v2',
        }),
      },
    ]);
    const conflictingApprovalStore = createPgEvmChainAnalysisProductionProvisioningStore({
      authorityVerifier: acceptingVerifier(),
      client: conflictingApprovalClient,
      clock: applicationClock,
    });

    await expect(
      conflictingApprovalStore.apply({
        plan: fixture.plan,
        verification: fixture.verification,
      }),
    ).rejects.toMatchObject({ code: 'provisioning_conflict' });
    expect(conflictingApprovalClient.transactionEvents).toEqual(['begin', 'rollback']);
    expect(
      conflictingApprovalClient.queries.some(
        (query) => query.tag === 'production-provisioning-receipt-insert',
      ),
    ).toBe(false);

    const conflictingAuthorizationClient = new ScriptedPgClient();
    conflictingAuthorizationClient.enqueue('production-provisioning-active-authorizations', [
      {
        payload: createGovernanceAuthorization({
          grantedAt: '2026-07-24T00:00:00.000Z',
          grantedByHash: testHash('legacy-grantor'),
          principalIdHash: testHash('legacy-worker'),
          roles: ['sampling_worker'],
          validUntil: '2027-07-24T00:00:00.000Z',
        }),
      },
    ]);
    const conflictingAuthorizationStore = createPgEvmChainAnalysisProductionProvisioningStore({
      authorityVerifier: acceptingVerifier(),
      client: conflictingAuthorizationClient,
      clock: applicationClock,
    });

    await expect(
      conflictingAuthorizationStore.apply({
        plan: fixture.plan,
        verification: fixture.verification,
      }),
    ).rejects.toMatchObject({ code: 'provisioning_conflict' });
    expect(conflictingAuthorizationClient.transactionEvents).toEqual(['begin', 'rollback']);

    const revokedPlannedAuthorizationClient = new ScriptedPgClient();
    const plannedAuthorization = fixture.plan.authorizations[0]!;
    revokedPlannedAuthorizationClient.enqueue('production-provisioning-active-authorizations', [
      {
        payload: plannedAuthorization,
        revocation_payload: createGovernanceAuthorizationRevocation({
          authorizationId: plannedAuthorization.authorizationId,
          reasonCode: 'identity_disabled',
          revokedAt: '2026-07-24T00:30:00.000Z',
          revokedByHash: fixture.plan.provisionedByHash,
        }),
      },
    ]);
    const revokedPlannedAuthorizationStore = createPgEvmChainAnalysisProductionProvisioningStore({
      authorityVerifier: acceptingVerifier(),
      client: revokedPlannedAuthorizationClient,
      clock: applicationClock,
    });

    await expect(
      revokedPlannedAuthorizationStore.apply({
        plan: fixture.plan,
        verification: fixture.verification,
      }),
    ).rejects.toMatchObject({ code: 'provisioning_conflict' });
    expect(revokedPlannedAuthorizationClient.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('returns the exact existing receipt idempotently after re-verification', async () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    const receipt = materializeProductionProvisioningReceipt({
      plan: fixture.plan,
      verification: fixture.verification,
    });
    let verificationCalls = 0;
    const client = new ScriptedPgClient();
    client.enqueue('production-provisioning-receipt-read', [{ payload: receipt }]);
    client.enqueue(
      'production-provisioning-receipt-authorizations-read',
      receiptAuthorizationRows(receipt),
    );
    const store = createPgEvmChainAnalysisProductionProvisioningStore({
      authorityVerifier: {
        async verify() {
          await Promise.resolve();
          verificationCalls += 1;
        },
      },
      client,
      clock: () => new Date('2026-07-25T01:00:00.000Z'),
    });

    await expect(
      store.apply({ plan: fixture.plan, verification: fixture.verification }),
    ).resolves.toEqual(receipt);
    expect(verificationCalls).toBe(1);
    expect(client.transactionEvents).toEqual(['begin', 'commit']);
    expect(client.auditEvents).toHaveLength(0);
    expect(
      client.queries.some((query) => query.tag === 'production-provisioning-active-approval'),
    ).toBe(false);
  });

  it('rejects an existing receipt whose normalized authorization lineage is missing', async () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    const receipt = materializeProductionProvisioningReceipt({
      plan: fixture.plan,
      verification: fixture.verification,
    });
    const client = new ScriptedPgClient();
    client.enqueue('production-provisioning-receipt-read', [{ payload: receipt }]);
    const store = createPgEvmChainAnalysisProductionProvisioningStore({
      authorityVerifier: acceptingVerifier(),
      client,
      clock: applicationClock,
    });

    await expect(
      store.apply({ plan: fixture.plan, verification: fixture.verification }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(client.transactionEvents).toEqual(['begin', 'rollback']);
  });

  it('rejects a first application outside the scheduled provisioning window', async () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    for (const clock of [
      () => new Date('2026-07-24T00:59:59.999Z'),
      () => new Date('2026-07-24T01:15:00.000Z'),
    ]) {
      const client = new ScriptedPgClient();
      const store = createPgEvmChainAnalysisProductionProvisioningStore({
        authorityVerifier: acceptingVerifier(),
        client,
        clock,
      });

      await expect(
        store.apply({ plan: fixture.plan, verification: fixture.verification }),
      ).rejects.toMatchObject({ code: 'provisioning_time_invalid' });
      expect(client.transactionEvents).toEqual(['begin', 'rollback']);
      expect(
        client.queries.some((query) => query.tag === 'production-provisioning-receipt-insert'),
      ).toBe(false);
    }
  });
});

function acceptingVerifier(): ProductionProvisioningAuthorityVerifier {
  return {
    async verify() {
      await Promise.resolve();
    },
  };
}

function eventKind(value: unknown): unknown {
  return (value as { eventKind?: unknown }).eventKind;
}

function applicationClock(): Date {
  return new Date('2026-07-24T01:05:00.000Z');
}

function receiptAuthorizationRows(
  receipt: ProductionProvisioningReceipt,
): Array<Record<string, unknown>> {
  return receipt.authorizationIds.map((authorizationId, index) => ({
    authorization_fingerprint: receipt.authorizationFingerprints[index],
    authorization_id: authorizationId,
    identity_evidence_hash: receipt.identityEvidenceHashes[index],
    ordinal: index + 1,
  }));
}
