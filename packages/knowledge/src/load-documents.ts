import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { KnowledgeStatus, SourceDocument, SourceType } from '@xxyy/shared';

const PRODUCT_FUNCTIONS_FILE = 'xxyy-product-functions.md';
const X_UPDATES_FILE = 'xxyy-x-updates.md';
const X_POSTS_FILE = path.posix.join('sources', 'usexxyyio-x-posts.jsonl');
const MANIFEST_FILE = 'manifest.jsonl';

export interface LoadProductDocumentsOptions {
  productFeaturesDir?: string;
  cwd?: string;
}

interface MarkdownMetadata {
  title?: string;
  section?: string;
  category?: string;
  effectiveAt?: string;
  lastmod?: string;
  sourceUrl?: string;
  retrievedAt?: string;
  status?: KnowledgeStatus;
  supersedes?: string[];
}

interface ManifestEntry {
  file?: string;
  order?: number;
  title?: string;
  source_url?: string;
  section?: string;
  category?: string;
  effective_at?: string;
  lastmod?: string | null;
  retrieved_at?: string;
  status?: KnowledgeStatus;
  supersedes?: string[];
}

interface XPostEntry {
  account?: string;
  createdAtIso?: string;
  fetchedAt?: string;
  id: string;
  text: string;
  url: string;
}

export async function loadProductDocuments(
  options: LoadProductDocumentsOptions = {},
): Promise<SourceDocument[]> {
  const productFeaturesDir = path.resolve(
    options.cwd ?? process.cwd(),
    options.productFeaturesDir ?? path.join('docs', 'product-features'),
  );
  const manifest = await readManifest(path.join(productFeaturesDir, MANIFEST_FILE));
  const documents: SourceDocument[] = [];

  documents.push(
    await readDocument({
      productFeaturesDir,
      relativeFile: PRODUCT_FUNCTIONS_FILE,
      sourceType: 'official_docs',
      fallbackTitle: 'XXYY 产品功能整理文档',
      fallbackModule: '产品功能',
      manifest,
    }),
  );
  documents.push(
    await readDocument({
      productFeaturesDir,
      relativeFile: X_UPDATES_FILE,
      sourceType: 'x_updates',
      fallbackTitle: 'XXYY X 历史推文产品更新汇总',
      fallbackModule: 'X Updates',
      manifest,
    }),
  );
  documents.push(...(await readXPostDocuments(productFeaturesDir)));

  for (const pageFile of await listPageFiles(productFeaturesDir)) {
    documents.push(
      await readDocument({
        productFeaturesDir,
        relativeFile: path.posix.join('pages', pageFile),
        sourceType: 'official_docs',
        fallbackTitle: titleFromFilename(pageFile),
        fallbackModule: '产品文档',
        manifest,
      }),
    );
  }

  return documents;
}

async function readXPostDocuments(productFeaturesDir: string): Promise<SourceDocument[]> {
  const relativeFile = X_POSTS_FILE;
  const file = path.join(productFeaturesDir, relativeFile);
  let rawContent: string;
  try {
    rawContent = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const documents: SourceDocument[] = [];
  rawContent.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    const parsed = JSON.parse(trimmed) as unknown;
    if (!isXPostEntry(parsed)) {
      throw new Error(`Invalid X post source entry on line ${index + 1}`);
    }

    documents.push(createXPostDocument(parsed, file));
  });

  return documents.sort((left, right) => left.id.localeCompare(right.id));
}

function isXPostEntry(value: unknown): value is XPostEntry {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.url === 'string' &&
    typeof value.text === 'string' &&
    (value.account === undefined || typeof value.account === 'string') &&
    (value.createdAtIso === undefined || typeof value.createdAtIso === 'string') &&
    (value.fetchedAt === undefined || typeof value.fetchedAt === 'string')
  );
}

