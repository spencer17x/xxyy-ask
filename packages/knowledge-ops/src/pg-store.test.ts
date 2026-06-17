import { describe, expect, it } from 'vitest';

import { createPgKnowledgeOpsStore } from './pg-store.js';
import type { KnowledgeCandidate, RawSupportMessage } from './types.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: unknown[] = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    const rows = this.queuedRows.length > 0 ? (this.queuedRows.shift() ?? []) : this.rows;
    return Promise.resolve({ rows: rows as T[] });
  }
}

const rawMessage: RawSupportMessage = {
  source: 'telegram',
  chatIdHash: 'support_chat_hash',
  contentHash: 'raw_content_hash',
  ingestedAt: '2026-06-17T02:00:00.000Z',
  messageId: '101',
  replyToMessageId: '100',
  senderRole: 'support',
  sentAt: '2026-06-17T01:59:00.000Z',
  text: '在钱包监控里配置 Telegram Bot。',
  threadId: 'thread-1',
};

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    confidence: 0.8,
    createdAt: '2026-06-17T02:00:00.000Z',
    existingKnowledgeMatches: [],
    generatedEvalCases: [
      {
        expectedAnswer: '在钱包监控里配置 Telegram Bot。',
        question: 'Telegram 通知怎么设置？',
      },
    ],
    id: 'kc_telegram_setup',
    proposedAnswer: '在钱包监控里配置 Telegram Bot。',
    question: 'Telegram 通知怎么设置？',
    redactionReport: {
      entities: [],
      riskFlags: [],
      riskLevel: 'low',
    },
    riskLevel: 'low',
    sourceRefs: [{ source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '100' }],
    status: 'needs_review',
    targetCategory: 'product_faq',
    type: 'faq',
    updatedAt: '2026-06-17T02:00:00.000Z',
    ...overrides,
  };
}

