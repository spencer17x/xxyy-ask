import { describe, expect, it } from 'vitest';

import {
  createPgSessionContextStore,
  migratePgSessionContextStore,
  summarizePgSessionContext,
} from './pg-session-context.js';
import type { SessionTurn } from './session-context.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  queryRows?: (sql: string, values: readonly unknown[]) => unknown[] | undefined;
  rows: unknown[] = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    const matchedRows = this.queryRows?.(sql, values);
    const rows =
      matchedRows ?? (this.queuedRows.length > 0 ? (this.queuedRows.shift() ?? []) : this.rows);
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
    expect(sql).toContain('create table if not exists customer_agent_session_summaries');
  });

  it('appends sanitized turns, updates safe summaries, and prunes old turns for the same session', async () => {
    const client = new FakePgClient();
    const store = createPgSessionContextStore({ client, maxTurnsPerSession: 4 });
    const turn: SessionTurn = {
      content:
        '我主要用手机端，钱包 0x1111111111111111111111111111111111111111，交易 0x2222222222222222222222222222222222222222222222222222222222222222',
      createdAt: '2026-06-19T08:00:00.000Z',
      metadata: { confidence: 0.8, intent: 'product_qa' },
      role: 'user',
    };

    await store.appendTurn('session-1', turn);

    expect(client.queries[0]?.sql).toContain('insert into customer_agent_session_turns');
    expect(client.queries[0]?.values).toEqual([
      'session-1',
      'user',
      '我主要用手机端，钱包 [evm_address]，交易 [evm_tx_hash]',
      JSON.stringify({ confidence: 0.8, intent: 'product_qa' }),
      '2026-06-19T08:00:00.000Z',
    ]);
    expect(client.queries[1]?.sql).toContain('insert into customer_agent_session_summaries');
    expect(client.queries[1]?.values).toEqual([
      'session-1',
      JSON.stringify({ productPreference: 'XXYY 移动端登录' }),
      '2026-06-19T08:00:00.000Z',
    ]);
    expect(client.queries[2]?.sql).toContain('delete from customer_agent_session_turns');
    expect(client.queries[2]?.values).toEqual(['session-1', 4]);
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

  it('returns safe session summaries', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        summary: { productPreference: 'XXYY 移动端登录' },
        updated_at: '2026-06-19T08:00:00.000Z',
      },
    ];
    const store = createPgSessionContextStore({ client, maxTurnsPerSession: 12 });
    const summaryStore = store as typeof store & {
      getSessionSummary(sessionId: string): Promise<{
        productPreference?: string;
        updatedAt: string;
      } | null>;
    };

    await expect(summaryStore.getSessionSummary('session-1')).resolves.toEqual({
      productPreference: 'XXYY 移动端登录',
      updatedAt: '2026-06-19T08:00:00.000Z',
    });
    expect(client.queries[0]?.sql).toContain('from customer_agent_session_summaries');
    expect(client.queries[0]?.values).toEqual(['session-1']);
  });

  it('clears stored turns and safe summaries for one session', async () => {
    const client = new FakePgClient();
    const store = createPgSessionContextStore({ client, maxTurnsPerSession: 12 });
    const clearableStore = store as typeof store & {
      clearSession(sessionId: string): Promise<void>;
    };

    await clearableStore.clearSession('session-1');

    expect(client.queries[0]?.sql).toContain('delete from customer_agent_session_turns');
    expect(client.queries[0]?.values).toEqual(['session-1']);
    expect(client.queries[1]?.sql).toContain('delete from customer_agent_session_summaries');
    expect(client.queries[1]?.values).toEqual(['session-1']);
  });

  it('summarizes sanitized session context for ops dashboards without exposing raw session ids', async () => {
    const client = new FakePgClient();
    client.queryRows = (sql) => {
      if (sql.includes('count(distinct session_id)')) {
        return [
          {
            active_session_count: '3',
            latest_turn_created_at: '2026-06-19T08:03:00.000Z',
            stored_turn_count: '7',
          },
        ];
      }
      if (sql.includes('max(updated_at) as latest_summary_updated_at')) {
        return [
          {
            gte24h: '1',
            h1to24h: '1',
            latest_summary_updated_at: '2026-06-19T08:04:00.000Z',
            lt1h: '1',
            oldest_summary_updated_at: '2026-06-18T07:59:59.000Z',
            summarized_session_count: '3',
          },
        ];
      }
      if (sql.includes("summary ->> 'productTopic'")) {
        return [
          { count: '1', label: 'Telegram 钱包监控' },
          { count: '1', label: 'XXYY Pro' },
        ];
      }
      if (sql.includes("summary ->> 'productPreference'")) {
        return [{ count: '2', label: 'XXYY 移动端登录' }];
      }
      if (sql.includes('order by updated_at desc')) {
        return [
          {
            session_id: 'session-1',
            summary: {
              productPreference: 'XXYY 移动端登录',
              productTopic: 'XXYY Pro',
            },
            updated_at: '2026-06-19T08:04:00.000Z',
          },
          {
            session_id: 'session-secret',
            summary: '{"productTopic":"Telegram 钱包监控"}',
            updated_at: '2026-06-19T08:02:00.000Z',
          },
        ];
      }

      return [];
    };

    const summary = await summarizePgSessionContext({
      client,
      nowMs: Date.parse('2026-06-19T08:00:00.000Z'),
      recentLimit: 2,
    });

    expect(summary).toEqual({
      activeSessionCount: 3,
      latestSummaryUpdatedAt: '2026-06-19T08:04:00.000Z',
      latestTurnCreatedAt: '2026-06-19T08:03:00.000Z',
      oldestSummaryUpdatedAt: '2026-06-18T07:59:59.000Z',
      productPreferenceCounts: {
        'XXYY 移动端登录': 2,
      },
      productTopicCounts: {
        'Telegram 钱包监控': 1,
        'XXYY Pro': 1,
      },
      recentSummaries: [
        {
          productPreference: 'XXYY 移动端登录',
          productTopic: 'XXYY Pro',
          sessionIdHash: summary.recentSummaries[0]?.sessionIdHash,
          updatedAt: '2026-06-19T08:04:00.000Z',
        },
        {
          productTopic: 'Telegram 钱包监控',
          sessionIdHash: summary.recentSummaries[1]?.sessionIdHash,
          updatedAt: '2026-06-19T08:02:00.000Z',
        },
      ],
      sessionSummaryAgeBuckets: {
        gte24h: 1,
        h1to24h: 1,
        lt1h: 1,
      },
      staleSummaryCount: 1,
      storedTurnCount: 7,
      summarizedSessionCount: 3,
    });
    expect(summary.recentSummaries[0]?.sessionIdHash).toMatch(/^[a-f0-9]{12}$/u);
    expect(summary.recentSummaries[1]?.sessionIdHash).toMatch(/^[a-f0-9]{12}$/u);
    expect(summary.recentSummaries.map((item) => item.sessionIdHash)).not.toContain('session-1');
    expect(summary.recentSummaries.map((item) => item.sessionIdHash)).not.toContain(
      'session-secret',
    );
    expect(client.queries[0]?.sql).toContain('from customer_agent_session_turns');
    expect(client.queries[1]?.sql).toContain('from customer_agent_session_summaries');
    expect(client.queries[1]?.sql).toContain('count(*) filter');
    expect(client.queries[1]?.values).toEqual([
      '2026-06-19T07:00:00.000Z',
      '2026-06-18T08:00:00.000Z',
    ]);
    expect(client.queries[2]?.sql).toContain("summary ->> 'productTopic'");
    expect(client.queries[3]?.sql).toContain("summary ->> 'productPreference'");
    expect(client.queries[4]?.values).toEqual([2]);
  });
});
