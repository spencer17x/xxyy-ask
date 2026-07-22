import type { PgControlClientLike, PgControlQueryResult } from './postgres.js';

interface AuditHead {
  fingerprint: string | null;
  sequence: number;
}

export class ScriptedPgClient implements PgControlClientLike {
  readonly auditEvents: unknown[] = [];
  readonly queries: Array<{ sql: string; tag: string | undefined; values: readonly unknown[] }> =
    [];
  readonly transactionEvents: string[] = [];
  private readonly responses = new Map<string, unknown[][]>();
  private readonly auditHeads = new Map<string, AuditHead>([
    ['governance', { fingerprint: null, sequence: 0 }],
    ['provider_control', { fingerprint: null, sequence: 0 }],
  ]);

  enqueue(tag: string, ...rows: unknown[][]): void {
    const queue = this.responses.get(tag) ?? [];
    queue.push(...rows);
    this.responses.set(tag, queue);
  }

  async query<T>(sql: string, values: readonly unknown[] = []): Promise<PgControlQueryResult<T>> {
    await Promise.resolve();
    const normalized = sql.trim().toLowerCase();
    const tag = sql.match(/\/\* control:([a-z0-9-]+) \*\//u)?.[1];
    this.queries.push({ sql, tag, values });
    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      this.transactionEvents.push(normalized);
      return { rows: [] };
    }
    if (tag === 'audit-head-lock') {
      const stream = String(values[0]);
      const head = this.auditHeads.get(stream)!;
      return {
        rows: [
          {
            last_event_fingerprint: head.fingerprint,
            last_sequence: head.sequence,
          } as T,
        ],
      };
    }
    if (tag === 'audit-insert') {
      this.auditEvents.push(JSON.parse(String(values[6])));
      return { rows: [] };
    }
    if (tag === 'audit-head-update') {
      const stream = String(values[0]);
      this.auditHeads.set(stream, {
        fingerprint: String(values[2]),
        sequence: Number(values[1]),
      });
      return { rows: [{ stream } as T] };
    }
    if (tag === 'audit-read') {
      const stream = String(values[0]);
      return {
        rows: this.auditEvents
          .filter(
            (event): event is Record<string, unknown> =>
              typeof event === 'object' &&
              event !== null &&
              (event as Record<string, unknown>).stream === stream,
          )
          .map((payload) => ({ payload }) as T),
      };
    }
    const queued = tag === undefined ? undefined : this.responses.get(tag)?.shift();
    return { rows: (queued ?? []) as T[] };
  }
}

export function authorizationRow(payload: unknown): unknown {
  return { payload, revocation_payload: null };
}

export function emptyBudgetWindow(input: {
  budgetId: string;
  policyFingerprint: string;
  windowEndsAt: string;
  windowStartedAt: string;
}): Record<string, unknown> {
  return {
    budget_id: input.budgetId,
    policy_fingerprint: input.policyFingerprint,
    reserved_cost_units: 0,
    reserved_requests: 0,
    reserved_response_bytes: 0,
    reserved_rpc_calls: 0,
    used_cost_units: 0,
    used_requests: 0,
    used_response_bytes: 0,
    used_rpc_calls: 0,
    window_ends_at: input.windowEndsAt,
    window_started_at: input.windowStartedAt,
  };
}