describe('createPgKnowledgeOpsStore', () => {
  it('migrates raw support message and knowledge candidate tables', async () => {
    const client = new FakePgClient();
    const store = createPgKnowledgeOpsStore({ client });

    await store.migrate();

    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists support_raw_messages');
    expect(sql).toContain('unique (source, chat_id_hash, message_id)');
    expect(sql).toContain('create table if not exists knowledge_candidates');
    expect(sql).toContain("status in ('draft', 'needs_review', 'approved', 'rejected'");
    expect(sql).toContain('create table if not exists knowledge_candidate_runs');
    expect(sql).toContain("run_type in ('publish', 'ingest', 'eval')");
    expect(sql).toContain('create table if not exists knowledge_source_cursors');
    expect(sql).toContain('primary key (source, cursor_key)');
  });

  it('upserts and lists raw support messages without storing clear chat identifiers', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        attachments_metadata: { fileName: 'guide.png' },
        chat_id_hash: 'support_chat_hash',
        content_hash: 'raw_content_hash',
        ingested_at: '2026-06-17T02:00:00.000Z',
        message_id: '101',
        reply_to_message_id: '100',
        sender_role: 'support',
        sent_at: '2026-06-17T01:59:00.000Z',
        source: 'telegram',
        text: '在钱包监控里配置 Telegram Bot。',
        thread_id: 'thread-1',
      },
    ];
    const store = createPgKnowledgeOpsStore({ client });

    await store.upsertRawMessages([rawMessage]);
    const messages = await store.listRawMessages({
      chatIdHash: 'support_chat_hash',
      source: 'telegram',
    });

    expect(client.queries[0]?.sql).toContain('insert into support_raw_messages');
    expect(client.queries[0]?.values).toEqual([
      'telegram',
      'support_chat_hash',
      '101',
      'thread-1',
      '100',
      'support',
      '2026-06-17T01:59:00.000Z',
      '在钱包监控里配置 Telegram Bot。',
      'raw_content_hash',
      '2026-06-17T02:00:00.000Z',
      null,
    ]);
    expect(client.queries[1]?.sql).toContain('where source = $1 and chat_id_hash = $2');
    expect(messages).toEqual([
      {
        ...rawMessage,
        attachmentsMetadata: { fileName: 'guide.png' },
      },
    ]);
  });

  it('upserts candidates and preserves reviewed status on duplicate mining', async () => {
    const client = new FakePgClient();
    const store = createPgKnowledgeOpsStore({ client });

    await store.addCandidates([candidate()]);

    expect(client.queries[0]?.sql).toContain('insert into knowledge_candidates');
    expect(client.queries[0]?.sql).toContain(
      "when knowledge_candidates.status in ('draft', 'needs_review')",
    );
    expect(client.queries[0]?.values).toEqual([
      'kc_telegram_setup',
      'faq',
      'needs_review',
      'Telegram 通知怎么设置？',
      '在钱包监控里配置 Telegram Bot。',
      'product_faq',
      JSON.stringify([{ source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '100' }]),
      JSON.stringify({ entities: [], riskFlags: [], riskLevel: 'low' }),
      JSON.stringify([]),
      0.8,
      'low',
      JSON.stringify([
        {
          expectedAnswer: '在钱包监控里配置 Telegram Bot。',
          question: 'Telegram 通知怎么设置？',
        },
      ]),
      null,
      null,
      null,
      '2026-06-17T02:00:00.000Z',
      '2026-06-17T02:00:00.000Z',
    ]);
  });

  it('reads and writes source cursors for incremental Telegram collection', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ cursor_value: '124' }], [], []];
    const store = createPgKnowledgeOpsStore({ client });

    const existingCursor = await store.getSourceCursor({
      cursorKey: 'telegram_updates:allowed_chats_hash',
      source: 'telegram',
    });
    await store.setSourceCursor({
      cursorKey: 'telegram_updates:allowed_chats_hash',
      cursorValue: '130',
      source: 'telegram',
      updatedAt: '2026-06-17T04:00:00.000Z',
    });
    const missingCursor = await store.getSourceCursor({
      cursorKey: 'telegram_updates:other',
      source: 'telegram',
    });

    expect(existingCursor).toBe('124');
    expect(missingCursor).toBeUndefined();
    expect(client.queries[0]?.sql).toContain('from knowledge_source_cursors');
    expect(client.queries[0]?.values).toEqual(['telegram', 'telegram_updates:allowed_chats_hash']);
    expect(client.queries[1]?.sql).toContain('insert into knowledge_source_cursors');
    expect(client.queries[1]?.values).toEqual([
      'telegram',
      'telegram_updates:allowed_chats_hash',
      '130',
      '2026-06-17T04:00:00.000Z',
    ]);
  });

  it('lists candidates by review queue filters and maps JSON fields', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        confidence: 0.65,
        created_at: '2026-06-17T02:00:00.000Z',
        existing_knowledge_matches: [],
        generated_eval_cases: [
          {
            expectedAnswer: '不能查询账户余额。',
            question: '帮我查钱包余额。',
          },
        ],
        id: 'kc_boundary',
        proposed_answer: '不能查询账户余额。',
        published_target: null,
        question: '帮我查钱包余额。',
        redaction_report: {
          entities: [],
          riskFlags: ['private_account_query'],
          riskLevel: 'high',
        },
        review_notes: null,
        reviewer: null,
        risk_level: 'high',
        source_refs: [{ source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '200' }],
        status: 'needs_review',
        target_category: 'policy_boundary',
        type: 'boundary_example',
        updated_at: '2026-06-17T02:30:00.000Z',
      },
    ];
    const store = createPgKnowledgeOpsStore({ client });

    const candidates = await store.listCandidates({
      limit: 10,
      riskLevel: 'high',
      status: 'needs_review',
      type: 'boundary_example',
    });

    expect(client.queries[0]?.sql).toContain('where status = $1 and type = $2 and risk_level = $3');
    expect(client.queries[0]?.values).toEqual(['needs_review', 'boundary_example', 'high', 10]);
    expect(candidates).toEqual([
      candidate({
        confidence: 0.65,
        generatedEvalCases: [
          {
            expectedAnswer: '不能查询账户余额。',
            question: '帮我查钱包余额。',
          },
        ],
        id: 'kc_boundary',
        proposedAnswer: '不能查询账户余额。',
        question: '帮我查钱包余额。',
        redactionReport: {
          entities: [],
          riskFlags: ['private_account_query'],
          riskLevel: 'high',
        },
        riskLevel: 'high',
        sourceRefs: [{ source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '200' }],
        targetCategory: 'policy_boundary',
        type: 'boundary_example',
        updatedAt: '2026-06-17T02:30:00.000Z',
      }),
    ]);
  });

  it('gets candidates by id from Postgres', async () => {
    const client = new FakePgClient();
    client.rows = [toPgCandidateRow(candidate({ status: 'approved' }))];
    const store = createPgKnowledgeOpsStore({ client });

    const found = await store.getCandidate('kc_telegram_setup');

    expect(client.queries[0]?.sql).toContain('from knowledge_candidates');
    expect(client.queries[0]?.sql).toContain('where id = $1');
    expect(client.queries[0]?.values).toEqual(['kc_telegram_setup']);
    expect(found).toMatchObject({
      id: 'kc_telegram_setup',
      status: 'approved',
    });
  });

  it('marks only approved Postgres candidates as published', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [toPgCandidateRow(candidate({ status: 'approved' }))],
      [
        toPgCandidateRow(
          candidate({
            publishedTarget: 'pages/65-reviewed-support-knowledge.md#kc_telegram_setup',
            status: 'published',
            updatedAt: '2026-06-17T05:00:00.000Z',
          }),
        ),
      ],
      [toPgCandidateRow(candidate({ id: 'kc_waiting', status: 'needs_review' }))],
      [],
    ];
    const store = createPgKnowledgeOpsStore({ client });

    const published = await store.markCandidatePublished('kc_telegram_setup', {
      publishedAt: '2026-06-17T05:00:00.000Z',
      publishedTarget: 'pages/65-reviewed-support-knowledge.md#kc_telegram_setup',
    });

    expect(client.queries[1]?.sql).toContain('update knowledge_candidates');
    expect(client.queries[1]?.values).toEqual([
      'published',
      'pages/65-reviewed-support-knowledge.md#kc_telegram_setup',
      '2026-06-17T05:00:00.000Z',
      'kc_telegram_setup',
    ]);
    expect(published).toMatchObject({
      publishedTarget: 'pages/65-reviewed-support-knowledge.md#kc_telegram_setup',
      status: 'published',
      updatedAt: '2026-06-17T05:00:00.000Z',
    });
    await expect(
      store.markCandidatePublished('kc_waiting', {
        publishedAt: '2026-06-17T05:00:00.000Z',
        publishedTarget: 'pages/65-reviewed-support-knowledge.md#kc_waiting',
      }),
    ).rejects.toThrow(
      'Knowledge candidate kc_waiting must be approved before publishing; current status is needs_review.',
    );
    await expect(
      store.markCandidatePublished('missing', {
        publishedAt: '2026-06-17T05:00:00.000Z',
        publishedTarget: 'pages/65-reviewed-support-knowledge.md#missing',
      }),
    ).rejects.toThrow('Knowledge candidate not found: missing');
  });

  it('marks Postgres candidates as ingested and records eval gate results', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [toPgCandidateRow(candidate({ status: 'published' }))],
      [
        toPgCandidateRow(
          candidate({
            status: 'ingested',
            updatedAt: '2026-06-17T06:00:00.000Z',
          }),
        ),
      ],
      [toPgCandidateRow(candidate({ status: 'ingested' }))],
      [
        toPgCandidateRow(
          candidate({
            status: 'eval_failed',
            updatedAt: '2026-06-17T06:10:00.000Z',
          }),
        ),
      ],
      [toPgCandidateRow(candidate({ id: 'kc_waiting', status: 'approved' }))],
    ];
    const store = createPgKnowledgeOpsStore({ client });

    const ingested = await store.markCandidateIngested('kc_telegram_setup', {
      ingestedAt: '2026-06-17T06:00:00.000Z',
    });
    const evaluated = await store.markCandidateEvalResult('kc_telegram_setup', {
      evaluatedAt: '2026-06-17T06:10:00.000Z',
      passed: false,
    });

    expect(client.queries[1]?.sql).toContain('update knowledge_candidates');
    expect(client.queries[1]?.values).toEqual([
      'ingested',
      '2026-06-17T06:00:00.000Z',
      'kc_telegram_setup',
    ]);
    expect(client.queries[3]?.values).toEqual([
      'eval_failed',
      '2026-06-17T06:10:00.000Z',
      'kc_telegram_setup',
    ]);
    expect(ingested).toMatchObject({
      status: 'ingested',
      updatedAt: '2026-06-17T06:00:00.000Z',
    });
    expect(evaluated).toMatchObject({
      status: 'eval_failed',
      updatedAt: '2026-06-17T06:10:00.000Z',
    });
    await expect(
      store.markCandidateIngested('kc_waiting', {
        ingestedAt: '2026-06-17T06:00:00.000Z',
      }),
    ).rejects.toThrow(
      'Knowledge candidate kc_waiting cannot be marked ingested from approved; expected status is published.',
    );
  });

  it('records and lists Postgres candidate publish, ingest, and eval runs', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [toPgCandidateRow(candidate({ status: 'published' }))],
      [
        {
          candidate_id: 'kc_telegram_setup',
          created_at: '2026-06-17T06:10:00.000Z',
          metadata: { failures: [] },
          run_id: 'eval_20260617T061000Z_abcd1234',
          run_type: 'eval',
          status: 'passed',
        },
      ],
      [
        {
          candidate_id: 'kc_telegram_setup',
          created_at: '2026-06-17T05:00:00.000Z',
          metadata: {
            publishedTarget: 'pages/support-faq.md#kc_telegram_setup',
          },
          run_id: 'publish_20260617T050000Z_abcd1234',
          run_type: 'publish',
          status: 'completed',
        },
        {
          candidate_id: 'kc_telegram_setup',
          created_at: '2026-06-17T06:10:00.000Z',
          metadata: { failures: [] },
          run_id: 'eval_20260617T061000Z_abcd1234',
          run_type: 'eval',
          status: 'passed',
        },
      ],
      [],
    ];
    const store = createPgKnowledgeOpsStore({ client });

    const recorded = await store.recordCandidateRun({
      candidateId: 'kc_telegram_setup',
      createdAt: '2026-06-17T06:10:00.000Z',
      metadata: { failures: [] },
      runId: 'eval_20260617T061000Z_abcd1234',
      runType: 'eval',
      status: 'passed',
    });
    const runs = await store.listCandidateRuns('kc_telegram_setup');

    expect(client.queries[1]?.sql).toContain('insert into knowledge_candidate_runs');
    expect(client.queries[1]?.values).toEqual([
      'kc_telegram_setup',
      'eval_20260617T061000Z_abcd1234',
      'eval',
      'passed',
      JSON.stringify({ failures: [] }),
      '2026-06-17T06:10:00.000Z',
    ]);
    expect(client.queries[2]?.sql).toContain('from knowledge_candidate_runs');
    expect(client.queries[2]?.values).toEqual(['kc_telegram_setup']);
    expect(recorded).toMatchObject({
      candidateId: 'kc_telegram_setup',
      runId: 'eval_20260617T061000Z_abcd1234',
      runType: 'eval',
      status: 'passed',
    });
    expect(runs).toEqual([
      expect.objectContaining({
        runId: 'publish_20260617T050000Z_abcd1234',
        runType: 'publish',
      }),
      expect.objectContaining({
        metadata: { failures: [] },
        runType: 'eval',
      }),
    ]);
    await expect(
      store.recordCandidateRun({
        candidateId: 'missing',
        runId: 'eval_missing',
        runType: 'eval',
        status: 'failed',
      }),
    ).rejects.toThrow('Knowledge candidate not found: missing');
  });

  it('records human review decisions in Postgres', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        ...toPgCandidateRow(candidate({ status: 'approved' })),
        review_notes: '审核通过，等待发布。',
        reviewer: 'ops@example.com',
        updated_at: '2026-06-17T03:00:00.000Z',
      },
    ];
    const store = createPgKnowledgeOpsStore({ client });

    const reviewed = await store.reviewCandidate('kc_telegram_setup', {
      action: 'approve',
      notes: '审核通过，等待发布。',
      reviewedAt: '2026-06-17T03:00:00.000Z',
      reviewer: 'ops@example.com',
    });

    expect(client.queries[0]?.sql).toContain('update knowledge_candidates');
    expect(client.queries[0]?.values).toEqual([
      'approved',
      'ops@example.com',
      '审核通过，等待发布。',
      '2026-06-17T03:00:00.000Z',
      'kc_telegram_setup',
    ]);
    expect(reviewed).toMatchObject({
      reviewNotes: '审核通过，等待发布。',
      reviewer: 'ops@example.com',
      status: 'approved',
      updatedAt: '2026-06-17T03:00:00.000Z',
    });
    expect(reviewed.publishedTarget).toBeUndefined();
  });

  it('rejects reviewing a missing Postgres candidate', async () => {
    const client = new FakePgClient();
    client.rows = [];
    const store = createPgKnowledgeOpsStore({ client });

    await expect(
      store.reviewCandidate('missing', {
        action: 'reject',
        reviewedAt: '2026-06-17T03:00:00.000Z',
        reviewer: 'ops@example.com',
      }),
    ).rejects.toThrow('Knowledge candidate not found: missing');
  });
});

function toPgCandidateRow(input: KnowledgeCandidate): Record<string, unknown> {
  return {
    confidence: input.confidence,
    created_at: input.createdAt,
    existing_knowledge_matches: input.existingKnowledgeMatches,
    generated_eval_cases: input.generatedEvalCases,
    id: input.id,
    proposed_answer: input.proposedAnswer,
    published_target: input.publishedTarget ?? null,
    question: input.question,
    redaction_report: input.redactionReport,
    review_notes: input.reviewNotes ?? null,
    reviewer: input.reviewer ?? null,
    risk_level: input.riskLevel,
    source_refs: input.sourceRefs,
    status: input.status,
    target_category: input.targetCategory,
    type: input.type,
    updated_at: input.updatedAt,
  };
}
