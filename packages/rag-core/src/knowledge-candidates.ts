import { createHash } from 'node:crypto';

import type { PgClientLike } from './pgvector-store.js';
import { redactSensitiveSupportText } from './redaction.js';

export const knowledgeCandidateStatuses = ['pending', 'approved', 'rejected', 'published'] as const;

export type KnowledgeCandidateStatus = (typeof knowledgeCandidateStatuses)[number];
export type KnowledgeCandidateSourceChannel = 'telegram' | 'telegram_export' | 'web';

export interface CreateKnowledgeCandidateInput {
  canonicalAnswer: string;
  question: string;
  sourceChannel: KnowledgeCandidateSourceChannel;
  effectiveAt?: string;
  evidence?: string;
  sourceAnswerMessageId?: string;
  sourceChatId?: string;
  sourceQuestionMessageId?: string;
  sourceUrl?: string;
  submittedBy?: string;
  supersedes?: string[];
}

export interface KnowledgeCandidate {
  canonicalAnswer: string;
  contentHash: string;
  createdAt: string;
  id: string;
  question: string;
  sourceChannel: KnowledgeCandidateSourceChannel;
  status: KnowledgeCandidateStatus;
  updatedAt: string;
  effectiveAt?: string;
  evidence?: string;
  publishedAt?: string;
  publishedDocumentId?: string;
  reviewNote?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  sourceAnswerMessageId?: string;
  sourceChatId?: string;
  sourceQuestionMessageId?: string;
  sourceUrl?: string;
  submittedBy?: string;
  supersedes?: string[];
}

export interface CreateKnowledgeCandidatesResult {
  created: KnowledgeCandidate[];
  duplicateCount: number;
}

export interface ListKnowledgeCandidatesOptions {
  limit?: number;
  status?: KnowledgeCandidateStatus;
}

export interface ReviewKnowledgeCandidateInput {
  decision: 'approve' | 'reject';
  id: string;
  reviewedBy: string;
  effectiveAt?: string;
  note?: string;
  sourceUrl?: string;
  supersedes?: string[];
}

export interface MarkKnowledgeCandidatePublishedInput {
  id: string;
  publishedDocumentId: string;
}

export interface PgKnowledgeCandidateStore {
  createMany(inputs: CreateKnowledgeCandidateInput[]): Promise<CreateKnowledgeCandidatesResult>;
  get(id: string): Promise<KnowledgeCandidate | undefined>;
  list(options?: ListKnowledgeCandidatesOptions): Promise<KnowledgeCandidate[]>;
  markPublished(input: MarkKnowledgeCandidatePublishedInput): Promise<KnowledgeCandidate>;
  migrate(): Promise<void>;
  review(input: ReviewKnowledgeCandidateInput): Promise<KnowledgeCandidate>;
}

export interface PgKnowledgeCandidateStoreOptions {
  client: PgClientLike;
}

interface KnowledgeCandidateRow {
  canonical_answer: string;
  content_hash: string;
  created_at: string;
  effective_at: string | null;
  evidence: string | null;
  id: string;
  published_at: string | null;
  published_document_id: string | null;
  question: string;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  source_answer_message_id: string | null;
  source_channel: KnowledgeCandidateSourceChannel;
  source_chat_id: string | null;
  source_question_message_id: string | null;
  source_url: string | null;
  status: KnowledgeCandidateStatus;
  submitted_by: string | null;
  supersedes: string[] | null;
  updated_at: string;
}

export class InvalidKnowledgeCandidateStateError extends Error {
  constructor(id: string, expectedState: string) {
    super(`Knowledge candidate ${id} must be ${expectedState}.`);
    this.name = 'InvalidKnowledgeCandidateStateError';
  }
}

