import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { SourceDocument, SourceType } from '@xxyy/shared';

const PRODUCT_FUNCTIONS_FILE = 'xxyy-product-functions.md';
const X_UPDATES_FILE = 'xxyy-x-updates.md';
const MANIFEST_FILE = 'manifest.jsonl';

export interface LoadProductDocumentsOptions {
  productFeaturesDir?: string;
  cwd?: string;
}

interface MarkdownMetadata {
  title?: string;
  section?: string;
  category?: string;
  sourceUrl?: string;
  retrievedAt?: string;
}

interface ManifestEntry {
  file?: string;
  order?: number;
  title?: string;
  source_url?: string;
  section?: string;
  category?: string;
  retrieved_at?: string;
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
  const { content, metadata } = parseMarkdownMetadata(rawContent);
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
  const id = `${args.sourceType}:${withoutMarkdownExtension(args.relativeFile)}`;
  const document: SourceDocument = {
    id,
    title,
    module,
    sourceType: args.sourceType,
    file,
    content,
  };

  if (typeof manifestEntry?.order === 'number') {
    document.order = manifestEntry.order;
  }
  if (sourceUrl !== undefined) {
    document.sourceUrl = sourceUrl;
  }
  if (retrievedAt !== undefined) {
    document.retrievedAt = retrievedAt;
  }

  return document;
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
    } else if (key === 'retrieved_at') {
      metadata.retrievedAt = value;
    }
  }

  return { content: rawContent.slice(contentStart), metadata };
}

function firstHeading(content: string): string | undefined {
  const headingMatch = /^#\s+(.+?)\s*$/m.exec(content);
  return headingMatch?.[1]?.trim();
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
    isOptionalString(record.retrieved_at)
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}
