import { Pool } from 'pg';

import type { BatchEmbeddingProvider, PreparedKnowledgeChunk } from '@xxyy/knowledge';
import { tokenize } from '@xxyy/knowledge';
import type { ChatChannel, ChunkMetadata, IndexEntry, Intent, SourceType } from '@xxyy/shared';

import type { RetrieveOptions, RetrievedChunk } from './retrieve.js';
import type { Retriever } from './retriever.js';
import { migratePgTxAnalysisReportStore } from './tx-analysis-report-store.js';

export interface PgClientLike {
  query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface PgVectorChunkMetadata extends ChunkMetadata {
  retrievedAt?: string;
}

export interface EmbeddedKnowledgeChunk extends Omit<PreparedKnowledgeChunk, 'metadata'> {
  metadata: PgVectorChunkMetadata;
  embedding: number[];
}

export interface PgVectorStore extends Retriever {
  getChunkContentHashes(chunkIds: readonly string[]): Promise<Map<string, string>>;
  getFeedbackStats(options?: GetFeedbackStatsOptions): Promise<FeedbackStats>;
  getStats(): Promise<KnowledgeStats>;
  migrate(): Promise<void>;
  recordFeedback(input: RecordFeedbackInput): Promise<void>;
  recordIngestionRun(input: RecordIngestionRunInput): Promise<void>;
  replaceChunks(chunks: EmbeddedKnowledgeChunk[]): Promise<void>;
  upsertChunks(chunks: EmbeddedKnowledgeChunk[]): Promise<void>;
}

export interface PgVectorStoreOptions {
  client: PgClientLike;
  embeddingProvider: BatchEmbeddingProvider;
}

export interface PgFeedbackStore {
  getFeedbackStats(options?: GetFeedbackStatsOptions): Promise<FeedbackStats>;
  recordFeedback(input: RecordFeedbackInput): Promise<void>;
}

export interface PgFeedbackStoreOptions {
  client: PgClientLike;
}

interface KnowledgeChunkRow {
  id: string;
  document_id: string;
  title: string;
  module: string;
  source_type: SourceType;
  source_url: string | null;
  file: string;
  heading_path: string[];
  order_index: number | null;
  retrieved_at: string | null;
  content: string;
  tokens: string[];
  embedding_distance: number;
}

interface KnowledgeChunkHashRow {
  content_hash: string;
  id: string;
}

export interface RecordIngestionRunInput {
  runId: string;
  source: string;
  documentCount: number;
  chunkCount: number;
  sourceCounts: Partial<Record<SourceType, number>>;
  contentHash: string;
}

export type FeedbackRating = 'positive' | 'negative';

export interface RecordFeedbackInput {
  answer: string;
  channel: ChatChannel;
  citationCount: number;
  intent: Intent;
  question: string;
  rating: FeedbackRating;
  comment?: string;
  sessionId?: string;
}

export interface GetFeedbackStatsOptions {
  limit?: number;
  rating?: FeedbackRating;
}

export interface FeedbackStats {
  totalCount: number;
  positiveCount: number;
  negativeCount: number;
  latest: FeedbackRecord[];
}

export interface FeedbackRecord {
  answer: string;
  channel: ChatChannel;
  citationCount: number;
  createdAt: string;
  intent: Intent;
  question: string;
  rating: FeedbackRating;
  comment?: string;
  sessionId?: string;
}

export interface KnowledgeSourceStats {
  sourceType: SourceType;
  documentCount: number;
  chunkCount: number;
}

export interface KnowledgeIngestionRun {
  runId: string;
  source: string;
  documentCount: number;
  chunkCount: number;
  sourceCounts: Partial<Record<SourceType, number>>;
  contentHash: string;
  createdAt: string;
}

export interface KnowledgeStats {
  documentCount: number;
  chunkCount: number;
  sourceUrlCount: number;
  sourceStats: KnowledgeSourceStats[];
  latestChunkUpdatedAt?: string;
  latestIngestionRun?: KnowledgeIngestionRun;
}

interface KnowledgeStatsRow {
  document_count: number;
  chunk_count: number;
  source_url_count: number;
  latest_chunk_updated_at: string | null;
}

interface KnowledgeSourceStatsRow {
  source_type: SourceType;
  document_count: number;
  chunk_count: number;
}

interface KnowledgeIngestionRunRow {
  run_id: string;
  source: string;
  document_count: number;
  chunk_count: number;
  source_counts: Partial<Record<SourceType, number>>;
  content_hash: string;
  created_at: string;
}

interface FeedbackStatsRow {
  total_count: number;
  positive_count: number;
  negative_count: number;
}

interface FeedbackRecordRow {
  answer: string;
  channel: ChatChannel;
  citation_count: number;
  comment: string | null;
  created_at: string;
  intent: Intent;
  question: string;
  rating: FeedbackRating;
  session_id: string | null;
}

const PGVECTOR_EMBEDDING_DIMENSION = 1536;
const DEFAULT_TOP_K = 6;
const LEXICAL_SCORE_WEIGHT = 0.5;
const DIRECT_X_POST_SOURCE_BOOST = 6;

export class VectorStoreConfigurationError extends Error {}

export class VectorStoreUnavailableError extends Error {
  constructor(public readonly originalError: unknown) {
    super('Vector store is unavailable. Check DATABASE_URL and database connectivity.');
  }
}

export function createPgPool(databaseUrl: string | undefined): Pool {
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new VectorStoreConfigurationError('DATABASE_URL is required for pgvector retrieval.');
  }

