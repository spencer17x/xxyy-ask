import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import {
  createPublicChainSampleManifest,
  createMainnetSamplingPolicy,
  evaluateMainnetSamplingCoverage,
  mainnetSamplingCoverageResultSchema,
  mainnetSamplingPlanSchema,
  mainnetSamplingPolicySchema,
  mainnetSamplingSourceApprovalSchema,
  materializeMainnetSamplingPlan,
  publicChainSampleManifestSchema,
  type MainnetSamplingCoverageResult,
  type MainnetSamplingPlan,
  type MainnetSamplingPolicy,
  type MainnetSamplingSourceApproval,
  type PublicChainSampleManifest,
} from '@xxyy/evm-chain-analysis-readiness';

import {
  ChainAnalysisControlStoreError,
  EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  samplingIntakeJobSchema,
  type SamplingIntakeJob,
} from './contracts.js';
import {
  appendControlAuditEvent,
  assertGovernanceAuthorization,
  assertSameFingerprint,
} from './control-store-internals.js';
import { migrateEvmChainAnalysisControlStore } from './migrations.js';
import {
  acquireControlLock,
  parseSafeInteger,
  queryControlDatabase,
  withControlTransaction,
  type PgControlClientLike,
} from './postgres.js';

const ISO_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const DEFAULT_SAMPLING_MAX_ATTEMPTS = 3;

interface PayloadRow {
  payload: unknown;
}

interface SamplingJobRow {
  attempt_count: number | string;
  completed_at: string | null;
  expires_at: string;
  failed_at: string | null;
  failure_code_hash: string | null;
  job_id: string;
  lease_expires_at: string | null;
  manifest_fingerprint: string | null;
  manifest_id: string | null;
  max_attempts: number | string;
  not_before: string;
  plan_fingerprint: string;
  plan_id: string;
  slot_id: string;
  status: 'failed' | 'queued' | 'running' | 'succeeded';
  stratum_id: string;
  worker_id_hash: string | null;
}

export interface SamplingIntakeCompletion {
  job: SamplingIntakeJob;
  manifest: PublicChainSampleManifest;
}

export interface PgEvmChainAnalysisSamplingStore {
  claimIntakeJob(input: {
    asOf: string;
    leaseSeconds?: number;
    workerIdHash: string;
  }): Promise<SamplingIntakeJob | undefined>;
  completeIntakeJob(input: {
    completedAt: string;
    jobId: string;
    manifest: unknown;
    workerIdHash: string;
  }): Promise<SamplingIntakeCompletion>;
  failIntakeJob(input: {
    failedAt: string;
    failureCodeHash: string;
    jobId: string;
    workerIdHash: string;
  }): Promise<SamplingIntakeJob>;
  getIntakeJob(jobId: string): Promise<SamplingIntakeJob | undefined>;
  getPlan(planId: string): Promise<MainnetSamplingPlan | undefined>;
  listManifests(planId: string): Promise<PublicChainSampleManifest[]>;
  migrate(): Promise<void>;
  recordCoverageRun(input: {
    actorIdHash: string;
    evaluatedAt: string;
    planId: string;
  }): Promise<MainnetSamplingCoverageResult>;
  recordPlan(input: { actorIdHash: string; plan: unknown }): Promise<MainnetSamplingPlan>;
  recordPolicy(input: { actorIdHash: string; policy: unknown }): Promise<MainnetSamplingPolicy>;
  recordSourceApproval(input: {
    actorIdHash: string;
    approval: unknown;
  }): Promise<MainnetSamplingSourceApproval>;
  retryIntakeJob(input: {
    actorIdHash: string;
    jobId: string;
    retriedAt: string;
  }): Promise<SamplingIntakeJob>;
}

