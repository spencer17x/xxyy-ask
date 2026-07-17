# XXYY Product Customer RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first-phase XXYY product customer service RAG system with document ingestion, retrieval, scoped answer generation, source citations, out-of-scope handling, CLI access, and a first API/Web entrypoint.

**Architecture:** Use a lightweight pnpm workspace monorepo. Keep the product-support capability in shared packages and make CLI/API/Web thin adapters. Use a local TypeScript RAG pipeline over the existing Markdown knowledge base. Keep the core deterministic and testable: document loading, chunking, BM25, local hash embeddings, classification, retrieval, and extractive fallback all work without API keys; OpenAI generation/embeddings are optional adapters behind interfaces.

**Tech Stack:** TypeScript, Node.js, pnpm workspaces, Vitest, optional OpenAI SDK, local JSON index files, lightweight HTTP API, Vite React Web UI.

## Monorepo Amendment

The original task list below used `src/rag/*` paths. Implement the same behavior through these workspace boundaries instead:

- `packages/shared`: shared domain types and channel-neutral request/response contracts.
- `packages/knowledge`: document loading, Markdown chunking, tokenization helpers, and local index persistence.
- `packages/rag-core`: config, classification, BM25/vector retrieval, grounded answering, evaluation, and `ChatService`.
- `apps/cli`: `ingest`, `ask`, and `evaluate` commands that call shared packages.
- `apps/api`: HTTP server with `POST /api/chat` and health endpoint.
- `apps/web`: minimal chat UI that calls the API and displays citations.

Generated runtime files should live under `.rag/` or `data/indexes/` and should not be committed unless explicitly promoted to fixtures.

---

## File Structure

- Create `src/rag/types.ts`: shared domain types for documents, chunks, index entries, classification, retrieval, and answers.
- Create `src/rag/config.ts`: environment/config parsing with safe defaults.
- Create `src/rag/paths.ts`: project-root-relative paths for docs and generated indexes.
- Create `src/rag/load-docs.ts`: read product docs, page docs, manifest, and X updates into normalized source documents.
- Create `src/rag/chunk.ts`: split Markdown into searchable chunks with metadata.
- Create `src/rag/tokenize.ts`: normalize Chinese/English/product terms for lexical search.
- Create `src/rag/bm25.ts`: deterministic lexical scoring.
- Create `src/rag/embeddings.ts`: local hash embedding provider and optional OpenAI embedding provider.
- Create `src/rag/index-store.ts`: build, save, and load the local JSON index.
- Create `src/rag/classify.ts`: classify questions into product, how-to, realtime, MEV, investment, or unknown.
- Create `src/rag/retrieve.ts`: combine BM25 and vector scores, then rerank with source preference.
- Create `src/rag/answer.ts`: generate grounded answers with citations and safe fallback text.
- Create `src/rag/evaluate.ts`: run golden-set checks against classification and citation behavior.
- Create `src/rag/cli.ts`: CLI command handlers for `ingest`, `ask`, and `evaluate`.
- Modify `src/index.ts`: dispatch CLI commands.
- Modify `package.json`: add dependencies and scripts.
- Create `eval/golden.jsonl`: small product-support evaluation set.
- Create tests beside modules under `src/rag/*.test.ts`.

Generated runtime files:

- Create `.rag/index.json` when `pnpm rag:ingest` runs.
- Do not commit `.rag/index.json`; add `.rag/` to `.gitignore`.

## Task 1: Tooling, Scripts, and Test Runner

**Files:**

- Modify: `package.json`
- Modify: `.gitignore`
- Create: `src/rag/smoke.test.ts`

- [ ] **Step 1: Add dependencies and scripts**

Run:

```bash
pnpm add dotenv openai
pnpm add -D vitest
```

Modify `package.json` scripts to include:

