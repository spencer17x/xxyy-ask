import { z } from 'zod';

import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';

export const EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION = '0.1.0' as const;

const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);

export const chainAnalysisGovernanceRoles = [
  'candidate_submitter',
  'governance_publisher',
  'independent_reviewer',
  'provider_operator',
  'readiness_attestor',
  'retention_worker',
  'sampling_planner',
  'sampling_worker',
] as const;

export const chainAnalysisControlAuditStreams = ['governance', 'provider_control'] as const;

export const chainAnalysisControlAuditEventKinds = [
  'authorization_recorded',
  'authorization_revoked',
  'budget_policy_installed',
  'budget_reserved',
  'budget_settled',
  'candidate_recorded',
  'circuit_initialized',
  'circuit_transition',
  'corpus_export_recorded',
  'corpus_evaluation_recorded',
  'governance_decision_recorded',
  'operations_evidence_recorded',
  'promotion_recorded',
  'production_provisioning_recorded',
  'provider_request_recorded',
  'readiness_attested',
  'readiness_policy_recorded',
  'retention_completed',
  'retention_job_claimed',
  'review_recorded',
  'review_job_claimed',
  'review_job_completed',
  'review_job_failed',
  'sampling_approval_recorded',
  'sampling_candidate_handoff_recorded',
  'sampling_job_claimed',
  'sampling_job_completed',
  'sampling_job_failed',
  'sampling_job_retried',
  'sampling_manifest_recorded',
  'sampling_plan_recorded',
  'sampling_policy_recorded',
  'sampling_run_recorded',
  'tombstone_recorded',
] as const;

export const governanceAuthorizationInputSchema = z
  .object({
    grantedAt: z.string().datetime({ offset: true }),
    grantedByHash: fingerprintSchema,
    principalIdHash: fingerprintSchema,
    roles: z
      .array(z.enum(chainAnalysisGovernanceRoles))
      .min(1)
      .max(chainAnalysisGovernanceRoles.length),
    validUntil: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((grant, context) => {
    if (
      new Set(grant.roles).size !== grant.roles.length ||
      [...grant.roles].sort().some((role, index) => role !== grant.roles[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Authorization roles must be unique and canonically sorted.',
        path: ['roles'],
      });
    }
    if (
      grant.validUntil !== undefined &&
      Date.parse(grant.validUntil) <= Date.parse(grant.grantedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Authorization validity must extend beyond grant time.',
        path: ['validUntil'],
      });
    }
  });

export const governanceAuthorizationSchema = z
  .object({
    ...governanceAuthorizationInputSchema.shape,
    authorizationFingerprint: fingerprintSchema,
    authorizationId: z.string().regex(/^authorization_[0-9a-f]{64}$/u),
    version: z.literal(EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION),
  })
  .strict()
  .superRefine((grant, context) => {
    const input = {
      grantedAt: grant.grantedAt,
      grantedByHash: grant.grantedByHash,
      principalIdHash: grant.principalIdHash,
      roles: grant.roles,
      ...(grant.validUntil === undefined ? {} : { validUntil: grant.validUntil }),
    };
    const parsedInput = governanceAuthorizationInputSchema.safeParse(input);
    if (!parsedInput.success) {
      for (const issue of parsedInput.error.issues) {
        context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
      }
    }
    if (grant.authorizationId !== `authorization_${grant.authorizationFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Authorization id must be content-addressed.',
        path: ['authorizationId'],
      });
    }
    const { authorizationFingerprint, authorizationId: _authorizationId, ...body } = grant;
    if (authorizationFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Authorization fingerprint must cover the normalized record.',
        path: ['authorizationFingerprint'],
      });
    }
  });

export const governanceAuthorizationRevocationInputSchema = z
  .object({
    authorizationId: z.string().regex(/^authorization_[0-9a-f]{64}$/u),
    reasonCode: identifierSchema,
    revokedAt: z.string().datetime({ offset: true }),
    revokedByHash: fingerprintSchema,
  })
  .strict();

export const governanceAuthorizationRevocationSchema = z
  .object({
    ...governanceAuthorizationRevocationInputSchema.shape,
    revocationFingerprint: fingerprintSchema,
    revocationId: z.string().regex(/^revocation_[0-9a-f]{64}$/u),
    version: z.literal(EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION),
  })
  .strict()
  .superRefine((revocation, context) => {
    if (revocation.revocationId !== `revocation_${revocation.revocationFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Revocation id must be content-addressed.',
        path: ['revocationId'],
      });
    }
    const { revocationFingerprint, revocationId: _revocationId, ...body } = revocation;
    if (revocationFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Revocation fingerprint must cover the normalized record.',
        path: ['revocationFingerprint'],
      });
    }
  });