const KNOWLEDGE_CANDIDATE_COLUMNS = `
  id,
  content_hash,
  question,
  canonical_answer,
  source_channel,
  source_chat_id,
  source_question_message_id,
  source_answer_message_id,
  source_url,
  submitted_by,
  evidence,
  effective_at::text as effective_at,
  supersedes,
  status,
  review_note,
  reviewed_by,
  reviewed_at::text as reviewed_at,
  published_document_id,
  published_at::text as published_at,
  created_at::text as created_at,
  updated_at::text as updated_at
`;

export function createPgKnowledgeCandidateStore(
  options: PgKnowledgeCandidateStoreOptions,
): PgKnowledgeCandidateStore {
  return {
    async createMany(
      inputs: CreateKnowledgeCandidateInput[],
    ): Promise<CreateKnowledgeCandidatesResult> {
      const created: KnowledgeCandidate[] = [];
      let duplicateCount = 0;

      for (const input of inputs) {
        const normalized = normalizeCreateInput(input);
        const contentHash = createCandidateContentHash(
          normalized.question,
          normalized.canonicalAnswer,
        );
        const id = `knowledge_candidate_${contentHash.slice(0, 16)}`;
        const response = await queryDatabase<KnowledgeCandidateRow>(
          options.client,
          `
          insert into knowledge_candidates (
            id, content_hash, question, canonical_answer, source_channel,
            source_chat_id, source_question_message_id, source_answer_message_id,
            source_url, submitted_by, evidence, effective_at, supersedes
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
            $13::jsonb
          )
          on conflict (content_hash) do nothing
          returning ${KNOWLEDGE_CANDIDATE_COLUMNS}
          `,
          [
            id,
            contentHash,
            normalized.question,
            normalized.canonicalAnswer,
            normalized.sourceChannel,
            normalized.sourceChatId ?? null,
            normalized.sourceQuestionMessageId ?? null,
            normalized.sourceAnswerMessageId ?? null,
            normalized.sourceUrl ?? null,
            normalized.submittedBy ?? null,
            normalized.evidence ?? null,
            normalized.effectiveAt ?? null,
            JSON.stringify(normalized.supersedes ?? []),
          ],
        );
        const row = response.rows[0];
        if (row === undefined) {
          duplicateCount += 1;
        } else {
          created.push(mapKnowledgeCandidateRow(row));
        }
      }

      return { created, duplicateCount };
    },

    async get(id: string): Promise<KnowledgeCandidate | undefined> {
      const response = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        select ${KNOWLEDGE_CANDIDATE_COLUMNS}
        from knowledge_candidates
        where id = $1
        `,
        [normalizeRequiredText(id, 'id')],
      );
      const row = response.rows[0];
      return row === undefined ? undefined : mapKnowledgeCandidateRow(row);
    },

    async list(input: ListKnowledgeCandidatesOptions = {}): Promise<KnowledgeCandidate[]> {
      const limit = normalizeListLimit(input.limit);
      const values = input.status === undefined ? [limit] : [input.status, limit];
      const whereClause = input.status === undefined ? '' : 'where status = $1';
      const response = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        select ${KNOWLEDGE_CANDIDATE_COLUMNS}
        from knowledge_candidates
        ${whereClause}
        order by created_at desc, id
        limit $${values.length}
        `,
        values,
      );
      return response.rows.map(mapKnowledgeCandidateRow);
    },

    async markPublished(input: MarkKnowledgeCandidatePublishedInput): Promise<KnowledgeCandidate> {
      const id = normalizeRequiredText(input.id, 'id');
      const response = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        update knowledge_candidates
        set
          status = 'published',
          published_document_id = $2,
          published_at = now(),
          updated_at = now()
        where id = $1 and status = 'approved'
        returning ${KNOWLEDGE_CANDIDATE_COLUMNS}
        `,
        [id, normalizeRequiredText(input.publishedDocumentId, 'publishedDocumentId')],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new InvalidKnowledgeCandidateStateError(id, 'approved before publication');
      }
      return mapKnowledgeCandidateRow(row);
    },

    migrate(): Promise<void> {
      return migrateKnowledgeCandidates(options.client);
    },

    async review(input: ReviewKnowledgeCandidateInput): Promise<KnowledgeCandidate> {
      const id = normalizeRequiredText(input.id, 'id');
      const nextStatus: KnowledgeCandidateStatus =
        input.decision === 'approve' ? 'approved' : 'rejected';
      const sourceUrl =
        input.sourceUrl === undefined ? undefined : normalizeSourceUrl(input.sourceUrl);
      const response = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        update knowledge_candidates
        set
          status = $2,
          reviewed_by = $3,
          review_note = $4,
          effective_at = coalesce($5::timestamptz, effective_at),
          source_url = coalesce($6, source_url),
          supersedes = coalesce($7::jsonb, supersedes),
          reviewed_at = now(),
          updated_at = now()
        where id = $1 and status = 'pending'
        returning ${KNOWLEDGE_CANDIDATE_COLUMNS}
        `,
        [
          id,
          nextStatus,
          normalizeRequiredText(input.reviewedBy, 'reviewedBy'),
          normalizeOptionalText(input.note) ?? null,
          normalizeOptionalTimestamp(input.effectiveAt) ?? null,
          sourceUrl ?? null,
          input.supersedes === undefined
            ? null
            : JSON.stringify(normalizeSupersedes(input.supersedes)),
        ],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new InvalidKnowledgeCandidateStateError(id, 'pending before review');
      }
      return mapKnowledgeCandidateRow(row);
    },
  };
}