function createXPostDocument(post: XPostEntry, file: string): SourceDocument {
  const account = post.account ?? 'useXXYYio';
  const createdMonth =
    typeof post.createdAtIso === 'string' && post.createdAtIso.length >= 7
      ? post.createdAtIso.slice(0, 7)
      : 'unknown';
  const document: SourceDocument = {
    id: `x_updates:${withoutKnownExtension(X_POSTS_FILE)}/${post.id}`,
    title: `X Post ${post.id}`,
    module: `X / @${account} / ${createdMonth}`,
    sourceType: 'x_updates',
    file,
    content: [
      `# X Post ${post.id}`,
      '',
      `- Account: @${account}`,
      `- Tweet ID: ${post.id}`,
      `- URL: ${post.url}`,
      ...(post.createdAtIso === undefined ? [] : [`- Published at: ${post.createdAtIso}`]),
      '',
      '## Text',
      '',
      post.text,
      '',
    ].join('\n'),
    sourceUrl: post.url,
    status: inferXPostStatus(post.text),
  };

  if (post.createdAtIso !== undefined) {
    document.effectiveAt = post.createdAtIso;
  }
  if (post.fetchedAt !== undefined) {
    document.retrievedAt = post.fetchedAt;
  }

  return document;
}

function inferXPostStatus(text: string): KnowledgeStatus {
  return /上线|新增|更新|升级|优化|支持|现已|全面支持|已支持|发布|launch|live|now supports|available|released/iu.test(
    text,
  )
    ? 'current'
    : 'historical';
}

async function listPageFiles(productFeaturesDir: string): Promise<string[]> {
  const pagesDir = path.join(productFeaturesDir, 'pages');
  const entries = await readdir(pagesDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort(compareStrings);
}

async function readDocument(args: {
  productFeaturesDir: string;
  relativeFile: string;
  sourceType: SourceType;
  fallbackTitle: string;
  fallbackModule: string;
  manifest: Map<string, ManifestEntry>;
}): Promise<SourceDocument> {
  const file = path.join(args.productFeaturesDir, args.relativeFile);
  const rawContent = await readFile(file, 'utf8');
  const parsed = parseMarkdownMetadata(rawContent);
  const content =
    args.relativeFile === X_UPDATES_FILE ? stripRawXPostIndex(parsed.content) : parsed.content;
  const { metadata } = parsed;
  const manifestEntry = findManifestEntry(args.manifest, args.relativeFile);
  const title =
    manifestEntry?.title ?? metadata.title ?? firstHeading(content) ?? args.fallbackTitle;
  const module =
    manifestEntry?.section ??
    metadata.section ??
    manifestEntry?.category ??
    metadata.category ??
    args.fallbackModule;
  const sourceUrl = manifestEntry?.source_url ?? metadata.sourceUrl;
  const retrievedAt = manifestEntry?.retrieved_at ?? metadata.retrievedAt;
  const effectiveAt =
    manifestEntry?.effective_at ??
    metadata.effectiveAt ??
    manifestEntry?.lastmod ??
    metadata.lastmod ??
    retrievedAt;
  const status = manifestEntry?.status ?? metadata.status ?? defaultStatus(args.sourceType);
  const supersedes = manifestEntry?.supersedes ?? metadata.supersedes;
  const id = `${args.sourceType}:${withoutMarkdownExtension(args.relativeFile)}`;
  const document: SourceDocument = {
    id,
    title,
    module,
    sourceType: args.sourceType,
    file,
    content,
    status,
  };

  if (typeof manifestEntry?.order === 'number') {
    document.order = manifestEntry.order;
  }
  if (sourceUrl !== undefined) {
    document.sourceUrl = sourceUrl;
  }
  if (effectiveAt !== undefined) {
    document.effectiveAt = effectiveAt;
  }
  if (retrievedAt !== undefined) {
    document.retrievedAt = retrievedAt;
  }
  if (supersedes !== undefined && supersedes.length > 0) {
    document.supersedes = supersedes;
  }

  return document;
}

function defaultStatus(sourceType: SourceType): KnowledgeStatus {
  return sourceType === 'official_docs' ? 'current' : 'historical';
}

async function readManifest(manifestPath: string): Promise<Map<string, ManifestEntry>> {
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return new Map();
    }
    throw error;
  }

  const entries = new Map<string, ManifestEntry>();
  const lines = manifestText.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    const parsed = JSON.parse(trimmed) as unknown;
    if (!isManifestEntry(parsed) || parsed.file === undefined) {
      throw new Error(`Invalid product document manifest entry on line ${index + 1}`);
    }

    const normalizedFile = normalizeRelativePath(parsed.file);
    entries.set(normalizedFile, parsed);
    entries.set(path.posix.join('pages', normalizedFile), parsed);
  });

  return entries;
}

