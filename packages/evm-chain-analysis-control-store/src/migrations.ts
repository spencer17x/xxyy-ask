import {
  queryControlDatabase,
  withControlTransaction,
  type PgControlClientLike,
} from './postgres.js';

const IMMUTABLE_TABLES = [
  'evm_chain_control_authorizations',
  'evm_chain_control_authorization_revocations',
  'evm_chain_control_replay_candidates',
  'evm_chain_control_replay_reviews',
  'evm_chain_control_replay_decisions',
  'evm_chain_control_replay_promotions',
  'evm_chain_control_replay_tombstones',
  'evm_chain_control_corpus_exports',
  'evm_chain_control_corpus_evaluation_reports',
  'evm_chain_control_operations_evidence',
  'evm_chain_control_readiness_attestations',
  'evm_chain_control_readiness_policies',
  'evm_chain_control_audit_events',
  'evm_chain_control_budget_policies',
  'evm_chain_control_budget_leases',
  'evm_chain_control_budget_settlements',
  'evm_chain_control_circuit_states',
  'evm_chain_control_sampling_approvals',
  'evm_chain_control_production_provisioning_receipts',
  'evm_chain_control_provisioning_receipt_grants',
  'evm_chain_control_sampling_policies',
  'evm_chain_control_sampling_plans',
  'evm_chain_control_sampling_manifests',
  'evm_chain_control_sampling_candidate_handoffs',
  'evm_chain_control_sampling_runs',
] as const;

