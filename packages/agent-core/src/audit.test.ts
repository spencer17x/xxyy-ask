import { describe, expect, it } from 'vitest';

import {
  createInMemoryAuditSink,
  createPgToolAuditSink,
  migratePgToolAuditStore,
  summarizePgToolAudit,
} from './audit.js';
import type { ToolAuditEvent } from './audit.js';

class FakePgClient {
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  queryRows?: (sql: string, values: readonly unknown[]) => unknown[] | undefined;
  rows: unknown[] = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: (this.queryRows?.(sql, values) ?? this.rows) as T[] });
  }
}

describe('createInMemoryAuditSink', () => {
  it('records immutable audit events', () => {
    const sink = createInMemoryAuditSink();
    const event: ToolAuditEvent = {
      channel: 'web',
      latencyMs: 12,
      status: 'success',
      toolName: 'answer_product_question',
    };
    const expectedEvent = { ...event };

    sink.record(event);
    event.latencyMs = 99;

    const events = sink.events();
    events[0]!.latencyMs = 42;

    expect(events).toEqual([{ ...expectedEvent, latencyMs: 42 }]);
    expect(sink.events()).toEqual([expectedEvent]);
  });
});

describe('createPgToolAuditSink', () => {
  it('migrates customer agent tool audit storage', async () => {
    const client = new FakePgClient();

    await migratePgToolAuditStore(client);

    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists customer_agent_tool_audit_events');
    expect(sql).toContain("status text not null check (status in ('failure', 'success'))");
    expect(sql).toContain('prompt_token_count integer');
    expect(sql).toContain('completion_token_count integer');
    expect(sql).toContain('total_token_count integer');
    expect(sql).toContain('customer_agent_tool_audit_events_created_idx');
    expect(sql).toContain('customer_agent_tool_audit_events_tool_status_idx');
  });

  it('records sanitized tool audit events without raw user identifiers', () => {
    const client = new FakePgClient();
    const sink = createPgToolAuditSink({ client });

    sink.record({
      channel: ' web ',
      citationCount: 2,
      completionTokenCount: 30.7,
      errorCode: ' TimeoutError ',
      intent: ' product_qa ',
      latencyMs: 12.8,
      promptTokenCount: 100.9,
      reportId: ' report-1 ',
      sessionIdPresent: true,
      sourceId: ' source-1 ',
      status: 'failure',
      toolName: ' answer_product_question ',
      totalTokenCount: 131.2,
      userIdPresent: false,
    });

    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]?.sql).toContain('insert into customer_agent_tool_audit_events');
    expect(client.queries[0]?.values).toEqual([
      'answer_product_question',
      'failure',
      12,
      'TimeoutError',
      'product_qa',
      'web',
      2,
      'report-1',
      'source-1',
      null,
      true,
      false,
      100,
      30,
      131,
    ]);
  });

  it('summarizes recent tool audit outcomes for ops dashboards', async () => {
    const client = new FakePgClient();
    client.queryRows = (sql, values) => {
      if (sql.includes('count(*) as total_count')) {
        expect(values).toEqual(['2026-06-18T08:00:00.000Z']);
        return [
          {
            completion_token_count: '150',
            failure_count: '2',
            latest_event_created_at: '2026-06-19T07:58:00.000Z',
            prompt_token_count: '450',
            success_count: '3',
            total_token_count: '600',
            total_count: '5',
          },
        ];
      }
      if (sql.includes('group by tool_name')) {
        expect(values).toEqual(['2026-06-18T08:00:00.000Z']);
        return [
          {
            completion_token_count: '100',
            failure_count: '1',
            prompt_token_count: '300',
            success_count: '2',
            total_token_count: '400',
            tool_name: 'answer_product_question',
          },
          {
            completion_token_count: '50',
            failure_count: '1',
            prompt_token_count: '150',
            success_count: '1',
            total_token_count: '200',
            tool_name: 'analyze_transaction',
          },
        ];
      }
      if (sql.includes('group by error_code')) {
        expect(values).toEqual(['2026-06-18T08:00:00.000Z']);
        return [
          { count: '1', error_code: 'TimeoutError' },
          { count: '1', error_code: 'VectorStoreUnavailableError' },
        ];
      }
      if (sql.includes('order by created_at desc, id desc')) {
        expect(values).toEqual(['2026-06-18T08:00:00.000Z', 2]);
        return [
          {
            channel: 'web',
            created_at: '2026-06-19T07:58:00.000Z',
            error_code: 'TimeoutError',
            intent: 'product_qa',
            latency_ms: '1200',
            tool_name: 'answer_product_question',
          },
          {
            channel: 'telegram',
            created_at: '2026-06-19T07:50:00.000Z',
            error_code: 'ProviderUnavailable',
            intent: 'tx_sandwich_detection',
            latency_ms: 640,
            tool_name: 'analyze_transaction',
          },
        ];
      }

      return [];
    };

    const summary = await summarizePgToolAudit({
      client,
      nowMs: Date.parse('2026-06-19T08:00:00.000Z'),
      recentFailureLimit: 2,
    });

    expect(summary).toEqual({
      failureCount: 2,
      failureErrorCodeCounts: {
        TimeoutError: 1,
        VectorStoreUnavailableError: 1,
      },
      latestEventCreatedAt: '2026-06-19T07:58:00.000Z',
      recentFailures: [
        {
          channel: 'web',
          createdAt: '2026-06-19T07:58:00.000Z',
          errorCode: 'TimeoutError',
          intent: 'product_qa',
          latencyMs: 1200,
          toolName: 'answer_product_question',
        },
        {
          channel: 'telegram',
          createdAt: '2026-06-19T07:50:00.000Z',
          errorCode: 'ProviderUnavailable',
          intent: 'tx_sandwich_detection',
          latencyMs: 640,
          toolName: 'analyze_transaction',
        },
      ],
      successCount: 3,
      tokenUsage: {
        completionTokens: 150,
        promptTokens: 450,
        totalTokens: 600,
      },
      toolStatusCounts: {
        analyze_transaction: {
          failure: 1,
          success: 1,
        },
        answer_product_question: {
          failure: 1,
          success: 2,
        },
      },
      toolTokenUsage: {
        analyze_transaction: {
          completionTokens: 50,
          promptTokens: 150,
          totalTokens: 200,
        },
        answer_product_question: {
          completionTokens: 100,
          promptTokens: 300,
          totalTokens: 400,
        },
      },
      totalCount: 5,
      windowStartedAt: '2026-06-18T08:00:00.000Z',
    });
  });
});
