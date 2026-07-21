import { createHash } from 'node:crypto';

import {
  InvalidKnowledgeCandidateStateError,
  migrateKnowledgeCandidates,
} from './knowledge-candidates.js';
import type { PgClientLike } from './pgvector-store.js';

export type KnowledgePublicationJobStatus = 'failed' | 'queued' | 'running' | 'succeeded';

export interface KnowledgePublicationJob {
  attemptCount: number;
  candidateId: string;
  createdAt: string;
  id: string;
  requestedBy: string;
  status: KnowledgePublicationJobStatus;
  updatedAt: string;
  completedAt?: string;
  documentId?: string;
  lastError?: string;
  leaseExpiresAt?: string;
  runId?: string;
  startedAt?: string;
  workerId?: string;
}

export interface ListKnowledgePublicationJobsOptions {
  candidateId?: string;
  limit?: number;
  status?: KnowledgePublicationJobStatus;
}

export interface PgKnowledgePublicationJobStore {
  claim(input: {
    id: string;
    leaseSeconds?: number;
    workerId: string;
  }): Promise<KnowledgePublicationJob>;
  claimNext(input: {
    leaseSeconds?: number;
    workerId: string;
  }): Promise<KnowledgePublicationJob | undefined>;
  complete(input: {
    attemptCount: number;
    documentId: string;
    id: string;
    runId?: string;
    workerId: string;
  }): Promise<KnowledgePublicationJob>;
  fail(input: {
    attemptCount: number;
    error: string;
    id: string;
    workerId: string;
  }): Promise<KnowledgePublicationJob>;
  get(id: string): Promise<KnowledgePublicationJob | undefined>;
  list(options?: ListKnowledgePublicationJobsOptions): Promise<KnowledgePublicationJob[]>;
  migrate(): Promise<void>;
  request(input: { candidateId: string; requestedBy: string }): Promise<KnowledgePublicationJob>;
  retry(input: { id: string; requestedBy: string }): Promise<KnowledgePublicationJob>;
}

interface KnowledgePublicationJobRow {
  attempt_count: number;
  candidate_id: string;
  completed_at: string | null;
  created_at: string;
  document_id: string | null;
  id: string;
  last_error: string | null;
  lease_expires_at: string | null;
  requested_by: string;
  run_id: string | null;
  started_at: string | null;
  status: KnowledgePublicationJobStatus;
  updated_at: string;
  worker_id: string | null;
}

const PUBLICATION_JOB_COLUMNS = `
  id,
  candidate_id,
  status,
  requested_by,
  worker_id,
  attempt_count,
  lease_expires_at::text as lease_expires_at,
  last_error,
  document_id,
  run_id,
  started_at::text as started_at,
  completed_at::text as completed_at,
  created_at::text as created_at,
  updated_at::text as updated_at
`;

export class KnowledgePublicationJobNotFoundError extends Error {
  constructor(id: string) {
    super(`Knowledge publication job ${id} was not found.`);
    this.name = 'KnowledgePublicationJobNotFoundError';
  }
}

export class InvalidKnowledgePublicationJobStateError extends Error {
  constructor(id: string, expectedState: string) {
    super(`Knowledge publication job ${id} must be ${expectedState}.`);
    this.name = 'InvalidKnowledgePublicationJobStateError';
  }
}

