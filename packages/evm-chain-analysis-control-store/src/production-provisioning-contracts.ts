import { z } from 'zod';

import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import { mainnetSamplingSourceApprovalSchema } from '@xxyy/evm-chain-analysis-readiness';

import {
  EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  chainAnalysisGovernanceRoles,
  createGovernanceAuthorization,
  governanceAuthorizationSchema,
  type ChainAnalysisGovernanceRole,
  type GovernanceAuthorization,
} from './contracts.js';

const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u);
const productionMarkerPattern =
  /(?:^|[-_.:])(?:contract[-_.]?only|demo|example|fake|fixture|placeholder|test)(?=$|[-_.:])/iu;

export const productionIdentityKinds = [
  'controlled_human_account',
  'platform_service_account',
] as const;

export const productionOwnerDomains = [
  'platform_operations',
  'product_owner',
  'technical_owner',
] as const;

export const productionOwnerBaseline = {
  governanceOwner: 'product_owner',
  legalAndRetentionOwner: 'product_owner',
  providerOperationsOwner: 'platform_operations',
  readinessPolicyOwner: 'technical_owner',
} as const;

const serviceAccountRoles = new Set<ChainAnalysisGovernanceRole>([
  'candidate_submitter',
  'provider_operator',
  'retention_worker',
  'sampling_worker',
]);
const controlledHumanRoles = new Set<ChainAnalysisGovernanceRole>([
  'governance_publisher',
  'independent_reviewer',
  'readiness_attestor',
  'sampling_planner',
]);
const ownerDomainByRole = {
  candidate_submitter: 'platform_operations',
  governance_publisher: 'product_owner',
  independent_reviewer: 'product_owner',
  provider_operator: 'platform_operations',
  readiness_attestor: 'technical_owner',
  retention_worker: 'platform_operations',
  sampling_planner: 'product_owner',
  sampling_worker: 'platform_operations',
} as const satisfies Record<ChainAnalysisGovernanceRole, ProductionOwnerDomain>;

const productionProvisioningIdentityShape = {
  identityEvidenceHash: fingerprintSchema,
  identityKind: z.enum(productionIdentityKinds),
  ownerDomain: z.enum(productionOwnerDomains),
  principalIdHash: fingerprintSchema,
  role: z.enum(chainAnalysisGovernanceRoles),
} as const;

export const productionProvisioningIdentitySchema = z
  .object(productionProvisioningIdentityShape)
  .strict();

const productionProvisioningPlanInputShape = {
  approval: mainnetSamplingSourceApprovalSchema,
  authorizationValidUntil: z.string().datetime({ offset: true }),
  identities: z.array(productionProvisioningIdentitySchema).length(9),
  provisionedAt: z.string().datetime({ offset: true }),
  provisionedByHash: fingerprintSchema,
} as const;

export const productionProvisioningPlanInputSchema = z
  .object(productionProvisioningPlanInputShape)
  .strict()
  .superRefine(validateProductionProvisioningPlanInput);

const productionProvisioningPlanCoreShape = {
  ...productionProvisioningPlanInputShape,
  authorizations: z.array(governanceAuthorizationSchema).length(9),
  ownerBaseline: z
    .object({
      governanceOwner: z.literal('product_owner'),
      legalAndRetentionOwner: z.literal('product_owner'),
      providerOperationsOwner: z.literal('platform_operations'),
      readinessPolicyOwner: z.literal('technical_owner'),
    })
    .strict(),
  protocols: z.tuple([z.literal('uniswap_v2'), z.literal('uniswap_v3')]),
  retentionDays: z.literal(90),
  sourceKinds: z.tuple([z.literal('official_explorer_export'), z.literal('public_rpc')]),
  targetChainIds: z.tuple([z.literal('1')]),
  version: z.literal(EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION),
} as const;

