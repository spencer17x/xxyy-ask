export type ToolAuditStatus = 'failure' | 'success';

export interface PgToolAuditClientLike {
  query<T = unknown>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface ToolAuditEvent {
  candidateId?: string;
  channel?: string;
  citationCount?: number;
  completionTokenCount?: number;
  errorCode?: string;
  intent?: string;
  latencyMs: number;
  promptTokenCount?: number;
  reportId?: string;
  sessionIdPresent?: boolean;
  sourceId?: string;
  status: ToolAuditStatus;
  toolName: string;
  totalTokenCount?: number;
  userIdPresent?: boolean;
}

export interface ToolAuditSink {
  record(event: ToolAuditEvent): void;
}

export interface InMemoryAuditSink extends ToolAuditSink {
  events(): ToolAuditEvent[];
}

export interface CreatePgToolAuditSinkOptions {
  client: PgToolAuditClientLike;
}

export interface SummarizePgToolAuditOptions {
  client: PgToolAuditClientLike;
  nowMs?: number;
  recentFailureLimit?: number;
  windowMs?: number;
}

export interface ToolAuditStatusCounts {
  failure: number;
  success: number;
}

export interface ToolAuditTokenUsage {
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
}

export interface RecentToolAuditFailure {
  channel?: string;
  createdAt: string;
  errorCode?: string;
  intent?: string;
  latencyMs: number;
  toolName: string;
}

export interface PgToolAuditOpsSummary {
  failureCount: number;
  failureErrorCodeCounts: Record<string, number>;
  latestEventCreatedAt?: string;
  recentFailures: RecentToolAuditFailure[];
  successCount: number;
  tokenUsage: ToolAuditTokenUsage;
  toolStatusCounts: Record<string, ToolAuditStatusCounts>;
  toolTokenUsage: Record<string, ToolAuditTokenUsage>;
  totalCount: number;
  windowStartedAt: string;
}

interface ToolAuditSummaryStatsRow {
  failure_count?: number | string | null;
  latest_event_created_at?: Date | string | null;
  completion_token_count?: number | string | null;
  prompt_token_count?: number | string | null;
  success_count?: number | string | null;
  total_token_count?: number | string | null;
  total_count?: number | string | null;
}

interface ToolAuditStatusCountRow {
  completion_token_count?: number | string | null;
  failure_count?: number | string | null;
  prompt_token_count?: number | string | null;
  success_count?: number | string | null;
  total_token_count?: number | string | null;
  tool_name?: string | null;
}

interface ToolAuditErrorCountRow {
  count?: number | string | null;
  error_code?: string | null;
}

interface RecentToolAuditFailureRow {
  channel?: string | null;
  created_at: Date | string;
  error_code?: string | null;
  intent?: string | null;
  latency_ms?: number | string | null;
  tool_name?: string | null;
}

const DEFAULT_TOOL_AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENT_TOOL_FAILURE_LIMIT = 5;

export function createNoopAuditSink(): ToolAuditSink {
  return {
    record() {
      // Intentionally ignored.
    },
  };
}

export function createPgToolAuditSink(options: CreatePgToolAuditSinkOptions): ToolAuditSink {
  return {
    record(event) {
      try {
        void options.client
          .query(
            `
            insert into customer_agent_tool_audit_events (
              tool_name,
              status,
              latency_ms,
              error_code,
              intent,
              channel,
              citation_count,
              report_id,
              source_id,
              candidate_id,
              session_id_present,
              user_id_present,
              prompt_token_count,
              completion_token_count,
              total_token_count
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            `,
            [
              normalizeRequiredText(event.toolName),
              event.status,
              normalizeCount(event.latencyMs),
              normalizeOptionalText(event.errorCode),
              normalizeOptionalText(event.intent),
              normalizeOptionalText(event.channel),
              normalizeOptionalCount(event.citationCount),
              normalizeOptionalText(event.reportId),
              normalizeOptionalText(event.sourceId),
              normalizeOptionalText(event.candidateId),
              event.sessionIdPresent ?? null,
              event.userIdPresent ?? null,
              normalizeOptionalCount(event.promptTokenCount),
              normalizeOptionalCount(event.completionTokenCount),
              normalizeOptionalCount(event.totalTokenCount),
            ],
          )
          .catch(() => undefined);
      } catch {
        // Tool audit is best-effort and must never affect customer answers.
      }
    },
  };
}

export async function migratePgToolAuditStore(client: PgToolAuditClientLike): Promise<void> {
  await client.query(`
    create table if not exists customer_agent_tool_audit_events (
      id bigserial primary key,
      tool_name text not null,
      status text not null check (status in ('failure', 'success')),
      latency_ms integer not null,
      error_code text,
      intent text,
      channel text,
      citation_count integer,
      report_id text,
      source_id text,
      candidate_id text,
      session_id_present boolean,
      user_id_present boolean,
      prompt_token_count integer,
      completion_token_count integer,
      total_token_count integer,
      created_at timestamptz not null default now()
    )
  `);
  await client.query(`
    alter table customer_agent_tool_audit_events
      add column if not exists prompt_token_count integer
  `);
  await client.query(`
    alter table customer_agent_tool_audit_events
      add column if not exists completion_token_count integer
  `);
  await client.query(`
    alter table customer_agent_tool_audit_events
      add column if not exists total_token_count integer
  `);
  await client.query(`
    create index if not exists customer_agent_tool_audit_events_created_idx
      on customer_agent_tool_audit_events (created_at desc, id desc)
  `);
  await client.query(`
    create index if not exists customer_agent_tool_audit_events_tool_status_idx
      on customer_agent_tool_audit_events (tool_name, status, created_at desc)
  `);
}

export async function summarizePgToolAudit(
  options: SummarizePgToolAuditOptions,
): Promise<PgToolAuditOpsSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const recentFailureLimit = options.recentFailureLimit ?? DEFAULT_RECENT_TOOL_FAILURE_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_TOOL_AUDIT_WINDOW_MS;
  const windowStartedAt = new Date(nowMs - windowMs).toISOString();
  const [stats, toolSummary, failureErrorCodeCounts, recentFailures] = await Promise.all([
    queryToolAuditStats(options.client, windowStartedAt),
    queryToolAuditToolSummary(options.client, windowStartedAt),
    queryToolAuditFailureErrorCounts(options.client, windowStartedAt),
    queryRecentToolAuditFailures(options.client, windowStartedAt, recentFailureLimit),
  ]);