export function createPgKnowledgePublicationJobStore(options: {
  client: PgClientLike;
}): PgKnowledgePublicationJobStore {
  return {
    async claim(input): Promise<KnowledgePublicationJob> {
      const id = normalizeRequiredText(input.id, 'id');
      const response = await queryDatabase<KnowledgePublicationJobRow>(
        options.client,
        `
        with updated as (
          update knowledge_publication_jobs
          set
            status = 'running',
            worker_id = $2,
            attempt_count = attempt_count + 1,
            lease_expires_at = now() + make_interval(secs => $3),
            last_error = null,
            started_at = now(),
            completed_at = null,
            updated_at = now()
          where
            id = $1
            and (
              status = 'queued'
              or (status = 'running' and lease_expires_at < now())
            )
          returning ${PUBLICATION_JOB_COLUMNS}
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'publication', candidate_id, 'publication_job_claimed', $2,
            jsonb_build_object('jobId', id, 'attemptCount', attempt_count)
          from updated
        )
        select ${PUBLICATION_JOB_COLUMNS}
        from updated
        `,
        [
          id,
          normalizeRequiredText(input.workerId, 'workerId'),
          normalizeLeaseSeconds(input.leaseSeconds),
        ],
      );
      const row = response.rows[0];
      if (row === undefined) {
        if ((await this.get(id)) === undefined) {
          throw new KnowledgePublicationJobNotFoundError(id);
        }
        throw new InvalidKnowledgePublicationJobStateError(id, 'queued or have an expired lease');
      }
      return mapKnowledgePublicationJobRow(row);
    },

    async claimNext(input): Promise<KnowledgePublicationJob | undefined> {
      return withTransaction(options.client, async (client) => {
        const response = await queryDatabase<KnowledgePublicationJobRow>(
          client,
          `
          with next_job as (
            select id
            from knowledge_publication_jobs
            where
              status = 'queued'
              or (status = 'running' and lease_expires_at < now())
            order by created_at, id
            for update skip locked
            limit 1
          ), updated as (
            update knowledge_publication_jobs jobs
            set
              status = 'running',
              worker_id = $1,
              attempt_count = attempt_count + 1,
              lease_expires_at = now() + make_interval(secs => $2),
              last_error = null,
              started_at = now(),
              completed_at = null,
              updated_at = now()
            from next_job
            where jobs.id = next_job.id
            returning ${prefixColumns(PUBLICATION_JOB_COLUMNS, 'jobs')}
          ), audited as (
            insert into knowledge_governance_audit_events (
              entity_type, entity_id, event_type, actor, details
            )
            select
              'publication', candidate_id, 'publication_job_claimed', $1,
              jsonb_build_object('jobId', id, 'attemptCount', attempt_count)
            from updated
          )
          select ${PUBLICATION_JOB_COLUMNS}
          from updated
          `,
          [
            normalizeRequiredText(input.workerId, 'workerId'),
            normalizeLeaseSeconds(input.leaseSeconds),
          ],
        );
        const row = response.rows[0];
        return row === undefined ? undefined : mapKnowledgePublicationJobRow(row);
      });
    },

    async complete(input): Promise<KnowledgePublicationJob> {
      const id = normalizeRequiredText(input.id, 'id');
      const documentId = normalizeRequiredText(input.documentId, 'documentId');
      const runId = normalizeOptionalText(input.runId) ?? null;
      const workerId = normalizeRequiredText(input.workerId, 'workerId');
      const attemptCount = normalizeAttemptCount(input.attemptCount);
      const response = await queryDatabase<KnowledgePublicationJobRow>(
        options.client,
        `
        with selected as (
          select id, candidate_id
          from knowledge_publication_jobs
          where
            id = $1
            and status = 'running'
            and worker_id = $4
            and attempt_count = $5
          for update
        ), published as (
          update knowledge_candidates candidates
          set
            status = 'published',
            published_document_id = $2,
            published_at = now(),
            updated_at = now()
          from selected
          where candidates.id = selected.candidate_id and candidates.status = 'approved'
          returning candidates.id
        ), updated as (
          update knowledge_publication_jobs jobs
          set
            status = 'succeeded',
            document_id = $2,
            run_id = $3,
            lease_expires_at = null,
            last_error = null,
            completed_at = now(),
            updated_at = now()
          from selected, published
          where jobs.id = selected.id and published.id = selected.candidate_id
          returning ${prefixColumns(PUBLICATION_JOB_COLUMNS, 'jobs')}
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'publication', candidate_id, 'candidate_published',
            coalesce(worker_id, 'system:publisher'),
            jsonb_build_object(
              'candidateId', candidate_id,
              'documentId', document_id,
              'jobId', id,
              'runId', run_id
            )
          from updated
        )
        select ${PUBLICATION_JOB_COLUMNS}
        from updated
        `,
        [id, documentId, runId, workerId, attemptCount],
      );
      const row = response.rows[0];
      if (row !== undefined) {
        return mapKnowledgePublicationJobRow(row);
      }

      const existing = await this.get(id);
      if (
        existing?.status === 'succeeded' &&
        existing.documentId === documentId &&
        (runId === null || existing.runId === runId)
      ) {
        return existing;
      }
      if (existing === undefined) {
        throw new KnowledgePublicationJobNotFoundError(id);
      }
      throw new InvalidKnowledgePublicationJobStateError(id, 'running with an approved candidate');
    },

    async fail(input): Promise<KnowledgePublicationJob> {
      const id = normalizeRequiredText(input.id, 'id');
      const error = normalizePublicationError(input.error);
      const workerId = normalizeRequiredText(input.workerId, 'workerId');
      const attemptCount = normalizeAttemptCount(input.attemptCount);
      const response = await queryDatabase<KnowledgePublicationJobRow>(
        options.client,
        `
        with updated as (
          update knowledge_publication_jobs
          set
            status = 'failed',
            lease_expires_at = null,
            last_error = $2,
            completed_at = now(),
            updated_at = now()
          where
            id = $1
            and status = 'running'
            and worker_id = $3
            and attempt_count = $4
          returning ${PUBLICATION_JOB_COLUMNS}
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'publication', candidate_id, 'publication_job_failed',
            coalesce(worker_id, 'system:publisher'),
            jsonb_build_object('jobId', id, 'attemptCount', attempt_count, 'error', last_error)
          from updated
        )
        select ${PUBLICATION_JOB_COLUMNS}
        from updated
        `,
        [id, error, workerId, attemptCount],
      );
      const row = response.rows[0];
      if (row === undefined) {
        if ((await this.get(id)) === undefined) {
          throw new KnowledgePublicationJobNotFoundError(id);
        }
        throw new InvalidKnowledgePublicationJobStateError(id, 'running before failure');
      }
      return mapKnowledgePublicationJobRow(row);
    },

    async get(id): Promise<KnowledgePublicationJob | undefined> {
      const response = await queryDatabase<KnowledgePublicationJobRow>(
        options.client,
        `
        select ${PUBLICATION_JOB_COLUMNS}
        from knowledge_publication_jobs
        where id = $1
        `,
        [normalizeRequiredText(id, 'id')],
      );
      const row = response.rows[0];
      return row === undefined ? undefined : mapKnowledgePublicationJobRow(row);
    },

    async list(input = {}): Promise<KnowledgePublicationJob[]> {
      const filters: string[] = [];
      const values: unknown[] = [];
      if (input.status !== undefined) {
        values.push(input.status);
        filters.push(`status = $${values.length}`);
      }
      if (input.candidateId !== undefined) {
        values.push(normalizeRequiredText(input.candidateId, 'candidateId'));
        filters.push(`candidate_id = $${values.length}`);
      }
      values.push(normalizeListLimit(input.limit));
      const response = await queryDatabase<KnowledgePublicationJobRow>(
        options.client,
        `
        select ${PUBLICATION_JOB_COLUMNS}
        from knowledge_publication_jobs
        ${filters.length === 0 ? '' : `where ${filters.join(' and ')}`}
        order by created_at desc, id
        limit $${values.length}
        `,
        values,
      );
      return response.rows.map(mapKnowledgePublicationJobRow);
    },

    migrate(): Promise<void> {
      return migrateKnowledgePublicationJobs(options.client);
    },

    async request(input): Promise<KnowledgePublicationJob> {
      const candidateId = normalizeRequiredText(input.candidateId, 'candidateId');
      const requestedBy = normalizeRequiredText(input.requestedBy, 'requestedBy');
      const id = publicationJobId(candidateId);
      const response = await queryDatabase<KnowledgePublicationJobRow>(
        options.client,
        `
        with candidate as (
          select id
          from knowledge_candidates
          where id = $1 and status = 'approved'
        ), inserted as (
          insert into knowledge_publication_jobs (id, candidate_id, requested_by)
          select $2, id, $3
          from candidate
          on conflict (candidate_id) do nothing
          returning ${PUBLICATION_JOB_COLUMNS}
        ), selected as (
          select ${PUBLICATION_JOB_COLUMNS}
          from inserted
          union all
          select ${PUBLICATION_JOB_COLUMNS}
          from knowledge_publication_jobs
          where candidate_id = $1 and not exists (select 1 from inserted)
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'publication', candidate_id, 'publication_requested', $3,
            jsonb_build_object('jobId', id, 'status', status)
          from inserted
        )
        select ${PUBLICATION_JOB_COLUMNS}
        from selected
        `,
        [candidateId, id, requestedBy],
      );
      const row = response.rows[0];
      if (row !== undefined) {
        return mapKnowledgePublicationJobRow(row);
      }

      const existing = await this.list({ candidateId, limit: 1 });
      const job = existing[0];
      if (job?.status === 'succeeded') {
        return job;
      }
      throw new InvalidKnowledgeCandidateStateError(candidateId, 'approved before publication');
    },

    async retry(input): Promise<KnowledgePublicationJob> {
      const id = normalizeRequiredText(input.id, 'id');
      const requestedBy = normalizeRequiredText(input.requestedBy, 'requestedBy');
      const response = await queryDatabase<KnowledgePublicationJobRow>(
        options.client,
        `
        with updated as (
          update knowledge_publication_jobs jobs
          set
            status = 'queued',
            requested_by = $2,
            worker_id = null,
            lease_expires_at = null,
            last_error = null,
            completed_at = null,
            updated_at = now()
          from knowledge_candidates candidates
          where
            jobs.id = $1
            and jobs.status = 'failed'
            and candidates.id = jobs.candidate_id
            and candidates.status = 'approved'
          returning ${prefixColumns(PUBLICATION_JOB_COLUMNS, 'jobs')}
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'publication', candidate_id, 'publication_job_retried', $2,
            jsonb_build_object('jobId', id, 'attemptCount', attempt_count)
          from updated
        )
        select ${PUBLICATION_JOB_COLUMNS}
        from updated
        `,
        [id, requestedBy],
      );
      const row = response.rows[0];
      if (row === undefined) {
        if ((await this.get(id)) === undefined) {
          throw new KnowledgePublicationJobNotFoundError(id);
        }
        throw new InvalidKnowledgePublicationJobStateError(
          id,
          'failed with a still-approved candidate before retry',
        );
      }
      return mapKnowledgePublicationJobRow(row);
    },
  };
}