export const productionProvisioningPlanSchema = z
  .object({
    ...productionProvisioningPlanCoreShape,
    planFingerprint: fingerprintSchema,
    planId: z.string().regex(/^production_provisioning_plan_[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((plan, context) => {
    const inputResult = productionProvisioningPlanInputSchema.safeParse({
      approval: plan.approval,
      authorizationValidUntil: plan.authorizationValidUntil,
      identities: plan.identities,
      provisionedAt: plan.provisionedAt,
      provisionedByHash: plan.provisionedByHash,
    });
    addNestedIssues(inputResult, context);
    if (!isIdentityOrderCanonical(plan.identities)) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning identities must use canonical role and principal order.',
        path: ['identities'],
      });
    }
    const expectedAuthorizations = materializeAuthorizations({
      authorizationValidUntil: plan.authorizationValidUntil,
      identities: plan.identities,
      provisionedAt: plan.provisionedAt,
      provisionedByHash: plan.provisionedByHash,
    });
    if (
      plan.authorizations.length !== expectedAuthorizations.length ||
      plan.authorizations.some(
        (authorization, index) =>
          authorization.authorizationFingerprint !==
          expectedAuthorizations[index]?.authorizationFingerprint,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning authorizations must be derived from the canonical identity plan.',
        path: ['authorizations'],
      });
    }
    if (plan.planId !== `production_provisioning_plan_${plan.planFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning plan id must be content-addressed.',
        path: ['planId'],
      });
    }
    const { planFingerprint, planId: _planId, ...fingerprintPayload } = plan;
    if (planFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning plan fingerprint must cover the normalized record.',
        path: ['planFingerprint'],
      });
    }
  });

const productionProvisioningVerificationClaimCoreShape = {
  authoritySystemId: stableIdSchema.refine(
    (value) => !productionMarkerPattern.test(value),
    'Production authority system id cannot use fixture or placeholder markers.',
  ),
  planFingerprint: fingerprintSchema,
  verificationEvidenceHash: fingerprintSchema,
  verifiedAt: z.string().datetime({ offset: true }),
  verifiedByHash: fingerprintSchema,
  version: z.literal(EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION),
} as const;

export const productionProvisioningVerificationClaimInputSchema = z
  .object({
    authoritySystemId: productionProvisioningVerificationClaimCoreShape.authoritySystemId,
    planFingerprint: fingerprintSchema,
    verificationEvidenceHash: fingerprintSchema,
    verifiedAt: z.string().datetime({ offset: true }),
    verifiedByHash: fingerprintSchema,
  })
  .strict();

export const productionProvisioningVerificationClaimSchema = z
  .object({
    ...productionProvisioningVerificationClaimCoreShape,
    verificationFingerprint: fingerprintSchema,
    verificationId: z.string().regex(/^production_provisioning_verification_[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((verification, context) => {
    if (
      verification.verificationId !==
      `production_provisioning_verification_${verification.verificationFingerprint.slice(7)}`
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning verification id must be content-addressed.',
        path: ['verificationId'],
      });
    }
    const {
      verificationFingerprint,
      verificationId: _verificationId,
      ...fingerprintPayload
    } = verification;
    if (verificationFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning verification fingerprint must cover the normalized claim.',
        path: ['verificationFingerprint'],
      });
    }
  });

export const productionProvisioningApplicationSchema = z
  .object({
    plan: productionProvisioningPlanSchema,
    verification: productionProvisioningVerificationClaimSchema,
  })
  .strict()
  .superRefine((application, context) => {
    const { plan, verification } = application;
    if (verification.planFingerprint !== plan.planFingerprint) {
      context.addIssue({
        code: 'custom',
        message: 'External verification must bind the exact provisioning plan.',
        path: ['verification', 'planFingerprint'],
      });
    }
    if (!plan.approval.approvedByHashes.includes(verification.verifiedByHash)) {
      context.addIssue({
        code: 'custom',
        message: 'External verifier must be one of the independently recorded approvers.',
        path: ['verification', 'verifiedByHash'],
      });
    }
    if (verification.verifiedByHash === plan.provisionedByHash) {
      context.addIssue({
        code: 'custom',
        message: 'Plan application and external verification require two distinct identities.',
        path: ['verification', 'verifiedByHash'],
      });
    }
    if (
      Date.parse(verification.verifiedAt) < Date.parse(plan.approval.approvedAt) ||
      Date.parse(verification.verifiedAt) > Date.parse(plan.provisionedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'External verification must follow approval and precede plan application.',
        path: ['verification', 'verifiedAt'],
      });
    }
    const existingEvidence = new Set([
      plan.approval.legalReviewEvidenceHash,
      plan.approval.retentionReviewEvidenceHash,
      ...plan.approval.sourceApprovalEvidenceHashes,
      ...plan.identities.map((identity) => identity.identityEvidenceHash),
      ...plan.approval.approvedByHashes,
      ...plan.identities.map((identity) => identity.principalIdHash),
    ]);
    if (existingEvidence.has(verification.verificationEvidenceHash)) {
      context.addIssue({
        code: 'custom',
        message:
          'External verification evidence must be independent from source and identity evidence.',
        path: ['verification', 'verificationEvidenceHash'],
      });
    }
  });

export const productionProvisioningReceiptSchema = z
  .object({
    appliedAt: z.string().datetime({ offset: true }),
    approvalFingerprint: fingerprintSchema,
    authorizationFingerprints: z.array(fingerprintSchema).length(9),
    authorizationIds: z.array(z.string().regex(/^authorization_[0-9a-f]{64}$/u)).length(9),
    identityEvidenceHashes: z.array(fingerprintSchema).length(9),
    plan: productionProvisioningPlanSchema,
    receiptFingerprint: fingerprintSchema,
    receiptId: z.string().regex(/^production_provisioning_receipt_[0-9a-f]{64}$/u),
    status: z.literal('applied'),
    verification: productionProvisioningVerificationClaimSchema,
    version: z.literal(EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION),
  })
  .strict()
  .superRefine((receipt, context) => {
    const applicationResult = productionProvisioningApplicationSchema.safeParse({
      plan: receipt.plan,
      verification: receipt.verification,
    });
    addNestedIssues(applicationResult, context);
    if (receipt.appliedAt !== receipt.plan.provisionedAt) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning receipt application time must match the approved plan.',
        path: ['appliedAt'],
      });
    }
    if (receipt.approvalFingerprint !== receipt.plan.approval.approvalFingerprint) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning receipt must retain exact source approval lineage.',
        path: ['approvalFingerprint'],
      });
    }
    const authorizations = receipt.plan.authorizations;
    if (
      !sameOrderedValues(
        receipt.authorizationFingerprints,
        authorizations.map((authorization) => authorization.authorizationFingerprint),
      ) ||
      !sameOrderedValues(
        receipt.authorizationIds,
        authorizations.map((authorization) => authorization.authorizationId),
      ) ||
      !sameOrderedValues(
        receipt.identityEvidenceHashes,
        receipt.plan.identities.map((identity) => identity.identityEvidenceHash),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning receipt must retain exact authorization and identity lineage.',
        path: ['authorizationFingerprints'],
      });
    }
    if (
      receipt.receiptId !== `production_provisioning_receipt_${receipt.receiptFingerprint.slice(7)}`
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning receipt id must be content-addressed.',
        path: ['receiptId'],
      });
    }
    const { receiptFingerprint, receiptId: _receiptId, ...fingerprintPayload } = receipt;
    if (receiptFingerprint !== sha256Fingerprint(fingerprintPayload)) {
      context.addIssue({
        code: 'custom',
        message: 'Provisioning receipt fingerprint must cover the complete applied lineage.',
        path: ['receiptFingerprint'],
      });
    }
  });

export type ProductionIdentityKind = (typeof productionIdentityKinds)[number];
export type ProductionOwnerDomain = (typeof productionOwnerDomains)[number];
export type ProductionProvisioningIdentity = z.output<typeof productionProvisioningIdentitySchema>;
export type ProductionProvisioningPlanInput = z.input<typeof productionProvisioningPlanInputSchema>;
export type ProductionProvisioningPlan = z.output<typeof productionProvisioningPlanSchema>;
export type ProductionProvisioningVerificationClaimInput = z.input<
  typeof productionProvisioningVerificationClaimInputSchema
>;
export type ProductionProvisioningVerificationClaim = z.output<
  typeof productionProvisioningVerificationClaimSchema
>;
export type ProductionProvisioningApplication = z.output<
  typeof productionProvisioningApplicationSchema
>;
export type ProductionProvisioningReceipt = z.output<typeof productionProvisioningReceiptSchema>;

export function createProductionProvisioningPlan(
  input: ProductionProvisioningPlanInput,
): ProductionProvisioningPlan {
  const parsed = productionProvisioningPlanInputSchema.parse(input);
  const identities = [...parsed.identities].sort(compareIdentities);
  const body = {
    ...parsed,
    authorizations: materializeAuthorizations({
      authorizationValidUntil: parsed.authorizationValidUntil,
      identities,
      provisionedAt: parsed.provisionedAt,
      provisionedByHash: parsed.provisionedByHash,
    }),
    identities,
    ownerBaseline: { ...productionOwnerBaseline },
    protocols: ['uniswap_v2', 'uniswap_v3'] as const,
    retentionDays: 90 as const,
    sourceKinds: ['official_explorer_export', 'public_rpc'] as const,
    targetChainIds: ['1'] as const,
    version: EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  };
  const planFingerprint = sha256Fingerprint(body);
  return productionProvisioningPlanSchema.parse({
    ...body,
    planFingerprint,
    planId: `production_provisioning_plan_${planFingerprint.slice(7)}`,
  });
}

export function createProductionProvisioningVerificationClaim(
  input: ProductionProvisioningVerificationClaimInput,
): ProductionProvisioningVerificationClaim {
  const parsed = productionProvisioningVerificationClaimInputSchema.parse(input);
  const body = {
    ...parsed,
    version: EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  };
  const verificationFingerprint = sha256Fingerprint(body);
  return productionProvisioningVerificationClaimSchema.parse({
    ...body,
    verificationFingerprint,
    verificationId: `production_provisioning_verification_${verificationFingerprint.slice(7)}`,
  });
}

export function materializeProductionProvisioningReceipt(
  input: ProductionProvisioningApplication,
): ProductionProvisioningReceipt {
  const { plan, verification } = productionProvisioningApplicationSchema.parse(input);
  const body = {
    appliedAt: plan.provisionedAt,
    approvalFingerprint: plan.approval.approvalFingerprint,
    authorizationFingerprints: plan.authorizations.map(
      (authorization) => authorization.authorizationFingerprint,
    ),
    authorizationIds: plan.authorizations.map((authorization) => authorization.authorizationId),
    identityEvidenceHashes: plan.identities.map((identity) => identity.identityEvidenceHash),
    plan,
    status: 'applied' as const,
    verification,
    version: EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  };
  const receiptFingerprint = sha256Fingerprint(body);
  return productionProvisioningReceiptSchema.parse({
    ...body,
    receiptFingerprint,
    receiptId: `production_provisioning_receipt_${receiptFingerprint.slice(7)}`,
  });
}

function validateProductionProvisioningPlanInput(
  input: z.output<z.ZodObject<typeof productionProvisioningPlanInputShape>>,
  context: z.RefinementCtx,
): void {
  const approval = input.approval;
  if (
    !sameOrderedValues(approval.sourceKinds, ['official_explorer_export', 'public_rpc']) ||
    approval.retentionDays !== 90 ||
    approval.publicChainDataOnly !== true ||
    approval.credentialsAllowed !== false ||
    approval.privateDataAllowed !== false
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Production provisioning must preserve the confirmed public-source 90-day baseline.',
      path: ['approval'],
    });
  }
  for (const [field, value] of [
    ['approvalName', approval.approvalName],
    ['retentionPolicyId', approval.retentionPolicyId],
  ] as const) {
    if (productionMarkerPattern.test(value)) {
      context.addIssue({
        code: 'custom',
        message: `${field} cannot use fixture or placeholder markers.`,
        path: ['approval', field],
      });
    }
  }
  if (
    Date.parse(input.provisionedAt) < Date.parse(approval.validFrom) ||
    Date.parse(input.provisionedAt) >= Date.parse(approval.validUntil)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Provisioning must occur inside the approved source and retention window.',
      path: ['provisionedAt'],
    });
  }
  if (
    Date.parse(input.authorizationValidUntil) <= Date.parse(input.provisionedAt) ||
    Date.parse(input.authorizationValidUntil) > Date.parse(approval.validUntil)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Authorization validity must be positive and cannot outlive source approval.',
      path: ['authorizationValidUntil'],
    });
  }
  if (!approval.approvedByHashes.includes(input.provisionedByHash)) {
    context.addIssue({
      code: 'custom',
      message: 'Provisioning actor must be one of the independently recorded approvers.',
      path: ['provisionedByHash'],
    });
  }
  const principalHashes = input.identities.map((identity) => identity.principalIdHash);
  const identityEvidenceHashes = input.identities.map((identity) => identity.identityEvidenceHash);
  if (new Set(principalHashes).size !== principalHashes.length) {
    context.addIssue({
      code: 'custom',
      message: 'Every production role requires a distinct principal.',
      path: ['identities'],
    });
  }
  const evidenceHashes = [
    approval.legalReviewEvidenceHash,
    approval.retentionReviewEvidenceHash,
    ...approval.sourceApprovalEvidenceHashes,
    ...identityEvidenceHashes,
  ];
  if (new Set(evidenceHashes).size !== evidenceHashes.length) {
    context.addIssue({
      code: 'custom',
      message: 'Every approval and identity evidence artifact requires a distinct fingerprint.',
      path: ['identities'],
    });
  }
  const identityHashes = new Set([...approval.approvedByHashes, ...principalHashes]);
  if (evidenceHashes.some((evidenceHash) => identityHashes.has(evidenceHash))) {
    context.addIssue({
      code: 'custom',
      message: 'Principal and evidence fingerprints must identify separate records.',
      path: ['identities'],
    });
  }
  if (approval.approvedByHashes.some((approverHash) => principalHashes.includes(approverHash))) {
    context.addIssue({
      code: 'custom',
      message: 'Out-of-band approval identities cannot receive runtime roles in the same plan.',
      path: ['identities'],
    });
  }
  for (const role of chainAnalysisGovernanceRoles) {
    const expected = role === 'independent_reviewer' ? 2 : 1;
    const matches = input.identities.filter((identity) => identity.role === role);
    if (matches.length !== expected) {
      context.addIssue({
        code: 'custom',
        message: `Production provisioning requires exactly ${expected} principal(s) for ${role}.`,
        path: ['identities'],
      });
    }
  }
  for (const [index, identity] of input.identities.entries()) {
    if (
      (serviceAccountRoles.has(identity.role) &&
        identity.identityKind !== 'platform_service_account') ||
      (controlledHumanRoles.has(identity.role) &&
        identity.identityKind !== 'controlled_human_account')
    ) {
      context.addIssue({
        code: 'custom',
        message: `Identity kind does not match the least-privilege ${identity.role} assignment.`,
        path: ['identities', index, 'identityKind'],
      });
    }
    if (identity.ownerDomain !== ownerDomainByRole[identity.role]) {
      context.addIssue({
        code: 'custom',
        message: `Owner domain does not match the confirmed ${identity.role} responsibility.`,
        path: ['identities', index, 'ownerDomain'],
      });
    }
  }
}

function materializeAuthorizations(input: {
  authorizationValidUntil: string;
  identities: readonly ProductionProvisioningIdentity[];
  provisionedAt: string;
  provisionedByHash: string;
}): GovernanceAuthorization[] {
  return input.identities.map((identity) =>
    createGovernanceAuthorization({
      grantedAt: input.provisionedAt,
      grantedByHash: input.provisionedByHash,
      principalIdHash: identity.principalIdHash,
      roles: [identity.role],
      validUntil: input.authorizationValidUntil,
    }),
  );
}

function compareIdentities(
  left: ProductionProvisioningIdentity,
  right: ProductionProvisioningIdentity,
): number {
  return (
    left.role.localeCompare(right.role) || left.principalIdHash.localeCompare(right.principalIdHash)
  );
}

function isIdentityOrderCanonical(identities: readonly ProductionProvisioningIdentity[]): boolean {
  return identities.every(
    (identity, index) => index === 0 || compareIdentities(identities[index - 1]!, identity) <= 0,
  );
}

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function addNestedIssues(result: z.ZodSafeParseResult<unknown>, context: z.RefinementCtx): void {
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
    }
  }
}