export const chainAnalysisControlAuditEventSchema = z
  .object({
    actorIdHash: fingerprintSchema,
    entityFingerprint: fingerprintSchema,
    entityId: identifierSchema,
    entityType: identifierSchema,
    eventAt: z.string().datetime({ offset: true }),
    eventFingerprint: fingerprintSchema,
    eventId: z.string().regex(/^control_audit_[0-9a-f]{64}$/u),
    eventKind: z.enum(chainAnalysisControlAuditEventKinds),
    payloadFingerprint: fingerprintSchema,
    previousEventFingerprint: fingerprintSchema.optional(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    stream: z.enum(chainAnalysisControlAuditStreams),
    version: z.literal(EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.sequence === 1 && event.previousEventFingerprint !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'The first audit event cannot reference a predecessor.',
        path: ['previousEventFingerprint'],
      });
    }
    if (event.sequence > 1 && event.previousEventFingerprint === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Every non-genesis audit event must reference its predecessor.',
        path: ['previousEventFingerprint'],
      });
    }
    if (event.eventId !== `control_audit_${event.eventFingerprint.slice(7)}`) {
      context.addIssue({
        code: 'custom',
        message: 'Audit event id must be content-addressed.',
        path: ['eventId'],
      });
    }
    const { eventFingerprint, eventId: _eventId, ...body } = event;
    if (eventFingerprint !== sha256Fingerprint(body)) {
      context.addIssue({
        code: 'custom',
        message: 'Audit event fingerprint must cover the complete chain link.',
        path: ['eventFingerprint'],
      });
    }
  });

export const retentionJobStatuses = ['completed', 'queued', 'running'] as const;
export const retentionJobOutcomes = ['expired_unpromoted', 'tombstoned'] as const;
export const samplingIntakeJobStatuses = ['failed', 'queued', 'running', 'succeeded'] as const;
export const reviewWorkJobStatuses = ['failed', 'queued', 'running', 'succeeded'] as const;
export const REQUIRED_REVIEW_WORK_SLOTS = 1;

export const retentionJobSchema = z
  .object({
    candidateId: identifierSchema,
    jobId: z.string().regex(/^retention_[0-9a-f]{64}$/u),
    retainUntil: z.string().datetime({ offset: true }),
    status: z.enum(retentionJobStatuses),
    attemptCount: z.number().int().nonnegative().max(1_000_000),
    completedAt: z.string().datetime({ offset: true }).optional(),
    leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
    outcome: z.enum(retentionJobOutcomes).optional(),
    workerIdHash: fingerprintSchema.optional(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.status === 'queued') {
      if (
        job.completedAt !== undefined ||
        job.leaseExpiresAt !== undefined ||
        job.outcome !== undefined ||
        job.workerIdHash !== undefined
      ) {
        context.addIssue({ code: 'custom', message: 'Queued jobs cannot carry lease or outcome.' });
      }
    } else if (job.status === 'running') {
      if (
        job.leaseExpiresAt === undefined ||
        job.workerIdHash === undefined ||
        job.completedAt !== undefined ||
        job.outcome !== undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Running jobs require an active worker lease.',
        });
      }
    } else if (
      job.completedAt === undefined ||
      job.outcome === undefined ||
      job.leaseExpiresAt !== undefined ||
      job.workerIdHash === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Completed jobs require worker, completion time, and outcome.',
      });
    }
  });

