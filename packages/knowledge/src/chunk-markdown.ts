import type { ChunkMetadata, RagChunk, SourceDocument } from '@xxyy/shared';

const DEFAULT_MAX_CHUNK_CHARS = 1200;

export interface ChunkMarkdownOptions {
  maxChunkChars?: number;
}

interface TextGroup {
  text: string;
  headingPath: string[];
}

export function chunkMarkdownDocuments(
  documents: SourceDocument[],
  options: ChunkMarkdownOptions = {},
): RagChunk[] {
  return documents.flatMap((document) => chunkMarkdownDocument(document, options));
}

function chunkMarkdownDocument(
  document: SourceDocument,
  options: ChunkMarkdownOptions = {},
): RagChunk[] {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  if (!Number.isInteger(maxChunkChars) || maxChunkChars <= 0) {
    throw new Error('maxChunkChars must be a positive integer');
  }

  const groups = collectMarkdownGroups(document.content, document.title);
  const chunks: RagChunk[] = [];

  for (const group of groups) {
    for (const text of splitText(group.text, maxChunkChars)) {
      const metadata = createChunkMetadata(document, group.headingPath);
      chunks.push({
        id: `${document.id}:chunk:${String(chunks.length + 1).padStart(4, '0')}`,
        documentId: document.id,
        text,
        metadata,
      });
    }
  }

  return chunks;
}

function collectMarkdownGroups(content: string, fallbackTitle: string): TextGroup[] {
  const lines = stripFrontmatter(content).split(/\r?\n/);
  const groups: TextGroup[] = [];
  let headingPath = [fallbackTitle];
  let currentLines: string[] = [];
  let currentKind: 'paragraph' | 'list' | undefined;

  const flush = (): void => {
    const text = currentLines.join('\n').trim();
    if (text.length > 0) {
      groups.push({ text, headingPath: [...headingPath] });
    }
    currentLines = [];
    currentKind = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
    if (heading !== null) {
      flush();
      const level = heading[1]?.length ?? 1;
      const title = heading[2]?.trim() ?? fallbackTitle;
      headingPath = [...headingPath.slice(0, level - 1), title];
      continue;
    }

    if (trimmed.length === 0) {
      flush();
      continue;
    }

    const kind = isListLine(trimmed) ? 'list' : 'paragraph';
    if (currentKind !== undefined && currentKind !== kind) {
      flush();
    }
    currentKind = kind;
    currentLines.push(trimmed);
  }

  flush();
  return groups;
}

function splitText(text: string, maxChunkChars: number): string[] {
  if (text.length <= maxChunkChars) {
    return [text];
  }

  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    current = line;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.flatMap((chunk) => splitLongLine(chunk, maxChunkChars));
}

function splitLongLine(text: string, maxChunkChars: number): string[] {
  if (text.length <= maxChunkChars) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChunkChars) {
    chunks.push(text.slice(index, index + maxChunkChars));
  }
  return chunks;
}

function createChunkMetadata(document: SourceDocument, headingPath: string[]): ChunkMetadata {
  const metadata: ChunkMetadata = {
    title: document.title,
    module: document.module,
    sourceType: document.sourceType,
    file: document.file,
    headingPath,
  };

  if (document.sourceUrl !== undefined) {
    metadata.sourceUrl = document.sourceUrl;
  }
  if (document.order !== undefined) {
    metadata.order = document.order;
  }
  if (document.effectiveAt !== undefined) {
    metadata.effectiveAt = document.effectiveAt;
  }
  if (document.retrievedAt !== undefined) {
    metadata.retrievedAt = document.retrievedAt;
  }
  if (document.status !== undefined) {
    metadata.status = document.status;
  }
  if (document.supersedes !== undefined && document.supersedes.length > 0) {
    metadata.supersedes = document.supersedes;
  }

  return metadata;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) {
    return content;
  }

  const endMatch = /\r?\n---\r?\n/.exec(content.slice(3));
  if (endMatch === null) {
    return content;
  }

  return content.slice(3 + endMatch.index + endMatch[0].length);
}

function isListLine(line: string): boolean {
  return /^(?:[-*+]|\d+\.)\s+/.test(line);
}
