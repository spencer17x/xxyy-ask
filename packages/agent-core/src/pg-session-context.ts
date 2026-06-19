import type { SessionContextStore, SessionTurn, SessionTurnMetadata } from './session-context.js';
import { sanitizeSessionText } from './session-context.js';

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

const DEFAULT_MAX_TURNS_PER_SESSION = 12;

export function createPgSessionContextStore(
  options: CreatePgSessionContextStoreOptions,
): SessionContextStore {
  const maxTurnsPerSession = options.maxTurnsPerSession ?? DEFAULT_MAX_TURNS_PER_SESSION;

  return {
    async appendTurn(sessionId, turn) {
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
          turn.role,
          sanitizeSessionText(turn.content),
          JSON.stringify(turn.metadata ?? {}),
          turn.createdAt,
        ],
      );
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