```json
{
  "scripts": {
    "check": "pnpm lint && pnpm format:check && pnpm typecheck && pnpm test",
    "dev": "tsx watch src/index.ts",
    "format": "prettier --write \"**/*.{ts,js,mjs,cjs,json,md,yml,yaml}\" \".vscode/*.json\"",
    "format:check": "prettier --check \"**/*.{ts,js,mjs,cjs,json,md,yml,yaml}\" \".vscode/*.json\"",
    "lint": "eslint . --max-warnings=0",
    "lint:fix": "eslint . --fix",
    "rag:ask": "tsx src/index.ts ask",
    "rag:evaluate": "tsx src/index.ts evaluate",
    "rag:ingest": "tsx src/index.ts ingest",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

Add `.rag/` to `.gitignore`.

- [ ] **Step 2: Write the smoke test**

Create `src/rag/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('test runner', () => {
  it('runs vitest', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm test
```

Expected: `1` test file passes.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore src/rag/smoke.test.ts
git commit -m "chore: add rag test tooling"
```

## Task 2: Shared Types and Config

**Files:**

- Create: `src/rag/types.ts`
- Create: `src/rag/config.ts`
- Create: `src/rag/config.test.ts`

- [ ] **Step 1: Write config tests**

Create `src/rag/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses local providers by default', () => {
    const config = loadConfig({});

    expect(config.embeddingProvider).toBe('local');
    expect(config.answerProvider).toBe('extractive');
    expect(config.topK).toBe(6);
  });

  it('accepts OpenAI providers from env', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'test-key',
      RAG_ANSWER_PROVIDER: 'openai',
      RAG_TOP_K: '4',
    });

    expect(config.embeddingProvider).toBe('openai');
    expect(config.answerProvider).toBe('openai');
    expect(config.topK).toBe(4);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/rag/config.test.ts
```

Expected: fail because `src/rag/config.ts` does not exist.

- [ ] **Step 3: Create shared types**

Create `src/rag/types.ts`:

```ts
export type SourceType = 'official_docs' | 'x_updates';

export type Intent =
  | 'product_qa'
  | 'how_to'
  | 'realtime_account_query'
  | 'mev_or_chain_forensics'
  | 'investment_advice'
  | 'unknown';

export interface SourceDocument {
  id: string;
  title: string;
  module: string;
  sourceType: SourceType;
  sourceUrl?: string;
  file: string;
  order?: number;
  retrievedAt?: string;
  content: string;
}

export interface ChunkMetadata {
  title: string;
  module: string;
  sourceType: SourceType;
  sourceUrl?: string;
  file: string;
  order?: number;
  headingPath: string[];
}

export interface RagChunk {
  id: string;
  documentId: string;
  text: string;
  metadata: ChunkMetadata;
}

export interface IndexEntry extends RagChunk {
  tokens: string[];
  embedding: number[];
}

export interface RagIndex {
  version: 1;
  builtAt: string;
  entries: IndexEntry[];
}

export interface Classification {
  intent: Intent;
  confidence: number;
  reason: string;
}

export interface RetrievalResult {
  chunk: IndexEntry;
  bm25Score: number;
  vectorScore: number;
  score: number;
}

export interface AnswerResult {
  intent: Intent;
  answer: string;
  sources: ChunkMetadata[];
}
```

- [ ] **Step 4: Create config loader**

Create `src/rag/config.ts`:

```ts
export interface RagConfig {
  embeddingProvider: 'local' | 'openai';
  answerProvider: 'extractive' | 'openai';
  openaiApiKey?: string;
  openaiEmbeddingModel: string;
  openaiAnswerModel: string;
  topK: number;
}

function parseProvider(
  value: string | undefined,
  allowed: readonly string[],
  fallback: string,
): string {
  if (!value) return fallback;
  return allowed.includes(value) ? value : fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RagConfig {
  const hasOpenAiKey = Boolean(env.OPENAI_API_KEY);
  const embeddingProvider = hasOpenAiKey ? 'openai' : 'local';
  const answerProvider = parseProvider(
    env.RAG_ANSWER_PROVIDER,
    ['extractive', 'openai'],
    hasOpenAiKey ? 'openai' : 'extractive',
  ) as RagConfig['answerProvider'];

  return {
    embeddingProvider,
    answerProvider,
    openaiApiKey: env.OPENAI_API_KEY,
    openaiEmbeddingModel: env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    openaiAnswerModel: env.OPENAI_MODEL ?? 'gpt-4o-mini',
    topK: parsePositiveInt(env.RAG_TOP_K, 6),
  };
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm test src/rag/config.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/rag/types.ts src/rag/config.ts src/rag/config.test.ts
git commit -m "feat: add rag config types"
```

## Task 3: Document Loading

**Files:**

- Create: `src/rag/paths.ts`
- Create: `src/rag/load-docs.ts`
- Create: `src/rag/load-docs.test.ts`

- [ ] **Step 1: Write document loading tests**

Create `src/rag/load-docs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadSourceDocuments } from './load-docs.js';
import { productFeaturesDir } from './paths.js';

describe('loadSourceDocuments', () => {
  it('loads official docs and x updates', async () => {
    const docs = await loadSourceDocuments(productFeaturesDir);
    const files = new Set(docs.map((doc) => doc.file));

    expect(files.has('xxyy-product-functions.md')).toBe(true);
    expect(files.has('xxyy-x-updates.md')).toBe(true);
    expect([...files].some((file) => file.startsWith('pages/'))).toBe(true);
  });

  it('marks x updates separately from official docs', async () => {
    const docs = await loadSourceDocuments(productFeaturesDir);
    const xUpdates = docs.find((doc) => doc.file === 'xxyy-x-updates.md');

    expect(xUpdates?.sourceType).toBe('x_updates');
    expect(xUpdates?.module).toBe('更新动态');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/rag/load-docs.test.ts
```

Expected: fail because loader modules do not exist.

- [ ] **Step 3: Create paths module**

Create `src/rag/paths.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);

export const projectRoot = path.resolve(path.dirname(currentFile), '../..');
export const productFeaturesDir = path.join(projectRoot, 'docs/product-features');
export const ragDir = path.join(projectRoot, '.rag');
export const ragIndexPath = path.join(ragDir, 'index.json');
export const goldenSetPath = path.join(projectRoot, 'eval/golden.jsonl');
```

- [ ] **Step 4: Create document loader**

Create `src/rag/load-docs.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SourceDocument, SourceType } from './types.js';

interface ManifestRow {
  order: number;
  title: string;
  source_url?: string;
  category?: string;
  section?: string;
  retrieved_at?: string;
  file: string;
}

async function readManifest(baseDir: string): Promise<Map<string, ManifestRow>> {
  const manifestPath = path.join(baseDir, 'manifest.jsonl');
  const text = await fs.readFile(manifestPath, 'utf8');
  const rows = new Map<string, ManifestRow>();

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = JSON.parse(trimmed) as ManifestRow;
    rows.set(row.file, row);
  }

  return rows;
}

function sourceTypeForFile(file: string): SourceType {
  return file === 'xxyy-x-updates.md' ? 'x_updates' : 'official_docs';
}

function moduleForFile(file: string, manifest?: ManifestRow): string {
  if (file === 'xxyy-x-updates.md') return '更新动态';
  if (file === 'xxyy-product-functions.md') return '产品功能汇总';
  return manifest?.section ?? manifest?.category ?? '产品功能';
}

async function loadPageDocs(
  baseDir: string,
  manifest: Map<string, ManifestRow>,
): Promise<SourceDocument[]> {
  const pagesDir = path.join(baseDir, 'pages');
  const files = (await fs.readdir(pagesDir)).filter((file) => file.endsWith('.md')).sort();

  return Promise.all(
    files.map(async (file) => {
      const content = await fs.readFile(path.join(pagesDir, file), 'utf8');
      const row = manifest.get(file);

      return {
        id: `pages/${file}`,
        title: row?.title ?? file,
        module: moduleForFile(file, row),
        sourceType: 'official_docs',
        sourceUrl: row?.source_url,
        file: `pages/${file}`,
        order: row?.order,
        retrievedAt: row?.retrieved_at,
        content,
      };
    }),
  );
}

export async function loadSourceDocuments(baseDir: string): Promise<SourceDocument[]> {
  const manifest = await readManifest(baseDir);
  const rootFiles = ['xxyy-product-functions.md', 'xxyy-x-updates.md'];
  const rootDocs = await Promise.all(
    rootFiles.map(async (file) => {
      const content = await fs.readFile(path.join(baseDir, file), 'utf8');

      return {
        id: file,
        title:
          file === 'xxyy-x-updates.md' ? 'XXYY X 历史推文产品更新汇总' : 'XXYY 产品功能整理文档',
        module: moduleForFile(file),
        sourceType: sourceTypeForFile(file),
        file,
        content,
      } satisfies SourceDocument;
    }),
  );

  return [...rootDocs, ...(await loadPageDocs(baseDir, manifest))];
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm test src/rag/load-docs.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/rag/paths.ts src/rag/load-docs.ts src/rag/load-docs.test.ts
git commit -m "feat: load rag source documents"
```

## Task 4: Markdown Chunking

**Files:**

- Create: `src/rag/chunk.ts`
- Create: `src/rag/chunk.test.ts`

- [ ] **Step 1: Write chunk tests**

Create `src/rag/chunk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunk.js';
import type { SourceDocument } from './types.js';

const doc: SourceDocument = {
  id: 'sample.md',
  title: 'Sample',
  module: '测试模块',
  sourceType: 'official_docs',
  file: 'sample.md',
  content: '# Sample\n\n## 钱包监控\n\n可以配置 Telegram 通知。\n\n## Pro\n\nPro 有独享节点。',
};

describe('chunkDocument', () => {
  it('keeps heading metadata', () => {
    const chunks = chunkDocument(doc, { maxChars: 80, overlapChars: 10 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.metadata.headingPath).toContain('钱包监控');
    expect(chunks[0]?.text).toContain('Telegram');
  });

  it('creates stable chunk ids', () => {
    const chunks = chunkDocument(doc, { maxChars: 80, overlapChars: 10 });

    expect(chunks[0]?.id).toBe('sample.md#chunk-0');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/rag/chunk.test.ts
```

Expected: fail because `chunk.ts` does not exist.

- [ ] **Step 3: Create chunker**

Create `src/rag/chunk.ts`:

```ts
import type { RagChunk, SourceDocument } from './types.js';

export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
}

interface Section {
  headingPath: string[];
  text: string;
}

function splitIntoSections(content: string): Section[] {
  const sections: Section[] = [];
  const headingPath: string[] = [];
  let current: string[] = [];

  for (const line of content.split('\n')) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (current.join('\n').trim()) {
        sections.push({ headingPath: [...headingPath], text: current.join('\n').trim() });
      }
      const level = heading[1]!.length;
      headingPath.splice(level - 1);
      headingPath[level - 1] = heading[2]!.trim();
      current = [line];
      continue;
    }
    current.push(line);
  }

  if (current.join('\n').trim()) {
    sections.push({ headingPath: [...headingPath], text: current.join('\n').trim() });
  }

  return sections;
}

function splitLongText(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    parts.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }

  return parts.filter(Boolean);
}

export function chunkDocument(document: SourceDocument, options: ChunkOptions): RagChunk[] {
  const chunks: RagChunk[] = [];

  for (const section of splitIntoSections(document.content)) {
    for (const part of splitLongText(section.text, options.maxChars, options.overlapChars)) {
      chunks.push({
        id: `${document.id}#chunk-${chunks.length}`,
        documentId: document.id,
        text: part,
        metadata: {
          title: document.title,
          module: document.module,
          sourceType: document.sourceType,
          sourceUrl: document.sourceUrl,
          file: document.file,
          order: document.order,
          headingPath: section.headingPath,
        },
      });
    }
  }

  return chunks;
}

