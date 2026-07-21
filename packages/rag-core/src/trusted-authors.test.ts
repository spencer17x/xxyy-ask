import { describe, expect, it } from 'vitest';

import { createPgTrustedAuthorStore } from './trusted-authors.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: (this.queuedRows.shift() ?? []) as T[] });
  }
}

describe('createPgTrustedAuthorStore', () => {
  it('migrates time-bounded trusted authors and governance audit events', async () => {
    const client = new FakePgClient();
    const store = createPgTrustedAuthorStore({ client });

    await store.migrate();

    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists knowledge_governance_audit_events');
    expect(sql).toContain('create table if not exists knowledge_trusted_authors');
    expect(sql).toContain('check (valid_to is null or valid_to > valid_from)');
    expect(sql).toContain('knowledge_trusted_authors_active_idx');
  });

  it('normalizes a trusted author and records the verification actor', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[trustedAuthorRow()]];
    const store = createPgTrustedAuthorStore({ client });

    const author = await store.trust({
      chatId: ' -100123 ',
      role: 'administrator',
      userId: 'user456',
      validFrom: '2026-07-01',
      validTo: '2026-08-01',
      verificationSource: 'manual',
      verifiedBy: 'operator:alice',
    });

    expect(author).toMatchObject({
      chatId: '-100123',
      role: 'administrator',
      userId: '456',
      verificationSource: 'manual',
      verifiedBy: 'operator:alice',
    });
    expect(client.queries[0]?.sql).toContain("'trusted_author_upserted'");
    expect(client.queries[0]?.values).toEqual([
      expect.stringMatching(/^trusted_author_/u),
      '-100123',
      '456',
      'administrator',
      '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      'manual',
      'operator:alice',
    ]);
  });

  it('resolves only the role interval active at the message time', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[trustedAuthorRow()]];
    const store = createPgTrustedAuthorStore({ client });

    await store.resolve({
      at: '2026-07-15T01:02:00Z',
      chatId: '-100123',
      userId: 'user456',
    });

    expect(client.queries[0]?.sql).toContain('valid_from <= $3::timestamptz');
    expect(client.queries[0]?.sql).toContain('(valid_to is null or valid_to > $3::timestamptz)');
    expect(client.queries[0]?.values).toEqual(['-100123', '456', '2026-07-15T01:02:00.000Z']);
  });

  it('rejects inverted validity windows before writing', async () => {
    const client = new FakePgClient();
    const store = createPgTrustedAuthorStore({ client });

    await expect(
      store.trust({
        chatId: '-100123',
        role: 'owner',
        userId: '456',
        validFrom: '2026-08-01',
        validTo: '2026-07-01',
        verificationSource: 'manual',
        verifiedBy: 'operator:alice',
      }),
    ).rejects.toThrow('validTo must be later than validFrom.');
    expect(client.queries).toHaveLength(0);
  });
});

function trustedAuthorRow() {
  return {
    chat_id: '-100123',
    created_at: '2026-07-15T00:00:00.000Z',
    id: 'trusted_author_1234567890abcdef',
    role: 'administrator' as const,
    updated_at: '2026-07-15T00:00:00.000Z',
    user_id: '456',
    valid_from: '2026-07-01T00:00:00.000Z',
    valid_to: '2026-08-01T00:00:00.000Z',
    verification_source: 'manual' as const,
    verified_at: '2026-07-15T00:00:00.000Z',
    verified_by: 'operator:alice',
  };
}
