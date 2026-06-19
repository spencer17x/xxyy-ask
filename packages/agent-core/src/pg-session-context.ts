import { createHash } from 'node:crypto';

import type {
  SessionContextStore,
  SessionContextSummary,
  SessionTurn,
  SessionTurnMetadata,
} from './session-context.js';
import { sanitizeSessionText, summarizeSessionTurn } from './session-context.js';

export interface PgClientLike {
  query<T = unknown>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface CreatePgSessionContextStoreOptions {
  client: PgClientLike;
  maxTurnsPerSession?: number;
}

export interface SummarizePgSessionContextOptions {
  client: PgClientLike;
  recentLimit?: number;
}

export interface RecentPgSessionContextSummary {
  productPreference?: string;
  productTopic?: string;
  sessionIdHash: string;
  updatedAt: string;
}

export interface PgSessionContextOpsSummary {
  activeSessionCount: number;
  latestSummaryUpdatedAt?: string;
  latestTurnCreatedAt?: string;
  productPreferenceCounts: Record<string, number>;
  productTopicCounts: Record<string, number>;
  recentSummaries: RecentPgSessionContextSummary[];
  storedTurnCount: number;
  summarizedSessionCount: number;
}

interface SessionTurnRow {
  content: string;
  created_at: Date | string;
  metadata: SessionTurnMetadata | string | null;
  role: SessionTurn['role'];
}

interface SessionSummaryRow {
  summary: SessionContextSummary | string | null;
  updated_at: Date | string;
}

interface SessionContextTurnStatsRow {
  active_session_count?: number | string | null;
  latest_turn_created_at?: Date | string | null;
  stored_turn_count?: number | string | null;
}

interface SessionContextSummaryStatsRow {
  latest_summary_updated_at?: Date | string | null;
  summarized_session_count?: number | string | null;
}

interface SessionContextLabelCountRow {
  count?: number | string | null;
  label?: string | null;
}

interface RecentSessionSummaryRow extends SessionSummaryRow {
  session_id: string;
}

const DEFAULT_MAX_TURNS_PER_SESSION = 12;
const DEFAULT_RECENT_SESSION_SUMMARY_LIMIT = 5;

export function createPgSessionContextStore(
  options: CreatePgSessionContextStoreOptions,
): SessionContextStore {
  const maxTurnsPerSession = options.maxTurnsPerSession ?? DEFAULT_MAX_TURNS_PER_SESSION;

  return {
    async appendTurn(sessionId, turn) {
      const storedTurn: SessionTurn = {
        ...turn,
        content: sanitizeSessionText(turn.content),
      };
      await options.client.query(
        `
        insert into customer_agent_session_turns (
          session_id,
          role,
          content,
          metadata,
          created_at
        )
        values ($1, $2, $3, $4::jsonb, $5)
        `,
        [
          sessionId,
          storedTurn.role,
          storedTurn.content,
          JSON.stringify(storedTurn.metadata ?? {}),
          storedTurn.createdAt,
        ],
      );
      const summaryPatch = summarizeSessionTurn(storedTurn);
      if (summaryPatch !== undefined) {
        await upsertSessionSummary(options.client, sessionId, summaryPatch, storedTurn.createdAt);
      }
      await pruneOldSessionTurns(options.client, sessionId, maxTurnsPerSession);
    },

    async clearSession(sessionId) {
      await options.client.query(
        `
        delete from customer_agent_session_turns
        where session_id = $1
        `,
        [sessionId],
      );
      await options.client.query(
        `
        delete from customer_agent_session_summaries
        where session_id = $1
        `,
        [sessionId],
      );
    },

    async getRecentTurns(sessionId, limit) {
      const response = await options.client.query<SessionTurnRow>(
        `
        select
          role,
          content,
          metadata,
          created_at
        from customer_agent_session_turns
        where session_id = $1
        order by created_at desc, id desc
        limit $2
        `,
        [sessionId, limit ?? maxTurnsPerSession],
      );

      return response.rows.map(mapSessionTurnRow).reverse();
    },

    async getSessionSummary(sessionId) {
      const response = await options.client.query<SessionSummaryRow>(
        `
        select
          summary,
          updated_at
        from customer_agent_session_summaries
        where session_id = $1
        limit 1
        `,
        [sessionId],
      );
      const row = response.rows[0];
      return row === undefined ? null : mapSessionSummaryRow(row);
    },
  };
}

export async function migratePgSessionContextStore(client: PgClientLike): Promise<void> {
  await client.query(`
    create table if not exists customer_agent_session_turns (
      id bigserial primary key,
      session_id text not null,
      role text not null check (role in ('assistant', 'user')),
      content text not null,
      metadata jsonb not null,
      created_at timestamptz not null
    )
  `);
  await client.query(`
    create index if not exists customer_agent_session_turns_session_created_idx
      on customer_agent_session_turns (session_id, created_at desc, id desc)
  `);
  await client.query(`
    create table if not exists customer_agent_session_summaries (
      session_id text primary key,
      summary jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null
    )
  `);
}

export async function summarizePgSessionContext(
  options: SummarizePgSessionContextOptions,
): Promise<PgSessionContextOpsSummary> {
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_SESSION_SUMMARY_LIMIT;
  const [turnStats, summaryStats, productTopics, productPreferences, recentSummaries] =
    await Promise.all([
      querySessionTurnStats(options.client),
      querySessionSummaryStats(options.client),
      querySessionSummaryLabelCounts(options.client, 'productTopic'),
      querySessionSummaryLabelCounts(options.client, 'productPreference'),
      queryRecentSessionSummaries(options.client, recentLimit),
    ]);

  return {
    ...optionalDate('latestSummaryUpdatedAt', summaryStats.latestSummaryUpdatedAt),
    ...optionalDate('latestTurnCreatedAt', turnStats.latestTurnCreatedAt),
    activeSessionCount: turnStats.activeSessionCount,
    productPreferenceCounts: productPreferences,
    productTopicCounts: productTopics,
    recentSummaries,
    storedTurnCount: turnStats.storedTurnCount,
    summarizedSessionCount: summaryStats.summarizedSessionCount,
  };
}

async function querySessionTurnStats(client: PgClientLike): Promise<{
  activeSessionCount: number;
  latestTurnCreatedAt?: string;
  storedTurnCount: number;
}> {
  const response = await client.query<SessionContextTurnStatsRow>(`
    select
      count(distinct session_id) as active_session_count,
      count(*) as stored_turn_count,
      max(created_at) as latest_turn_created_at
    from customer_agent_session_turns
  `);
  const row = response.rows[0];

  return {
    activeSessionCount: parseCount(row?.active_session_count),
    ...optionalDate('latestTurnCreatedAt', row?.latest_turn_created_at),
    storedTurnCount: parseCount(row?.stored_turn_count),
  };
}

async function querySessionSummaryStats(client: PgClientLike): Promise<{
  latestSummaryUpdatedAt?: string;
  summarizedSessionCount: number;
}> {
  const response = await client.query<SessionContextSummaryStatsRow>(`
    select
      count(*) as summarized_session_count,
      max(updated_at) as latest_summary_updated_at
    from customer_agent_session_summaries
  `);
  const row = response.rows[0];

  return {
    ...optionalDate('latestSummaryUpdatedAt', row?.latest_summary_updated_at),
    summarizedSessionCount: parseCount(row?.summarized_session_count),
  };
}

async function querySessionSummaryLabelCounts(
  client: PgClientLike,
  field: 'productPreference' | 'productTopic',
): Promise<Record<string, number>> {
  const response = await client.query<SessionContextLabelCountRow>(`
    select
      nullif(trim(summary ->> '${field}'), '') as label,
      count(*) as count
    from customer_agent_session_summaries
    where nullif(trim(summary ->> '${field}'), '') is not null
    group by label
    order by count desc, label asc
  `);

  const counts = new Map<string, number>();
  for (const row of response.rows) {
    const label = row.label?.trim();
    if (label === undefined || label.length === 0) {
      continue;
    }
    counts.set(label, parseCount(row.count));
  }

  return Object.fromEntries(counts.entries());
}

async function queryRecentSessionSummaries(
  client: PgClientLike,
  recentLimit: number,
): Promise<RecentPgSessionContextSummary[]> {
  const response = await client.query<RecentSessionSummaryRow>(
    `
    select
      session_id,
      summary,
      updated_at
    from customer_agent_session_summaries
    order by updated_at desc
    limit $1
    `,
    [recentLimit],
  );

  return response.rows.map(mapRecentSessionSummaryRow);
}

async function upsertSessionSummary(
  client: PgClientLike,
  sessionId: string,
  summaryPatch: Omit<SessionContextSummary, 'updatedAt'>,
  updatedAt: string,
): Promise<void> {
  await client.query(
    `
    insert into customer_agent_session_summaries (
      session_id,
      summary,
      updated_at
    )
    values ($1, $2::jsonb, $3)
    on conflict (session_id) do update
      set summary = customer_agent_session_summaries.summary || excluded.summary,
          updated_at = greatest(customer_agent_session_summaries.updated_at, excluded.updated_at)
    `,
    [sessionId, JSON.stringify(summaryPatch), updatedAt],
  );
}

async function pruneOldSessionTurns(
  client: PgClientLike,
  sessionId: string,
  maxTurnsPerSession: number,
): Promise<void> {
  await client.query(
    `
    delete from customer_agent_session_turns
    where session_id = $1
      and id not in (
        select id
        from customer_agent_session_turns
        where session_id = $1
        order by created_at desc, id desc
        limit $2
      )
    `,
    [sessionId, maxTurnsPerSession],
  );
}

function mapSessionTurnRow(row: SessionTurnRow): SessionTurn {
  return {
    content: row.content,
    createdAt: normalizeCreatedAt(row.created_at),
    metadata: parseMetadata(row.metadata),
    role: row.role,
  };
}

function normalizeCreatedAt(createdAt: Date | string): string {
  return createdAt instanceof Date ? createdAt.toISOString() : createdAt;
}

function parseMetadata(metadata: SessionTurnRow['metadata']): SessionTurnMetadata {
  if (metadata === null) {
    return {};
  }

  if (typeof metadata !== 'string') {
    return metadata;
  }

  try {
    const parsed = JSON.parse(metadata) as SessionTurnMetadata;
    return parsed;
  } catch {
    return {};
  }
}

function mapSessionSummaryRow(row: SessionSummaryRow): SessionContextSummary {
  const parsed = parseSummary(row.summary);
  return {
    ...parsed,
    updatedAt: normalizeCreatedAt(row.updated_at),
  };
}

function mapRecentSessionSummaryRow(row: RecentSessionSummaryRow): RecentPgSessionContextSummary {
  const summary = parseSummary(row.summary);
  return {
    ...(summary.productPreference === undefined
      ? {}
      : { productPreference: summary.productPreference }),
    ...(summary.productTopic === undefined ? {} : { productTopic: summary.productTopic }),
    sessionIdHash: hashSessionId(row.session_id),
    updatedAt: normalizeCreatedAt(row.updated_at),
  };
}

function parseSummary(
  summary: SessionSummaryRow['summary'],
): Omit<SessionContextSummary, 'updatedAt'> {
  const parsed = typeof summary === 'string' ? parseSummaryJson(summary) : summary;
  if (parsed === null || typeof parsed !== 'object') {
    return {};
  }

  return {
    ...(typeof parsed.productPreference === 'string'
      ? { productPreference: parsed.productPreference }
      : {}),
    ...(typeof parsed.productTopic === 'string' ? { productTopic: parsed.productTopic } : {}),
  };
}

function optionalDate<Key extends string>(
  key: Key,
  value: Date | string | null | undefined,
): Record<Key, string> | Record<string, never> {
  return value === null || value === undefined
    ? {}
    : ({ [key]: normalizeCreatedAt(value) } as Record<Key, string>);
}

function parseCount(value: number | string | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  }

  return 0;
}

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
}

function parseSummaryJson(summary: string): Omit<SessionContextSummary, 'updatedAt'> {
  try {
    return JSON.parse(summary) as Omit<SessionContextSummary, 'updatedAt'>;
  } catch {
    return {};
  }
}
