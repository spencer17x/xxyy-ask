import type { ChunkMetadata, RagChunk, SourceDocument } from '@xxyy/shared';

const DEFAULT_MAX_CHUNK_CHARS = 900;
const DEFAULT_OVERLAP_CHARS = 100;

export interface ChunkMarkdownOptions {
  maxChunkChars?: number;
  overlapChars?: number;
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
  const overlapChars =
    options.overlapChars ?? Math.min(DEFAULT_OVERLAP_CHARS, Math.floor(maxChunkChars / 4));
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChunkChars) {
    throw new Error('overlapChars must be a non-negative integer smaller than maxChunkChars');
  }

  const groups = mergeAdjacentGroups(
    collectMarkdownGroups(document.content, document.title),
    maxChunkChars,
  );
  const chunks: RagChunk[] = [];

  for (const group of groups) {
    for (const text of splitText(group.text, maxChunkChars, overlapChars)) {
      if (!isIndexableChunkText(text)) {
        continue;
      }
      const metadata = createChunkMetadata(document, group.headingPath);
      chunks.push({
        id: `${document.id}:chunk:${String(chunks.length + 1).padStart(4, '0')}`,
        documentId: document.id,
        text,
        metadata,
      });
    }
  }

  const rollup = createDocumentRollup(groups, document.title, maxChunkChars);
  if (rollup !== undefined) {
    chunks.push({
      id: `${document.id}:chunk:${String(chunks.length + 1).padStart(4, '0')}`,
      documentId: document.id,
      text: rollup.text,
      metadata: createChunkMetadata(document, rollup.headingPath),
    });
  }

  return chunks;
}

function createDocumentRollup(
  groups: TextGroup[],
  documentTitle: string,
  maxChunkChars: number,
): TextGroup | undefined {
  const sections = groups
    .filter((group) => !isFencedCodeBlock(group.text) && isIndexableChunkText(group.text))
    .map((group) => ({
      heading: group.headingPath.slice(1).join(' > ') || documentTitle,
      text: group.text,
    }));
  const distinctHeadings = new Set(sections.map((section) => section.heading));
  if (distinctHeadings.size < 3) {
    return undefined;
  }

  const text = sections.map((section) => `### ${section.heading}\n${section.text}`).join('\n\n');
  if (text.length > maxChunkChars) {
    return undefined;
  }

  return {
    headingPath: [documentTitle, 'Document overview / 页面概览'],
    text,
  };
}

function mergeAdjacentGroups(groups: TextGroup[], maxChunkChars: number): TextGroup[] {
  const merged: TextGroup[] = [];

  for (const group of groups) {
    const previous = merged.at(-1);
    const combinedText = previous === undefined ? group.text : `${previous.text}\n\n${group.text}`;
    if (
      previous !== undefined &&
      sameHeadingPath(previous.headingPath, group.headingPath) &&
      combinedText.length <= maxChunkChars
    ) {
      previous.text = combinedText;
      continue;
    }

    merged.push({ headingPath: [...group.headingPath], text: group.text });
  }

  return merged;
}

function sameHeadingPath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((heading, index) => heading === right[index]);
}

