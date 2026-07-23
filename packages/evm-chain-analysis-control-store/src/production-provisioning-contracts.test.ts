import { describe, expect, it } from 'vitest';

import {
  createProductionProvisioningPlan,
  createProductionProvisioningPlanFromRequest,
  createProductionProvisioningVerificationClaim,
  productionProvisioningApplicationSchema,
  productionProvisioningPlanSchema,
} from './index.js';
import { testHash } from './fixtures.test-helper.js';
import {
  createContractOnlyProductionApproval,
  createContractOnlyProductionProvisioningFixture,
} from './production-provisioning.test-helper.js';

describe('production approval and identity provisioning contracts', () => {
  it('content-addresses the single-owner baseline with eight role bindings', () => {
    const { approval, identities, plan } = createContractOnlyProductionProvisioningFixture();
    const {
      approvalFingerprint: _approvalFingerprint,
      approvalId: _approvalId,
      version: _approvalVersion,
      ...approvalRequest
    } = approval;
    const requestPlan = createProductionProvisioningPlanFromRequest({
      approval: approvalRequest,
      authorizationValidUntil: plan.authorizationValidUntil,
      identities,
      provisionedAt: plan.provisionedAt,
      provisionedByHash: plan.provisionedByHash,
    });

    expect(plan.targetChainIds).toEqual(['1']);
    expect(plan.protocols).toEqual(['uniswap_v2', 'uniswap_v3']);
    expect(plan.sourceKinds).toEqual(['official_explorer_export', 'public_rpc']);
    expect(plan.retentionDays).toBe(90);
    expect(plan.ownerBaseline).toEqual({
      governanceOwner: 'product_owner',
      legalAndRetentionOwner: 'product_owner',
      providerOperationsOwner: 'platform_operations',
      readinessPolicyOwner: 'technical_owner',
    });
    expect(plan.governanceProfile).toEqual({
      automatedAuthorityVerificationRequired: true,
      humanApproverCount: 1,
      humanReviewerCount: 1,
      minimumConfirmationDelaySeconds: 900,
      mode: 'single_owner',
    });
    expect(plan.identities.map((identity) => identity.role)).toEqual([
      'candidate_submitter',
      'governance_publisher',
      'independent_reviewer',
      'provider_operator',
      'readiness_attestor',
      'retention_worker',
      'sampling_planner',
      'sampling_worker',
    ]);
    expect(plan.authorizations).toHaveLength(8);
    expect(plan.identities.map(({ ownerDomain, role }) => [role, ownerDomain])).toEqual([
      ['candidate_submitter', 'platform_operations'],
      ['governance_publisher', 'product_owner'],
      ['independent_reviewer', 'product_owner'],
      ['provider_operator', 'platform_operations'],
      ['readiness_attestor', 'technical_owner'],
      ['retention_worker', 'platform_operations'],
      ['sampling_planner', 'product_owner'],
      ['sampling_worker', 'platform_operations'],
    ]);
    expect(plan.authorizations.every((authorization) => authorization.roles.length === 1)).toBe(
      true,
    );
    expect(
      new Set(
        plan.identities
          .filter((identity) => identity.identityKind === 'controlled_human_account')
          .map((identity) => identity.principalIdHash),
      ),
    ).toEqual(new Set([plan.provisionedByHash]));
    const servicePrincipalHashes = plan.identities
      .filter((identity) => identity.identityKind === 'platform_service_account')
      .map((identity) => identity.principalIdHash);
    expect(servicePrincipalHashes).toHaveLength(4);
    expect(new Set(servicePrincipalHashes).size).toBe(4);
    expect(plan.planId).toBe(`production_provisioning_plan_${plan.planFingerprint.slice(7)}`);
    expect(JSON.stringify(plan)).not.toMatch(/\b(?:https?|wss?):|secretref:|endpoint/iu);
    expect(plan.approval.credentialsAllowed).toBe(false);
    expect(requestPlan).toEqual(plan);
  });

  it('rejects changed retention, fixture markers, service collisions, and role-kind drift', () => {
    const fixture = createContractOnlyProductionProvisioningFixture();
    const common = {
      approval: fixture.approval,
      authorizationValidUntil: fixture.plan.authorizationValidUntil,
      identities: fixture.identities,
      provisionedAt: fixture.plan.provisionedAt,
      provisionedByHash: fixture.plan.provisionedByHash,
    };
    const wrongRetention = createContractOnlyProductionApproval({
      approvalName: 'production_mainnet_sources_30d_v1',
      retentionDays: 30,
      retentionPolicyId: 'public_chain_30d_v1',
    });
    expect(() =>
      createProductionProvisioningPlan({ ...common, approval: wrongRetention }),
    ).toThrow();

    const multipleApprovers = createContractOnlyProductionApproval({
      approvedByHashes: [fixture.plan.provisionedByHash, testHash('second-human')],
    });
    expect(() =>
      createProductionProvisioningPlan({ ...common, approval: multipleApprovers }),
    ).toThrow();

    const fixtureNamedApproval = createContractOnlyProductionApproval({
      approvalName: 'contract-only-mainnet-sources',
    });
    expect(() =>
      createProductionProvisioningPlan({ ...common, approval: fixtureNamedApproval }),
    ).toThrow();

    const legitimateSubstringApproval = createContractOnlyProductionApproval({
      approvalName: 'latest_mainnet_sources',
      retentionPolicyId: 'attestation_90d',
    });
    expect(() =>
      createProductionProvisioningPlan({ ...common, approval: legitimateSubstringApproval }),
    ).not.toThrow();

    const duplicatePrincipal = fixture.identities.map((identity, index) =>
      index === 1
        ? { ...identity, principalIdHash: fixture.identities[0]!.principalIdHash }
        : identity,
    );
    expect(() =>
      createProductionProvisioningPlan({ ...common, identities: duplicatePrincipal }),
    ).toThrow();

    const multipleHumanPrincipals = fixture.identities.map((identity) =>
      identity.role === 'readiness_attestor'
        ? { ...identity, principalIdHash: testHash('second-human') }
        : identity,
    );
    expect(() =>
      createProductionProvisioningPlan({ ...common, identities: multipleHumanPrincipals }),
    ).toThrow();

    const wrongKind = fixture.identities.map((identity) =>
      identity.role === 'independent_reviewer'
        ? { ...identity, identityKind: 'platform_service_account' as const }
        : identity,
    );
    expect(() => createProductionProvisioningPlan({ ...common, identities: wrongKind })).toThrow();

    const wrongOwner = fixture.identities.map((identity) =>
      identity.role === 'readiness_attestor'
        ? { ...identity, ownerDomain: 'product_owner' as const }
        : identity,
    );
    expect(() => createProductionProvisioningPlan({ ...common, identities: wrongOwner })).toThrow();

    const reusedEvidence = fixture.identities.map((identity, index) =>
      index === 0
        ? {
            ...identity,
            identityEvidenceHash: fixture.plan.approval.legalReviewEvidenceHash,
          }
        : identity,
    );
    expect(() =>
      createProductionProvisioningPlan({ ...common, identities: reusedEvidence }),
    ).toThrow();

    const principalAsEvidence = fixture.identities.map((identity, index) =>
      index === 0
        ? {
            ...identity,
            identityEvidenceHash: identity.principalIdHash,
          }
        : identity,
    );
    expect(() =>
      createProductionProvisioningPlan({ ...common, identities: principalAsEvidence }),
    ).toThrow();

    expect(
      productionProvisioningPlanSchema.safeParse({
        ...fixture.plan,
        targetChainIds: ['10'],
      }).success,
    ).toBe(false);
  });

  it('requires exact-plan automated verification after the owner confirmation window', () => {
    const fixture = createContractOnlyProductionProvisioningFixture();

    expect(
      productionProvisioningApplicationSchema.parse({
        plan: fixture.plan,
        verification: fixture.verification,
      }).verification.verificationFingerprint,
    ).toBe(fixture.verification.verificationFingerprint);

    const selfVerified = createProductionProvisioningVerificationClaim({
      authoritySystemId: 'platform_policy_verifier',
      planFingerprint: fixture.plan.planFingerprint,
      verificationEvidenceHash: testHash('verification-self'),
      verifiedAt: '2026-07-24T00:30:00.000Z',
      verifiedByHash: fixture.plan.provisionedByHash,
    });
    expect(
      productionProvisioningApplicationSchema.safeParse({
        plan: fixture.plan,
        verification: selfVerified,
      }).success,
    ).toBe(false);

    const runtimePrincipalVerification = createProductionProvisioningVerificationClaim({
      authoritySystemId: 'platform_policy_verifier',
      planFingerprint: fixture.plan.planFingerprint,
      verificationEvidenceHash: testHash('verification-runtime-principal'),
      verifiedAt: '2026-07-24T00:30:00.000Z',
      verifiedByHash: fixture.plan.identities[0]!.principalIdHash,
    });
    expect(
      productionProvisioningApplicationSchema.safeParse({
        plan: fixture.plan,
        verification: runtimePrincipalVerification,
      }).success,
    ).toBe(false);

    const verifierAsEvidence = createProductionProvisioningVerificationClaim({
      authoritySystemId: 'platform_policy_verifier',
      planFingerprint: fixture.plan.planFingerprint,
      verificationEvidenceHash: fixture.verification.verifiedByHash,
      verifiedAt: '2026-07-24T00:30:00.000Z',
      verifiedByHash: fixture.verification.verifiedByHash,
    });
    expect(
      productionProvisioningApplicationSchema.safeParse({
        plan: fixture.plan,
        verification: verifierAsEvidence,
      }).success,
    ).toBe(false);

    const prematureVerification = createProductionProvisioningVerificationClaim({
      authoritySystemId: 'platform_policy_verifier',
      planFingerprint: fixture.plan.planFingerprint,
      verificationEvidenceHash: testHash('verification-too-early'),
      verifiedAt: '2026-07-23T23:05:00.000Z',
      verifiedByHash: fixture.verification.verifiedByHash,
    });
    expect(
      productionProvisioningApplicationSchema.safeParse({
        plan: fixture.plan,
        verification: prematureVerification,
      }).success,
    ).toBe(false);

    const reusedEvidence = createProductionProvisioningVerificationClaim({
      authoritySystemId: 'platform_policy_verifier',
      planFingerprint: fixture.plan.planFingerprint,
      verificationEvidenceHash: fixture.plan.approval.legalReviewEvidenceHash,
      verifiedAt: '2026-07-24T00:30:00.000Z',
      verifiedByHash: fixture.verification.verifiedByHash,
    });
    expect(
      productionProvisioningApplicationSchema.safeParse({
        plan: fixture.plan,
        verification: reusedEvidence,
      }).success,
    ).toBe(false);

    const wrongPlan = createProductionProvisioningVerificationClaim({
      authoritySystemId: 'platform_policy_verifier',
      planFingerprint: testHash('other-plan'),
      verificationEvidenceHash: testHash('other-plan-verification'),
      verifiedAt: '2026-07-24T00:30:00.000Z',
      verifiedByHash: fixture.verification.verifiedByHash,
    });
    expect(
      productionProvisioningApplicationSchema.safeParse({
        plan: fixture.plan,
        verification: wrongPlan,
      }).success,
    ).toBe(false);
  });
});
