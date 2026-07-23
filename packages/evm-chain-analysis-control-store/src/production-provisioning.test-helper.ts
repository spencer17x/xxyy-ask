import { createMainnetSamplingSourceApproval } from '@xxyy/evm-chain-analysis-readiness';

import { testHash } from './fixtures.test-helper.js';
import {
  createProductionProvisioningPlan,
  createProductionProvisioningVerificationClaim,
  type ProductionProvisioningIdentity,
} from './production-provisioning-contracts.js';

export function createContractOnlyProductionProvisioningFixture() {
  const provisionedByHash = testHash('production-provisioner');
  const verifiedByHash = testHash('production-verifier');
  const approval = createContractOnlyProductionApproval({
    approvedByHashes: [provisionedByHash, verifiedByHash],
  });
  const identities = contractOnlyProductionIdentities();
  const plan = createProductionProvisioningPlan({
    approval,
    authorizationValidUntil: '2027-01-24T00:00:00.000Z',
    identities,
    provisionedAt: '2026-07-24T01:00:00.000Z',
    provisionedByHash,
  });
  const verification = createProductionProvisioningVerificationClaim({
    authoritySystemId: 'org_approval_registry',
    planFingerprint: plan.planFingerprint,
    verificationEvidenceHash: testHash('production-verification-evidence'),
    verifiedAt: '2026-07-24T00:30:00.000Z',
    verifiedByHash,
  });
  return { approval, identities, plan, verification };
}

export function createContractOnlyProductionApproval(
  overrides: Partial<Parameters<typeof createMainnetSamplingSourceApproval>[0]> = {},
) {
  return createMainnetSamplingSourceApproval({
    approvalName: 'production_mainnet_sources_v1',
    approvedAt: '2026-07-23T23:00:00.000Z',
    approvedByHashes: [testHash('production-provisioner'), testHash('production-verifier')],
    credentialsAllowed: false,
    legalReviewEvidenceHash: testHash('production-legal-review'),
    privateDataAllowed: false,
    publicChainDataOnly: true,
    retentionDays: 90,
    retentionPolicyId: 'public_chain_90d_v1',
    retentionReviewEvidenceHash: testHash('production-retention-review'),
    sourceApprovalEvidenceHashes: [
      testHash('production-explorer-source-review'),
      testHash('production-rpc-source-review'),
    ],
    sourceKinds: ['official_explorer_export', 'public_rpc'],
    validFrom: '2026-07-24T00:00:00.000Z',
    validUntil: '2027-07-24T00:00:00.000Z',
    ...overrides,
  });
}

function contractOnlyProductionIdentities(): ProductionProvisioningIdentity[] {
  return [
    identity('sampling_worker', 'platform_service_account'),
    identity('independent_reviewer', 'controlled_human_account', 'a'),
    identity('candidate_submitter', 'platform_service_account'),
    identity('readiness_attestor', 'controlled_human_account'),
    identity('governance_publisher', 'controlled_human_account'),
    identity('provider_operator', 'platform_service_account'),
    identity('retention_worker', 'platform_service_account'),
    identity('sampling_planner', 'controlled_human_account'),
    identity('independent_reviewer', 'controlled_human_account', 'b'),
  ];
}

function identity(
  role: ProductionProvisioningIdentity['role'],
  identityKind: ProductionProvisioningIdentity['identityKind'],
  suffix = '',
): ProductionProvisioningIdentity {
  const label = `${role}${suffix}`;
  return {
    identityEvidenceHash: testHash(`production-identity-evidence-${label}`),
    identityKind,
    ownerDomain: ownerDomain(role),
    principalIdHash: testHash(`production-principal-${label}`),
    role,
  };
}

function ownerDomain(
  role: ProductionProvisioningIdentity['role'],
): ProductionProvisioningIdentity['ownerDomain'] {
  if (role === 'readiness_attestor') {
    return 'technical_owner';
  }
  if (
    role === 'candidate_submitter' ||
    role === 'provider_operator' ||
    role === 'retention_worker' ||
    role === 'sampling_worker'
  ) {
    return 'platform_operations';
  }
  return 'product_owner';
}
