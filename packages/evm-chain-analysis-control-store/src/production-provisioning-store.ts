import { mainnetSamplingSourceApprovalSchema } from '@xxyy/evm-chain-analysis-readiness';

import {
  ChainAnalysisControlStoreError,
  governanceAuthorizationRevocationSchema,
  governanceAuthorizationSchema,
} from './contracts.js';
import { appendControlAuditEvent, assertSameFingerprint } from './control-store-internals.js';
import { recordGovernanceAuthorizationArtifact } from './governance-store.js';
import { migrateEvmChainAnalysisControlStore } from './migrations.js';
import {
  materializeProductionProvisioningReceipt,
  productionProvisioningApplicationSchema,
  productionProvisioningReceiptSchema,
  type ProductionProvisioningPlan,
  type ProductionProvisioningReceipt,
  type ProductionProvisioningVerificationClaim,
} from './production-provisioning-contracts.js';
import {
  acquireControlLock,
  parseSafeInteger,
  queryControlDatabase,
  withControlTransaction,
  type PgControlClientLike,
} from './postgres.js';
import { recordMainnetSamplingSourceApprovalArtifact } from './sampling-store.js';

interface PayloadRow {
  payload: unknown;
}

interface ReceiptAuthorizationRow {
  authorization_fingerprint: string;
  authorization_id: string;
  identity_evidence_hash: string;
  ordinal: number | string;
}

interface ActiveAuthorizationRow extends PayloadRow {
  revocation_payload: unknown;
}

export interface ProductionProvisioningAuthorityVerifier {
  verify(input: {
    plan: ProductionProvisioningPlan;
    verification: ProductionProvisioningVerificationClaim;
  }): Promise<void>;
}

export interface PgEvmChainAnalysisProductionProvisioningStore {
  apply(input: { plan: unknown; verification: unknown }): Promise<ProductionProvisioningReceipt>;
  getReceipt(planId: string): Promise<ProductionProvisioningReceipt | undefined>;
  migrate(): Promise<void>;
}