export async function migrateKnowledgeCandidates(client: PgClientLike): Promise<void> {
  await queryDatabase(
    client,
    `
    do $$
    begin
      if to_regclass('public.knowledge_candidates') is not null
        and not exists (
          select 1
          from information_schema.columns
          where
            table_schema = 'public'
            and table_name = 'knowledge_candidates'
            and column_name = 'content_hash'
        )
      then
        if to_regclass('public.knowledge_candidates_legacy') is not null then
          raise exception 'Cannot preserve legacy knowledge_candidates: knowledge_candidates_legacy already exists.';
        end if;

        alter table knowledge_candidates rename to knowledge_candidates_legacy;

        if exists (
          select 1
          from pg_constraint
          where
            conrelid = 'public.knowledge_candidates_legacy'::regclass
            and conname = 'knowledge_candidates_pkey'
        )
        then
          alter table knowledge_candidates_legacy
            rename constraint knowledge_candidates_pkey to knowledge_candidates_legacy_pkey;
        end if;
      end if;
    end
    $$
    `,
  );
  await queryDatabase(
    client,
    `
    create table if not exists knowledge_candidates (
      id text primary key,
      content_hash text not null unique,
      question text not null,
      canonical_answer text not null,
      source_channel text not null check (
        source_channel in ('telegram', 'telegram_export', 'web')
      ),
      source_chat_id text,
      source_question_message_id text,
      source_answer_message_id text,
      source_url text,
      submitted_by text,
      evidence text,
      effective_at timestamptz,
      supersedes jsonb not null default '[]'::jsonb,
      status text not null default 'pending' check (
        status in ('pending', 'approved', 'rejected', 'published')
      ),
      review_note text,
      reviewed_by text,
      reviewed_at timestamptz,
      published_document_id text,
      published_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_candidates_review_status_created_at_idx
      on knowledge_candidates (status, created_at desc)
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_candidates_review_source_message_idx
      on knowledge_candidates (
        source_channel, source_chat_id, source_answer_message_id
      )
    `,
  );
}