export function createPgEvmChainAnalysisSamplingStore(options: {
  client: PgControlClientLike;
}): PgEvmChainAnalysisSamplingStore {
  const { client } = options;
  return {
    async claimIntakeJob(input): Promise<SamplingIntakeJob | undefined> {
      const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.asOf,
          principalIdHash: input.workerIdHash,
          role: 'sampling_worker',
        });
        const response = await queryControlDatabase<SamplingJobRow>(
          transaction,
          `
            /* control:sampling-job-claim */
            with selected as (
              select job_id
              from evm_chain_control_sampling_jobs
              where
                not_before <= $1::timestamptz
                and expires_at >= $1::timestamptz
                and attempt_count < max_attempts
                and (
                  status = 'queued'
                  or (status = 'running' and lease_expires_at <= $1::timestamptz)
                )
              order by not_before, expires_at, job_id
              for update skip locked
              limit 1
            )
            update evm_chain_control_sampling_jobs job
            set
              status = 'running',
              attempt_count = job.attempt_count + 1,
              worker_id_hash = $2,
              lease_expires_at = least(
                job.expires_at,
                $1::timestamptz + make_interval(secs => $3)
              ),
              completed_at = null,
              failed_at = null,
              failure_code_hash = null,
              manifest_id = null,
              manifest_fingerprint = null
            from selected
            where job.job_id = selected.job_id
            returning ${samplingJobColumns('job')}
          `,
          [input.asOf, input.workerIdHash, leaseSeconds],
        );
        const row = response.rows[0];
        if (row === undefined) {
          return undefined;
        }
        const job = mapSamplingJob(row);
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.workerIdHash,
          entityFingerprint: sha256Fingerprint(job),
          entityId: job.jobId,
          entityType: 'sampling_intake_job',
          eventAt: input.asOf,
          eventKind: 'sampling_job_claimed',
          payload: {
            attemptCount: job.attemptCount,
            leaseExpiresAt: job.leaseExpiresAt,
            slotId: job.slotId,
          },
          stream: 'governance',
        });
        return job;
      });
    },

    async completeIntakeJob(input): Promise<SamplingIntakeCompletion> {
      const manifest = publicChainSampleManifestSchema.parse(input.manifest);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.completedAt,
          principalIdHash: input.workerIdHash,
          role: 'sampling_worker',
        });
        const current = await requireSamplingJob(transaction, input.jobId, true);
        if (current.status === 'succeeded') {
          if (
            current.manifestFingerprint !== manifest.manifestFingerprint ||
            current.manifestId !== manifest.manifestId
          ) {
            throw new ChainAnalysisControlStoreError(
              'immutable_conflict',
              'Sampling job already succeeded with a different immutable manifest.',
            );
          }
          return {
            job: current,
            manifest: await requireManifest(transaction, manifest.manifestId),
          };
        }
        assertActiveWorkerLease(current, input.workerIdHash, input.completedAt);
        const plan = await requirePlan(transaction, current.planId);
        validateManifestForJob(manifest, plan, current, input.completedAt);
        const duplicate = await readManifestBySlotOrIdentity(
          transaction,
          manifest.slotId,
          manifest.sampleIdentityFingerprint,
        );
        if (duplicate !== undefined) {
          if (duplicate.manifestFingerprint !== manifest.manifestFingerprint) {
            throw new ChainAnalysisControlStoreError(
              'sample_duplicate',
              'Sampling slot or chain/transaction identity already belongs to another manifest.',
            );
          }
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Manifest exists without the corresponding succeeded job transition.',
          );
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:sampling-manifest-insert */
            insert into evm_chain_control_sampling_manifests (
              manifest_id,
              manifest_fingerprint,
              plan_id,
              slot_id,
              sample_identity_fingerprint,
              collected_at,
              retain_until,
              payload
            ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::jsonb)
          `,
          [
            manifest.manifestId,
            manifest.manifestFingerprint,
            manifest.planId,
            manifest.slotId,
            manifest.sampleIdentityFingerprint,
            manifest.collectedAt,
            manifest.retainUntil,
            JSON.stringify(manifest),
          ],
        );
        const updated = await queryControlDatabase<SamplingJobRow>(
          transaction,
          `
            /* control:sampling-job-complete */
            update evm_chain_control_sampling_jobs
            set
              status = 'succeeded',
              lease_expires_at = null,
              completed_at = $2::timestamptz,
              manifest_id = $3,
              manifest_fingerprint = $4
            where
              job_id = $1
              and status = 'running'
              and worker_id_hash = $5
              and lease_expires_at >= $2::timestamptz
            returning ${samplingJobColumns()}
          `,
          [
            input.jobId,
            input.completedAt,
            manifest.manifestId,
            manifest.manifestFingerprint,
            input.workerIdHash,
          ],
        );
        const row = updated.rows[0];
        if (row === undefined) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Sampling job lost its generation-fenced worker lease.',
          );
        }
        const job = mapSamplingJob(row);
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.workerIdHash,
          entityFingerprint: manifest.manifestFingerprint,
          entityId: manifest.manifestId,
          entityType: 'public_chain_sample_manifest',
          eventAt: input.completedAt,
          eventKind: 'sampling_manifest_recorded',
          payload: {
            planId: manifest.planId,
            sampleIdentityFingerprint: manifest.sampleIdentityFingerprint,
            slotId: manifest.slotId,
          },
          stream: 'governance',
        });
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.workerIdHash,
          entityFingerprint: sha256Fingerprint(job),
          entityId: job.jobId,
          entityType: 'sampling_intake_job',
          eventAt: input.completedAt,
          eventKind: 'sampling_job_completed',
          payload: {
            manifestFingerprint: manifest.manifestFingerprint,
            manifestId: manifest.manifestId,
          },
          stream: 'governance',
        });
        return { job, manifest };
      });
    },

    async failIntakeJob(input): Promise<SamplingIntakeJob> {
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.failedAt,
          principalIdHash: input.workerIdHash,
          role: 'sampling_worker',
        });
        const current = await requireSamplingJob(transaction, input.jobId, true);
        if (current.status === 'failed') {
          if (
            current.workerIdHash === input.workerIdHash &&
            current.failedAt === input.failedAt &&
            current.failureCodeHash === input.failureCodeHash
          ) {
            return current;
          }
          throw new ChainAnalysisControlStoreError(
            'immutable_conflict',
            'Sampling job already carries a different failure outcome.',
          );
        }
        assertActiveWorkerLease(current, input.workerIdHash, input.failedAt);
        const updated = await queryControlDatabase<SamplingJobRow>(
          transaction,
          `
            /* control:sampling-job-fail */
            update evm_chain_control_sampling_jobs
            set
              status = 'failed',
              lease_expires_at = null,
              failed_at = $2::timestamptz,
              failure_code_hash = $3
            where
              job_id = $1
              and status = 'running'
              and worker_id_hash = $4
              and lease_expires_at >= $2::timestamptz
            returning ${samplingJobColumns()}
          `,
          [input.jobId, input.failedAt, input.failureCodeHash, input.workerIdHash],
        );
        const row = updated.rows[0];
        if (row === undefined) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Sampling job lost its generation-fenced worker lease.',
          );
        }
        const job = mapSamplingJob(row);
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.workerIdHash,
          entityFingerprint: sha256Fingerprint(job),
          entityId: job.jobId,
          entityType: 'sampling_intake_job',
          eventAt: input.failedAt,
          eventKind: 'sampling_job_failed',
          payload: {
            attemptCount: job.attemptCount,
            failureCodeHash: input.failureCodeHash,
          },
          stream: 'governance',
        });
        return job;
      });
    },

    async getIntakeJob(jobId): Promise<SamplingIntakeJob | undefined> {
      return readSamplingJob(client, jobId, false);
    },

    async getPlan(planId): Promise<MainnetSamplingPlan | undefined> {
      return readPlan(client, planId);
    },

    async listManifests(planId): Promise<PublicChainSampleManifest[]> {
      return readManifests(client, planId);
    },

    async migrate(): Promise<void> {
      await migrateEvmChainAnalysisControlStore(client);
    },

    async recordCoverageRun(input): Promise<MainnetSamplingCoverageResult> {
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.evaluatedAt,
          principalIdHash: input.actorIdHash,
          role: 'sampling_planner',
        });
        const plan = await requirePlan(transaction, input.planId);
        const approval = await requireApproval(transaction, plan.approvalFingerprint);
        const manifests = await readManifests(transaction, plan.planId);
        const result = evaluateMainnetSamplingCoverage({
          approval,
          evaluatedAt: input.evaluatedAt,
          manifests,
          plan,
        });
        await acquireControlLock(transaction, `sampling-run:${result.runId}`);
        const existing = await readPayloadByKey(
          transaction,
          '/* control:sampling-run-read */ select payload from evm_chain_control_sampling_runs where run_id = $1',
          result.runId,
        );
        if (existing !== undefined) {
          const parsed = mainnetSamplingCoverageResultSchema.parse(existing);
          assertSameFingerprint(result.runFingerprint, parsed.runFingerprint, 'Sampling run');
          return parsed;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:sampling-run-insert */
            insert into evm_chain_control_sampling_runs (
              run_id, run_fingerprint, plan_id, evaluated_at, status, payload
            ) values ($1, $2, $3, $4::timestamptz, $5, $6::jsonb)
          `,
          [
            result.runId,
            result.runFingerprint,
            result.planId,
            result.evaluatedAt,
            result.status,
            JSON.stringify(result),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: result.runFingerprint,
          entityId: result.runId,
          entityType: 'sampling_coverage_run',
          eventAt: result.evaluatedAt,
          eventKind: 'sampling_run_recorded',
          payload: {
            accepted: result.acceptedManifestFingerprints.length,
            rejected: result.rejectedManifests.length,
            status: result.status,
          },
          stream: 'governance',
        });
        return result;
      });
    },

    async recordPlan(input): Promise<MainnetSamplingPlan> {
      const plan = mainnetSamplingPlanSchema.parse(input.plan);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: plan.plannedAt,
          principalIdHash: input.actorIdHash,
          role: 'sampling_planner',
        });
        await acquireControlLock(transaction, `sampling-plan:${plan.planId}`);
        const approval = await requireApproval(transaction, plan.approvalFingerprint);
        const policy = await requirePolicy(transaction, plan.policyFingerprint);
        const reproduced = materializeMainnetSamplingPlan(approval, policy, plan.plannedAt);
        assertSameFingerprint(plan.planFingerprint, reproduced.planFingerprint, 'Sampling plan');
        const existing = await readPlan(transaction, plan.planId);
        if (existing !== undefined) {
          assertSameFingerprint(plan.planFingerprint, existing.planFingerprint, 'Sampling plan');
          return existing;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:sampling-plan-insert */
            insert into evm_chain_control_sampling_plans (
              plan_id,
              plan_fingerprint,
              policy_fingerprint,
              approval_fingerprint,
              planned_at,
              sampling_starts_at,
              sampling_ends_at,
              payload
            ) values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::jsonb)
          `,
          [
            plan.planId,
            plan.planFingerprint,
            plan.policyFingerprint,
            plan.approvalFingerprint,
            plan.plannedAt,
            plan.samplingStartsAt,
            plan.samplingEndsAt,
            JSON.stringify(plan),
          ],
        );
        for (const slot of plan.slots) {
          const jobId = samplingJobId(plan.planFingerprint, slot.slotId);
          await queryControlDatabase(
            transaction,
            `
              /* control:sampling-job-enqueue */
              insert into evm_chain_control_sampling_jobs (
                job_id,
                plan_id,
                plan_fingerprint,
                slot_id,
                stratum_id,
                not_before,
                expires_at,
                status,
                max_attempts
              ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'queued', $8)
            `,
            [
              jobId,
              plan.planId,
              plan.planFingerprint,
              slot.slotId,
              slot.stratumId,
              plan.samplingStartsAt,
              plan.samplingEndsAt,
              DEFAULT_SAMPLING_MAX_ATTEMPTS,
            ],
          );
        }
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: plan.planFingerprint,
          entityId: plan.planId,
          entityType: 'mainnet_sampling_plan',
          eventAt: plan.plannedAt,
          eventKind: 'sampling_plan_recorded',
          payload: {
            policyFingerprint: plan.policyFingerprint,
            slotCount: plan.slots.length,
          },
          stream: 'governance',
        });
        return plan;
      });
    },

    async recordPolicy(input): Promise<MainnetSamplingPolicy> {
      const policy = mainnetSamplingPolicySchema.parse(input.policy);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: policy.createdAt,
          principalIdHash: input.actorIdHash,
          role: 'sampling_planner',
        });
        await acquireControlLock(transaction, `sampling-policy:${policy.policyId}`);
        const approval = await requireApproval(transaction, policy.approvalFingerprint);
        const reproduced = createMainnetSamplingPolicy(approval, policyInputOf(policy));
        assertSameFingerprint(
          policy.policyFingerprint,
          reproduced.policyFingerprint,
          'Sampling policy',
        );
        const existing = await readPolicyById(transaction, policy.policyId);
        if (existing !== undefined) {
          assertSameFingerprint(
            policy.policyFingerprint,
            existing.policyFingerprint,
            'Sampling policy',
          );
          return existing;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:sampling-policy-insert */
            insert into evm_chain_control_sampling_policies (
              policy_id,
              policy_fingerprint,
              approval_fingerprint,
              created_at,
              sampling_starts_at,
              sampling_ends_at,
              payload
            ) values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7::jsonb)
          `,
          [
            policy.policyId,
            policy.policyFingerprint,
            policy.approvalFingerprint,
            policy.createdAt,
            policy.samplingStartsAt,
            policy.samplingEndsAt,
            JSON.stringify(policy),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: policy.policyFingerprint,
          entityId: policy.policyId,
          entityType: 'mainnet_sampling_policy',
          eventAt: policy.createdAt,
          eventKind: 'sampling_policy_recorded',
          payload: {
            approvalFingerprint: policy.approvalFingerprint,
            targetSamples: policy.totalTargetSamples,
          },
          stream: 'governance',
        });
        return policy;
      });
    },

    async recordSourceApproval(input): Promise<MainnetSamplingSourceApproval> {
      const approval = mainnetSamplingSourceApprovalSchema.parse(input.approval);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: approval.approvedAt,
          principalIdHash: input.actorIdHash,
          role: 'sampling_planner',
        });
        await acquireControlLock(transaction, `sampling-approval:${approval.approvalId}`);
        const existing = await readApprovalById(transaction, approval.approvalId);
        if (existing !== undefined) {
          assertSameFingerprint(
            approval.approvalFingerprint,
            existing.approvalFingerprint,
            'Sampling source approval',
          );
          return existing;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:sampling-approval-insert */
            insert into evm_chain_control_sampling_approvals (
              approval_id,
              approval_fingerprint,
              approved_at,
              valid_from,
              valid_until,
              payload
            ) values ($1, $2, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6::jsonb)
          `,
          [
            approval.approvalId,
            approval.approvalFingerprint,
            approval.approvedAt,
            approval.validFrom,
            approval.validUntil,
            JSON.stringify(approval),
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: approval.approvalFingerprint,
          entityId: approval.approvalId,
          entityType: 'mainnet_sampling_source_approval',
          eventAt: approval.approvedAt,
          eventKind: 'sampling_approval_recorded',
          payload: {
            retentionPolicyId: approval.retentionPolicyId,
            sourceKinds: approval.sourceKinds,
            validUntil: approval.validUntil,
          },
          stream: 'governance',
        });
        return approval;
      });
    },

    async retryIntakeJob(input): Promise<SamplingIntakeJob> {
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.retriedAt,
          principalIdHash: input.actorIdHash,
          role: 'sampling_planner',
        });
        const current = await requireSamplingJob(transaction, input.jobId, true);
        if (
          current.status !== 'failed' ||
          current.attemptCount >= current.maxAttempts ||
          Date.parse(input.retriedAt) > Date.parse(current.expiresAt)
        ) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Only a failed, in-window sampling job with remaining attempts can be retried.',
          );
        }
        const updated = await queryControlDatabase<SamplingJobRow>(
          transaction,
          `
            /* control:sampling-job-retry */
            update evm_chain_control_sampling_jobs
            set
              status = 'queued',
              worker_id_hash = null,
              failed_at = null,
              failure_code_hash = null
            where job_id = $1 and status = 'failed' and attempt_count < max_attempts
            returning ${samplingJobColumns()}
          `,
          [input.jobId],
        );
        const row = updated.rows[0];
        if (row === undefined) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Sampling job retry lost its locked failed state.',
          );
        }
        const job = mapSamplingJob(row);
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: sha256Fingerprint(job),
          entityId: job.jobId,
          entityType: 'sampling_intake_job',
          eventAt: input.retriedAt,
          eventKind: 'sampling_job_retried',
          payload: { attemptCount: job.attemptCount },
          stream: 'governance',
        });
        return job;
      });
    },
  };
}

function policyInputOf(policy: MainnetSamplingPolicy) {
  return {
    createdAt: policy.createdAt,
    policyName: policy.policyName,
    samplingEndsAt: policy.samplingEndsAt,
    samplingStartsAt: policy.samplingStartsAt,
    strata: policy.strata.map((stratum) => ({
      chainCondition: stratum.chainCondition,
      chainId: stratum.chainId,
      dataCompleteness: stratum.dataCompleteness,
      protocol: stratum.protocol,
      routeClass: stratum.routeClass,
      targetLabel: stratum.targetLabel,
      targetSamples: stratum.targetSamples,
      tokenBehavior: stratum.tokenBehavior,
    })),
  };
}

function validateManifestForJob(
  manifest: PublicChainSampleManifest,
  plan: MainnetSamplingPlan,
  job: SamplingIntakeJob,
  completedAt: string,
): void {
  let reproduced: PublicChainSampleManifest;
  try {
    reproduced = createPublicChainSampleManifest(plan, manifestInputOf(manifest));
  } catch (error) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'Sample manifest cannot be reproduced from the persisted sampling plan.',
      { cause: error },
    );
  }
  const slot = plan.slots.find((candidate) => candidate.slotId === job.slotId);
  const stratum = plan.strata.find((candidate) => candidate.stratumId === job.stratumId);
  if (
    slot === undefined ||
    stratum === undefined ||
    reproduced.manifestFingerprint !== manifest.manifestFingerprint ||
    slot.stratumId !== stratum.stratumId ||
    manifest.planId !== plan.planId ||
    manifest.planFingerprint !== plan.planFingerprint ||
    manifest.policyFingerprint !== plan.policyFingerprint ||
    manifest.approvalFingerprint !== plan.approvalFingerprint ||
    manifest.slotId !== job.slotId ||
    manifest.stratumId !== job.stratumId ||
    manifest.chainId !== stratum.chainId ||
    manifest.chainCondition !== stratum.chainCondition ||
    manifest.dataCompleteness !== stratum.dataCompleteness ||
    manifest.protocol !== stratum.protocol ||
    manifest.routeClass !== stratum.routeClass ||
    manifest.targetLabel !== stratum.targetLabel ||
    manifest.tokenBehavior !== stratum.tokenBehavior ||
    !plan.sourceKinds.includes(manifest.sourceKind) ||
    Date.parse(manifest.collectedAt) < Date.parse(plan.samplingStartsAt) ||
    Date.parse(manifest.collectedAt) > Date.parse(plan.samplingEndsAt) ||
    Date.parse(completedAt) < Date.parse(manifest.collectedAt)
  ) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'Sample manifest does not reproduce the leased plan slot and collection window.',
    );
  }
}

function manifestInputOf(manifest: PublicChainSampleManifest) {
  return {
    blockHash: manifest.blockHash,
    blockNumber: manifest.blockNumber,
    collectedAt: manifest.collectedAt,
    credentialScan: manifest.credentialScan,
    privateDataScan: manifest.privateDataScan,
    providerObservationHashes: manifest.providerObservationHashes,
    ...(manifest.reorgEvidence === undefined ? {} : { reorgEvidence: manifest.reorgEvidence }),
    scannedAt: manifest.scannedAt,
    scannerVersion: manifest.scannerVersion,
    slotId: manifest.slotId,
    sourceKind: manifest.sourceKind,
    sourcePayloadHashes: manifest.sourcePayloadHashes,
    transactionHash: manifest.transactionHash,
    transactionIndex: manifest.transactionIndex,
  };
}

function assertActiveWorkerLease(
  job: SamplingIntakeJob,
  workerIdHash: string,
  transitionAt: string,
): void {
  if (
    job.status !== 'running' ||
    job.workerIdHash !== workerIdHash ||
    job.leaseExpiresAt === undefined ||
    Date.parse(job.leaseExpiresAt) < Date.parse(transitionAt)
  ) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'Sampling transition requires the current unexpired generation-fenced worker lease.',
    );
  }
}

async function requireApproval(
  client: PgControlClientLike,
  approvalFingerprint: string,
): Promise<MainnetSamplingSourceApproval> {
  const payload = await readPayloadByKey(
    client,
    '/* control:sampling-approval-read */ select payload from evm_chain_control_sampling_approvals where approval_fingerprint = $1',
    approvalFingerprint,
  );
  if (payload === undefined) {
    throw new ChainAnalysisControlStoreError(
      'sampling_approval_not_found',
      `Sampling source approval ${approvalFingerprint} was not found.`,
    );
  }
  return mainnetSamplingSourceApprovalSchema.parse(payload);
}

async function readApprovalById(
  client: PgControlClientLike,
  approvalId: string,
): Promise<MainnetSamplingSourceApproval | undefined> {
  const payload = await readPayloadByKey(
    client,
    '/* control:sampling-approval-by-id */ select payload from evm_chain_control_sampling_approvals where approval_id = $1',
    approvalId,
  );
  return payload === undefined ? undefined : mainnetSamplingSourceApprovalSchema.parse(payload);
}

async function requirePolicy(
  client: PgControlClientLike,
  policyFingerprint: string,
): Promise<MainnetSamplingPolicy> {
  const payload = await readPayloadByKey(
    client,
    '/* control:sampling-policy-read */ select payload from evm_chain_control_sampling_policies where policy_fingerprint = $1',
    policyFingerprint,
  );
  if (payload === undefined) {
    throw new ChainAnalysisControlStoreError(
      'sampling_policy_not_found',
      `Sampling policy ${policyFingerprint} was not found.`,
    );
  }
  return mainnetSamplingPolicySchema.parse(payload);
}

async function readPolicyById(
  client: PgControlClientLike,
  policyId: string,
): Promise<MainnetSamplingPolicy | undefined> {
  const payload = await readPayloadByKey(
    client,
    '/* control:sampling-policy-by-id */ select payload from evm_chain_control_sampling_policies where policy_id = $1',
    policyId,
  );
  return payload === undefined ? undefined : mainnetSamplingPolicySchema.parse(payload);
}

async function requirePlan(
  client: PgControlClientLike,
  planId: string,
): Promise<MainnetSamplingPlan> {
  const plan = await readPlan(client, planId);
  if (plan === undefined) {
    throw new ChainAnalysisControlStoreError(
      'sampling_plan_not_found',
      `Sampling plan ${planId} was not found.`,
    );
  }
  return plan;
}

async function readPlan(
  client: PgControlClientLike,
  planId: string,
): Promise<MainnetSamplingPlan | undefined> {
  const payload = await readPayloadByKey(
    client,
    '/* control:sampling-plan-read */ select payload from evm_chain_control_sampling_plans where plan_id = $1',
    planId,
  );
  return payload === undefined ? undefined : mainnetSamplingPlanSchema.parse(payload);
}

async function readManifests(
  client: PgControlClientLike,
  planId: string,
): Promise<PublicChainSampleManifest[]> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:sampling-manifests-read */
      select payload
      from evm_chain_control_sampling_manifests
      where plan_id = $1
      order by manifest_id
      limit 1001
    `,
    [planId],
  );
  return response.rows.map((row) => publicChainSampleManifestSchema.parse(row.payload));
}