export function createPgEvmChainAnalysisProductionProvisioningStore(options: {
  authorityVerifier: ProductionProvisioningAuthorityVerifier;
  client: PgControlClientLike;
}): PgEvmChainAnalysisProductionProvisioningStore {
  const { authorityVerifier, client } = options;
  return {
    async apply(input): Promise<ProductionProvisioningReceipt> {
      const application = productionProvisioningApplicationSchema.parse(input);
      const expectedReceipt = materializeProductionProvisioningReceipt(application);
      try {
        await authorityVerifier.verify(structuredClone(application));
      } catch {
        throw new ChainAnalysisControlStoreError(
          'provisioning_verification_failed',
          'External production approval and identity verification failed.',
        );
      }

      return withControlTransaction(client, async (transaction) => {
        await acquireControlLock(transaction, `production-provisioning:${application.plan.planId}`);
        const existing = await readReceipt(transaction, application.plan.planId);
        if (existing !== undefined) {
          assertSameFingerprint(
            expectedReceipt.receiptFingerprint,
            existing.receiptFingerprint,
            'Production provisioning receipt',
          );
          return existing;
        }

        await acquireControlLock(transaction, 'sampling-approval-schedule');
        for (const role of [
          ...new Set(
            application.plan.authorizations.flatMap((authorization) => authorization.roles),
          ),
        ].sort()) {
          await acquireControlLock(transaction, `authorization-role-schedule:${role}`);
        }
        await assertNoConflictingActiveApproval(transaction, application.plan);
        await assertNoConflictingActiveAuthorizations(transaction, application.plan);
        await recordMainnetSamplingSourceApprovalArtifact(
          transaction,
          application.plan.approval,
          application.plan.provisionedByHash,
        );
        for (const authorization of application.plan.authorizations) {
          await recordGovernanceAuthorizationArtifact(transaction, authorization);
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:production-provisioning-receipt-insert */
            insert into evm_chain_control_production_provisioning_receipts (
              receipt_id,
              receipt_fingerprint,
              plan_id,
              plan_fingerprint,
              verification_fingerprint,
              approval_fingerprint,
              authorization_ids,
              applied_at,
              payload
            ) values ($1, $2, $3, $4, $5, $6, $7::text[], $8::timestamptz, $9::jsonb)
          `,
          [
            expectedReceipt.receiptId,
            expectedReceipt.receiptFingerprint,
            application.plan.planId,
            application.plan.planFingerprint,
            application.verification.verificationFingerprint,
            application.plan.approval.approvalFingerprint,
            expectedReceipt.authorizationIds,
            expectedReceipt.appliedAt,
            JSON.stringify(expectedReceipt),
          ],
        );
        for (const [index, authorizationId] of expectedReceipt.authorizationIds.entries()) {
          await queryControlDatabase(
            transaction,
            `
              /* control:production-provisioning-receipt-authorization-insert */
              insert into evm_chain_control_provisioning_receipt_grants (
                receipt_id,
                ordinal,
                authorization_id,
                authorization_fingerprint,
                identity_evidence_hash
              ) values ($1, $2, $3, $4, $5)
            `,
            [
              expectedReceipt.receiptId,
              index + 1,
              authorizationId,
              expectedReceipt.authorizationFingerprints[index],
              expectedReceipt.identityEvidenceHashes[index],
            ],
          );
        }
        await appendControlAuditEvent(transaction, {
          actorIdHash: application.plan.provisionedByHash,
          entityFingerprint: expectedReceipt.receiptFingerprint,
          entityId: expectedReceipt.receiptId,
          entityType: 'production_provisioning_receipt',
          eventAt: expectedReceipt.appliedAt,
          eventKind: 'production_provisioning_recorded',
          payload: {
            approvalFingerprint: expectedReceipt.approvalFingerprint,
            authorizationFingerprints: expectedReceipt.authorizationFingerprints,
            planFingerprint: application.plan.planFingerprint,
            verificationFingerprint: application.verification.verificationFingerprint,
          },
          stream: 'governance',
        });
        return expectedReceipt;
      });
    },

    async getReceipt(planId): Promise<ProductionProvisioningReceipt | undefined> {
      return readReceipt(client, planId);
    },

    async migrate(): Promise<void> {
      await migrateEvmChainAnalysisControlStore(client);
    },
  };
}

async function assertNoConflictingActiveApproval(
  client: PgControlClientLike,
  plan: ProductionProvisioningPlan,
): Promise<void> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:production-provisioning-active-approval */
      select payload
      from evm_chain_control_sampling_approvals
      where valid_from <= $1::timestamptz and valid_until > $1::timestamptz
      order by approval_id
    `,
    [plan.provisionedAt],
  );
  for (const row of response.rows) {
    const approval = mainnetSamplingSourceApprovalSchema.parse(row.payload);
    if (approval.approvalFingerprint !== plan.approval.approvalFingerprint) {
      throw new ChainAnalysisControlStoreError(
        'provisioning_conflict',
        'A different source, legal, or retention approval is active at provisioning time.',
      );
    }
  }
}

async function assertNoConflictingActiveAuthorizations(
  client: PgControlClientLike,
  plan: ProductionProvisioningPlan,
): Promise<void> {
  const response = await queryControlDatabase<ActiveAuthorizationRow>(
    client,
    `
      /* control:production-provisioning-active-authorizations */
      select grant_record.payload, revocation_record.payload as revocation_payload
      from evm_chain_control_authorizations grant_record
      left join evm_chain_control_authorization_revocations revocation_record
        on revocation_record.authorization_id = grant_record.authorization_id
      where
        grant_record.roles && $1::text[]
        and grant_record.granted_at <= $2::timestamptz
        and (
          grant_record.valid_until is null
          or grant_record.valid_until > $2::timestamptz
        )
      order by grant_record.authorization_id
    `,
    [plan.authorizations.flatMap((authorization) => authorization.roles), plan.provisionedAt],
  );
  const expected = new Set(
    plan.authorizations.map((authorization) => authorization.authorizationFingerprint),
  );
  for (const row of response.rows) {
    const authorization = governanceAuthorizationSchema.parse(row.payload);
    const revocation =
      row.revocation_payload === null || row.revocation_payload === undefined
        ? undefined
        : governanceAuthorizationRevocationSchema.parse(row.revocation_payload);
    if (expected.has(authorization.authorizationFingerprint)) {
      if (revocation !== undefined) {
        throw new ChainAnalysisControlStoreError(
          'provisioning_conflict',
          'A planned authorization was already revoked before the provisioning receipt existed.',
        );
      }
      continue;
    }
    if (
      revocation === undefined ||
      Date.parse(revocation.revokedAt) > Date.parse(plan.provisionedAt)
    ) {
      throw new ChainAnalysisControlStoreError(
        'provisioning_conflict',
        'An unplanned active authorization conflicts with the least-privilege role set.',
      );
    }
  }
}

async function readReceipt(
  client: PgControlClientLike,
  planId: string,
): Promise<ProductionProvisioningReceipt | undefined> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:production-provisioning-receipt-read */
      select payload
      from evm_chain_control_production_provisioning_receipts
      where plan_id = $1
    `,
    [planId],
  );
  const row = response.rows[0];
  if (row === undefined) {
    return undefined;
  }
  const receipt = productionProvisioningReceiptSchema.parse(row.payload);
  const authorizationResponse = await queryControlDatabase<ReceiptAuthorizationRow>(
    client,
    `
      /* control:production-provisioning-receipt-authorizations-read */
      select
        ordinal,
        authorization_id,
        authorization_fingerprint,
        identity_evidence_hash
      from evm_chain_control_provisioning_receipt_grants
      where receipt_id = $1
      order by ordinal
    `,
    [receipt.receiptId],
  );
  if (
    authorizationResponse.rows.length !== receipt.authorizationIds.length ||
    authorizationResponse.rows.some(
      (authorization, index) =>
        parseSafeInteger(authorization.ordinal, 'provisioning receipt authorization ordinal') !==
          index + 1 ||
        authorization.authorization_id !== receipt.authorizationIds[index] ||
        authorization.authorization_fingerprint !== receipt.authorizationFingerprints[index] ||
        authorization.identity_evidence_hash !== receipt.identityEvidenceHashes[index],
    )
  ) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'Production provisioning receipt authorization lineage is missing or inconsistent.',
    );
  }
  return receipt;
}