  return new Pool({ connectionString: databaseUrl });
}

export function createPgFeedbackStore(options: PgFeedbackStoreOptions): PgFeedbackStore {
  return {
    async getFeedbackStats(input: GetFeedbackStatsOptions = {}): Promise<FeedbackStats> {
      return getFeedbackStats(options.client, input);
    },

    async recordFeedback(input: RecordFeedbackInput): Promise<void> {
      await recordFeedback(options.client, input);
    },
  };
}

export function createPgVectorStore(options: PgVectorStoreOptions): PgVectorStore {
  const upsertChunks = async (chunks: EmbeddedKnowledgeChunk[]): Promise<void> => {
    for (const chunk of chunks) {
      validateEmbedding(chunk.embedding);

      await queryDatabase(
        options.client,
        `
        insert into knowledge_chunks (
          id, document_id, title, module, source_type, source_url, file,
          heading_path, order_index, retrieved_at, content, tokens, embedding, content_hash,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::vector, $14, now())
        on conflict (id) do update set
          document_id = excluded.document_id,
          title = excluded.title,
          module = excluded.module,
          source_type = excluded.source_type,
          source_url = excluded.source_url,
          file = excluded.file,
          heading_path = excluded.heading_path,
          order_index = excluded.order_index,
          retrieved_at = coalesce(excluded.retrieved_at, knowledge_chunks.retrieved_at),
          content = excluded.content,
          tokens = excluded.tokens,
          embedding = excluded.embedding,
          content_hash = excluded.content_hash,
          updated_at = now()
        `,
        [
          chunk.id,
          chunk.documentId,
          chunk.metadata.title,
          chunk.metadata.module,
          chunk.metadata.sourceType,
          chunk.metadata.sourceUrl,
          chunk.metadata.file,
          JSON.stringify(chunk.metadata.headingPath),
          chunk.metadata.order,
          chunk.metadata.retrievedAt ?? null,
          chunk.text,
          chunk.tokens,
          toPgVectorLiteral(chunk.embedding),
          chunk.contentHash,
        ],
      );
    }
  };

  return {
    async getChunkContentHashes(chunkIds: readonly string[]): Promise<Map<string, string>> {
      if (chunkIds.length === 0) {
        return new Map();
      }

      const response = await queryDatabase<KnowledgeChunkHashRow>(
        options.client,
        `
        select id, content_hash
        from knowledge_chunks
        where id = any($1::text[])
        `,
        [chunkIds],
      );

      return new Map(response.rows.map((row) => [row.id, row.content_hash]));
    },

    async getFeedbackStats(input: GetFeedbackStatsOptions = {}): Promise<FeedbackStats> {
      return getFeedbackStats(options.client, input);
    },

    async getStats(): Promise<KnowledgeStats> {
      const [totals, sourceStats, latestIngestionRun] = await Promise.all([
        getKnowledgeTotals(options.client),
        getKnowledgeSourceStats(options.client),
        getLatestIngestionRun(options.client),
      ]);

      return {
        chunkCount: totals.chunk_count,
        documentCount: totals.document_count,
        sourceStats,
        sourceUrlCount: totals.source_url_count,
        ...(totals.latest_chunk_updated_at === null
          ? {}
          : { latestChunkUpdatedAt: totals.latest_chunk_updated_at }),
        ...(latestIngestionRun === undefined ? {} : { latestIngestionRun }),
      };
    },

    async migrate(): Promise<void> {
      await queryDatabase(options.client, 'create extension if not exists vector');
      await queryDatabase(
        options.client,
        `
        create table if not exists knowledge_chunks (
          id text primary key,
          document_id text not null,
          title text not null,
          module text not null,
          source_type text not null check (source_type in ('official_docs', 'x_updates')),
          source_url text,
          file text not null,
          heading_path jsonb not null,
          order_index integer,
          retrieved_at timestamptz,
          content text not null,
          tokens text[] not null,
          embedding vector(1536) not null,
          content_hash text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists knowledge_chunks_embedding_idx
          on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists knowledge_chunks_tokens_idx
          on knowledge_chunks using gin (tokens)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists knowledge_chunks_source_type_idx
          on knowledge_chunks (source_type)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create table if not exists rag_ingestion_runs (
          id bigserial primary key,
          run_id text not null unique,
          source text not null,
          document_count integer not null,
          chunk_count integer not null,
          source_counts jsonb not null,
          content_hash text not null,
          created_at timestamptz not null default now()
        )
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists rag_ingestion_runs_created_at_idx
          on rag_ingestion_runs (created_at desc)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create table if not exists rag_feedback (
          id bigserial primary key,
          channel text not null check (channel in ('cli', 'web', 'telegram')),
          session_id text,
          rating text not null check (rating in ('positive', 'negative')),
          question text not null,
          answer text not null,
          intent text not null check (
            intent in (
              'product_qa',
              'how_to',
              'realtime_account_query',
              'mev_or_chain_forensics',
              'investment_advice',
              'unknown'
            )
          ),
          citation_count integer not null check (citation_count >= 0),
          comment text,
          created_at timestamptz not null default now()
        )
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists rag_feedback_created_at_idx
          on rag_feedback (created_at desc)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists rag_feedback_rating_idx
          on rag_feedback (rating)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists rag_feedback_session_id_idx
          on rag_feedback (session_id)
          where session_id is not null
      `,
      );
      await migratePgTxAnalysisReportStore(options.client);
    },

    async recordFeedback(input: RecordFeedbackInput): Promise<void> {
      await recordFeedback(options.client, input);
    },

    async recordIngestionRun(input: RecordIngestionRunInput): Promise<void> {
      await queryDatabase(
        options.client,
        `
        insert into rag_ingestion_runs (
          run_id, source, document_count, chunk_count, source_counts, content_hash
        )
        values ($1, $2, $3, $4, $5::jsonb, $6)
        on conflict (run_id) do nothing
        `,
        [
          input.runId,
          input.source,
          input.documentCount,
          input.chunkCount,
          JSON.stringify(input.sourceCounts),
          input.contentHash,
        ],
      );
    },

    async replaceChunks(chunks: EmbeddedKnowledgeChunk[]): Promise<void> {
      await upsertChunks(chunks);
      await pruneStaleChunks(
        options.client,
        chunks.map((chunk) => chunk.id),
      );
    },

    upsertChunks,

    async retrieve(question: string, retrieveOptions: RetrieveOptions): Promise<RetrievedChunk[]> {
      const [queryEmbedding] = await options.embeddingProvider.embedTexts([question]);
      if (queryEmbedding === undefined) {
        return [];
      }

      validateEmbedding(queryEmbedding);

      const topK = normalizeTopK(retrieveOptions.topK);
      const queryTokens = tokenize(question);
      const candidateLimit = Math.max(topK * 4, topK);
      const response = await queryDatabase<KnowledgeChunkRow>(
        options.client,
        `
        with vector_candidates as (
          select
            id, document_id, title, module, source_type, source_url, file,
            heading_path, order_index, retrieved_at, content, tokens,
            embedding <=> $1::vector as embedding_distance,
            0::integer as token_overlap
          from knowledge_chunks
          order by embedding <=> $1::vector
          limit $2
        ),
        lexical_candidates as (
          select
            id, document_id, title, module, source_type, source_url, file,
            heading_path, order_index, retrieved_at, content, tokens,
            embedding <=> $1::vector as embedding_distance,
            (
              select count(*)::integer
              from unnest(tokens) as token(value)
              where token.value = any($3::text[])
            ) as token_overlap
          from knowledge_chunks
          where tokens && $3::text[]
          order by token_overlap desc, embedding_distance asc
          limit $2
        ),
        combined_candidates as (
          select * from vector_candidates
          union all
          select * from lexical_candidates
        )
        select distinct on (id)
          id, document_id, title, module, source_type, source_url, file,
          heading_path, order_index, retrieved_at, content, tokens,
          embedding_distance
        from combined_candidates
        order by id, token_overlap desc, embedding_distance asc
        `,
        [toPgVectorLiteral(queryEmbedding), candidateLimit, queryTokens],
      );

      return response.rows
        .map((row) => mapRow(row, question, queryTokens))
        .sort(compareRetrievedChunks)
        .slice(0, topK)
        .map((chunk, index) => ({ ...chunk, rank: index + 1 }));
    },
  };
}