export function chunkDocuments(documents: SourceDocument[]): RagChunk[] {
  return documents.flatMap((document) =>
    chunkDocument(document, { maxChars: 1200, overlapChars: 120 }),
  );
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test src/rag/chunk.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/rag/chunk.ts src/rag/chunk.test.ts
git commit -m "feat: chunk rag documents"
```

## Task 5: Tokenization and BM25

**Files:**

- Create: `src/rag/tokenize.ts`
- Create: `src/rag/bm25.ts`
- Create: `src/rag/bm25.test.ts`

- [ ] **Step 1: Write BM25 tests**

Create `src/rag/bm25.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scoreBm25 } from './bm25.js';
import { tokenize } from './tokenize.js';

describe('tokenize', () => {
  it('keeps product terms and Chinese bigrams', () => {
    const tokens = tokenize('钱包监控 Telegram 通知 Pro');

    expect(tokens).toContain('钱包');
    expect(tokens).toContain('监控');
    expect(tokens).toContain('telegram');
    expect(tokens).toContain('pro');
  });
});

describe('scoreBm25', () => {
  it('scores relevant documents higher', () => {
    const docs = [tokenize('钱包监控支持 Telegram 通知'), tokenize('扫链页面支持筛选新币')];

    const scores = scoreBm25(tokenize('钱包监控怎么设置通知'), docs);

    expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/rag/bm25.test.ts
```

Expected: fail because modules do not exist.

- [ ] **Step 3: Create tokenizer**

Create `src/rag/tokenize.ts`:

```ts
const productTerms = [
  'xxyy',
  'pro',
  'pump',
  'pumpswap',
  'fourmeme',
  'telegram',
  'base',
  'bsc',
  'eth',
  'solana',
  'dashboard',
  'tagholder',
  'kol',
  'mev',
];

export function tokenize(input: string): string[] {
  const normalized = input.toLowerCase().replace(/[`*_()[\]{}.,!?;:，。！？；：、]/g, ' ');
  const asciiTokens = normalized.match(/[a-z0-9]+/g) ?? [];
  const chineseChars = normalized.match(/\p{Script=Han}/gu) ?? [];
  const chineseBigrams: string[] = [];

  for (let index = 0; index < chineseChars.length; index += 1) {
    const current = chineseChars[index];
    if (current) chineseBigrams.push(current);
    const next = chineseChars[index + 1];
    if (current && next) chineseBigrams.push(`${current}${next}`);
  }

  const boostedTerms = productTerms.filter((term) => normalized.includes(term));

  return [...new Set([...asciiTokens, ...chineseBigrams, ...boostedTerms])];
}
```

- [ ] **Step 4: Create BM25 scorer**

Create `src/rag/bm25.ts`:

```ts
function termFrequency(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function scoreBm25(queryTokens: string[], documents: string[][]): number[] {
  const k1 = 1.2;
  const b = 0.75;
  const averageLength =
    documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(documents.length, 1);
  const docFrequencies = new Map<string, number>();

  for (const document of documents) {
    for (const token of new Set(document)) {
      docFrequencies.set(token, (docFrequencies.get(token) ?? 0) + 1);
    }
  }

  return documents.map((document) => {
    const frequencies = termFrequency(document);
    let score = 0;

    for (const token of queryTokens) {
      const frequency = frequencies.get(token) ?? 0;
      if (frequency === 0) continue;
      const docFrequency = docFrequencies.get(token) ?? 0;
      const idf = Math.log(1 + (documents.length - docFrequency + 0.5) / (docFrequency + 0.5));
      const denominator =
        frequency + k1 * (1 - b + b * (document.length / Math.max(averageLength, 1)));
      score += idf * ((frequency * (k1 + 1)) / denominator);
    }

    return score;
  });
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm test src/rag/bm25.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/rag/tokenize.ts src/rag/bm25.ts src/rag/bm25.test.ts
git commit -m "feat: add rag lexical scoring"
```

## Task 6: Embeddings and Index Store

**Files:**

- Create: `src/rag/embeddings.ts`
- Create: `src/rag/index-store.ts`
- Create: `src/rag/index-store.test.ts`

- [ ] **Step 1: Write index tests**

Create `src/rag/index-store.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localEmbedding, cosineSimilarity } from './embeddings.js';
import { loadIndex, saveIndex } from './index-store.js';
import type { RagIndex } from './types.js';

describe('localEmbedding', () => {
  it('creates fixed-size vectors', async () => {
    const embedding = await localEmbedding('钱包监控');

    expect(embedding).toHaveLength(128);
    expect(cosineSimilarity(embedding, embedding)).toBeGreaterThan(0.99);
  });
});

describe('index-store', () => {
  it('saves and loads index json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xxyy-rag-'));
    const file = path.join(dir, 'index.json');
    const index: RagIndex = { version: 1, builtAt: '2026-06-03T00:00:00.000Z', entries: [] };

    await saveIndex(file, index);
    await expect(loadIndex(file)).resolves.toEqual(index);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/rag/index-store.test.ts
```

Expected: fail because modules do not exist.

- [ ] **Step 3: Create embeddings module**

Create `src/rag/embeddings.ts`:

```ts
import crypto from 'node:crypto';
import OpenAI from 'openai';
import type { RagConfig } from './config.js';

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export async function localEmbedding(text: string, dimensions = 128): Promise<number[]> {
  const vector = Array.from({ length: dimensions }, () => 0);
  const words = text.toLowerCase().match(/[\p{Script=Han}a-z0-9]+/gu) ?? [];

  for (const word of words) {
    const digest = crypto.createHash('sha256').update(word).digest();
    const slot = digest[0]! % dimensions;
    const sign = digest[1]! % 2 === 0 ? 1 : -1;
    vector[slot] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  return dot / ((Math.sqrt(leftMagnitude) || 1) * (Math.sqrt(rightMagnitude) || 1));
}

export function createEmbeddingProvider(config: RagConfig): EmbeddingProvider {
  if (config.embeddingProvider === 'openai' && config.openaiApiKey) {
    const client = new OpenAI({ apiKey: config.openaiApiKey });
    return {
      async embed(text: string): Promise<number[]> {
        const response = await client.embeddings.create({
          model: config.openaiEmbeddingModel,
          input: text,
        });
        return response.data[0]?.embedding ?? [];
      },
    };
  }

  return {
    embed(text: string): Promise<number[]> {
      return localEmbedding(text);
    },
  };
}
```

- [ ] **Step 4: Create index store**

Create `src/rag/index-store.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RagIndex } from './types.js';

export async function saveIndex(filePath: string, index: RagIndex): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

export async function loadIndex(filePath: string): Promise<RagIndex> {
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text) as RagIndex;
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm test src/rag/index-store.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/rag/embeddings.ts src/rag/index-store.ts src/rag/index-store.test.ts
git commit -m "feat: add rag index store"
```

## Task 7: Ingestion CLI

**Files:**

- Create: `src/rag/cli.ts`
- Modify: `src/index.ts`
- Create: `src/rag/ingest.ts`
- Create: `src/rag/ingest.test.ts`

- [ ] **Step 1: Write ingestion test**

Create `src/rag/ingest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildIndex } from './ingest.js';
import { loadConfig } from './config.js';
import { productFeaturesDir } from './paths.js';

describe('buildIndex', () => {
  it('builds index entries from product docs', async () => {
    const index = await buildIndex(productFeaturesDir, loadConfig({}));

    expect(index.version).toBe(1);
    expect(index.entries.length).toBeGreaterThan(20);
    expect(index.entries.some((entry) => entry.metadata.sourceType === 'x_updates')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/rag/ingest.test.ts
```

Expected: fail because `ingest.ts` does not exist.

- [ ] **Step 3: Create ingestion module**

Create `src/rag/ingest.ts`:

```ts
import type { RagConfig } from './config.js';
import { chunkDocuments } from './chunk.js';
import { createEmbeddingProvider } from './embeddings.js';
import { loadSourceDocuments } from './load-docs.js';
import { tokenize } from './tokenize.js';
import type { RagIndex } from './types.js';

export async function buildIndex(baseDir: string, config: RagConfig): Promise<RagIndex> {
  const documents = await loadSourceDocuments(baseDir);
  const chunks = chunkDocuments(documents);
  const provider = createEmbeddingProvider(config);
  const entries = [];

  for (const chunk of chunks) {
    entries.push({
      ...chunk,
      tokens: tokenize(`${chunk.metadata.title} ${chunk.metadata.module} ${chunk.text}`),
      embedding: await provider.embed(chunk.text),
    });
  }

  return {
    version: 1,
    builtAt: new Date().toISOString(),
    entries,
  };
}
```

- [ ] **Step 4: Create CLI module**

Create `src/rag/cli.ts`:

```ts
import 'dotenv/config';
import { loadConfig } from './config.js';
import { buildIndex } from './ingest.js';
import { saveIndex } from './index-store.js';
import { productFeaturesDir, ragIndexPath } from './paths.js';

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[2];

  if (command === 'ingest') {
    const index = await buildIndex(productFeaturesDir, loadConfig());
    await saveIndex(ragIndexPath, index);
    console.log(`Built ${index.entries.length} chunks at ${ragIndexPath}`);
    return;
  }

  console.log('Usage: pnpm rag:ingest | pnpm rag:ask -- "问题" | pnpm rag:evaluate');
}
```

Modify `src/index.ts`:

```ts
import { runCli } from './rag/cli.js';

await runCli(process.argv);
```

- [ ] **Step 5: Run tests and ingest**

Run:

```bash
pnpm test src/rag/ingest.test.ts
pnpm rag:ingest
```

Expected: test passes and CLI prints `Built <number> chunks at .../.rag/index.json`.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/rag/cli.ts src/rag/ingest.ts src/rag/ingest.test.ts .rag/index.json
git reset .rag/index.json
git commit -m "feat: add rag ingestion cli"
```

## Task 8: Intent Classification

**Files:**

- Create: `src/rag/classify.ts`
- Create: `src/rag/classify.test.ts`

- [ ] **Step 1: Write classification tests**

Create `src/rag/classify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyQuestion } from './classify.js';

describe('classifyQuestion', () => {
  it('classifies product how-to questions', () => {
    expect(classifyQuestion('钱包监控怎么设置 Telegram 通知？').intent).toBe('how_to');
  });

  it('classifies MEV checks as out of scope for phase one', () => {
    expect(classifyQuestion('帮我看看这笔交易是不是被夹了 0x123').intent).toBe(
      'mev_or_chain_forensics',
    );
  });

  it('classifies investment advice', () => {
    expect(classifyQuestion('今天应该买哪个币？').intent).toBe('investment_advice');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/rag/classify.test.ts
```

Expected: fail because `classify.ts` does not exist.

- [ ] **Step 3: Create classifier**

Create `src/rag/classify.ts`:

```ts
import type { Classification } from './types.js';

const mevPattern = /(mev|夹子|被夹|夹了|sandwich|滑点损失|交易\s*hash|tx\s*hash|0x[a-f0-9]{16,})/i;
const realtimePattern =
  /(订单|余额|返佣|返现|cashback|我的|账户|个人|提现|交易记录|钱包地址).*(查|查询|看|多少|状态)/i;
const investmentPattern = /(买哪个|推荐.*币|能不能买|会不会涨|收益|喊单|发财|几倍|百倍|金狗)/i;
const howToPattern = /(怎么|如何|怎样|教程|设置|配置|开通|开启|关闭|导出|导入|使用|操作)/i;

export function classifyQuestion(question: string): Classification {
  if (mevPattern.test(question)) {
    return {
      intent: 'mev_or_chain_forensics',
      confidence: 0.95,
      reason: 'question asks for chain forensics or MEV detection',
    };
  }
  if (investmentPattern.test(question)) {
    return {
      intent: 'investment_advice',
      confidence: 0.9,
      reason: 'question asks for investment advice',
    };
  }
  if (realtimePattern.test(question)) {
    return {
      intent: 'realtime_account_query',
      confidence: 0.85,
      reason: 'question asks for private realtime account data',
    };
  }
  if (howToPattern.test(question)) {
    return {
      intent: 'how_to',
      confidence: 0.8,
      reason: 'question asks how to use a product feature',
    };
  }
  if (question.trim().length < 3) {
    return { intent: 'unknown', confidence: 0.6, reason: 'question is too short' };
  }
  return { intent: 'product_qa', confidence: 0.7, reason: 'default product knowledge question' };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test src/rag/classify.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/rag/classify.ts src/rag/classify.test.ts
git commit -m "feat: classify rag questions"
```

## Task 9: Retrieval Pipeline

**Files:**

- Create: `src/rag/retrieve.ts`
- Create: `src/rag/retrieve.test.ts`

- [ ] **Step 1: Write retrieval tests**

Create `src/rag/retrieve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { retrieve } from './retrieve.js';
import type { RagIndex } from './types.js';

const index: RagIndex = {
  version: 1,
  builtAt: '2026-06-03T00:00:00.000Z',
  entries: [
    {
      id: 'wallet#chunk-0',
      documentId: 'wallet',
      text: '钱包监控支持 Telegram 通知，可以配置 Bot 推送。',
      metadata: {
        title: '钱包监控',
        module: '钱包监控',
        sourceType: 'official_docs',
        file: 'wallet.md',
        headingPath: ['钱包监控'],
      },
      tokens: ['钱包', '监控', 'telegram', '通知'],
      embedding: [1, 0],
    },
    {
      id: 'pro#chunk-0',
      documentId: 'pro',
      text: 'Pro 提供独享节点和更高监控额度。',
      metadata: {
        title: 'Pro',
        module: 'Pro',
        sourceType: 'official_docs',
        file: 'pro.md',
        headingPath: ['Pro'],
      },
      tokens: ['pro', '节点'],
      embedding: [0, 1],
    },
  ],
};

describe('retrieve', () => {
  it('returns relevant chunks first', async () => {
    const results = await retrieve('钱包监控通知', index, { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe('wallet#chunk-0');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/rag/retrieve.test.ts
```

Expected: fail because `retrieve.ts` does not exist.

- [ ] **Step 3: Create retriever**

Create `src/rag/retrieve.ts`:

```ts
import { scoreBm25 } from './bm25.js';
import { cosineSimilarity, localEmbedding } from './embeddings.js';
import { tokenize } from './tokenize.js';
import type { RagIndex, RetrievalResult } from './types.js';

export interface RetrieveOptions {
  topK: number;
}

function sourceWeight(sourceType: string): number {
  return sourceType === 'official_docs' ? 0.08 : 0;
}

export async function retrieve(
  question: string,
  index: RagIndex,
  options: RetrieveOptions,
): Promise<RetrievalResult[]> {
  const queryTokens = tokenize(question);
  const bm25Scores = scoreBm25(
    queryTokens,
    index.entries.map((entry) => entry.tokens),
  );
  const queryEmbedding = await localEmbedding(question, index.entries[0]?.embedding.length ?? 128);

  return index.entries
    .map((entry, position) => {
      const bm25Score = bm25Scores[position] ?? 0;
      const vectorScore = cosineSimilarity(queryEmbedding, entry.embedding);
      return {
        chunk: entry,
        bm25Score,
        vectorScore,
        score: bm25Score * 0.7 + vectorScore * 0.3 + sourceWeight(entry.metadata.sourceType),
      };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, options.topK);
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm test src/rag/retrieve.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/rag/retrieve.ts src/rag/retrieve.test.ts
git commit -m "feat: retrieve rag chunks"
```

## Task 10: Grounded Answering

**Files:**

- Create: `src/rag/answer.ts`
- Create: `src/rag/answer.test.ts`
- Modify: `src/rag/cli.ts`

- [ ] **Step 1: Write answer tests**

Create `src/rag/answer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { answerQuestion } from './answer.js';
import type { Classification, RetrievalResult } from './types.js';

const productClassification: Classification = { intent: 'how_to', confidence: 0.8, reason: 'test' };
const mevClassification: Classification = {
  intent: 'mev_or_chain_forensics',
  confidence: 0.9,
  reason: 'test',
};

const results: RetrievalResult[] = [
  {
    chunk: {
      id: 'wallet#chunk-0',
      documentId: 'wallet',
      text: '钱包监控支持 Telegram Bot 推送，可以在监控管理中配置通知。',
      metadata: {
        title: '钱包监控',
        module: '钱包监控',
        sourceType: 'official_docs',
        file: 'wallet.md',
        headingPath: ['钱包监控'],
      },
      tokens: [],
      embedding: [],
    },
    bm25Score: 1,
    vectorScore: 1,
    score: 1,
  },
];

describe('answerQuestion', () => {
  it('answers product questions with sources', async () => {
    const answer = await answerQuestion('钱包监控怎么设置通知？', productClassification, results, {
      provider: 'extractive',
    });

    expect(answer.answer).toContain('钱包监控');
    expect(answer.sources).toHaveLength(1);
  });

  it('returns boundary text for MEV questions', async () => {
    const answer = await answerQuestion('帮我看交易是否被夹', mevClassification, [], {
      provider: 'extractive',
    });

    expect(answer.answer).toContain('暂不支持');
    expect(answer.sources).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/rag/answer.test.ts
```

Expected: fail because `answer.ts` does not exist.

- [ ] **Step 3: Create answer module**

Create `src/rag/answer.ts`:

```ts
import OpenAI from 'openai';
import type { Classification, AnswerResult, RetrievalResult } from './types.js';

export interface AnswerOptions {
  provider: 'extractive' | 'openai';
  openaiApiKey?: string;
  openaiAnswerModel?: string;
}

function boundaryAnswer(classification: Classification): string | undefined {
  if (classification.intent === 'mev_or_chain_forensics') {
    return '当前产品客服机器人暂不支持查询个人交易记录，也不能直接判断交易是否被 MEV 或夹子攻击。判断这类问题需要读取交易 hash、区块或 slot、前后交易和池子价格变化。你可以把交易 hash 提供给人工客服，或等待后续链上检测工具上线。';
  }
  if (classification.intent === 'realtime_account_query') {
    return '当前产品客服机器人不能读取你的账户、订单、返佣、余额或钱包数据。你可以在 XXYY 页面查看对应模块，或联系人工客服处理。';
  }
  if (classification.intent === 'investment_advice') {
    return '我不能提供买卖建议、项目推荐或收益承诺。不过可以介绍 XXYY 中用于观察项目的功能，例如趋势、扫链、钱包监控、Holder 分析和 KOL 买入列表。';
  }
  if (classification.intent === 'unknown') {
    return '我还不确定你想了解哪个 XXYY 功能。你可以补充功能名称，例如钱包监控、扫链、挂单、Pro 权益或 Telegram 通知。';
  }
  return undefined;
}

function sourceList(results: RetrievalResult[]) {
  const seen = new Set<string>();
  return results
    .map((result) => result.chunk.metadata)
    .filter((metadata) => {
      const key = `${metadata.file}:${metadata.headingPath.join('/')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function extractiveAnswer(results: RetrievalResult[]): string {
  if (results.length === 0) {
    return '当前知识库没有明确说明。你可以换一种问法，或联系人工客服确认。';
  }

  const bullets = results
    .slice(0, 3)
    .map((result) => `- ${result.chunk.text.replace(/\s+/g, ' ').slice(0, 260)}`);
  return `根据当前知识库，相关信息如下：\n\n${bullets.join('\n')}`;
}

async function openAiAnswer(
  question: string,
  results: RetrievalResult[],
  options: AnswerOptions,
): Promise<string> {
  if (!options.openaiApiKey) return extractiveAnswer(results);
  const client = new OpenAI({ apiKey: options.openaiApiKey });
  const context = results
    .map((result, index) => `[${index + 1}] ${result.chunk.text}`)
    .join('\n\n');
  const response = await client.responses.create({
    model: options.openaiAnswerModel ?? 'gpt-4o-mini',
    input: [
      {
        role: 'system',
        content:
          '你是 XXYY 产品客服。只基于给定资料回答。没有依据就说当前知识库没有明确说明。不要提供投资建议。',
      },
      {
        role: 'user',
        content: `问题：${question}\n\n资料：\n${context}`,
      },
    ],
  });
  return response.output_text.trim() || extractiveAnswer(results);
}

export async function answerQuestion(
  question: string,
  classification: Classification,
  results: RetrievalResult[],
  options: AnswerOptions,
): Promise<AnswerResult> {
  const boundary = boundaryAnswer(classification);
  if (boundary) return { intent: classification.intent, answer: boundary, sources: [] };

  const answer =
    options.provider === 'openai'
      ? await openAiAnswer(question, results, options)
      : extractiveAnswer(results);
  return { intent: classification.intent, answer, sources: sourceList(results) };
}
```

- [ ] **Step 4: Wire ask command**

Modify `src/rag/cli.ts` to include `ask` handling:

```ts
import 'dotenv/config';
import { answerQuestion } from './answer.js';
import { classifyQuestion } from './classify.js';
import { loadConfig } from './config.js';
import { buildIndex } from './ingest.js';
import { loadIndex, saveIndex } from './index-store.js';
import { productFeaturesDir, ragIndexPath } from './paths.js';
import { retrieve } from './retrieve.js';

function questionFromArgv(argv: string[]): string {
  const direct = argv.slice(3).join(' ').trim();
  if (!direct) throw new Error('Missing question. Usage: pnpm rag:ask -- "钱包监控怎么设置通知？"');
  return direct;
}

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[2];
  const config = loadConfig();

  if (command === 'ingest') {
    const index = await buildIndex(productFeaturesDir, config);
    await saveIndex(ragIndexPath, index);
    console.log(`Built ${index.entries.length} chunks at ${ragIndexPath}`);
    return;
  }

  if (command === 'ask') {
    const question = questionFromArgv(argv);
    const classification = classifyQuestion(question);
    const index = await loadIndex(ragIndexPath);
    const results = ['product_qa', 'how_to'].includes(classification.intent)
      ? await retrieve(question, index, { topK: config.topK })
      : [];
    const answer = await answerQuestion(question, classification, results, {
      provider: config.answerProvider,
      openaiApiKey: config.openaiApiKey,
      openaiAnswerModel: config.openaiAnswerModel,
    });

    console.log(answer.answer);
    if (answer.sources.length > 0) {
      console.log('\n来源：');
      for (const source of answer.sources) {
        console.log(`- ${source.title} (${source.file})`);
      }
    }
    return;
  }

  console.log('Usage: pnpm rag:ingest | pnpm rag:ask -- "问题" | pnpm rag:evaluate');
}
```

- [ ] **Step 5: Run tests and ask command**

Run:

```bash
pnpm test src/rag/answer.test.ts
pnpm rag:ingest
pnpm rag:ask -- "钱包监控怎么设置 Telegram 通知？"
pnpm rag:ask -- "帮我看这笔交易是不是被夹了 0x123"
```

Expected:

- First ask prints product knowledge and sources.
- Second ask prints boundary text and no sources.

- [ ] **Step 6: Commit**

```bash
git add src/rag/answer.ts src/rag/answer.test.ts src/rag/cli.ts
git commit -m "feat: answer rag questions"
```

## Task 11: Evaluation CLI and Golden Set

**Files:**

- Create: `eval/golden.jsonl`
- Create: `src/rag/evaluate.ts`
- Create: `src/rag/evaluate.test.ts`
- Modify: `src/rag/cli.ts`

- [ ] **Step 1: Create golden set**

Create `eval/golden.jsonl`:

```jsonl
{"question":"钱包监控如何设置 Telegram 通知？","expectedIntent":"how_to","mustCite":true}
{"question":"Pro 和永久 Pro 有什么区别？","expectedIntent":"product_qa","mustCite":true}
{"question":"扫链页面可以筛选哪些条件？","expectedIntent":"product_qa","mustCite":true}
{"question":"帮我看这笔交易是不是被夹了 0xabc123","expectedIntent":"mev_or_chain_forensics","mustCite":false}
{"question":"今天应该买哪个币？","expectedIntent":"investment_advice","mustCite":false}
```

- [ ] **Step 2: Write evaluation tests**

Create `src/rag/evaluate.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGoldenSet } from './evaluate.js';

describe('loadGoldenSet', () => {
  it('loads jsonl cases', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'xxyy-eval-')), 'golden.jsonl');
    await fs.writeFile(
      file,
      '{"question":"q","expectedIntent":"product_qa","mustCite":true}\n',
      'utf8',
    );

    const cases = await loadGoldenSet(file);

    expect(cases).toEqual([{ question: 'q', expectedIntent: 'product_qa', mustCite: true }]);
  });
});
```

- [ ] **Step 3: Run the failing test**

Run:

```bash
pnpm test src/rag/evaluate.test.ts
```

Expected: fail because `evaluate.ts` does not exist.

- [ ] **Step 4: Create evaluator**

Create `src/rag/evaluate.ts`:

```ts
import fs from 'node:fs/promises';
import { answerQuestion } from './answer.js';
import { classifyQuestion } from './classify.js';
import type { RagConfig } from './config.js';
import { loadIndex } from './index-store.js';
import { retrieve } from './retrieve.js';
import type { Intent, RagIndex } from './types.js';

export interface GoldenCase {
  question: string;
  expectedIntent: Intent;
  mustCite: boolean;
}

export interface EvaluationResult {
  total: number;
  passed: number;
  failures: string[];
}

export async function loadGoldenSet(filePath: string): Promise<GoldenCase[]> {
  const text = await fs.readFile(filePath, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GoldenCase);
}

export async function evaluateCases(
  cases: GoldenCase[],
  index: RagIndex,
  config: RagConfig,
): Promise<EvaluationResult> {
  const failures: string[] = [];

  for (const testCase of cases) {
    const classification = classifyQuestion(testCase.question);
    const results = ['product_qa', 'how_to'].includes(classification.intent)
      ? await retrieve(testCase.question, index, { topK: config.topK })
      : [];
    const answer = await answerQuestion(testCase.question, classification, results, {
      provider: 'extractive',
    });

    if (classification.intent !== testCase.expectedIntent) {
      failures.push(
        `${testCase.question}: expected ${testCase.expectedIntent}, got ${classification.intent}`,
      );
    }
    if (testCase.mustCite && answer.sources.length === 0) {
      failures.push(`${testCase.question}: expected at least one citation`);
    }
    if (!testCase.mustCite && answer.sources.length > 0) {
      failures.push(`${testCase.question}: expected no citations`);
    }
  }

  return {
    total: cases.length,
    passed: cases.length - failures.length,
    failures,
  };
}

export async function evaluateIndex(
  indexPath: string,
  goldenPath: string,
  config: RagConfig,
): Promise<EvaluationResult> {
  const [index, cases] = await Promise.all([loadIndex(indexPath), loadGoldenSet(goldenPath)]);
  return evaluateCases(cases, index, config);
}
```

- [ ] **Step 5: Wire evaluate command**

Modify `src/rag/cli.ts` to import evaluator and handle `evaluate`:

```ts
import { evaluateIndex } from './evaluate.js';
import { goldenSetPath, productFeaturesDir, ragIndexPath } from './paths.js';
```

Add this command branch before usage output:

```ts
if (command === 'evaluate') {
  const result = await evaluateIndex(ragIndexPath, goldenSetPath, config);
  for (const failure of result.failures) console.log(`FAIL ${failure}`);
  console.log(`Evaluation: ${result.passed}/${result.total} passed`);
  if (result.failures.length > 0) process.exitCode = 1;
  return;
}
```

- [ ] **Step 6: Run evaluation**

Run:

```bash
pnpm test src/rag/evaluate.test.ts
pnpm rag:ingest
pnpm rag:evaluate
```

Expected: evaluation prints `Evaluation: 5/5 passed`.

- [ ] **Step 7: Commit**

```bash
git add eval/golden.jsonl src/rag/evaluate.ts src/rag/evaluate.test.ts src/rag/cli.ts
git commit -m "feat: add rag evaluation"
```

## Task 12: Final Documentation and Verification

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/product-features/README.md`

- [ ] **Step 1: Document CLI usage**

Add a section to `docs/README.md`:

````markdown
## 产品客服 RAG CLI

第一期产品客服机器人使用本仓库中的 XXYY 产品文档作为知识库。

```bash
pnpm install --frozen-lockfile
pnpm rag:ingest
pnpm rag:ask -- "钱包监控怎么设置 Telegram 通知？"
pnpm rag:evaluate
```

当前版本只做产品知识问答和超范围识别，不查询个人账户、订单、钱包、交易记录或 MEV 夹子检测。
````

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm format
pnpm check
git diff --check
pnpm rag:ingest
pnpm rag:evaluate
```

Expected:

- `pnpm check` passes.
- `git diff --check` exits with code `0`.
- `pnpm rag:evaluate` prints `Evaluation: 5/5 passed`.

- [ ] **Step 3: Commit**

```bash
git add docs/README.md docs/product-features/README.md
git commit -m "docs: document rag cli"
```

## Self-Review

- Spec coverage: the plan covers product QA, how-to answers, citations, out-of-scope handling, investment refusal, golden-set evaluation, and future tool extension points.
- Placeholder scan: the plan contains no placeholder markers, no incomplete task, and no step that asks the implementer to invent missing behavior.
- Type consistency: `SourceDocument`, `RagChunk`, `RagIndex`, `Classification`, `RetrievalResult`, and `AnswerResult` are introduced in Task 2 and reused consistently in later tasks.
- Scope check: the plan intentionally excludes MEV tooling, user account queries, web UI, Telegram bot integration, and transaction execution from first-phase implementation.
