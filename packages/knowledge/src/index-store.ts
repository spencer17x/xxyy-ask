import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { IndexEntry, RagChunk, RagIndex, SourceDocument } from '@xxyy/shared';

import { chunkMarkdownDocuments } from './chunk-markdown.js';
import { tokenize } from './tokenize.js';

const INDEX_VERSION = 1;
const DETERMINISTIC_BUILT_AT = '1970-01-01T00:00:00.000Z';
const DEFAULT_EMBEDDING_DIMENSIONS = 32;

export interface EmbeddingProvider {
  embed(text: string, chunk: RagChunk): number[] | Promise<number[]>;
}

export interface PreparedKnowledgeChunk extends RagChunk {
  searchableText: string;
  tokens: string[];
  contentHash: string;
}

export function prepareKnowledgeChunks(documents: SourceDocument[]): PreparedKnowledgeChunk[] {
  return chunkMarkdownDocuments(documents).map((chunk) => {
    const searchableText = createSearchableText(chunk);
    return {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        file: normalizeFilePath(chunk.metadata.file),
      },
      searchableText,
      tokens: tokenize(searchableText),
      contentHash: createContentHash(chunk.text),
    };
  });
}

export async function buildKnowledgeIndex(
  documents: SourceDocument[],
  embeddingProvider: EmbeddingProvider = localHashEmbeddingProvider,
): Promise<RagIndex> {
  const chunks = prepareKnowledgeChunks(documents);
  const entries: IndexEntry[] = [];

  for (const chunk of chunks) {
    const entry = {
      id: chunk.id,
      documentId: chunk.documentId,
      text: chunk.text,
      metadata: chunk.metadata,
      tokens: chunk.tokens,
    };
    entries.push({
      ...entry,
      embedding: await embeddingProvider.embed(chunk.searchableText, entry),
    });
  }

  return {
    version: INDEX_VERSION,
    builtAt: DETERMINISTIC_BUILT_AT,
    entries,
  };
}

export async function saveKnowledgeIndex(filePath: string, index: RagIndex): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

export async function loadKnowledgeIndex(filePath: string): Promise<RagIndex> {
  const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  if (!isRagIndex(parsed)) {
    throw new Error('Invalid knowledge index');
  }

  return parsed;
}

export const localHashEmbeddingProvider: EmbeddingProvider = {
  embed(text: string): number[] {
    return createLocalHashEmbedding(text);
  },
};

function createSearchableText(chunk: RagChunk): string {
  return [
    chunk.metadata.title,
    chunk.metadata.module,
    ...chunk.metadata.headingPath,
    chunk.text,
  ].join('\n');
}

function createContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeFilePath(file: string): string {
  return file.replace(/^\/+/, '');
}

export function createLocalHashEmbedding(
  text: string,
  dimensions = DEFAULT_EMBEDDING_DIMENSIONS,
): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const hash = hashString(token);
    const index = hash % dimensions;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }

  const norm = Math.hypot(...vector);
  if (norm === 0) {
    return vector;
  }

  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) {
      hash ^= codePoint;
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function isRagIndex(value: unknown): value is RagIndex {
  if (!isObject(value)) {
    return false;
  }

  return (
    value.version === INDEX_VERSION &&
    typeof value.builtAt === 'string' &&
    Array.isArray(value.entries) &&
    value.entries.every(isIndexEntry)
  );
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (!isObject(value) || !isChunkMetadata(value.metadata)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.documentId === 'string' &&
    typeof value.text === 'string' &&
    Array.isArray(value.tokens) &&
    value.tokens.every((token) => typeof token === 'string') &&
    Array.isArray(value.embedding) &&
    value.embedding.every((dimension) => typeof dimension === 'number')
  );
}

function isChunkMetadata(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.title === 'string' &&
    typeof value.module === 'string' &&
    (value.sourceType === 'official_docs' || value.sourceType === 'x_updates') &&
    typeof value.file === 'string' &&
    Array.isArray(value.headingPath) &&
    value.headingPath.every((heading) => typeof heading === 'string') &&
    isOptionalString(value.sourceUrl) &&
    (value.order === undefined || typeof value.order === 'number')
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}