function normalizeCreateInput(input: CreateKnowledgeCandidateInput): CreateKnowledgeCandidateInput {
  const normalized: CreateKnowledgeCandidateInput = {
    canonicalAnswer: sanitizeCandidateText(input.canonicalAnswer, 'canonicalAnswer'),
    question: sanitizeCandidateText(input.question, 'question'),
    sourceChannel: input.sourceChannel,
  };

  const effectiveAt = normalizeOptionalTimestamp(input.effectiveAt);
  if (effectiveAt !== undefined) {
    normalized.effectiveAt = effectiveAt;
  }
  if (input.evidence !== undefined) {
    normalized.evidence = sanitizeCandidateText(input.evidence, 'evidence');
  }
  if (input.sourceAnswerMessageId !== undefined) {
    normalized.sourceAnswerMessageId = normalizeRequiredText(
      input.sourceAnswerMessageId,
      'sourceAnswerMessageId',
    );
  }
  if (input.sourceChatId !== undefined) {
    normalized.sourceChatId = normalizeRequiredText(input.sourceChatId, 'sourceChatId');
  }
  if (input.sourceQuestionMessageId !== undefined) {
    normalized.sourceQuestionMessageId = normalizeRequiredText(
      input.sourceQuestionMessageId,
      'sourceQuestionMessageId',
    );
  }
  if (input.sourceUrl !== undefined) {
    normalized.sourceUrl = normalizeSourceUrl(input.sourceUrl);
  }
  if (input.submittedBy !== undefined) {
    normalized.submittedBy = normalizeRequiredText(input.submittedBy, 'submittedBy');
  }
  if (input.supersedes !== undefined) {
    normalized.supersedes = normalizeSupersedes(input.supersedes);
  }

  return normalized;
}

function sanitizeCandidateText(text: string, field: string): string {
  const sanitized = redactSensitiveSupportText(text)
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/gu, '[solana_signature]')
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, '[phone]')
    .replace(/(?<![\w/])@[A-Za-z0-9_]{5,32}\b/gu, '[telegram_user]')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (sanitized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return sanitized;
}

function createCandidateContentHash(question: string, canonicalAnswer: string): string {
  return createHash('sha256')
    .update(question.normalize('NFKC').toLowerCase())
    .update('\0')
    .update(canonicalAnswer.normalize('NFKC').toLowerCase())
    .digest('hex');
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeOptionalTimestamp(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value);
  if (normalized === undefined) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error('effectiveAt must be a valid date or timestamp.');
  }
  return normalized;
}

function normalizeSupersedes(values: string[]): string[] {
  const normalized = [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ];
  if (normalized.some((value) => !/^[A-Za-z0-9_.:/-]+$/u.test(value))) {
    throw new Error('supersedes values must be knowledge document or chunk ids.');
  }
  return normalized;
}

function normalizeSourceUrl(value: string): string {
  const normalized = normalizeRequiredText(value, 'sourceUrl');
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('sourceUrl must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    throw new Error('sourceUrl must be a valid HTTPS URL.');
  }
  return url.toString();
}

function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return 20;
  }
  return Math.min(limit, 100);
}

function mapKnowledgeCandidateRow(row: KnowledgeCandidateRow): KnowledgeCandidate {
  return {
    canonicalAnswer: row.canonical_answer,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    id: row.id,
    question: row.question,
    sourceChannel: row.source_channel,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.effective_at === null ? {} : { effectiveAt: row.effective_at }),
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    ...(row.published_document_id === null
      ? {}
      : { publishedDocumentId: row.published_document_id }),
    ...(row.review_note === null ? {} : { reviewNote: row.review_note }),
    ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
    ...(row.reviewed_by === null ? {} : { reviewedBy: row.reviewed_by }),
    ...(row.source_answer_message_id === null
      ? {}
      : { sourceAnswerMessageId: row.source_answer_message_id }),
    ...(row.source_chat_id === null ? {} : { sourceChatId: row.source_chat_id }),
    ...(row.source_question_message_id === null
      ? {}
      : { sourceQuestionMessageId: row.source_question_message_id }),
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    ...(row.submitted_by === null ? {} : { submittedBy: row.submitted_by }),
    ...(row.supersedes === null || row.supersedes.length === 0
      ? {}
      : { supersedes: row.supersedes }),
  };
}

async function queryDatabase<T>(
  client: PgClientLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ rows: T[] }> {
  return client.query<T>(sql, values);
}
