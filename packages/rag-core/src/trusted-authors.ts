import { createHash } from 'node:crypto';

import type { PgClientLike } from './pgvector-store.js';

export type TrustedAuthorRole = 'administrator' | 'knowledge_editor' | 'owner';
export type TrustedAuthorVerificationSource = 'import' | 'manual' | 'telegram_api';

export interface TrustedAuthor {
  chatId: string;
  createdAt: string;
  id: string;
  role: TrustedAuthorRole;
  updatedAt: string;
  userId: string;
  validFrom: string;
  verificationSource: TrustedAuthorVerificationSource;
  verifiedAt: string;
  verifiedBy: string;
  validTo?: string;
}

export interface TrustAuthorInput {
  chatId: string;
  role: TrustedAuthorRole;
  userId: string;
  validFrom: string;
  verificationSource: TrustedAuthorVerificationSource;
  verifiedBy: string;
  validTo?: string;
}

export interface ResolveTrustedAuthorInput {
  at: string;
  chatId: string;
  userId: string;
}

export interface ListTrustedAuthorsOptions {
  activeAt?: string;
  chatId?: string;
  limit?: number;
}

export interface PgTrustedAuthorStore {
  list(options?: ListTrustedAuthorsOptions): Promise<TrustedAuthor[]>;
  migrate(): Promise<void>;
  resolve(input: ResolveTrustedAuthorInput): Promise<TrustedAuthor | undefined>;
  trust(input: TrustAuthorInput): Promise<TrustedAuthor>;
}

export interface PgTrustedAuthorStoreOptions {
  client: PgClientLike;
}

interface TrustedAuthorRow {
  chat_id: string;
  created_at: string;
  id: string;
  role: TrustedAuthorRole;
  updated_at: string;
  user_id: string;
  valid_from: string;
  valid_to: string | null;
  verification_source: TrustedAuthorVerificationSource;
  verified_at: string;
  verified_by: string;
}

const TRUSTED_AUTHOR_COLUMNS = `
  id,
  chat_id,
  user_id,
  role,
  valid_from::text as valid_from,
  valid_to::text as valid_to,
  verification_source,
  verified_by,
  verified_at::text as verified_at,
  created_at::text as created_at,
  updated_at::text as updated_at
`;

export function createPgTrustedAuthorStore(
  options: PgTrustedAuthorStoreOptions,
): PgTrustedAuthorStore {
  return {
    async list(input: ListTrustedAuthorsOptions = {}): Promise<TrustedAuthor[]> {
      const values: unknown[] = [];
      const predicates: string[] = [];
      if (input.chatId !== undefined) {
        values.push(normalizeRequiredText(input.chatId, 'chatId'));
        predicates.push(`chat_id = $${values.length}`);
      }
      if (input.activeAt !== undefined) {
        values.push(normalizeTimestamp(input.activeAt, 'activeAt'));
        const placeholder = `$${values.length}::timestamptz`;
        predicates.push(`valid_from <= ${placeholder}`);
        predicates.push(`(valid_to is null or valid_to > ${placeholder})`);
      }
      values.push(normalizeListLimit(input.limit));
      const response = await queryDatabase<TrustedAuthorRow>(
        options.client,
        `
        select ${TRUSTED_AUTHOR_COLUMNS}
        from knowledge_trusted_authors
        ${predicates.length === 0 ? '' : `where ${predicates.join(' and ')}`}
        order by chat_id, user_id, valid_from desc
        limit $${values.length}
        `,
        values,
      );
      return response.rows.map(mapTrustedAuthorRow);
    },

    migrate(): Promise<void> {
      return migrateTrustedAuthors(options.client);
    },

    async resolve(input: ResolveTrustedAuthorInput): Promise<TrustedAuthor | undefined> {
      const response = await queryDatabase<TrustedAuthorRow>(
        options.client,
        `
        select ${TRUSTED_AUTHOR_COLUMNS}
        from knowledge_trusted_authors
        where
          chat_id = $1
          and user_id = $2
          and valid_from <= $3::timestamptz
          and (valid_to is null or valid_to > $3::timestamptz)
        order by valid_from desc
        limit 1
        `,
        [
          normalizeRequiredText(input.chatId, 'chatId'),
          normalizeTelegramUserId(input.userId),
          normalizeTimestamp(input.at, 'at'),
        ],
      );
      const row = response.rows[0];
      return row === undefined ? undefined : mapTrustedAuthorRow(row);
    },

    async trust(input: TrustAuthorInput): Promise<TrustedAuthor> {
      const normalized = normalizeTrustAuthorInput(input);
      const id = createTrustedAuthorId(normalized);
      const response = await queryDatabase<TrustedAuthorRow>(
        options.client,
        `
        with trusted as (
          insert into knowledge_trusted_authors (
            id, chat_id, user_id, role, valid_from, valid_to,
            verification_source, verified_by, verified_at
          )
          values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, now())
          on conflict (chat_id, user_id, valid_from) do update
          set
            role = excluded.role,
            valid_to = excluded.valid_to,
            verification_source = excluded.verification_source,
            verified_by = excluded.verified_by,
            verified_at = now(),
            updated_at = now()
          returning ${TRUSTED_AUTHOR_COLUMNS}
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'trusted_author', id, 'trusted_author_upserted', $8,
            jsonb_build_object(
              'chatId', chat_id,
              'userId', user_id,
              'role', role,
              'validFrom', valid_from,
              'validTo', valid_to,
              'verificationSource', verification_source
            )
          from trusted
        )
        select ${TRUSTED_AUTHOR_COLUMNS}
        from trusted
        `,
        [
          id,
          normalized.chatId,
          normalized.userId,
          normalized.role,
          normalized.validFrom,
          normalized.validTo ?? null,
          normalized.verificationSource,
          normalized.verifiedBy,
        ],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new Error('Trusted author upsert did not return a row.');
      }
      return mapTrustedAuthorRow(row);
    },
  };
}