  return {
    ...optionalDate('latestEventCreatedAt', stats.latestEventCreatedAt),
    failureCount: stats.failureCount,
    failureErrorCodeCounts,
    recentFailures,
    successCount: stats.successCount,
    tokenUsage: stats.tokenUsage,
    toolStatusCounts: toolSummary.statusCounts,
    toolTokenUsage: toolSummary.tokenUsage,
    totalCount: stats.totalCount,
    windowStartedAt,
  };
}

async function queryToolAuditStats(
  client: PgToolAuditClientLike,
  windowStartedAt: string,
): Promise<{
  failureCount: number;
  latestEventCreatedAt?: string;
  successCount: number;
  tokenUsage: ToolAuditTokenUsage;
  totalCount: number;
}> {
  const response = await client.query<ToolAuditSummaryStatsRow>(
    `
    select
      count(*) as total_count,
      count(*) filter (where status = 'success') as success_count,
      count(*) filter (where status = 'failure') as failure_count,
      coalesce(sum(prompt_token_count), 0) as prompt_token_count,
      coalesce(sum(completion_token_count), 0) as completion_token_count,
      coalesce(sum(total_token_count), 0) as total_token_count,
      max(created_at) as latest_event_created_at
    from customer_agent_tool_audit_events
    where created_at >= $1::timestamptz
    `,
    [windowStartedAt],
  );
  const row = response.rows[0];

  return {
    failureCount: parseCount(row?.failure_count),
    ...optionalDate('latestEventCreatedAt', row?.latest_event_created_at),
    successCount: parseCount(row?.success_count),
    tokenUsage: tokenUsageFromRow(row),
    totalCount: parseCount(row?.total_count),
  };
}

