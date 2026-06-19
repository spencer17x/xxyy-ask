import type {
  KnowledgeCandidate,
  KnowledgeCandidateStatus,
  KnowledgeRiskLevel,
  RawSupportMessage,
  RedactionReport,
  SupportMessageSenderRole,
  SupportSource,
} from './types.js';
import type {
  KnowledgeCandidateRun,
  KnowledgeCandidateStore,
  ListKnowledgeCandidatesFilter,
  MarkKnowledgeCandidateEvalResultInput,
  MarkKnowledgeCandidateIngestedInput,
  MarkKnowledgeCandidatePublishedInput,
  RecordKnowledgeCandidateRunInput,
  ReviewKnowledgeCandidateInput,
} from './knowledge-candidate-store.js';
import {
  KnowledgeCandidateInvalidPublishStatusError,
  KnowledgeCandidateInvalidStatusTransitionError,
  KnowledgeCandidateNotFoundError,
} from './knowledge-candidate-store.js';

export interface PgClientLike {
  query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface PgKnowledgeOpsStoreOptions {
  client: PgClientLike;
}

export interface ListRawSupportMessagesFilter {
  chatIdHash?: string;
  limit?: number;
  source?: SupportSource;
}

export interface SourceCursorInput {
  cursorKey: string;
  source: SupportSource;
}

export interface SetSourceCursorInput extends SourceCursorInput {
  cursorValue: string;
  updatedAt?: string;
}

export interface PgKnowledgeOpsStore extends KnowledgeCandidateStore {
  getSourceCursor(input: SourceCursorInput): Promise<string | undefined>;
  listRawMessages(filter?: ListRawSupportMessagesFilter): Promise<RawSupportMessage[]>;
  migrate(): Promise<void>;
  setSourceCursor(input: SetSourceCursorInput): Promise<void>;
  upsertRawMessages(messages: RawSupportMessage[]): Promise<RawSupportMessage[]>;
}

interface RawSupportMessageRow {
  attachments_metadata: unknown;
  chat_id_hash: string;
  content_hash: string;
  ingested_at: Date | string;
  message_id: string;
  reply_to_message_id: string | null;
  sender_role: SupportMessageSenderRole;
  sent_at: Date | string;
  source: SupportSource;
  text: string;
  thread_id: string | null;
}

interface KnowledgeCandidateRow {
  confidence: number;
  created_at: Date | string;
  existing_knowledge_matches: unknown;
  generated_eval_cases: unknown;
  id: string;
  proposed_answer: string;
  published_target: string | null;
  question: string;
  redaction_report: unknown;
  review_notes: string | null;
  reviewer: string | null;
  risk_level: KnowledgeRiskLevel;
  source_refs: unknown;
  status: KnowledgeCandidateStatus;
  target_category: KnowledgeCandidate['targetCategory'];
  type: KnowledgeCandidate['type'];
  updated_at: Date | string;
}

interface KnowledgeCandidateRunRow {
  candidate_id: string;
  created_at: Date | string;
  metadata: unknown;
  run_id: string;
  run_type: KnowledgeCandidateRun['runType'];
  status: KnowledgeCandidateRun['status'];
}

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;

export function createPgKnowledgeOpsStore(
  options: PgKnowledgeOpsStoreOptions,
): PgKnowledgeOpsStore {
  return {
    addCandidates(candidates) {
      return Promise.all(candidates.map((candidate) => upsertCandidate(options.client, candidate)));
    },

    async getSourceCursor(input) {
      const response = await options.client.query<{ cursor_value: string }>(
        `
        select cursor_value
        from knowledge_source_cursors
        where source = $1 and cursor_key = $2
        `,
        [input.source, input.cursorKey],
      );

      return response.rows[0]?.cursor_value;
    },

    getCandidate(candidateId) {
      return getCandidateById(options.client, candidateId);
    },

    async listCandidates(filter = {}) {
      const { sql, values } = buildListCandidatesQuery(filter);
      const response = await options.client.query<KnowledgeCandidateRow>(sql, values);
      return response.rows.map(mapCandidateRow);
    },

    async listRawMessages(filter = {}) {
      const { sql, values } = buildListRawMessagesQuery(filter);
      const response = await options.client.query<RawSupportMessageRow>(sql, values);
      return response.rows.map(mapRawSupportMessageRow);
    },

    async markCandidateEvalResult(candidateId, input) {
      return markCandidateEvalResult(options.client, candidateId, input);
    },

    async markCandidateIngested(candidateId, input) {
      return markCandidateIngested(options.client, candidateId, input ?? {});
    },

    async markCandidatePublished(candidateId, input) {
      return markCandidatePublished(options.client, candidateId, input);
    },

    async listCandidateRuns(candidateId) {
      return listCandidateRuns(options.client, candidateId);
    },

    async recordCandidateRun(input) {
      return recordCandidateRun(options.client, input);
    },

    async migrate() {
      await migratePgKnowledgeOpsStore(options.client);
    },

    async reviewCandidate(candidateId, input) {
      const status = reviewActionToStatus(input.action);
      const reviewedAt = input.reviewedAt ?? new Date().toISOString();
      const response = await options.client.query<KnowledgeCandidateRow>(
        `
        update knowledge_candidates
        set
          status = $1,
          reviewer = $2,
          review_notes = $3,
          updated_at = $4
        where id = $5
        returning ${candidateReturnColumns()}
        `,
        [status, input.reviewer, input.notes ?? null, reviewedAt, candidateId],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new KnowledgeCandidateNotFoundError(candidateId);
      }

      return mapCandidateRow(row);
    },

    async setSourceCursor(input) {
      await options.client.query(
        `
        insert into knowledge_source_cursors (
          source,
          cursor_key,
          cursor_value,
          updated_at
        )
        values ($1, $2, $3, $4)
        on conflict (source, cursor_key) do update set
          cursor_value = excluded.cursor_value,
          updated_at = excluded.updated_at
        `,
        [
          input.source,
          input.cursorKey,
          input.cursorValue,
          input.updatedAt ?? new Date().toISOString(),
        ],
      );
    },

    async upsertRawMessages(messages) {
      for (const message of messages) {
        await upsertRawMessage(options.client, message);
      }

      return messages;
    },
  };
}

export async function migratePgKnowledgeOpsStore(client: PgClientLike): Promise<void> {
  await client.query(`
    create table if not exists support_raw_messages (
      id bigserial primary key,
      source text not null check (source in ('telegram')),
      chat_id_hash text not null,
      message_id text not null,
      thread_id text,
      reply_to_message_id text,
      sender_role text not null check (sender_role in ('user', 'support', 'system', 'unknown')),
      sent_at timestamptz not null,
      text text not null,
      content_hash text not null,
      ingested_at timestamptz not null,
      attachments_metadata jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (source, chat_id_hash, message_id)
    )
  `);
  await client.query(`
    create index if not exists support_raw_messages_ingested_at_idx
      on support_raw_messages (ingested_at desc)
  `);
  await client.query(`
    create index if not exists support_raw_messages_content_hash_idx
      on support_raw_messages (content_hash)
  `);
  await client.query(`
    create index if not exists support_raw_messages_source_chat_idx
      on support_raw_messages (source, chat_id_hash)
  `);
  await client.query(`
    create table if not exists knowledge_candidates (
      id text primary key,
      type text not null check (type in ('faq', 'doc_patch', 'boundary_example', 'eval_case')),
      status text not null check (
        status in ('draft', 'needs_review', 'approved', 'rejected', 'published', 'ingested', 'eval_passed', 'eval_failed')
      ),
      question text not null,
      proposed_answer text not null,
      target_category text not null check (
        target_category in ('product_faq', 'policy_boundary', 'doc_patch', 'eval_case')
      ),
      source_refs jsonb not null,
      redaction_report jsonb not null,
      existing_knowledge_matches jsonb not null,
      confidence double precision not null check (confidence >= 0 and confidence <= 1),
      risk_level text not null check (risk_level in ('low', 'medium', 'high')),
      generated_eval_cases jsonb not null,
      reviewer text,
      review_notes text,
      published_target text,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);
  await client.query(`
    create index if not exists knowledge_candidates_status_idx
      on knowledge_candidates (status)
  `);
  await client.query(`
    create index if not exists knowledge_candidates_risk_level_idx
      on knowledge_candidates (risk_level)
  `);
  await client.query(`
    create index if not exists knowledge_candidates_updated_at_idx
      on knowledge_candidates (updated_at desc)
  `);
  await client.query(`
    create table if not exists knowledge_candidate_runs (
      candidate_id text not null references knowledge_candidates(id) on delete cascade,
      run_id text not null,
      run_type text not null check (run_type in ('publish', 'ingest', 'eval')),
      status text not null check (status in ('completed', 'passed', 'failed')),
      metadata jsonb not null,
      created_at timestamptz not null,
      primary key (candidate_id, run_type, run_id)
    )
  `);
  await client.query(`
    create index if not exists knowledge_candidate_runs_candidate_created_idx
      on knowledge_candidate_runs (candidate_id, created_at asc)
  `);
  await client.query(`
    create table if not exists knowledge_source_cursors (
      source text not null check (source in ('telegram')),
      cursor_key text not null,
      cursor_value text not null,
      updated_at timestamptz not null,
      primary key (source, cursor_key)
    )
  `);
  await client.query(`
    create index if not exists knowledge_source_cursors_updated_at_idx
      on knowledge_source_cursors (updated_at desc)
  `);
}

async function getCandidateById(
  client: PgClientLike,
  candidateId: string,
): Promise<KnowledgeCandidate | undefined> {
  const response = await client.query<KnowledgeCandidateRow>(
    `
    select ${candidateReturnColumns()}
    from knowledge_candidates
    where id = $1
    `,
    [candidateId],
  );

  const row = response.rows[0];
  return row === undefined ? undefined : mapCandidateRow(row);
}

async function markCandidatePublished(
  client: PgClientLike,
  candidateId: string,
  input: MarkKnowledgeCandidatePublishedInput,
): Promise<KnowledgeCandidate> {
  const candidate = await getCandidateById(client, candidateId);
  if (candidate === undefined) {
    throw new KnowledgeCandidateNotFoundError(candidateId);
  }
  if (candidate.status !== 'approved') {
    throw new KnowledgeCandidateInvalidPublishStatusError(candidateId, candidate.status);
  }

  const publishedAt = input.publishedAt ?? new Date().toISOString();
  const response = await client.query<KnowledgeCandidateRow>(
    `
    update knowledge_candidates
    set
      status = $1,
      published_target = $2,
      updated_at = $3
    where id = $4
    returning ${candidateReturnColumns()}
    `,
    ['published', input.publishedTarget, publishedAt, candidateId],
  );
  const row = response.rows[0];
  if (row === undefined) {
    throw new KnowledgeCandidateNotFoundError(candidateId);
  }

  return mapCandidateRow(row);
}

async function markCandidateIngested(
  client: PgClientLike,
  candidateId: string,
  input: MarkKnowledgeCandidateIngestedInput,
): Promise<KnowledgeCandidate> {
  const candidate = await getCandidateById(client, candidateId);
  if (candidate === undefined) {
    throw new KnowledgeCandidateNotFoundError(candidateId);
  }
  if (candidate.status !== 'published') {
    throw new KnowledgeCandidateInvalidStatusTransitionError(
      candidateId,
      'ingested',
      candidate.status,
      'published',
    );
  }

  return updateCandidateStatus(client, candidateId, 'ingested', input.ingestedAt);
}

async function markCandidateEvalResult(
  client: PgClientLike,
  candidateId: string,
  input: MarkKnowledgeCandidateEvalResultInput,
): Promise<KnowledgeCandidate> {
  const candidate = await getCandidateById(client, candidateId);
  if (candidate === undefined) {
    throw new KnowledgeCandidateNotFoundError(candidateId);
  }
  if (candidate.status !== 'ingested') {
    throw new KnowledgeCandidateInvalidStatusTransitionError(
      candidateId,
      input.passed ? 'eval_passed' : 'eval_failed',
      candidate.status,
      'ingested',
    );
  }

  return updateCandidateStatus(
    client,
    candidateId,
    input.passed ? 'eval_passed' : 'eval_failed',
    input.evaluatedAt,
  );
}

async function recordCandidateRun(
  client: PgClientLike,
  input: RecordKnowledgeCandidateRunInput,
): Promise<KnowledgeCandidateRun> {
  const candidate = await getCandidateById(client, input.candidateId);
  if (candidate === undefined) {
    throw new KnowledgeCandidateNotFoundError(input.candidateId);
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const metadata = input.metadata ?? {};
  const response = await client.query<KnowledgeCandidateRunRow>(
    `
    insert into knowledge_candidate_runs (
      candidate_id,
      run_id,
      run_type,
      status,
      metadata,
      created_at
    )
    values ($1, $2, $3, $4, $5::jsonb, $6)
    on conflict (candidate_id, run_type, run_id) do update set
      status = excluded.status,
      metadata = excluded.metadata,
      created_at = excluded.created_at
    returning ${candidateRunReturnColumns()}
    `,
    [
      input.candidateId,
      input.runId,
      input.runType,
      input.status,
      JSON.stringify(metadata),
      createdAt,
    ],
  );
  const row = response.rows[0];
  if (row === undefined) {
    throw new KnowledgeCandidateNotFoundError(input.candidateId);
  }

  return mapCandidateRunRow(row);
}

async function listCandidateRuns(
  client: PgClientLike,
  candidateId: string,
): Promise<KnowledgeCandidateRun[]> {
  const response = await client.query<KnowledgeCandidateRunRow>(
    `
    select ${candidateRunReturnColumns()}
    from knowledge_candidate_runs
    where candidate_id = $1
    order by created_at asc, run_type asc, run_id asc
    `,
    [candidateId],
  );

  return response.rows.map(mapCandidateRunRow);
}

async function updateCandidateStatus(
  client: PgClientLike,
  candidateId: string,
  status: KnowledgeCandidateStatus,
  updatedAt: string | undefined,
): Promise<KnowledgeCandidate> {
  const response = await client.query<KnowledgeCandidateRow>(
    `
    update knowledge_candidates
    set
      status = $1,
      updated_at = $2
    where id = $3
    returning ${candidateReturnColumns()}
    `,
    [status, updatedAt ?? new Date().toISOString(), candidateId],
  );
  const row = response.rows[0];
  if (row === undefined) {
    throw new KnowledgeCandidateNotFoundError(candidateId);
  }

  return mapCandidateRow(row);
}

async function upsertRawMessage(client: PgClientLike, message: RawSupportMessage): Promise<void> {
  await client.query(
    `
    insert into support_raw_messages (
      source,
      chat_id_hash,
      message_id,
      thread_id,
      reply_to_message_id,
      sender_role,
      sent_at,
      text,
      content_hash,
      ingested_at,
      attachments_metadata
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
    on conflict (source, chat_id_hash, message_id) do update set
      thread_id = excluded.thread_id,
      reply_to_message_id = excluded.reply_to_message_id,
      sender_role = excluded.sender_role,
      sent_at = excluded.sent_at,
      text = excluded.text,
      content_hash = excluded.content_hash,
      ingested_at = excluded.ingested_at,
      attachments_metadata = excluded.attachments_metadata,
      updated_at = now()
    `,
    [
      message.source,
      message.chatIdHash,
      message.messageId,
      message.threadId ?? null,
      message.replyToMessageId ?? null,
      message.senderRole,
      message.sentAt,
      message.text,
      message.contentHash,
      message.ingestedAt,
      message.attachmentsMetadata === undefined
        ? null
        : JSON.stringify(message.attachmentsMetadata),
    ],
  );
}

async function upsertCandidate(
  client: PgClientLike,
  candidate: KnowledgeCandidate,
): Promise<KnowledgeCandidate> {
  const response = await client.query<KnowledgeCandidateRow>(
    `
    insert into knowledge_candidates (
      id,
      type,
      status,
      question,
      proposed_answer,
      target_category,
      source_refs,
      redaction_report,
      existing_knowledge_matches,
      confidence,
      risk_level,
      generated_eval_cases,
      reviewer,
      review_notes,
      published_target,
      created_at,
      updated_at
    )
    values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15, $16, $17)
    on conflict (id) do update set
      type = excluded.type,
      status = case
        when knowledge_candidates.status in ('draft', 'needs_review') then excluded.status
        else knowledge_candidates.status
      end,
      question = excluded.question,
      proposed_answer = excluded.proposed_answer,
      target_category = excluded.target_category,
      source_refs = excluded.source_refs,
      redaction_report = excluded.redaction_report,
      existing_knowledge_matches = excluded.existing_knowledge_matches,
      confidence = excluded.confidence,
      risk_level = excluded.risk_level,
      generated_eval_cases = excluded.generated_eval_cases,
      updated_at = excluded.updated_at
    returning ${candidateReturnColumns()}
    `,
    [
      candidate.id,
      candidate.type,
      candidate.status,
      candidate.question,
      candidate.proposedAnswer,
      candidate.targetCategory,
      JSON.stringify(candidate.sourceRefs),
      JSON.stringify(candidate.redactionReport),
      JSON.stringify(candidate.existingKnowledgeMatches),
      candidate.confidence,
      candidate.riskLevel,
      JSON.stringify(candidate.generatedEvalCases),
      candidate.reviewer ?? null,
      candidate.reviewNotes ?? null,
      candidate.publishedTarget ?? null,
      candidate.createdAt,
      candidate.updatedAt,
    ],
  );

  return mapCandidateRow(response.rows[0] ?? toCandidateRow(candidate));
}

function buildListRawMessagesQuery(filter: ListRawSupportMessagesFilter): {
  sql: string;
  values: readonly unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filter.source !== undefined) {
    values.push(filter.source);
    clauses.push(`source = $${values.length}`);
  }

  if (filter.chatIdHash !== undefined) {
    values.push(filter.chatIdHash);
    clauses.push(`chat_id_hash = $${values.length}`);
  }

  const limit = normalizeLimit(filter.limit);
  values.push(limit);
  const whereClause = clauses.length === 0 ? '' : `where ${clauses.join(' and ')}`;

  return {
    sql: `
      select
        source,
        chat_id_hash,
        message_id,
        thread_id,
        reply_to_message_id,
        sender_role,
        sent_at::text as sent_at,
        text,
        content_hash,
        ingested_at::text as ingested_at,
        attachments_metadata
      from support_raw_messages
      ${whereClause}
      order by sent_at asc, message_id asc
      limit $${values.length}
    `,
    values,
  };
}

function buildListCandidatesQuery(filter: ListKnowledgeCandidatesFilter): {
  sql: string;
  values: readonly unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filter.status !== undefined) {
    values.push(filter.status);
    clauses.push(`status = $${values.length}`);
  }

  if (filter.type !== undefined) {
    values.push(filter.type);
    clauses.push(`type = $${values.length}`);
  }

  if (filter.riskLevel !== undefined) {
    values.push(filter.riskLevel);
    clauses.push(`risk_level = $${values.length}`);
  }

  if (filter.source !== undefined) {
    values.push(JSON.stringify([{ source: filter.source }]));
    clauses.push(`source_refs @> $${values.length}::jsonb`);
  }

  const limit = normalizeLimit(filter.limit);
  values.push(limit);
  const whereClause = clauses.length === 0 ? '' : `where ${clauses.join(' and ')}`;

  return {
    sql: `
      select ${candidateReturnColumns()}
      from knowledge_candidates
      ${whereClause}
      order by updated_at desc
      limit $${values.length}
    `,
    values,
  };
}

function mapRawSupportMessageRow(row: RawSupportMessageRow): RawSupportMessage {
  return {
    source: row.source,
    chatIdHash: row.chat_id_hash,
    messageId: row.message_id,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }),
    senderRole: row.sender_role,
    sentAt: toIsoString(row.sent_at),
    text: row.text,
    contentHash: row.content_hash,
    ingestedAt: toIsoString(row.ingested_at),
    ...(row.attachments_metadata === null
      ? {}
      : { attachmentsMetadata: row.attachments_metadata as Record<string, unknown> }),
  };
}

function mapCandidateRow(row: KnowledgeCandidateRow): KnowledgeCandidate {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    question: row.question,
    proposedAnswer: row.proposed_answer,
    targetCategory: row.target_category,
    sourceRefs: row.source_refs as KnowledgeCandidate['sourceRefs'],
    redactionReport: row.redaction_report as RedactionReport,
    existingKnowledgeMatches:
      row.existing_knowledge_matches as KnowledgeCandidate['existingKnowledgeMatches'],
    confidence: row.confidence,
    riskLevel: row.risk_level,
    generatedEvalCases: row.generated_eval_cases as KnowledgeCandidate['generatedEvalCases'],
    ...(row.reviewer === null ? {} : { reviewer: row.reviewer }),
    ...(row.review_notes === null ? {} : { reviewNotes: row.review_notes }),
    ...(row.published_target === null ? {} : { publishedTarget: row.published_target }),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapCandidateRunRow(row: KnowledgeCandidateRunRow): KnowledgeCandidateRun {
  return {
    candidateId: row.candidate_id,
    createdAt: toIsoString(row.created_at),
    metadata: row.metadata as Record<string, unknown>,
    runId: row.run_id,
    runType: row.run_type,
    status: row.status,
  };
}

function toCandidateRow(candidate: KnowledgeCandidate): KnowledgeCandidateRow {
  return {
    confidence: candidate.confidence,
    created_at: candidate.createdAt,
    existing_knowledge_matches: candidate.existingKnowledgeMatches,
    generated_eval_cases: candidate.generatedEvalCases,
    id: candidate.id,
    proposed_answer: candidate.proposedAnswer,
    published_target: candidate.publishedTarget ?? null,
    question: candidate.question,
    redaction_report: candidate.redactionReport,
    review_notes: candidate.reviewNotes ?? null,
    reviewer: candidate.reviewer ?? null,
    risk_level: candidate.riskLevel,
    source_refs: candidate.sourceRefs,
    status: candidate.status,
    target_category: candidate.targetCategory,
    type: candidate.type,
    updated_at: candidate.updatedAt,
  };
}

function reviewActionToStatus(
  action: ReviewKnowledgeCandidateInput['action'],
): KnowledgeCandidateStatus {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'reject':
    case 'merge_duplicate':
      return 'rejected';
    case 'request_changes':
      return 'draft';
  }
}

function candidateReturnColumns(): string {
  return `
    id,
    type,
    status,
    question,
    proposed_answer,
    target_category,
    source_refs,
    redaction_report,
    existing_knowledge_matches,
    confidence,
    risk_level,
    generated_eval_cases,
    reviewer,
    review_notes,
    published_target,
    created_at::text as created_at,
    updated_at::text as updated_at
  `;
}

function candidateRunReturnColumns(): string {
  return `
    candidate_id,
    run_id,
    run_type,
    status,
    metadata,
    created_at::text as created_at
  `;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_QUERY_LIMIT;
  }

  return Math.min(limit, MAX_QUERY_LIMIT);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