function findManifestEntry(
  manifest: Map<string, ManifestEntry>,
  relativeFile: string,
): ManifestEntry | undefined {
  return manifest.get(normalizeRelativePath(relativeFile));
}

function parseMarkdownMetadata(rawContent: string): {
  content: string;
  metadata: MarkdownMetadata;
} {
  if (!rawContent.startsWith('---')) {
    return { content: rawContent, metadata: {} };
  }

  const endMatch = /\r?\n---\r?\n/.exec(rawContent.slice(3));
  if (endMatch === null) {
    return { content: rawContent, metadata: {} };
  }

  const frontmatterStart = 3;
  const frontmatterEnd = frontmatterStart + endMatch.index;
  const contentStart = frontmatterEnd + endMatch[0].length;
  const frontmatter = rawContent.slice(frontmatterStart, frontmatterEnd);
  const metadata: MarkdownMetadata = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z_]+):\s*(.+?)\s*$/.exec(line.trim());
    if (match === null) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) {
      continue;
    }

    const value = unquote(rawValue);
    if (key === 'title') {
      metadata.title = value;
    } else if (key === 'section') {
      metadata.section = value;
    } else if (key === 'category') {
      metadata.category = value;
    } else if (key === 'source_url') {
      metadata.sourceUrl = value;
    } else if (key === 'effective_at' || key === 'effectiveAt') {
      metadata.effectiveAt = value;
    } else if (key === 'lastmod') {
      metadata.lastmod = value;
    } else if (key === 'retrieved_at') {
      metadata.retrievedAt = value;
    } else if (key === 'status' && isKnowledgeStatus(value)) {
      metadata.status = value;
    } else if (key === 'supersedes') {
      metadata.supersedes = parseSupersedes(value);
    }
  }

  return { content: rawContent.slice(contentStart), metadata };
}

function firstHeading(content: string): string | undefined {
  const headingMatch = /^#\s+(.+?)\s*$/m.exec(content);
  return headingMatch?.[1]?.trim();
}

function stripRawXPostIndex(content: string): string {
  const match = /\n## 可溯源原始消息索引\s*\n/u.exec(content);
  if (match === null) {
    return content;
  }

  return `${content.slice(0, match.index).trimEnd()}\n`;
}

function titleFromFilename(filename: string): string {
  return withoutMarkdownExtension(filename)
    .replace(/^\d+-/, '')
    .replace(/__/g, ' / ')
    .replace(/-/g, ' ');
}

function withoutMarkdownExtension(file: string): string {
  return normalizeRelativePath(file).replace(/\.md$/u, '');
}

function withoutKnownExtension(file: string): string {
  return normalizeRelativePath(file).replace(/\.(?:jsonl|md)$/u, '');
}

function normalizeRelativePath(file: string): string {
  return file.replaceAll(path.sep, '/');
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    isOptionalString(record.file) &&
    isOptionalNumber(record.order) &&
    isOptionalString(record.title) &&
    isOptionalString(record.source_url) &&
    isOptionalString(record.section) &&
    isOptionalString(record.category) &&
    isOptionalString(record.effective_at) &&
    isOptionalNullableString(record.lastmod) &&
    isOptionalString(record.retrieved_at) &&
    isOptionalKnowledgeStatus(record.status) &&
    isOptionalStringArray(record.supersedes)
  );
}

function parseSupersedes(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter((item) => item.length > 0);
  }

  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isKnowledgeStatus(value: string): value is KnowledgeStatus {
  return value === 'current' || value === 'historical' || value === 'deprecated';
}

function isOptionalKnowledgeStatus(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && isKnowledgeStatus(value));
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}
