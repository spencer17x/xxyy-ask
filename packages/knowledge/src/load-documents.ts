import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  knowledgeSourceCatalog,
  type ChatAttachment,
  type KnowledgeStatus,
  type SourceDocument,
  type SourceType,
} from '@xxyy/shared';

const PRODUCT_FUNCTIONS_FILE = 'xxyy-product-functions.md';
const X_UPDATES_FILE = 'xxyy-x-updates.md';
const X_POSTS_FILE = path.posix.join('sources', 'usexxyyio-x-posts.jsonl');
const MANIFEST_FILE = 'manifest.jsonl';
const ADMIN_VERIFIED_DIR = 'admin-verified';
const DOCS_ORIGIN = new URL(knowledgeSourceCatalog.official_docs.canonicalUrl).origin;
const X_ACCOUNT = 'useXXYYio';
const X_PROFILE_URL = knowledgeSourceCatalog.x_updates.canonicalUrl;
const OPTIONAL_MARKDOWN_DIRECTORIES: Array<{
  directory: string;
  fallbackModule: string;
  sourceType: SourceType;
}> = [
  {
    directory: path.posix.join('enriched', 'media'),
    fallbackModule: '产品文档图片文字',
    sourceType: 'official_docs',
  },
  {
    directory: path.posix.join('enriched', 'videos'),
    fallbackModule: '产品教程视频',
    sourceType: 'official_docs',
  },
  {
    directory: path.posix.join('enriched', 'reviewed'),
    fallbackModule: '官网人工校正',
    sourceType: 'official_docs',
  },
];

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
  ingest?: boolean;
  content_state?: 'content' | 'empty' | 'not_found';
}

interface XPostEntry {
  account?: string;
  createdAtIso?: string;
  fetchedAt?: string;
  id: string;
  media?: XPostMediaEntry[];
  text: string;
  url: string;
}

interface XPostMediaEntry {
  expandedUrl?: string;
  mediaUrl?: string;
  type?: string;
}

export async function loadProductDocuments(
  options: LoadProductDocumentsOptions = {},
): Promise<SourceDocument[]> {
  const productFeaturesDir = path.resolve(
    options.cwd ?? process.cwd(),
    options.productFeaturesDir ?? path.join('docs', 'product-features'),
  );
  const manifest = await readManifest(path.join(productFeaturesDir, MANIFEST_FILE));
  const pageDocuments = await readPageDocuments(productFeaturesDir, manifest);
  const documents: SourceDocument[] = [];

  if (pageDocuments.length === 0) {
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
  }
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

  for (const adminVerifiedFile of await listOptionalMarkdownFiles(
    path.join(productFeaturesDir, ADMIN_VERIFIED_DIR),
  )) {
    documents.push(
      await readDocument({
        productFeaturesDir,
        relativeFile: path.posix.join(ADMIN_VERIFIED_DIR, adminVerifiedFile),
        sourceType: 'admin_verified',
        fallbackTitle: titleFromFilename(adminVerifiedFile),
        fallbackModule: 'XXYY 客服群审核知识',
        manifest,
      }),
    );
  }

  for (const optionalDirectory of OPTIONAL_MARKDOWN_DIRECTORIES) {
    for (const markdownFile of await listOptionalMarkdownFiles(
      path.join(productFeaturesDir, optionalDirectory.directory),
    )) {
      documents.push(
        await readDocument({
          productFeaturesDir,
          relativeFile: path.posix.join(optionalDirectory.directory, markdownFile),
          sourceType: optionalDirectory.sourceType,
          fallbackTitle: titleFromFilename(markdownFile),
          fallbackModule: optionalDirectory.fallbackModule,
          manifest,
        }),
      );
    }
  }

  documents.push(...pageDocuments);

  return documents;
}

async function readPageDocuments(
  productFeaturesDir: string,
  manifest: Map<string, ManifestEntry>,
): Promise<SourceDocument[]> {
  const documents: SourceDocument[] = [];
  for (const pageFile of await listPageFiles(productFeaturesDir)) {
    const relativeFile = path.posix.join('pages', pageFile);
    const manifestEntry = findManifestEntry(manifest, relativeFile);
    if (manifestEntry?.ingest === false) {
      continue;
    }
    const document = await readDocument({
      productFeaturesDir,
      relativeFile,
      sourceType: 'official_docs',
      fallbackTitle: titleFromFilename(pageFile),
      fallbackModule: '产品文档',
      manifest,
    });
    if (isIndexablePageDocument(document)) {
      documents.push(document);
    }
  }
  return documents;
}

