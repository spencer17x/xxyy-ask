import { describe, expect, it } from 'vitest';

import {
  createPgKnowledgeCandidateStore,
  InvalidKnowledgeCandidateStateError,
} from './knowledge-candidates.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: (this.queuedRows.shift() ?? []) as T[] });
  }
}

describe('createPgKnowledgeCandidateStore', () => {
  it('migrates the candidate review schema', async () => {
    const client = new FakePgClient();
    const store = createPgKnowledgeCandidateStore({ client });

    await store.migrate();

    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists knowledge_candidates');
    expect(sql).toContain("status in ('pending', 'approved', 'rejected', 'published')");
    expect(sql).toContain('knowledge_candidates_status_created_at_idx');
  });

  it('creates redacted candidates idempotently', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        candidateRow({
          canonical_answer: '请联系 [telegram_user]，支持地址 [evm_address]。',
          question: '手机号 [phone] 的用户怎么配置？',
        }),
      ],
      [],
    ];
    const store = createPgKnowledgeCandidateStore({ client });

    const result = await store.createMany([
      {
        canonicalAnswer:
          '请联系 @support_admin，支持地址 0x1234567890123456789012345678901234567890。',
        question: '手机号 +86 138 0013 8000 的用户怎么配置？',
        sourceAnswerMessageId: '2',
        sourceChannel: 'telegram_export',
        sourceChatId: '-100123',
        sourceQuestionMessageId: '1',
        submittedBy: 'user-admin-1',
      },
      {
        canonicalAnswer: '重复答案',
        question: '重复问题',
        sourceChannel: 'telegram_export',
      },
    ]);

    expect(result.created).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
    expect(client.queries[0]?.values[2]).toBe('手机号 [phone] 的用户怎么配置？');
    expect(client.queries[0]?.values[3]).toBe('请联系 [telegram_user]，支持地址 [evm_address]。');
    expect(JSON.stringify(client.queries[0]?.values)).not.toContain('138 0013 8000');
    expect(JSON.stringify(client.queries[0]?.values)).not.toContain('@support_admin');
  });

  it('lists candidates by review status', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[candidateRow({ status: 'approved' })]];
    const store = createPgKnowledgeCandidateStore({ client });

    const candidates = await store.list({ limit: 5, status: 'approved' });

    expect(candidates[0]).toMatchObject({
      id: 'knowledge_candidate_1234567890abcdef',
      status: 'approved',
    });
    expect(client.queries[0]?.sql).toContain('where status = $1');
    expect(client.queries[0]?.values).toEqual(['approved', 5]);
  });

  it('reviews only pending candidates', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        candidateRow({
          effective_at: '2026-07-15T00:00:00.000Z',
          reviewed_at: '2026-07-15T01:00:00.000Z',
          reviewed_by: 'telegram:123',
          source_url: 'https://docs.example.com/feature',
          status: 'approved',
          supersedes: ['official_docs:old-feature'],
        }),
      ],
    ];
    const store = createPgKnowledgeCandidateStore({ client });

    const reviewed = await store.review({
      decision: 'approve',
      effectiveAt: '2026-07-15',
      id: 'knowledge_candidate_1234567890abcdef',
      reviewedBy: 'telegram:123',
      sourceUrl: 'https://docs.example.com/feature',
      supersedes: ['official_docs:old-feature'],
    });

    expect(reviewed).toMatchObject({
      reviewedBy: 'telegram:123',
      sourceUrl: 'https://docs.example.com/feature',
      status: 'approved',
      supersedes: ['official_docs:old-feature'],
    });
    expect(client.queries[0]?.sql).toContain("where id = $1 and status = 'pending'");
  });

  it('rejects invalid review transitions', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[]];
    const store = createPgKnowledgeCandidateStore({ client });

    await expect(
      store.review({
        decision: 'reject',
        id: 'knowledge_candidate_1234567890abcdef',
        reviewedBy: 'telegram:123',
      }),
    ).rejects.toBeInstanceOf(InvalidKnowledgeCandidateStateError);
  });

  it('marks approved candidates as published with a document id', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        candidateRow({
          published_at: '2026-07-15T02:00:00.000Z',
          published_document_id:
            'admin_verified:admin-verified/knowledge_candidate_1234567890abcdef',
          status: 'published',
        }),
      ],
    ];
    const store = createPgKnowledgeCandidateStore({ client });

    const published = await store.markPublished({
      id: 'knowledge_candidate_1234567890abcdef',
      publishedDocumentId: 'admin_verified:admin-verified/knowledge_candidate_1234567890abcdef',
    });

    expect(published.status).toBe('published');
    expect(published.publishedDocumentId).toContain('admin_verified:');
  });
});

function candidateRow(overrides: Record<string, unknown> = {}) {
  return { ...baseCandidateRow(), ...overrides };
}

function baseCandidateRow() {
  return {
    canonical_answer: '是的，XXYY 已支持该功能。',
    content_hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    created_at: '2026-07-15T00:00:00.000Z',
    effective_at: null,
    evidence: null,
    id: 'knowledge_candidate_1234567890abcdef',
    published_at: null,
    published_document_id: null,
    question: 'XXYY 支持该功能吗？',
    review_note: null,
    reviewed_at: null,
    reviewed_by: null,
    source_answer_message_id: '2',
    source_channel: 'telegram_export' as const,
    source_chat_id: '-100123',
    source_question_message_id: '1',
    source_url: null,
    status: 'pending',
    submitted_by: 'user-admin-1',
    supersedes: [],
    updated_at: '2026-07-15T00:00:00.000Z',
  };
}
