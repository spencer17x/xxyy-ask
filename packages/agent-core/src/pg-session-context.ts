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

const DEFAULT_MAX_TURNS_PER_SESSION = 12;

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

function parseSummaryJson(summary: string): Omit<SessionContextSummary, 'updatedAt'> {
  try {
    return JSON.parse(summary) as Omit<SessionContextSummary, 'updatedAt'>;
  } catch {
    return {};
  }
}
