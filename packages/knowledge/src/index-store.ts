import { createHash } from 'node:crypto';

import type { RagChunk, SourceDocument } from '@xxyy/shared';

import { chunkMarkdownDocuments } from './chunk-markdown.js';
import { tokenize } from './tokenize.js';

const DEFAULT_EMBEDDING_DIMENSIONS = 32;

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
      contentHash: createContentHash(chunk),
    };
  });
}

function createSearchableText(chunk: RagChunk): string {
  return [
    chunk.metadata.title,
    chunk.metadata.module,
    ...chunk.metadata.headingPath,
    chunk.text,
  ].join('\n');
}

function createContentHash(chunk: RagChunk): string {
  return createHash('sha256')
    .update(chunk.text)
    .update('\0')
    .update(JSON.stringify(chunk.metadata.attachments ?? []))
    .digest('hex');
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
