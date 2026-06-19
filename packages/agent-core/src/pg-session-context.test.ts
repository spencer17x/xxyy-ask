import { describe, expect, it } from 'vitest';

import { createPgSessionContextStore, migratePgSessionContextStore } from './pg-session-context.js';
import type { SessionTurn } from './session-context.js';

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

describe('createPgSessionContextStore', () => {
  it('migrates customer agent session turn storage', async () => {
    const client = new FakePgClient();

    await migratePgSessionContextStore(client);

    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists customer_agent_session_turns');
    expect(sql).toContain("role text not null check (role in ('assistant', 'user'))");
    expect(sql).toContain('customer_agent_session_turns_session_created_idx');
  });

  it('appends sanitized turns and prunes old turns for the same session', async () => {
    const client = new FakePgClient();
    const store = createPgSessionContextStore({ client, maxTurnsPerSession: 4 });
    const turn: SessionTurn = {
      content:
        '我的钱包 0x1111111111111111111111111111111111111111，交易 0x2222222222222222222222222222222222222222222222222222222222222222',
      createdAt: '2026-06-19T08:00:00.000Z',
      metadata: { confidence: 0.8, intent: 'product_qa' },
      role: 'user',
    };

    await store.appendTurn('session-1', turn);

    expect(client.queries[0]?.sql).toContain('insert into customer_agent_session_turns');
    expect(client.queries[0]?.values).toEqual([
      'session-1',
      'user',
      '我的钱包 [evm_address]，交易 [evm_tx_hash]',
      JSON.stringify({ confidence: 0.8, intent: 'product_qa' }),
      '2026-06-19T08:00:00.000Z',
    ]);
    expect(client.queries[1]?.sql).toContain('delete from customer_agent_session_turns');
    expect(client.queries[1]?.values).toEqual(['session-1', 4]);
  });

  it('returns recent turns in chronological order', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content: '怎么升级？',
        created_at: '2026-06-19T08:02:00.000Z',
        metadata: { intent: 'how_to' },
        role: 'user',
      },
      {
        content: 'XXYY Pro 有哪些权益？',
        created_at: '2026-06-19T08:01:00.000Z',
        metadata: { confidence: 0.7, intent: 'product_qa' },
        role: 'assistant',
      },
    ];
    const store = createPgSessionContextStore({ client, maxTurnsPerSession: 12 });

    await expect(store.getRecentTurns('session-1', 2)).resolves.toEqual([
      {
        content: 'XXYY Pro 有哪些权益？',
        createdAt: '2026-06-19T08:01:00.000Z',
        metadata: { confidence: 0.7, intent: 'product_qa' },
        role: 'assistant',
      },
      {
        content: '怎么升级？',
        createdAt: '2026-06-19T08:02:00.000Z',
        metadata: { intent: 'how_to' },
        role: 'user',
      },
    ]);
    expect(client.queries[0]?.sql).toContain('order by created_at desc, id desc');
    expect(client.queries[0]?.values).toEqual(['session-1', 2]);
  });
});