export async function migrateKnowledgeGovernanceAudit(client: PgClientLike): Promise<void> {
  await queryDatabase(
    client,
    `
    create table if not exists knowledge_governance_audit_events (
      id bigserial primary key,
      entity_type text not null check (
        entity_type in ('candidate', 'publication', 'trusted_author')
      ),
      entity_id text not null,
      event_type text not null,
      actor text not null,
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_governance_audit_entity_idx
      on knowledge_governance_audit_events (entity_type, entity_id, created_at desc)
    `,
  );
}

export async function migrateTrustedAuthors(client: PgClientLike): Promise<void> {
  await migrateKnowledgeGovernanceAudit(client);
  await queryDatabase(
    client,
    `
    create table if not exists knowledge_trusted_authors (
      id text primary key,
      chat_id text not null,
      user_id text not null,
      role text not null check (
        role in ('administrator', 'knowledge_editor', 'owner')
      ),
      valid_from timestamptz not null,
      valid_to timestamptz,
      verification_source text not null check (
        verification_source in ('import', 'manual', 'telegram_api')
      ),
      verified_by text not null,
      verified_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (chat_id, user_id, valid_from),
      check (valid_to is null or valid_to > valid_from)
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_trusted_authors_active_idx
      on knowledge_trusted_authors (chat_id, user_id, valid_from desc, valid_to)
    `,
  );
}

export function normalizeTelegramUserId(value: string): string {
  const normalized = normalizeRequiredText(value, 'userId').replace(/^user(?=\d+$)/u, '');
  if (!/^[A-Za-z0-9_:@.-]+$/u.test(normalized)) {
    throw new Error('userId contains unsupported characters.');
  }
  return normalized;
}

function normalizeTrustAuthorInput(input: TrustAuthorInput): TrustAuthorInput {
  const validFrom = normalizeTimestamp(input.validFrom, 'validFrom');
  const validTo =
    input.validTo === undefined ? undefined : normalizeTimestamp(input.validTo, 'validTo');
  if (validTo !== undefined && Date.parse(validTo) <= Date.parse(validFrom)) {
    throw new Error('validTo must be later than validFrom.');
  }
  return {
    chatId: normalizeRequiredText(input.chatId, 'chatId'),
    role: input.role,
    userId: normalizeTelegramUserId(input.userId),
    validFrom,
    verificationSource: input.verificationSource,
    verifiedBy: normalizeRequiredText(input.verifiedBy, 'verifiedBy'),
    ...(validTo === undefined ? {} : { validTo }),
  };
}

function createTrustedAuthorId(input: TrustAuthorInput): string {
  const hash = createHash('sha256')
    .update(input.chatId)
    .update('\0')
    .update(input.userId)
    .update('\0')
    .update(input.validFrom)
    .digest('hex');
  return `trusted_author_${hash.slice(0, 20)}`;
}

function normalizeTimestamp(value: string, field: string): string {
  const normalized = normalizeRequiredText(value, field);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${field} must be a valid date or timestamp.`);
  }
  return new Date(normalized).toISOString();
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return 100;
  }
  return Math.min(limit, 500);
}

function mapTrustedAuthorRow(row: TrustedAuthorRow): TrustedAuthor {
  return {
    chatId: row.chat_id,
    createdAt: row.created_at,
    id: row.id,
    role: row.role,
    updatedAt: row.updated_at,
    userId: row.user_id,
    validFrom: row.valid_from,
    verificationSource: row.verification_source,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    ...(row.valid_to === null ? {} : { validTo: row.valid_to }),
  };
}

async function queryDatabase<T>(
  client: PgClientLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ rows: T[] }> {
  return client.query<T>(sql, values);
}