export const CHAIN_ANALYSIS_CONTROL_STORE_MIGRATIONS = [
  `
    create table if not exists evm_chain_control_authorizations (
      authorization_id text primary key,
      authorization_fingerprint text not null unique,
      principal_id_hash text not null,
      roles text[] not null,
      granted_at timestamptz not null,
      valid_until timestamptz,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create index if not exists evm_chain_control_authorizations_principal_idx
      on evm_chain_control_authorizations (principal_id_hash, granted_at, valid_until)
  `,
  `
    create table if not exists evm_chain_control_authorization_revocations (
      revocation_id text primary key,
      revocation_fingerprint text not null unique,
      authorization_id text not null unique references evm_chain_control_authorizations(authorization_id),
      revoked_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_replay_candidates (
      candidate_id text primary key,
      candidate_fingerprint text not null unique,
      submitter_id_hash text not null,
      revision integer not null check (revision > 0),
      supersedes_candidate_id text references evm_chain_control_replay_candidates(candidate_id),
      submitted_at timestamptz not null,
      retain_until timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create unique index if not exists evm_chain_control_replay_candidates_supersedes_idx
      on evm_chain_control_replay_candidates (supersedes_candidate_id)
      where supersedes_candidate_id is not null
  `,
  `
    create index if not exists evm_chain_control_replay_candidates_retention_idx
      on evm_chain_control_replay_candidates (retain_until, candidate_id)
  `,
  `
    create table if not exists evm_chain_control_replay_reviews (
      review_id text primary key,
      review_fingerprint text not null unique,
      candidate_id text not null references evm_chain_control_replay_candidates(candidate_id),
      reviewer_id_hash text not null,
      reviewed_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      unique (candidate_id, reviewer_id_hash)
    )
  `,
  `
    create table if not exists evm_chain_control_review_work_jobs (
      job_id text primary key,
      candidate_id text not null references evm_chain_control_replay_candidates(candidate_id),
      candidate_fingerprint text not null,
      slot_ordinal integer not null check (slot_ordinal = 1),
      not_before timestamptz not null,
      expires_at timestamptz not null,
      status text not null check (status in ('failed', 'queued', 'running', 'succeeded')),
      attempt_count integer not null default 0 check (attempt_count >= 0),
      max_attempts integer not null default 3 check (max_attempts > 0),
      reviewer_id_hash text,
      lease_expires_at timestamptz,
      completed_at timestamptz,
      failed_at timestamptz,
      failure_code_hash text,
      review_id text references evm_chain_control_replay_reviews(review_id),
      review_fingerprint text,
      unique (candidate_id, slot_ordinal),
      check (expires_at > not_before),
      check (attempt_count <= max_attempts),
      check (
        (status = 'queued' and attempt_count = 0)
        or (status <> 'queued' and attempt_count > 0)
      ),
      check (
        (status = 'queued' and reviewer_id_hash is null and lease_expires_at is null
          and completed_at is null and failed_at is null and failure_code_hash is null
          and review_id is null and review_fingerprint is null)
        or (status = 'running' and reviewer_id_hash is not null and lease_expires_at is not null
          and completed_at is null and failed_at is null and failure_code_hash is null
          and review_id is null and review_fingerprint is null)
        or (status = 'succeeded' and reviewer_id_hash is not null and lease_expires_at is null
          and completed_at is not null and failed_at is null and failure_code_hash is null
          and review_id is not null and review_fingerprint is not null)
        or (status = 'failed' and reviewer_id_hash is not null and lease_expires_at is null
          and completed_at is null and failed_at is not null and failure_code_hash is not null
          and review_id is null and review_fingerprint is null)
      )
    )
  `,
  `
    create unique index if not exists evm_chain_control_review_work_jobs_reviewer_idx
      on evm_chain_control_review_work_jobs (candidate_id, reviewer_id_hash)
      where reviewer_id_hash is not null and status in ('running', 'succeeded')
  `,
  `
    create index if not exists evm_chain_control_review_work_jobs_claim_idx
      on evm_chain_control_review_work_jobs (not_before, expires_at, candidate_id, slot_ordinal)
      where status in ('failed', 'queued', 'running')
  `,
  `
    create table if not exists evm_chain_control_replay_decisions (
      decision_fingerprint text primary key,
      candidate_id text not null references evm_chain_control_replay_candidates(candidate_id),
      evaluated_at timestamptz not null,
      status text not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create index if not exists evm_chain_control_replay_decisions_candidate_idx
      on evm_chain_control_replay_decisions (candidate_id, evaluated_at desc)
  `,
  `
    create table if not exists evm_chain_control_replay_promotions (
      candidate_id text primary key references evm_chain_control_replay_candidates(candidate_id),
      promotion_fingerprint text not null unique,
      promoted_at timestamptz not null,
      retain_until timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_replay_tombstones (
      candidate_id text primary key references evm_chain_control_replay_candidates(candidate_id),
      tombstone_id text not null unique,
      tombstone_fingerprint text not null unique,
      deleted_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_corpus_exports (
      export_fingerprint text primary key,
      exported_at timestamptz not null,
      corpus_id text not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_readiness_policies (
      policy_fingerprint text primary key,
      actor_id_hash text not null,
      recorded_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_operations_evidence (
      evidence_fingerprint text primary key,
      actor_id_hash text not null,
      recorded_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_corpus_evaluation_reports (
      report_fingerprint text primary key,
      corpus_export_fingerprint text not null
        references evm_chain_control_corpus_exports(export_fingerprint),
      corpus_fingerprint text not null,
      corpus_id text not null,
      actor_id_hash text not null,
      evaluated_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      unique (corpus_export_fingerprint, evaluated_at)
    )
  `,
  `
    create table if not exists evm_chain_control_readiness_attestations (
      readiness_fingerprint text primary key,
      corpus_report_fingerprint text not null
        references evm_chain_control_corpus_evaluation_reports(report_fingerprint),
      operations_evidence_fingerprint text not null
        references evm_chain_control_operations_evidence(evidence_fingerprint),
      policy_fingerprint text not null
        references evm_chain_control_readiness_policies(policy_fingerprint),
      actor_id_hash text not null,
      evaluated_at timestamptz not null,
      status text not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    alter table evm_chain_control_readiness_attestations
      add column if not exists corpus_report_fingerprint text
        references evm_chain_control_corpus_evaluation_reports(report_fingerprint)
  `,
  `
    alter table evm_chain_control_readiness_attestations
      add column if not exists operations_evidence_fingerprint text
        references evm_chain_control_operations_evidence(evidence_fingerprint)
  `,
  `
    alter table evm_chain_control_readiness_attestations
      add column if not exists policy_fingerprint text
        references evm_chain_control_readiness_policies(policy_fingerprint)
  `,
  `
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conname = 'evm_chain_control_readiness_attestations_lineage_required'
          and conrelid = 'evm_chain_control_readiness_attestations'::regclass
      ) then
        alter table evm_chain_control_readiness_attestations
          add constraint evm_chain_control_readiness_attestations_lineage_required
          check (
            corpus_report_fingerprint is not null
            and operations_evidence_fingerprint is not null
            and policy_fingerprint is not null
          ) not valid;
      end if;
    end;
    $$
  `,
  `
    create table if not exists evm_chain_control_retention_jobs (
      job_id text primary key,
      candidate_id text not null unique references evm_chain_control_replay_candidates(candidate_id),
      retain_until timestamptz not null,
      status text not null check (status in ('queued', 'running', 'completed')),
      attempt_count integer not null default 0 check (attempt_count >= 0),
      worker_id_hash text,
      lease_expires_at timestamptz,
      completed_at timestamptz,
      outcome text check (outcome in ('expired_unpromoted', 'tombstoned')),
      check (
        (status = 'queued' and worker_id_hash is null and lease_expires_at is null and completed_at is null and outcome is null)
        or (status = 'running' and worker_id_hash is not null and lease_expires_at is not null and completed_at is null and outcome is null)
        or (status = 'completed' and worker_id_hash is not null and lease_expires_at is null and completed_at is not null and outcome is not null)
      )
    )
  `,
  `
    create index if not exists evm_chain_control_retention_jobs_claim_idx
      on evm_chain_control_retention_jobs (retain_until, job_id)
      where status <> 'completed'
  `,
  `
    create table if not exists evm_chain_control_audit_heads (
      stream text primary key,
      last_sequence bigint not null default 0 check (last_sequence >= 0),
      last_event_fingerprint text,
      check ((last_sequence = 0) = (last_event_fingerprint is null))
    )
  `,
  `
    insert into evm_chain_control_audit_heads (stream)
    values ('governance'), ('provider_control')
    on conflict (stream) do nothing
  `,
  `
    create table if not exists evm_chain_control_audit_events (
      event_id text primary key,
      event_fingerprint text not null unique,
      stream text not null references evm_chain_control_audit_heads(stream),
      sequence bigint not null check (sequence > 0),
      previous_event_fingerprint text,
      event_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      unique (stream, sequence)
    )
  `,
  `
    create table if not exists evm_chain_control_budget_policies (
      policy_fingerprint text primary key,
      budget_id text not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_active_budget_policies (
      budget_id text primary key,
      policy_fingerprint text not null references evm_chain_control_budget_policies(policy_fingerprint),
      generation bigint not null check (generation >= 0),
      installed_at timestamptz not null
    )
  `,
  `
    create table if not exists evm_chain_control_budget_windows (
      budget_id text not null,
      policy_fingerprint text not null references evm_chain_control_budget_policies(policy_fingerprint),
      window_started_at timestamptz not null,
      window_ends_at timestamptz not null,
      reserved_cost_units bigint not null default 0 check (reserved_cost_units >= 0),
      reserved_requests bigint not null default 0 check (reserved_requests >= 0),
      reserved_response_bytes bigint not null default 0 check (reserved_response_bytes >= 0),
      reserved_rpc_calls bigint not null default 0 check (reserved_rpc_calls >= 0),
      used_cost_units bigint not null default 0 check (used_cost_units >= 0),
      used_requests bigint not null default 0 check (used_requests >= 0),
      used_response_bytes bigint not null default 0 check (used_response_bytes >= 0),
      used_rpc_calls bigint not null default 0 check (used_rpc_calls >= 0),
      primary key (budget_id, policy_fingerprint, window_started_at),
      check (window_ends_at > window_started_at)
    )
  `,
  `
    create table if not exists evm_chain_control_budget_leases (
      lease_id text primary key,
      lease_fingerprint text not null unique,
      request_fingerprint text not null unique,
      budget_id text not null,
      policy_fingerprint text not null references evm_chain_control_budget_policies(policy_fingerprint),
      window_started_at timestamptz not null,
      issued_at timestamptz not null,
      expires_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      foreign key (budget_id, policy_fingerprint, window_started_at)
        references evm_chain_control_budget_windows(budget_id, policy_fingerprint, window_started_at)
    )
  `,
  `
    create index if not exists evm_chain_control_budget_leases_active_idx
      on evm_chain_control_budget_leases (budget_id, policy_fingerprint, expires_at)
  `,
  `
    create table if not exists evm_chain_control_budget_settlements (
      lease_id text primary key references evm_chain_control_budget_leases(lease_id),
      settlement_fingerprint text not null unique,
      settled_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_circuit_states (
      state_fingerprint text primary key,
      adapter text not null,
      chain_id text not null,
      provider_id text not null,
      generation bigint not null check (generation >= 0),
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      unique (adapter, chain_id, provider_id, generation)
    )
  `,
  `
    create table if not exists evm_chain_control_circuit_heads (
      adapter text not null,
      chain_id text not null,
      provider_id text not null,
      generation bigint not null check (generation >= 0),
      state_fingerprint text not null references evm_chain_control_circuit_states(state_fingerprint),
      primary key (adapter, chain_id, provider_id)
    )
  `,
  `
    create table if not exists evm_chain_control_sampling_approvals (
      approval_id text primary key,
      approval_fingerprint text not null unique,
      approved_at timestamptz not null,
      valid_from timestamptz not null,
      valid_until timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      check (valid_until > valid_from)
    )
  `,
  `
    create table if not exists evm_chain_control_production_provisioning_receipts (
      receipt_id text primary key,
      receipt_fingerprint text not null unique,
      plan_id text not null unique,
      plan_fingerprint text not null unique,
      verification_fingerprint text not null unique,
      approval_fingerprint text not null
        references evm_chain_control_sampling_approvals(approval_fingerprint),
      authorization_ids text[] not null check (cardinality(authorization_ids) = 8),
      applied_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create unique index if not exists evm_chain_control_authorizations_id_fingerprint_idx
      on evm_chain_control_authorizations (authorization_id, authorization_fingerprint)
  `,
  `
    create table if not exists evm_chain_control_provisioning_receipt_grants (
      receipt_id text not null
        references evm_chain_control_production_provisioning_receipts(receipt_id),
      ordinal integer not null check (ordinal between 1 and 8),
      authorization_id text not null,
      authorization_fingerprint text not null,
      identity_evidence_hash text not null,
      primary key (receipt_id, ordinal),
      unique (receipt_id, authorization_id),
      foreign key (authorization_id, authorization_fingerprint)
        references evm_chain_control_authorizations(
          authorization_id,
          authorization_fingerprint
        )
    )
  `,
  `
    create table if not exists evm_chain_control_sampling_policies (
      policy_id text primary key,
      policy_fingerprint text not null unique,
      approval_fingerprint text not null
        references evm_chain_control_sampling_approvals(approval_fingerprint),
      created_at timestamptz not null,
      sampling_starts_at timestamptz not null,
      sampling_ends_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      check (sampling_ends_at > sampling_starts_at)
    )
  `,
  `
    create table if not exists evm_chain_control_sampling_plans (
      plan_id text primary key,
      plan_fingerprint text not null unique,
      policy_fingerprint text not null
        references evm_chain_control_sampling_policies(policy_fingerprint),
      approval_fingerprint text not null
        references evm_chain_control_sampling_approvals(approval_fingerprint),
      planned_at timestamptz not null,
      sampling_starts_at timestamptz not null,
      sampling_ends_at timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      check (sampling_ends_at > sampling_starts_at)
    )
  `,
  `
    create table if not exists evm_chain_control_sampling_manifests (
      manifest_id text primary key,
      manifest_fingerprint text not null unique,
      plan_id text not null references evm_chain_control_sampling_plans(plan_id),
      slot_id text not null unique,
      sample_identity_fingerprint text not null unique,
      collected_at timestamptz not null,
      retain_until timestamptz not null,
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      check (retain_until > collected_at)
    )
  `,
  `
    create index if not exists evm_chain_control_sampling_manifests_plan_idx
      on evm_chain_control_sampling_manifests (plan_id, manifest_id)
  `,
  `
    create table if not exists evm_chain_control_sampling_candidate_handoffs (
      handoff_id text primary key,
      handoff_fingerprint text not null unique,
      manifest_id text not null unique
        references evm_chain_control_sampling_manifests(manifest_id),
      candidate_id text not null unique
        references evm_chain_control_replay_candidates(candidate_id),
      handed_off_at timestamptz not null,
      target_disposition text not null check (target_disposition in ('deviated', 'matched')),
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_sampling_runs (
      run_id text primary key,
      run_fingerprint text not null unique,
      plan_id text not null references evm_chain_control_sampling_plans(plan_id),
      evaluated_at timestamptz not null,
      status text not null check (status in ('blocked', 'complete', 'in_progress', 'incomplete')),
      payload jsonb not null check (jsonb_typeof(payload) = 'object')
    )
  `,
  `
    create table if not exists evm_chain_control_sampling_jobs (
      job_id text primary key,
      plan_id text not null references evm_chain_control_sampling_plans(plan_id),
      plan_fingerprint text not null,
      slot_id text not null unique,
      stratum_id text not null,
      not_before timestamptz not null,
      expires_at timestamptz not null,
      status text not null check (status in ('failed', 'queued', 'running', 'succeeded')),
      attempt_count integer not null default 0 check (attempt_count >= 0),
      max_attempts integer not null default 3 check (max_attempts > 0),
      worker_id_hash text,
      lease_expires_at timestamptz,
      completed_at timestamptz,
      failed_at timestamptz,
      failure_code_hash text,
      manifest_id text references evm_chain_control_sampling_manifests(manifest_id),
      manifest_fingerprint text,
      check (expires_at > not_before),
      check (attempt_count <= max_attempts),
      check (
        (status = 'queued' and worker_id_hash is null and lease_expires_at is null
          and completed_at is null and failed_at is null and failure_code_hash is null
          and manifest_id is null and manifest_fingerprint is null)
        or (status = 'running' and worker_id_hash is not null and lease_expires_at is not null
          and completed_at is null and failed_at is null and failure_code_hash is null
          and manifest_id is null and manifest_fingerprint is null)
        or (status = 'succeeded' and worker_id_hash is not null and lease_expires_at is null
          and completed_at is not null and failed_at is null and failure_code_hash is null
          and manifest_id is not null and manifest_fingerprint is not null)
        or (status = 'failed' and worker_id_hash is not null and lease_expires_at is null
          and completed_at is null and failed_at is not null and failure_code_hash is not null
          and manifest_id is null and manifest_fingerprint is null)
      )
    )
  `,
  `
    create index if not exists evm_chain_control_sampling_jobs_claim_idx
      on evm_chain_control_sampling_jobs (not_before, expires_at, job_id)
      where status in ('queued', 'running')
  `,
  `
    do $single_owner_profile$
    declare
      constraint_name text;
    begin
      if exists (
        select 1
        from evm_chain_control_review_work_jobs
        where slot_ordinal <> 1
      ) then
        raise exception
          'single-owner migration requires archived or removed legacy multi-slot review jobs';
      end if;
      if exists (
        select 1
        from evm_chain_control_production_provisioning_receipts
        where cardinality(authorization_ids) <> 8
      ) or exists (
        select 1
        from evm_chain_control_provisioning_receipt_grants
        where ordinal not between 1 and 8
      ) then
        raise exception
          'single-owner migration requires archived or removed legacy provisioning receipts';
      end if;

      for constraint_name in
        select constraint_record.conname
        from pg_constraint constraint_record
        where
          constraint_record.conrelid =
            'evm_chain_control_review_work_jobs'::regclass
          and constraint_record.contype = 'c'
          and pg_get_constraintdef(constraint_record.oid) like '%slot_ordinal%'
      loop
        execute format(
          'alter table evm_chain_control_review_work_jobs drop constraint %I',
          constraint_name
        );
      end loop;
      alter table evm_chain_control_review_work_jobs
        add constraint evm_chain_control_review_work_jobs_single_owner_slot_check
        check (slot_ordinal = 1);

      for constraint_name in
        select constraint_record.conname
        from pg_constraint constraint_record
        where
          constraint_record.conrelid =
            'evm_chain_control_production_provisioning_receipts'::regclass
          and constraint_record.contype = 'c'
          and pg_get_constraintdef(constraint_record.oid) like '%authorization_ids%'
      loop
        execute format(
          'alter table evm_chain_control_production_provisioning_receipts drop constraint %I',
          constraint_name
        );
      end loop;
      alter table evm_chain_control_production_provisioning_receipts
        add constraint evm_chain_control_provisioning_receipts_single_owner_grants_check
        check (cardinality(authorization_ids) = 8);

      for constraint_name in
        select constraint_record.conname
        from pg_constraint constraint_record
        where
          constraint_record.conrelid =
            'evm_chain_control_provisioning_receipt_grants'::regclass
          and constraint_record.contype = 'c'
          and pg_get_constraintdef(constraint_record.oid) like '%ordinal%'
      loop
        execute format(
          'alter table evm_chain_control_provisioning_receipt_grants drop constraint %I',
          constraint_name
        );
      end loop;
      alter table evm_chain_control_provisioning_receipt_grants
        add constraint evm_chain_control_provisioning_receipt_grants_single_owner_ordinal_check
        check (ordinal between 1 and 8);
    end;
    $single_owner_profile$
  `,
  `
    create or replace function reject_evm_chain_control_artifact_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception 'evm chain control artifacts are append-only';
    end;
    $$
  `,
] as const;

export async function migrateEvmChainAnalysisControlStore(
  client: PgControlClientLike,
): Promise<void> {
  await withControlTransaction(client, async (transaction) => {
    for (const migration of CHAIN_ANALYSIS_CONTROL_STORE_MIGRATIONS) {
      await queryControlDatabase(transaction, `/* control:migrate */ ${migration}`);
    }
    for (const table of IMMUTABLE_TABLES) {
      const trigger = `${table}_append_only`;
      await queryControlDatabase(transaction, `drop trigger if exists ${trigger} on ${table}`);
      await queryControlDatabase(
        transaction,
        `
          create trigger ${trigger}
          before update or delete on ${table}
          for each row execute function reject_evm_chain_control_artifact_mutation()
        `,
      );
    }
  });
}
