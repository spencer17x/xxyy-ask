import { describe, expect, it } from 'vitest';

import { InvalidKnowledgeCandidateStateError } from './knowledge-candidates.js';
import {
  createPgKnowledgePublicationJobStore,
  InvalidKnowledgePublicationJobStateError,
  KnowledgePublicationJobNotFoundError,
} from './knowledge-publication-jobs.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: (this.queuedRows.shift() ?? []) as T[] });
  }
}

describe('createPgKnowledgePublicationJobStore', () => {
  it('migrates a durable publication queue and backfills published candidates', async () => {
    const client = new FakePgClient();
    const store = createPgKnowledgePublicationJobStore({ client });

    await store.migrate();

    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists knowledge_publication_jobs');
    expect(sql).toContain("status in ('queued', 'running', 'failed', 'succeeded')");
    expect(sql).toContain('candidate_id text not null unique');
    expect(sql).toContain("where status = 'published'");
  });

  it('idempotently requests a job only for an approved candidate', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[publicationJobRow()]];
    const store = createPgKnowledgePublicationJobStore({ client });

    const job = await store.request({
      candidateId: 'knowledge_candidate_123',
      requestedBy: 'admin:alice',
    });

    expect(job).toMatchObject({
      candidateId: 'knowledge_candidate_123',
      requestedBy: 'admin:alice',
      status: 'queued',
    });
    expect(client.queries[0]?.sql).toContain("where id = $1 and status = 'approved'");
    expect(client.queries[0]?.sql).toContain('on conflict (candidate_id)');
    expect(client.queries[0]?.sql).toContain("'publication_requested'");
  });

  it('rejects a publication request when the candidate is not approved', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[], []];
    const store = createPgKnowledgePublicationJobStore({ client });

    await expect(
      store.request({ candidateId: 'knowledge_candidate_pending', requestedBy: 'admin:alice' }),
    ).rejects.toBeInstanceOf(InvalidKnowledgeCandidateStateError);
  });

  it('claims queued work with a lease and attempt counter', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        publicationJobRow({
          attempt_count: 1,
          lease_expires_at: '2026-07-21T09:30:00.000Z',
          started_at: '2026-07-21T09:00:00.000Z',
          status: 'running',
          worker_id: 'worker:one',
        }),
      ],
    ];
    const store = createPgKnowledgePublicationJobStore({ client });

    const job = await store.claim({
      id: 'knowledge_publication_123',
      leaseSeconds: 1800,
      workerId: 'worker:one',
    });

    expect(job).toMatchObject({ attemptCount: 1, status: 'running', workerId: 'worker:one' });
    expect(client.queries[0]?.sql).toContain("status = 'queued'");
    expect(client.queries[0]?.sql).toContain('lease_expires_at < now()');
    expect(client.queries[0]?.sql).toContain("'publication_job_claimed'");
  });

  it('completes the candidate and publication job in the same database operation', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        publicationJobRow({
          completed_at: '2026-07-21T09:10:00.000Z',
          document_id: 'admin_verified:knowledge_candidate_123',
          run_id: 'ingestion-1',
          status: 'succeeded',
        }),
      ],
    ];
    const store = createPgKnowledgePublicationJobStore({ client });

    const job = await store.complete({
      attemptCount: 1,
      documentId: 'admin_verified:knowledge_candidate_123',
      id: 'knowledge_publication_123',
      runId: 'ingestion-1',
      workerId: 'worker:one',
    });

    expect(job).toMatchObject({ runId: 'ingestion-1', status: 'succeeded' });
    expect(client.queries[0]?.sql).toContain("candidates.status = 'approved'");
    expect(client.queries[0]?.sql).toContain("status = 'published'");
    expect(client.queries[0]?.sql).toContain('worker_id = $4');
    expect(client.queries[0]?.sql).toContain('attempt_count = $5');
    expect(client.queries[0]?.sql).toContain("'candidate_published'");
  });

  it('records failures and only retries failed jobs whose candidate remains approved', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [publicationJobRow({ last_error: 'retrieval gate failed', status: 'failed' })],
      [publicationJobRow({ requested_by: 'admin:bob' })],
    ];
    const store = createPgKnowledgePublicationJobStore({ client });

    const failed = await store.fail({
      attemptCount: 1,
      error: 'retrieval gate failed',
      id: 'knowledge_publication_123',
      workerId: 'worker:one',
    });
    const retried = await store.retry({
      id: 'knowledge_publication_123',
      requestedBy: 'admin:bob',
    });

    expect(failed).toMatchObject({ lastError: 'retrieval gate failed', status: 'failed' });
    expect(retried).toMatchObject({ requestedBy: 'admin:bob', status: 'queued' });
    expect(client.queries[0]?.sql).toContain("'publication_job_failed'");
    expect(client.queries[0]?.sql).toContain('worker_id = $3');
    expect(client.queries[0]?.sql).toContain('attempt_count = $4');
    expect(client.queries[1]?.sql).toContain("jobs.status = 'failed'");
    expect(client.queries[1]?.sql).toContain("candidates.status = 'approved'");
    expect(client.queries[1]?.sql).toContain("'publication_job_retried'");
  });

  it('does not retry a queued or running job', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[], [publicationJobRow()]];
    const store = createPgKnowledgePublicationJobStore({ client });

    await expect(
      store.retry({ id: 'knowledge_publication_123', requestedBy: 'admin:alice' }),
    ).rejects.toBeInstanceOf(InvalidKnowledgePublicationJobStateError);
  });

  it('fences stale workers from completing or failing a reclaimed attempt', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [],
      [publicationJobRow({ attempt_count: 2, status: 'running', worker_id: 'worker:current' })],
      [],
      [publicationJobRow({ attempt_count: 2, status: 'running', worker_id: 'worker:current' })],
    ];
    const store = createPgKnowledgePublicationJobStore({ client });

    await expect(
      store.complete({
        attemptCount: 1,
        documentId: 'admin_verified:knowledge_candidate_123',
        id: 'knowledge_publication_123',
        workerId: 'worker:stale',
      }),
    ).rejects.toBeInstanceOf(InvalidKnowledgePublicationJobStateError);
    await expect(
      store.fail({
        attemptCount: 1,
        error: 'stale failure',
        id: 'knowledge_publication_123',
        workerId: 'worker:stale',
      }),
    ).rejects.toBeInstanceOf(InvalidKnowledgePublicationJobStateError);

    expect(client.queries[0]?.values).toEqual([
      'knowledge_publication_123',
      'admin_verified:knowledge_candidate_123',
      null,
      'worker:stale',
      1,
    ]);
    expect(client.queries[2]?.values).toEqual([
      'knowledge_publication_123',
      'stale failure',
      'worker:stale',
      1,
    ]);
  });

  it('distinguishes a missing job from an invalid transition', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[], []];
    const store = createPgKnowledgePublicationJobStore({ client });

    await expect(
      store.retry({ id: 'knowledge_publication_missing', requestedBy: 'admin:alice' }),
    ).rejects.toBeInstanceOf(KnowledgePublicationJobNotFoundError);
  });
});

function publicationJobRow(overrides: Record<string, unknown> = {}) {
  return {
    attempt_count: 0,
    candidate_id: 'knowledge_candidate_123',
    completed_at: null,
    created_at: '2026-07-21T09:00:00.000Z',
    document_id: null,
    id: 'knowledge_publication_123',
    last_error: null,
    lease_expires_at: null,
    requested_by: 'admin:alice',
    run_id: null,
    started_at: null,
    status: 'queued' as const,
    updated_at: '2026-07-21T09:00:00.000Z',
    worker_id: null,
    ...overrides,
  };
}
