import { Pool } from 'pg';

import type { BatchEmbeddingProvider, PreparedKnowledgeChunk } from '@xxyy/knowledge';
import { tokenize } from '@xxyy/knowledge';
import type { ChunkMetadata, IndexEntry, SourceType } from '@xxyy/shared';

import type { RetrieveOptions, RetrievedChunk } from './retrieve.js';
import type { Retriever } from './retriever.js';

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
  migrate(): Promise<void>;
  upsertChunks(chunks: EmbeddedKnowledgeChunk[]): Promise<void>;
}

export interface PgVectorStoreOptions {
  client: PgClientLike;
  embeddingProvider: BatchEmbeddingProvider;
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

const PGVECTOR_EMBEDDING_DIMENSION = 1536;
const DEFAULT_TOP_K = 6;

export class VectorStoreConfigurationError extends Error {}

export function createPgPool(databaseUrl: string | undefined): Pool {
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new VectorStoreConfigurationError(
      'DATABASE_URL is required when RAG_VECTOR_STORE=pgvector.',
    );
  }

  return new Pool({ connectionString: databaseUrl });
}

export function createPgVectorStore(options: PgVectorStoreOptions): PgVectorStore {
  return {
    async migrate(): Promise<void> {
      await options.client.query('create extension if not exists vector');
      await options.client.query(`
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
      `);
      await options.client.query(`
        create index if not exists knowledge_chunks_embedding_idx
          on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
      `);
      await options.client.query(`
        create index if not exists knowledge_chunks_tokens_idx
          on knowledge_chunks using gin (tokens)
      `);
      await options.client.query(`
        create index if not exists knowledge_chunks_source_type_idx
          on knowledge_chunks (source_type)
      `);
    },

    async upsertChunks(chunks: EmbeddedKnowledgeChunk[]): Promise<void> {
      for (const chunk of chunks) {
        validateEmbedding(chunk.embedding);

        await options.client.query(
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
    },

    async retrieve(question: string, retrieveOptions: RetrieveOptions): Promise<RetrievedChunk[]> {
      const [queryEmbedding] = await options.embeddingProvider.embedTexts([question]);
      if (queryEmbedding === undefined) {
        return [];
      }

      validateEmbedding(queryEmbedding);

      const topK = normalizeTopK(retrieveOptions.topK);
      const queryTokens = tokenize(question);
      const response = await options.client.query<KnowledgeChunkRow>(
        `
        select
          id, document_id, title, module, source_type, source_url, file,
          heading_path, order_index, retrieved_at, content, tokens,
          embedding <=> $1::vector as embedding_distance
        from knowledge_chunks
        order by embedding <=> $1::vector
        limit $2
        `,
        [toPgVectorLiteral(queryEmbedding), Math.max(topK * 4, topK)],
      );

      return response.rows
        .map((row) => mapRow(row, queryTokens))
        .sort(compareRetrievedChunks)
        .slice(0, topK)
        .map((chunk, index) => ({ ...chunk, rank: index + 1 }));
    },
  };
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

function mapRow(row: KnowledgeChunkRow, queryTokens: string[]): RetrievedChunk {
  const lexicalScore = queryTokens.filter((token) => row.tokens.includes(token)).length;
  const vectorScore = Math.max(0, 1 - row.embedding_distance);
  const score = Number(
    (vectorScore + lexicalScore * 0.1 + sourceBoost(row.source_type)).toFixed(8),
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

function compareRetrievedChunks(left: RetrievedChunk, right: RetrievedChunk): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.id.localeCompare(right.id);
}