async function queryToolAuditToolSummary(
  client: PgToolAuditClientLike,
  windowStartedAt: string,
): Promise<{
  statusCounts: Record<string, ToolAuditStatusCounts>;
  tokenUsage: Record<string, ToolAuditTokenUsage>;
}> {
  const response = await client.query<ToolAuditStatusCountRow>(
    `
    select
      tool_name,
      count(*) filter (where status = 'success') as success_count,
      count(*) filter (where status = 'failure') as failure_count,
      coalesce(sum(prompt_token_count), 0) as prompt_token_count,
      coalesce(sum(completion_token_count), 0) as completion_token_count,
      coalesce(sum(total_token_count), 0) as total_token_count
    from customer_agent_tool_audit_events
    where created_at >= $1::timestamptz
    group by tool_name
    order by tool_name asc
    `,
    [windowStartedAt],
  );
  const counts = new Map<string, ToolAuditStatusCounts>();
  const tokenUsage = new Map<string, ToolAuditTokenUsage>();
  for (const row of response.rows) {
    const toolName = normalizeOptionalText(row.tool_name);
    if (toolName === null) {
      continue;
    }
    counts.set(toolName, {
      failure: parseCount(row.failure_count),
      success: parseCount(row.success_count),
    });
    tokenUsage.set(toolName, tokenUsageFromRow(row));
  }

  return {
    statusCounts: Object.fromEntries(counts.entries()),
    tokenUsage: Object.fromEntries(tokenUsage.entries()),
  };
}

async function queryToolAuditFailureErrorCounts(
  client: PgToolAuditClientLike,
  windowStartedAt: string,
): Promise<Record<string, number>> {
  const response = await client.query<ToolAuditErrorCountRow>(
    `
    select
      error_code,
      count(*) as count
    from customer_agent_tool_audit_events
    where created_at >= $1::timestamptz
      and status = 'failure'
      and nullif(trim(error_code), '') is not null
    group by error_code
    order by count desc, error_code asc
    `,
    [windowStartedAt],
  );
  const counts = new Map<string, number>();
  for (const row of response.rows) {
    const errorCode = normalizeOptionalText(row.error_code);
    if (errorCode === null) {
      continue;
    }
    counts.set(errorCode, parseCount(row.count));
  }

  return Object.fromEntries(counts.entries());
}

async function queryRecentToolAuditFailures(
  client: PgToolAuditClientLike,
  windowStartedAt: string,
  limit: number,
): Promise<RecentToolAuditFailure[]> {
  const response = await client.query<RecentToolAuditFailureRow>(
    `
    select
      tool_name,
      error_code,
      intent,
      channel,
      latency_ms,
      created_at
    from customer_agent_tool_audit_events
    where created_at >= $1::timestamptz
      and status = 'failure'
    order by created_at desc, id desc
    limit $2
    `,
    [windowStartedAt, limit],
  );

  return response.rows.flatMap(mapRecentToolAuditFailure);
}

function mapRecentToolAuditFailure(row: RecentToolAuditFailureRow): RecentToolAuditFailure[] {
  const toolName = normalizeOptionalText(row.tool_name);
  if (toolName === null) {
    return [];
  }
  const channel = normalizeOptionalText(row.channel);
  const errorCode = normalizeOptionalText(row.error_code);
  const intent = normalizeOptionalText(row.intent);

  return [
    {
      ...(channel === null ? {} : { channel }),
      createdAt: normalizeDate(row.created_at),
      ...(errorCode === null ? {} : { errorCode }),
      ...(intent === null ? {} : { intent }),
      latencyMs: parseCount(row.latency_ms),
      toolName,
    },
  ];
}

function normalizeRequiredText(value: string): string {
  const normalized = normalizeOptionalText(value);
  return normalized ?? 'unknown';
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function normalizeOptionalCount(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : normalizeCount(value);
}

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseCount(value: number | string | null | undefined): number {
  if (typeof value === 'number') {
    return normalizeCount(value);
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return normalizeCount(parsed);
  }

  return 0;
}

function tokenUsageFromRow(
  row:
    | {
        completion_token_count?: number | string | null;
        prompt_token_count?: number | string | null;
        total_token_count?: number | string | null;
      }
    | undefined,
): ToolAuditTokenUsage {
  return {
    completionTokens: parseCount(row?.completion_token_count),
    promptTokens: parseCount(row?.prompt_token_count),
    totalTokens: parseCount(row?.total_token_count),
  };
}

function optionalDate<Key extends string>(
  key: Key,
  value: Date | string | null | undefined,
): Record<Key, string> | Record<string, never> {
  return value === null || value === undefined
    ? {}
    : ({ [key]: normalizeDate(value) } as Record<Key, string>);
}

function normalizeDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function createInMemoryAuditSink(): InMemoryAuditSink {
  const recordedEvents: ToolAuditEvent[] = [];

  return {
    record(event) {
      recordedEvents.push({ ...event });
    },

    events() {
      return recordedEvents.map((event) => ({ ...event }));
    },
  };
}