export async function migrateKnowledgePublicationJobs(client: PgClientLike): Promise<void> {
  await migrateKnowledgeCandidates(client);
  await queryDatabase(
    client,
    `
    create table if not exists knowledge_publication_jobs (
      id text primary key,
      candidate_id text not null unique references knowledge_candidates(id) on delete restrict,
      status text not null default 'queued' check (
        status in ('queued', 'running', 'failed', 'succeeded')
      ),
      requested_by text not null,
      worker_id text,
      attempt_count integer not null default 0 check (attempt_count >= 0),
      lease_expires_at timestamptz,
      last_error text,
      document_id text,
      run_id text,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_publication_jobs_status_created_at_idx
      on knowledge_publication_jobs (status, created_at)
    `,
  );
  await queryDatabase(
    client,
    `
    insert into knowledge_publication_jobs (
      id, candidate_id, status, requested_by, attempt_count,
      document_id, completed_at, created_at, updated_at
    )
    select
      'knowledge_publication_' || left(md5(id), 20),
      id,
      'succeeded',
      coalesce(reviewed_by, 'system:migration'),
      1,
      published_document_id,
      published_at,
      coalesce(reviewed_at, created_at),
      coalesce(published_at, updated_at)
    from knowledge_candidates
    where status = 'published' and published_document_id is not null
    on conflict (candidate_id) do nothing
    `,
  );
}