async function requireManifest(
  client: PgControlClientLike,
  manifestId: string,
): Promise<PublicChainSampleManifest> {
  const payload = await readPayloadByKey(
    client,
    '/* control:sampling-manifest-read */ select payload from evm_chain_control_sampling_manifests where manifest_id = $1',
    manifestId,
  );
  if (payload === undefined) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      `Succeeded sampling manifest ${manifestId} was not found.`,
    );
  }
  return publicChainSampleManifestSchema.parse(payload);
}

async function readManifestBySlotOrIdentity(
  client: PgControlClientLike,
  slotId: string,
  sampleIdentityFingerprint: string,
): Promise<PublicChainSampleManifest | undefined> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:sampling-manifest-dedupe-read */
      select payload
      from evm_chain_control_sampling_manifests
      where slot_id = $1 or sample_identity_fingerprint = $2
      order by manifest_id
      limit 1
    `,
    [slotId, sampleIdentityFingerprint],
  );
  const row = response.rows[0];
  return row === undefined ? undefined : publicChainSampleManifestSchema.parse(row.payload);
}

async function requireSamplingJob(
  client: PgControlClientLike,
  jobId: string,
  forUpdate: boolean,
): Promise<SamplingIntakeJob> {
  const job = await readSamplingJob(client, jobId, forUpdate);
  if (job === undefined) {
    throw new ChainAnalysisControlStoreError(
      'sampling_job_not_found',
      `Sampling intake job ${jobId} was not found.`,
    );
  }
  return job;
}

async function readSamplingJob(
  client: PgControlClientLike,
  jobId: string,
  forUpdate: boolean,
): Promise<SamplingIntakeJob | undefined> {
  const response = await queryControlDatabase<SamplingJobRow>(
    client,
    `
      /* control:sampling-job-read */
      select ${samplingJobColumns()}
      from evm_chain_control_sampling_jobs
      where job_id = $1
      ${forUpdate ? 'for update' : ''}
    `,
    [jobId],
  );
  const row = response.rows[0];
  return row === undefined ? undefined : mapSamplingJob(row);
}

async function readPayloadByKey(
  client: PgControlClientLike,
  sql: string,
  value: string,
): Promise<unknown> {
  const response = await queryControlDatabase<PayloadRow>(client, sql, [value]);
  return response.rows[0]?.payload;
}

function samplingJobId(planFingerprint: string, slotId: string): string {
  return `sampling_job_${sha256Fingerprint({
    planFingerprint,
    slotId,
    version: EVM_CHAIN_ANALYSIS_CONTROL_STORE_VERSION,
  }).slice(7)}`;
}

function mapSamplingJob(row: SamplingJobRow): SamplingIntakeJob {
  return samplingIntakeJobSchema.parse({
    attemptCount: parseSafeInteger(row.attempt_count, 'sampling attempt count'),
    expiresAt: row.expires_at,
    jobId: row.job_id,
    maxAttempts: parseSafeInteger(row.max_attempts, 'sampling maximum attempts'),
    notBefore: row.not_before,
    planFingerprint: row.plan_fingerprint,
    planId: row.plan_id,
    slotId: row.slot_id,
    status: row.status,
    stratumId: row.stratum_id,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.failed_at === null ? {} : { failedAt: row.failed_at }),
    ...(row.failure_code_hash === null ? {} : { failureCodeHash: row.failure_code_hash }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.manifest_fingerprint === null ? {} : { manifestFingerprint: row.manifest_fingerprint }),
    ...(row.manifest_id === null ? {} : { manifestId: row.manifest_id }),
    ...(row.worker_id_hash === null ? {} : { workerIdHash: row.worker_id_hash }),
  });
}

function samplingJobColumns(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return `
    ${prefix}job_id,
    ${prefix}plan_id,
    ${prefix}plan_fingerprint,
    ${prefix}slot_id,
    ${prefix}stratum_id,
    to_char(${prefix}not_before at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as not_before,
    to_char(${prefix}expires_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as expires_at,
    ${prefix}status,
    ${prefix}attempt_count,
    ${prefix}max_attempts,
    ${prefix}worker_id_hash,
    to_char(${prefix}lease_expires_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as lease_expires_at,
    to_char(${prefix}completed_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as completed_at,
    to_char(${prefix}failed_at at time zone 'UTC', '${ISO_TIMESTAMP_FORMAT}') as failed_at,
    ${prefix}failure_code_hash,
    ${prefix}manifest_id,
    ${prefix}manifest_fingerprint
  `;
}

function normalizeLeaseSeconds(value: number | undefined): number {
  const normalized = value ?? 300;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 3_600) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'Sampling leaseSeconds must be an integer between 1 and 3600.',
    );
  }
  return normalized;
}