function collectMarkdownGroups(content: string, fallbackTitle: string): TextGroup[] {
  const lines = stripFrontmatter(content).split(/\r?\n/);
  const groups: TextGroup[] = [];
  let headingPath = [fallbackTitle];
  let currentLines: string[] = [];
  let currentKind: 'code' | 'paragraph' | 'list' | undefined;
  let activeFence: string | undefined;

  const flush = (): void => {
    const text = stripNonSemanticMarkup(currentLines.join('\n'));
    if (text.length > 0) {
      groups.push({ text, headingPath: [...headingPath] });
    }
    currentLines = [];
    currentKind = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (activeFence !== undefined) {
      currentLines.push(trimmed);
      if (isClosingFence(trimmed, activeFence)) {
        activeFence = undefined;
        flush();
      }
      continue;
    }

    const openingFence = /^(`{3,}|~{3,})/u.exec(trimmed)?.[1];
    if (openingFence !== undefined) {
      flush();
      currentKind = 'code';
      currentLines.push(trimmed);
      activeFence = openingFence;
      continue;
    }

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

function splitText(text: string, maxChunkChars: number, overlapChars: number): string[] {
  if (text.length <= maxChunkChars) {
    return [text];
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const separator = text.includes('\n') ? '\n' : ' ';
  const structuredBlock =
    isFencedCodeBlock(text) || (lines.length > 1 && lines.every(isStructuredLine));
  const units = structuredBlock ? lines : lines.flatMap(splitSentences);
  return packSemanticUnits(units, maxChunkChars, structuredBlock ? 0 : overlapChars, separator);
}

function packSemanticUnits(
  units: string[],
  maxChunkChars: number,
  overlapChars: number,
  separator: string,
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];

  const flush = (): string[] => {
    if (current.length === 0) {
      return [];
    }
    const flushed = [...current];
    chunks.push(joinUnits(flushed, separator));
    current = [];
    return flushed;
  };

  for (const unit of units) {
    if (unit.length > maxChunkChars) {
      flush();
      chunks.push(...splitLongLine(unit, maxChunkChars, overlapChars));
      continue;
    }

    const candidate = joinUnits([...current, unit], separator);
    if (candidate.length <= maxChunkChars) {
      current.push(unit);
      continue;
    }

    const previous = flush();
    current = createOverlapUnits(previous, overlapChars, separator);
    while (current.length > 0 && joinUnits([...current, unit], separator).length > maxChunkChars) {
      current.shift();
    }
    current.push(unit);
  }

  flush();
  return chunks;
}

function createOverlapUnits(units: string[], overlapChars: number, separator: string): string[] {
  if (overlapChars === 0 || units.length === 0) {
    return [];
  }

  const selected: string[] = [];
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit === undefined) {
      continue;
    }
    const candidate = joinUnits([unit, ...selected], separator);
    if (candidate.length > overlapChars) {
      break;
    }
    selected.unshift(unit);
  }
  if (selected.length > 0) {
    return selected;
  }

  const last = units.at(-1);
  return last === undefined ? [] : [last.slice(-overlapChars)];
}

function splitLongLine(text: string, maxChunkChars: number, overlapChars: number): string[] {
  if (text.length <= maxChunkChars) {
    return [text];
  }

  const chunks: string[] = [];
  const step = maxChunkChars - overlapChars;
  for (let index = 0; index < text.length; index += step) {
    chunks.push(text.slice(index, index + maxChunkChars));
    if (index + maxChunkChars >= text.length) {
      break;
    }
  }
  return chunks;
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    const isBoundary =
      character === '。' ||
      character === '！' ||
      character === '？' ||
      character === '；' ||
      character === '!' ||
      character === '?' ||
      character === ';' ||
      (character === '.' && (next === undefined || /\s/u.test(next)));
    if (!isBoundary) {
      continue;
    }
    const sentence = text.slice(start, index + 1).trim();
    if (sentence.length > 0) {
      sentences.push(sentence);
    }
    start = index + 1;
  }
  const remainder = text.slice(start).trim();
  if (remainder.length > 0) {
    sentences.push(remainder);
  }
  return sentences.length === 0 ? [text] : sentences;
}

function joinUnits(units: string[], separator: string): string {
  return units.join(separator).trim();
}

function isStructuredLine(line: string): boolean {
  return (
    isListLine(line) || /^\|.*\|$/u.test(line) || /^```[a-z0-9_-]*$/iu.test(line) || line === '```'
  );
}

function isIndexableChunkText(text: string): boolean {
  const normalized = text.trim();
  if (/^(?:```|~~~)[a-z0-9_-]*$/iu.test(normalized)) {
    return false;
  }
  if (/^\[(?:mit|license|许可证)\]\([^)]*\)[.!。]?$/iu.test(normalized)) {
    return false;
  }
  return hasMeaningfulText(normalized);
}

function stripNonSemanticMarkup(text: string): string {
  return text
    .replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<figure\b[^>]*>[^]*?<\/figure>/giu, (figure) =>
      hasMeaningfulText(figure) ? figure : ' ',
    )
    .replace(/^\s*(?:\*{3,}|-{3,}|_{3,})\s*$/gmu, ' ')
    .trim();
}

function hasMeaningfulText(text: string): boolean {
  return (
    text
      .replace(/<!--[^]*?-->/gu, ' ')
      .replace(/^\s*(?:```|~~~)[^\n]*$/gmu, ' ')
      .replace(/<img\b[^>]*\balt=(["'])(.*?)\1[^>]*>/giu, '$2')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/[\s\p{P}\p{S}]+/gu, '').length > 0
  );
}

function createChunkMetadata(document: SourceDocument, headingPath: string[]): ChunkMetadata {
  const metadata: ChunkMetadata = {
    title: document.title,
    module: document.module,
    sourceType: document.sourceType,
    file: document.file,
    headingPath,
  };

  if (document.attachments !== undefined && document.attachments.length > 0) {
    metadata.attachments = document.attachments.map((attachment) => ({ ...attachment }));
  }
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

function isFencedCodeBlock(text: string): boolean {
  return /^(?:`{3,}|~{3,})/u.test(text.trimStart());
}

function isClosingFence(line: string, openingFence: string): boolean {
  const closingFence = /^(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
  return (
    closingFence !== undefined &&
    closingFence[0] === openingFence[0] &&
    closingFence.length >= openingFence.length
  );
}