function publicationJobId(candidateId: string): string {
  return `knowledge_publication_${createHash('sha256').update(candidateId).digest('hex').slice(0, 20)}`;
}

function mapKnowledgePublicationJobRow(row: KnowledgePublicationJobRow): KnowledgePublicationJob {
  return {
    attemptCount: row.attempt_count,
    candidateId: row.candidate_id,
    createdAt: row.created_at,
    id: row.id,
    requestedBy: row.requested_by,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.document_id === null ? {} : { documentId: row.document_id }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.worker_id === null ? {} : { workerId: row.worker_id }),
  };
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function normalizePublicationError(value: string): string {
  return normalizeRequiredText(value, 'error').slice(0, 4000);
}

function normalizeLeaseSeconds(value: number | undefined): number {
  if (value === undefined) {
    return 30 * 60;
  }
  if (!Number.isInteger(value) || value < 30 || value > 24 * 60 * 60) {
    throw new Error('leaseSeconds must be an integer between 30 and 86400.');
  }
  return value;
}

function normalizeAttemptCount(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('attemptCount must be a positive integer.');
  }
  return value;
}

function normalizeListLimit(value: number | undefined): number {
  if (value === undefined) {
    return 50;
  }
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error('limit must be an integer between 1 and 500.');
  }
  return value;
}

function prefixColumns(columns: string, alias: string): string {
  return columns
    .split(',')
    .map((column) => {
      const trimmed = column.trim();
      const expression = trimmed.replace(/::text as .+$/u, '');
      const outputName = trimmed.match(/ as (\w+)$/u)?.[1];
      return `${alias}.${expression}${outputName === undefined ? '' : ` as ${outputName}`}`;
    })
    .join(',\n');
}

async function withTransaction<T>(
  client: PgClientLike,
  operation: (client: PgClientLike) => Promise<T>,
): Promise<T> {
  if (client.connect === undefined || client.release !== undefined) {
    return operation(client);
  }
  const transactionClient = await client.connect();
  try {
    await transactionClient.query('begin');
    const result = await operation(transactionClient);
    await transactionClient.query('commit');
    return result;
  } catch (error) {
    await transactionClient.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    transactionClient.release();
  }
}

async function queryDatabase<T>(
  client: PgClientLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ rows: T[] }> {
  try {
    return await client.query<T>(sql, values);
  } catch (error) {
    throw new Error('Knowledge publication job database operation failed.', { cause: error });
  }
}