export const samplingIntakeJobSchema = z
  .object({
    attemptCount: z.number().int().nonnegative().max(1_000_000),
    completedAt: z.string().datetime({ offset: true }).optional(),
    expiresAt: z.string().datetime({ offset: true }),
    failedAt: z.string().datetime({ offset: true }).optional(),
    failureCodeHash: fingerprintSchema.optional(),
    jobId: z.string().regex(/^sampling_job_[0-9a-f]{64}$/u),
    leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
    manifestFingerprint: fingerprintSchema.optional(),
    manifestId: z
      .string()
      .regex(/^sample_manifest_[0-9a-f]{64}$/u)
      .optional(),
    maxAttempts: z.number().int().positive().max(100),
    notBefore: z.string().datetime({ offset: true }),
    planFingerprint: fingerprintSchema,
    planId: z.string().regex(/^sampling_plan_[0-9a-f]{64}$/u),
    slotId: z.string().regex(/^sampling_slot_[0-9a-f]{64}$/u),
    status: z.enum(samplingIntakeJobStatuses),
    stratumId: z.string().regex(/^sampling_stratum_[0-9a-f]{64}$/u),
    workerIdHash: fingerprintSchema.optional(),
  })
  .strict()
  .superRefine((job, context) => {
    if (Date.parse(job.expiresAt) <= Date.parse(job.notBefore)) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling job collection window must have a positive duration.',
        path: ['expiresAt'],
      });
    }
    if (job.attemptCount > job.maxAttempts) {
      context.addIssue({
        code: 'custom',
        message: 'Sampling job attempts cannot exceed the configured limit.',
        path: ['attemptCount'],
      });
    }
    if (job.status !== 'queued' && job.attemptCount === 0) {
      context.addIssue({
        code: 'custom',
        message: 'A claimed or completed sampling job must have at least one attempt.',
        path: ['attemptCount'],
      });
    }
    const hasCompletion = job.completedAt !== undefined;
    const hasFailure = job.failedAt !== undefined || job.failureCodeHash !== undefined;
    const hasManifest = job.manifestId !== undefined || job.manifestFingerprint !== undefined;
    if (job.status === 'queued') {
      if (
        job.workerIdHash !== undefined ||
        job.leaseExpiresAt !== undefined ||
        hasCompletion ||
        hasFailure ||
        hasManifest
      ) {
        context.addIssue({ code: 'custom', message: 'Queued sampling jobs cannot carry outcome.' });
      }
    } else if (job.status === 'running') {
      if (
        job.workerIdHash === undefined ||
        job.leaseExpiresAt === undefined ||
        hasCompletion ||
        hasFailure ||
        hasManifest
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Running sampling jobs require only an active worker lease.',
        });
      }
    } else if (job.status === 'succeeded') {
      if (
        job.workerIdHash === undefined ||
        !hasCompletion ||
        job.leaseExpiresAt !== undefined ||
        hasFailure ||
        job.manifestId === undefined ||
        job.manifestFingerprint === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Succeeded sampling jobs require worker, completion, and manifest evidence.',
        });
      }
    } else if (
      job.workerIdHash === undefined ||
      job.leaseExpiresAt !== undefined ||
      hasCompletion ||
      job.failedAt === undefined ||
      job.failureCodeHash === undefined ||
      hasManifest
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Failed sampling jobs require worker, failure time, and failure code hash.',
      });
    }
  });