async function getFeedbackStats(
  client: PgClientLike,
  options: GetFeedbackStatsOptions,
): Promise<FeedbackStats> {
  const [totals, latest] = await Promise.all([
    getFeedbackTotals(client, options.rating),
    getLatestFeedback(client, options.limit, options.rating),
  ]);

  return {
    latest,
    negativeCount: totals.negative_count,
    positiveCount: totals.positive_count,
    totalCount: totals.total_count,
  };
}

async function getFeedbackTotals(
  client: PgClientLike,
  rating: FeedbackRating | undefined,
): Promise<FeedbackStatsRow> {
  const whereClause = rating === undefined ? '' : 'where rating = $1';
  const values = rating === undefined ? [] : [rating];
  const response = await queryDatabase<FeedbackStatsRow>(
    client,
    `
    select
      count(*)::integer as total_count,
      count(*) filter (where rating = 'positive')::integer as positive_count,
      count(*) filter (where rating = 'negative')::integer as negative_count
    from rag_feedback
    ${whereClause}
    `,
    values,
  );

  return (
    response.rows[0] ?? {
      negative_count: 0,
      positive_count: 0,
      total_count: 0,
    }
  );
}

async function getLatestFeedback(
  client: PgClientLike,
  limit: number | undefined,
  rating: FeedbackRating | undefined,
): Promise<FeedbackRecord[]> {
  const normalizedLimit = normalizeFeedbackLimit(limit);
  const whereClause = rating === undefined ? '' : 'where rating = $1';
  const values = rating === undefined ? [normalizedLimit] : [rating, normalizedLimit];
  const response = await queryDatabase<FeedbackRecordRow>(
    client,
    `
    select
      answer,
      channel,
      citation_count,
      comment,
      created_at::text as created_at,
      intent,
      question,
      rating,
      session_id
    from rag_feedback
    ${whereClause}
    order by created_at desc
    limit $${values.length}
    `,
    values,
  );

  return response.rows.map((row) => ({
    answer: row.answer,
    channel: row.channel,
    citationCount: row.citation_count,
    createdAt: row.created_at,
    intent: row.intent,
    question: row.question,
    rating: row.rating,
    ...(row.comment === null ? {} : { comment: row.comment }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
  }));
}

async function recordFeedback(client: PgClientLike, input: RecordFeedbackInput): Promise<void> {
  const question = sanitizeFeedbackText(input.question);
  const answer = sanitizeFeedbackText(input.answer);
  const comment = input.comment === undefined ? null : sanitizeFeedbackText(input.comment);

  await queryDatabase(
    client,
    `
    insert into rag_feedback (
      channel, session_id, rating, question, answer, intent, citation_count, comment
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      input.channel,
      input.sessionId ?? null,
      input.rating,
      question,
      answer,
      input.intent,
      input.citationCount,
      comment,
    ],
  );
}

function sanitizeFeedbackText(text: string): string {
  return redactFeedbackCredentials(text)
    .replace(/\b0x[a-fA-F0-9]{64}\b/gu, '[evm_tx_hash]')
    .replace(/\b0x[a-fA-F0-9]{40}\b/gu, '[evm_address]')
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/gu, '[solana_signature]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, '[phone]')
    .trim();
}

function redactFeedbackCredentials(text: string): string {
  return text
    .replace(
      /((?:私钥|助记词|恢复词|密钥)\s*(?:是|为|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:private\s+key|seed\s+phrase|mnemonic|secret\s+recovery\s+phrase)\s*(?:is|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:我的)?(?:密码|登录密码)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:api\s*key|access\s*token|auth\s*token|访问令牌)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
      '$1[sensitive_credential]',
    )
    .replace(/(\b(?:my\s+)?password\s*(?:is|:|=)\s*)[^\s,，。；;]+/giu, '$1[sensitive_credential]');
}

async function getKnowledgeTotals(client: PgClientLike): Promise<KnowledgeStatsRow> {
  const response = await queryDatabase<KnowledgeStatsRow>(
    client,
    `
    select
      count(distinct document_id)::integer as document_count,
      count(*)::integer as chunk_count,
      (count(distinct source_url) filter (where source_url is not null))::integer as source_url_count,
      max(updated_at)::text as latest_chunk_updated_at
    from knowledge_chunks
    `,
  );

  return (
    response.rows[0] ?? {
      chunk_count: 0,
      document_count: 0,
      latest_chunk_updated_at: null,
      source_url_count: 0,
    }
  );
}

async function getKnowledgeSourceStats(client: PgClientLike): Promise<KnowledgeSourceStats[]> {
  const response = await queryDatabase<KnowledgeSourceStatsRow>(
    client,
    `
    select
      source_type,
      count(distinct document_id)::integer as document_count,
      count(*)::integer as chunk_count
    from knowledge_chunks
    group by source_type
    order by source_type
    `,
  );

  return response.rows.map((row) => ({
    chunkCount: row.chunk_count,
    documentCount: row.document_count,
    sourceType: row.source_type,
  }));
}

async function getLatestIngestionRun(
  client: PgClientLike,
): Promise<KnowledgeIngestionRun | undefined> {
  const response = await queryDatabase<KnowledgeIngestionRunRow>(
    client,
    `
    select
      run_id,
      source,
      document_count,
      chunk_count,
      source_counts,
      content_hash,
      created_at::text as created_at
    from rag_ingestion_runs
    order by created_at desc
    limit 1
    `,
  );
  const row = response.rows[0];
  if (row === undefined) {
    return undefined;
  }

  return {
    chunkCount: row.chunk_count,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    documentCount: row.document_count,
    runId: row.run_id,
    source: row.source,
    sourceCounts: row.source_counts,
  };
}

async function pruneStaleChunks(client: PgClientLike, retainedChunkIds: string[]): Promise<void> {
  await queryDatabase(
    client,
    `
    delete from knowledge_chunks
    where not (id = any($1::text[]))
    `,
    [retainedChunkIds],
  );
}

async function queryDatabase<T>(
  client: PgClientLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ rows: T[] }> {
  try {
    return await client.query<T>(sql, values);
  } catch (error) {
    throw new VectorStoreUnavailableError(error);
  }
}

export function toPgVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function validateEmbedding(embedding: number[]): void {
  if (embedding.length !== PGVECTOR_EMBEDDING_DIMENSION) {
    throw new Error(
      `Expected embedding dimension ${PGVECTOR_EMBEDDING_DIMENSION}, got ${embedding.length}.`,
    );
  }

  for (let index = 0; index < PGVECTOR_EMBEDDING_DIMENSION; index += 1) {
    if (!Number.isFinite(embedding[index])) {
      throw new Error('Embedding contains a non-finite value.');
    }
  }
}

function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined) {
    return DEFAULT_TOP_K;
  }

  if (!Number.isInteger(topK) || topK <= 0) {
    return DEFAULT_TOP_K;
  }

  return topK;
}

function normalizeFeedbackLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 10;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    return 10;
  }

  return Math.min(limit, 100);
}

function mapRow(row: KnowledgeChunkRow, question: string, queryTokens: string[]): RetrievedChunk {
  const lexicalScore = queryTokens.filter((token) => row.tokens.includes(token)).length;
  const vectorScore = Math.max(0, 1 - row.embedding_distance);
  const score = Number(
    (
      vectorScore +
      lexicalScore * LEXICAL_SCORE_WEIGHT +
      sourceBoost(row.source_type) +
      directXPostSourceBoost(question, row)
    ).toFixed(8),
  );
  const entry: IndexEntry = {
    documentId: row.document_id,
    embedding: [],
    id: row.id,
    metadata: {
      file: row.file,
      headingPath: row.heading_path,
      module: row.module,
      sourceType: row.source_type,
      title: row.title,
      ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
      ...(row.order_index === null ? {} : { order: row.order_index }),
      ...(row.retrieved_at === null ? {} : { retrievedAt: row.retrieved_at }),
    },
    text: row.content,
    tokens: row.tokens,
  };

  return {
    ...entry,
    lexicalScore,
    rank: 0,
    score,
    vectorScore,
  };
}

function sourceBoost(sourceType: SourceType): number {
  return sourceType === 'official_docs' ? 0.05 : 0;
}

function directXPostSourceBoost(question: string, row: KnowledgeChunkRow): number {
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();
  if (!/哪条推文|哪条推特|推文|推特|tweet|x\s*post/u.test(normalizedQuestion)) {
    return 0;
  }

  if (
    row.source_type === 'x_updates' &&
    row.title.startsWith('X Post ') &&
    row.source_url !== null &&
    /^https:\/\/x\.com\/useXXYYio\/status\/\d+$/iu.test(row.source_url)
  ) {
    return DIRECT_X_POST_SOURCE_BOOST;
  }

  return 0;
}

function compareRetrievedChunks(left: RetrievedChunk, right: RetrievedChunk): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.id.localeCompare(right.id);
}