async function listOptionalMarkdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort(compareStrings);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
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
    (value.account === undefined || value.account === X_ACCOUNT) &&
    (value.createdAtIso === undefined || typeof value.createdAtIso === 'string') &&
    (value.fetchedAt === undefined || typeof value.fetchedAt === 'string') &&
    (value.media === undefined ||
      (Array.isArray(value.media) && value.media.every(isXPostMediaEntry))) &&
    isCanonicalXPostUrl(value.url, value.id)
  );
}

function isXPostMediaEntry(value: unknown): value is XPostMediaEntry {
  return (
    isObject(value) &&
    (value.expandedUrl === undefined || typeof value.expandedUrl === 'string') &&
    (value.mediaUrl === undefined || typeof value.mediaUrl === 'string') &&
    (value.type === undefined || typeof value.type === 'string')
  );
}

function createXPostDocument(post: XPostEntry, file: string): SourceDocument {
  const account = post.account ?? X_ACCOUNT;
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
    content: [`# X Post ${post.id}`, '', '## Text', '', post.text, ''].join('\n'),
    sourceUrl: post.url,
    status: inferXPostStatus(post.text),
  };
  const attachments = createXPostAttachments(post);
  if (attachments.length > 0) {
    document.attachments = attachments;
  }

  if (post.createdAtIso !== undefined) {
    document.effectiveAt = post.createdAtIso;
  }
  if (post.fetchedAt !== undefined) {
    document.retrievedAt = post.fetchedAt;
  }

  return document;
}

function inferXPostStatus(text: string): KnowledgeStatus {
  return /上线|新增|更新|升级|优化|支持|现已|全面支持|已支持|发布|入口|直达链接|可在.{0,20}(?:找到|进入)|launch|live|now supports|available|released/iu.test(
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
  const sourceType = resolveDocumentSourceType({
    configuredSourceType: args.sourceType,
    relativeFile: args.relativeFile,
    sourceUrl,
  });
  const effectiveAt = firstNonEmptyString(
    manifestEntry?.effective_at,
    metadata.effectiveAt,
    manifestEntry?.lastmod,
    metadata.lastmod,
    retrievedAt,
  );
  const status = manifestEntry?.status ?? metadata.status ?? defaultStatus(sourceType);
  const supersedes = manifestEntry?.supersedes ?? metadata.supersedes;
  const id = `${sourceType}:${withoutMarkdownExtension(args.relativeFile)}`;
  const document: SourceDocument = {
    id,
    title,
    module,
    sourceType,
    file,
    content,
    status,
  };
  const attachments = createMarkdownDocumentAttachments({
    content,
    relativeFile: args.relativeFile,
    sourceUrl,
    title,
  });
  if (attachments.length > 0) {
    document.attachments = attachments;
  }

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

function createMarkdownDocumentAttachments(input: {
  content: string;
  relativeFile: string;
  sourceUrl: string | undefined;
  title: string;
}): ChatAttachment[] {
  if (input.relativeFile.startsWith(`${path.posix.join('enriched', 'media')}/`)) {
    const assetFile = /(?:^|\n)\s*-\s*图片文件[：:]\s*(?<file>[A-Za-z0-9._-]+)/u.exec(input.content)
      ?.groups?.file;
    const mediaType = assetFile === undefined ? undefined : imageMediaType(assetFile);
    if (
      assetFile !== undefined &&
      mediaType !== undefined &&
      path.posix.basename(assetFile) === assetFile
    ) {
      return [
        {
          kind: 'image',
          mediaType,
          title: input.title,
          url: `/assets/${assetFile}`,
        },
      ];
    }
  }

  if (
    input.relativeFile.startsWith(`${path.posix.join('enriched', 'videos')}/`) &&
    input.sourceUrl !== undefined
  ) {
    if (isLocalMp4AssetUrl(input.sourceUrl)) {
      return [
        {
          kind: 'video',
          mediaType: 'video/mp4',
          title: input.title,
          url: input.sourceUrl,
        },
      ];
    }
    if (isSupportedExternalVideoUrl(input.sourceUrl)) {
      return [
        {
          kind: 'video',
          mediaType: 'text/html',
          title: input.title,
          url: input.sourceUrl,
        },
      ];
    }
  }

  return [];
}

function createXPostAttachments(post: XPostEntry): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];
  for (const [index, media] of (post.media ?? []).entries()) {
    const titlePrefix = `@${X_ACCOUNT} 更新 ${post.id}`;
    if (media.type === 'photo' && media.mediaUrl !== undefined) {
      const mediaType = imageMediaType(media.mediaUrl);
      if (mediaType !== undefined && isAllowedXMediaUrl(media.mediaUrl)) {
        attachments.push({
          kind: 'image',
          mediaType,
          title: `${titlePrefix} 图片 ${index + 1}`,
          url: media.mediaUrl,
        });
      }
      continue;
    }

    if (media.type === 'video') {
      const videoUrl = canonicalXVideoUrl(media.expandedUrl, post.id) ?? post.url;
      const posterUrl =
        media.mediaUrl !== undefined && isAllowedXMediaUrl(media.mediaUrl)
          ? media.mediaUrl
          : undefined;
      attachments.push({
        kind: 'video',
        mediaType: 'text/html',
        ...(posterUrl === undefined ? {} : { posterUrl }),
        title: `${titlePrefix} 视频 ${index + 1}`,
        url: videoUrl,
      });
    }
  }
  return attachments;
}