export const reviewWorkJobSchema = z
  .object({
    attemptCount: z.number().int().nonnegative().max(1_000_000),
    candidateFingerprint: fingerprintSchema,
    candidateId: identifierSchema,
    completedAt: z.string().datetime({ offset: true }).optional(),
    expiresAt: z.string().datetime({ offset: true }),
    failedAt: z.string().datetime({ offset: true }).optional(),
    failureCodeHash: fingerprintSchema.optional(),
    jobId: z.string().regex(/^review_job_[0-9a-f]{64}$/u),
    leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
    maxAttempts: z.number().int().positive().max(100),
    notBefore: z.string().datetime({ offset: true }),
    reviewFingerprint: fingerprintSchema.optional(),
    reviewId: z
      .string()
      .regex(/^review_[0-9a-f]{64}$/u)
      .optional(),
    reviewerIdHash: fingerprintSchema.optional(),
    slotOrdinal: z.number().int().min(1).max(REQUIRED_REVIEW_WORK_SLOTS),
    status: z.enum(reviewWorkJobStatuses),
  })
  .strict()
  .superRefine((job, context) => {
    if (Date.parse(job.expiresAt) <= Date.parse(job.notBefore)) {
      context.addIssue({
        code: 'custom',
        message: 'Review work must have a positive candidate review window.',
        path: ['expiresAt'],
      });
    }
    if (job.attemptCount > job.maxAttempts) {
      context.addIssue({
        code: 'custom',
        message: 'Review work attempts cannot exceed the configured limit.',
        path: ['attemptCount'],
      });
    }
    if (
      job.leaseExpiresAt !== undefined &&
      (Date.parse(job.leaseExpiresAt) <= Date.parse(job.notBefore) ||
        Date.parse(job.leaseExpiresAt) > Date.parse(job.expiresAt))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Review work lease must end inside the candidate review window.',
        path: ['leaseExpiresAt'],
      });
    }
    for (const [path, timestamp] of [
      ['completedAt', job.completedAt],
      ['failedAt', job.failedAt],
    ] as const) {
      if (
        timestamp !== undefined &&
        (Date.parse(timestamp) < Date.parse(job.notBefore) ||
          Date.parse(timestamp) >= Date.parse(job.expiresAt))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Review work transition must occur inside the candidate review window.',
          path: [path],
        });
      }
    }
    if (job.status !== 'queued' && job.attemptCount === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Claimed review work must have at least one attempt.',
        path: ['attemptCount'],
      });
    }
    const hasCompletion = job.completedAt !== undefined;
    const hasFailure = job.failedAt !== undefined || job.failureCodeHash !== undefined;
    const hasReview = job.reviewId !== undefined || job.reviewFingerprint !== undefined;
    if (job.status === 'queued') {
      if (
        job.reviewerIdHash !== undefined ||
        job.leaseExpiresAt !== undefined ||
        hasCompletion ||
        hasFailure ||
        hasReview
      ) {
        context.addIssue({ code: 'custom', message: 'Queued review work cannot carry outcome.' });
      }
    } else if (job.status === 'running') {
      if (
        job.reviewerIdHash === undefined ||
        job.leaseExpiresAt === undefined ||
        hasCompletion ||
        hasFailure ||
        hasReview
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Running review work requires only an active reviewer lease.',
        });
      }
    } else if (job.status === 'succeeded') {
      if (
        job.reviewerIdHash === undefined ||
        !hasCompletion ||
        job.leaseExpiresAt !== undefined ||
        hasFailure ||
        job.reviewId === undefined ||
        job.reviewFingerprint === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Succeeded review work requires reviewer, completion, and review evidence.',
        });
      }
    } else if (
      job.reviewerIdHash === undefined ||
      job.leaseExpiresAt !== undefined ||
      hasCompletion ||
      job.failedAt === undefined ||
      job.failureCodeHash === undefined ||
      hasReview
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Failed review work requires reviewer, failure time, and failure evidence.',
      });
    }
    const expectedJobId = reviewWorkJobId({
      candidateFingerprint: job.candidateFingerprint,
      candidateId: job.candidateId,
      slotOrdinal: job.slotOrdinal,
    });
    if (job.jobId !== expectedJobId) {
      context.addIssue({
        code: 'custom',
        message: 'Review work id must be derived from candidate revision and slot ordinal.',
        path: ['jobId'],
      });
    }
    if (
      job.reviewFingerprint !== undefined &&
      job.reviewId !== `review_${job.reviewFingerprint.slice(7)}`
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Completed review id must match its review fingerprint.',
        path: ['reviewId'],
      });
    }
  });

export const chainAnalysisControlStoreErrorCodes = [
  'already_exists',
  'authorization_missing',
  'authorization_revoked',
  'budget_concurrency_exhausted',
  'budget_exhausted',
  'budget_policy_conflict',
  'budget_policy_missing',
  'candidate_not_found',
  'circuit_not_found',
  'corpus_export_not_found',
  'corpus_report_not_found',
  'database_unavailable',
  'immutable_conflict',
  'invalid_actor',
  'invalid_audit_chain',
  'invalid_state',
  'lease_already_settled',
  'lease_not_found',
  'operations_evidence_not_found',
  'provisioning_conflict',
  'provisioning_time_invalid',
  'provisioning_verification_failed',
  'readiness_policy_not_found',
  'retention_job_not_found',
  'review_job_not_found',
  'review_lease_required',
  'reviewer_conflict',
  'sample_duplicate',
  'sampling_approval_not_found',
  'sampling_job_not_found',
  'sampling_manifest_not_found',
  'sampling_plan_not_found',
  'sampling_policy_not_found',
  'stale_generation',
] as const;