function imageMediaType(
  value: string,
): Extract<ChatAttachment, { kind: 'image' }>['mediaType'] | undefined {
  let pathname = value;
  let format: string | null = null;
  try {
    const url = new URL(value);
    pathname = url.pathname;
    format = url.searchParams.get('format');
  } catch {
    // Local asset filenames are expected here.
  }
  const extension = (format ?? path.posix.extname(pathname).slice(1)).toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'avif') return 'image/avif';
  return undefined;
}

function isAllowedXMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'pbs.twimg.com';
  } catch {
    return false;
  }
}

function canonicalXVideoUrl(value: string | undefined, postId: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    const pattern = new RegExp(`^/${X_ACCOUNT}/status/${postId}/video/\\d+/?$`, 'u');
    return url.origin === new URL(X_PROFILE_URL).origin && pattern.test(url.pathname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isLocalMp4AssetUrl(value: string): boolean {
  return /^\/assets\/[A-Za-z0-9._-]+\.mp4$/iu.test(value);
}

function isSupportedExternalVideoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      ((url.hostname === 'www.youtube.com' &&
        url.pathname === '/watch' &&
        url.searchParams.has('v')) ||
        url.hostname === 'youtu.be')
    );
  } catch {
    return false;
  }
}

function resolveDocumentSourceType(input: {
  configuredSourceType: SourceType;
  relativeFile: string;
  sourceUrl: string | undefined;
}): SourceType {
  if (input.configuredSourceType === 'admin_verified' || input.sourceUrl === undefined) {
    return input.configuredSourceType;
  }

  if (input.sourceUrl.startsWith('/assets/')) {
    return 'official_docs';
  }
  if (
    input.configuredSourceType === 'official_docs' &&
    input.relativeFile.startsWith(`${path.posix.join('enriched', 'videos')}/`) &&
    isSupportedExternalVideoUrl(input.sourceUrl)
  ) {
    return 'official_docs';
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(input.sourceUrl);
  } catch {
    throw new Error(`Invalid knowledge source URL for ${input.relativeFile}: ${input.sourceUrl}`);
  }

  if (sourceUrl.origin === DOCS_ORIGIN) {
    return 'official_docs';
  }
  if (isCanonicalXPostUrl(sourceUrl.toString())) {
    return 'x_updates';
  }

  throw new Error(`Unsupported knowledge source URL for ${input.relativeFile}: ${input.sourceUrl}`);
}

function isCanonicalXPostUrl(value: string, expectedId?: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.origin !== new URL(X_PROFILE_URL).origin) {
    return false;
  }

  const match = new RegExp(`^/${X_ACCOUNT}/status/(?<id>\\d+)/?$`, 'u').exec(url.pathname);
  const id = match?.groups?.id;
  return id !== undefined && (expectedId === undefined || id === expectedId);
}

function defaultStatus(sourceType: SourceType): KnowledgeStatus {
  return sourceType === 'x_updates' ? 'historical' : 'current';
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | undefined {
  return values.find(
    (value): value is string => value !== null && value !== undefined && value.trim().length > 0,
  );
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
    isOptionalStringArray(record.supersedes) &&
    isOptionalBoolean(record.ingest) &&
    isOptionalContentState(record.content_state)
  );
}

function isIndexablePageDocument(document: SourceDocument): boolean {
  if (
    document.title.normalize('NFKC').trim().toLowerCase() === 'page not found' ||
    (/^#\s+page not found\s*$/imu.test(document.content) &&
      /does not exist|moved, renamed, or deleted/iu.test(document.content))
  ) {
    return false;
  }

  const body = document.content
    .replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<figure[^>]*>[^]*?<\/figure>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^#{1,6}\s+.*$/gmu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return body.length > 0;
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

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalContentState(value: unknown): boolean {
  return value === undefined || value === 'content' || value === 'empty' || value === 'not_found';
}