export type ChainAnalysisGovernanceRole = (typeof chainAnalysisGovernanceRoles)[number];
export type ChainAnalysisControlAuditStream = (typeof chainAnalysisControlAuditStreams)[number];
export type ChainAnalysisControlAuditEventKind =
  (typeof chainAnalysisControlAuditEventKinds)[number];
export type GovernanceAuthorizationInput = z.input<typeof governanceAuthorizationInputSchema>;
export type GovernanceAuthorization = z.output<typeof governanceAuthorizationSchema>;
export type GovernanceAuthorizationRevocationInput = z.input<
  typeof governanceAuthorizationRevocationInputSchema
>;
export type GovernanceAuthorizationRevocation = z.output<
  typeof governanceAuthorizationRevocationSchema
>;
export type ChainAnalysisControlAuditEvent = z.output<typeof chainAnalysisControlAuditEventSchema>;
export type RetentionJob = z.output<typeof retentionJobSchema>;
export type SamplingIntakeJob = z.output<typeof samplingIntakeJobSchema>;
export type ReviewWorkJob = z.output<typeof reviewWorkJobSchema>;
export type ChainAnalysisControlStoreErrorCode =
  (typeof chainAnalysisControlStoreErrorCodes)[number];

export class ChainAnalysisControlStoreError extends Error {
  readonly code: ChainAnalysisControlStoreErrorCode;

  constructor(code: ChainAnalysisControlStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChainAnalysisControlStoreError';
    this.code = code;
  }
}

export function reviewWorkJobId(input: {
  candidateFingerprint: string;
  candidateId: string;
  slotOrdinal: number;
}): string {
  return `review_job_${sha256Fingerprint(input).slice(7)}`;
}

export function createGovernanceAuthorization(
  input: GovernanceAuthorizationInput,
): GovernanceAuthorization {
  const parsed = governanceAuthorizationInputSchema.parse({
    ...input,
    roles: [...input.roles].sort(),
  });
  const body = {
    ...parsed,
    version: EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  };
  const authorizationFingerprint = sha256Fingerprint(body);
  return governanceAuthorizationSchema.parse({
    ...body,
    authorizationFingerprint,
    authorizationId: `authorization_${authorizationFingerprint.slice(7)}`,
  });
}

export function createGovernanceAuthorizationRevocation(
  input: GovernanceAuthorizationRevocationInput,
): GovernanceAuthorizationRevocation {
  const parsed = governanceAuthorizationRevocationInputSchema.parse(input);
  const body = {
    ...parsed,
    version: EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  };
  const revocationFingerprint = sha256Fingerprint(body);
  return governanceAuthorizationRevocationSchema.parse({
    ...body,
    revocationFingerprint,
    revocationId: `revocation_${revocationFingerprint.slice(7)}`,
  });
}

export function createChainAnalysisControlAuditEvent(input: {
  actorIdHash: string;
  entityFingerprint: string;
  entityId: string;
  entityType: string;
  eventAt: string;
  eventKind: ChainAnalysisControlAuditEventKind;
  payloadFingerprint: string;
  previousEventFingerprint?: string;
  sequence: number;
  stream: ChainAnalysisControlAuditStream;
}): ChainAnalysisControlAuditEvent {
  const body = {
    ...input,
    version: EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  };
  const eventFingerprint = sha256Fingerprint(body);
  return chainAnalysisControlAuditEventSchema.parse({
    ...body,
    eventFingerprint,
    eventId: `control_audit_${eventFingerprint.slice(7)}`,
  });
}

export function verifyChainAnalysisControlAuditEvents(
  input: readonly unknown[],
): ChainAnalysisControlAuditEvent[] {
  const events = input.map((event) => chainAnalysisControlAuditEventSchema.parse(event));
  for (const [index, event] of events.entries()) {
    const expectedSequence = index + 1;
    const previous = events[index - 1];
    if (
      event.sequence !== expectedSequence ||
      event.previousEventFingerprint !== previous?.eventFingerprint ||
      (previous !== undefined && event.stream !== previous.stream)
    ) {
      throw new ChainAnalysisControlStoreError(
        'invalid_audit_chain',
        `Audit chain diverged at sequence ${event.sequence}.`,
      );
    }
  }
  return events;
}
