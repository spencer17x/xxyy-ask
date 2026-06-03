# XXYY pgvector Agentic RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the production RAG path from local JSON-only retrieval to Postgres + pgvector + OpenAI-compatible embeddings while keeping local mode as the development fallback.

**Architecture:** Add configuration for `local` versus `pgvector`, introduce an OpenAI-compatible embedding provider, prepare reusable chunk metadata for both stores, and add a pgvector-backed retriever behind the existing `ChatService`. CLI and API select the retriever from config, while answer generation and HTTP contracts remain unchanged.

**Tech Stack:** TypeScript, pnpm workspace, Vitest, Node `fetch`, `pg`, Postgres, pgvector, OpenAI-compatible `/embeddings` and `/chat/completions`.

---

## File Structure

- Modify `package.json`: root scripts for optional Docker database commands if a compose file is added.
- Modify `.env.example`: add `RAG_VECTOR_STORE`, `DATABASE_URL`, and `OPENAI_EMBEDDING_MODEL`.
- Modify `packages/knowledge/src/index-store.ts`: expose reusable prepared chunks and content hashing.
- Modify `packages/knowledge/src/index.ts`: export prepared chunk types and helpers.
- Create `packages/knowledge/src/openai-embedding-provider.ts`: OpenAI-compatible batch embedding provider and configuration error.
- Create `packages/knowledge/src/openai-embedding-provider.test.ts`: provider tests with mocked `fetch`.
- Modify `packages/knowledge/src/index-store.test.ts`: prepared chunk tests and local index regression tests.
- Modify `packages/rag-core/package.json`: add `pg` dependency and `@types/pg` dev dependency if `pg` types are not bundled.
- Modify `packages/rag-core/src/config.ts`: parse vector store, database URL, and embedding model.
- Modify `packages/rag-core/src/config.test.ts`: config tests.
- Create `packages/rag-core/src/retriever.ts`: common retriever interface and local retriever adapter.
- Create `packages/rag-core/src/pgvector-store.ts`: schema migration, upsert, and retrieve implementation.
- Create `packages/rag-core/src/pgvector-store.test.ts`: fake pg client tests for SQL, vector literal, upsert, retrieve mapping.
- Modify `packages/rag-core/src/chat-service.ts`: accept async `retriever` or local `index`.
- Modify `packages/rag-core/src/chat-service.test.ts`: async retriever and boundary tests.
- Modify `packages/rag-core/src/index.ts`: public exports.
- Modify `apps/cli/package.json`: ensure runtime can reach `pg` through `@xxyy/rag-core`; no direct `pg` import unless the implementation places Pool construction in CLI.
- Modify `apps/cli/src/index.ts`: local/pgvector ingest and ask selection.
- Modify `apps/cli/src/index.test.ts`: CLI config routing tests.
- Modify `apps/api/src/index.ts`: local/pgvector ChatService loader and database configuration errors.
- Modify `apps/api/src/index.test.ts`: API error and pgvector loader tests.
- Modify `docs/README.md`: production setup and commands.
- Create `docker-compose.yml`: optional local Postgres + pgvector service for development.

---

### Task 1: Configuration For Production Vector Store

**Files:**

- Modify: `packages/rag-core/src/config.ts`
- Modify: `packages/rag-core/src/config.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing config tests**

Add these tests to `packages/rag-core/src/config.test.ts`:

```ts
it('defaults to local vector store and OpenAI small embedding model', () => {
  const config = loadRagConfig({});

  expect(config.vectorStore).toBe('local');
  expect(config.databaseUrl).toBeUndefined();
  expect(config.openAiEmbeddingModel).toBe('text-embedding-3-small');
});

it('loads pgvector and embedding configuration from env', () => {
  const config = loadRagConfig({
    DATABASE_URL: 'postgres://xxyy:secret@localhost:5432/xxyy_ask',
    OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
    RAG_VECTOR_STORE: 'pgvector',
  });

  expect(config.vectorStore).toBe('pgvector');
  expect(config.databaseUrl).toBe('postgres://xxyy:secret@localhost:5432/xxyy_ask');
  expect(config.openAiEmbeddingModel).toBe('text-embedding-3-large');
});

it('rejects unsupported vector store configuration', () => {
  expect(() => loadRagConfig({ RAG_VECTOR_STORE: 'pinecone' })).toThrow(
    'Unsupported RAG_VECTOR_STORE: pinecone',
  );
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm test packages/rag-core/src/config.test.ts
```

Expected: FAIL because `vectorStore`, `databaseUrl`, and `openAiEmbeddingModel` do not exist yet.

- [ ] **Step 3: Implement config fields**

Update `packages/rag-core/src/config.ts`:

```ts
export type VectorStoreKind = 'local' | 'pgvector';

export interface RagConfig {
  topK: number;
  answerProvider: string;
  embeddingProvider: string;
  indexPath: string;
  vectorStore: VectorStoreKind;
  databaseUrl: string | undefined;
  openAiApiKey: string | undefined;
  openAiApiKeyPresent: boolean;
  openAiBaseUrl: string;
  openAiModel: string | undefined;
  openAiEmbeddingModel: string;
}

export type RagEnv = Partial<
  Record<
    | 'DATABASE_URL'
    | 'OPENAI_API_KEY'
    | 'OPENAI_BASE_URL'
    | 'OPENAI_EMBEDDING_MODEL'
    | 'OPENAI_MODEL'
    | 'RAG_ANSWER_PROVIDER'
    | 'RAG_EMBEDDING_PROVIDER'
    | 'RAG_INDEX_PATH'
    | 'RAG_TOP_K'
    | 'RAG_VECTOR_STORE',
    string
  >
>;

const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

export function loadRagConfig(env: RagEnv = process.env): RagConfig {
  const config: RagConfig = {
    topK: parseTopK(env.RAG_TOP_K),
    answerProvider: env.RAG_ANSWER_PROVIDER ?? 'openai',
    embeddingProvider: env.RAG_EMBEDDING_PROVIDER ?? 'local',
    indexPath: env.RAG_INDEX_PATH ?? '.rag/index.json',
    vectorStore: parseVectorStore(env.RAG_VECTOR_STORE),
    databaseUrl: env.DATABASE_URL,
    openAiApiKey: env.OPENAI_API_KEY,
    openAiApiKeyPresent: Boolean(env.OPENAI_API_KEY),
    openAiBaseUrl: env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    openAiModel: env.OPENAI_MODEL,
    openAiEmbeddingModel: env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
  };

  return config;
}

function parseVectorStore(value: string | undefined): VectorStoreKind {
  if (value === undefined || value === 'local' || value === 'pgvector') {
    return value ?? 'local';
  }

  throw new Error(`Unsupported RAG_VECTOR_STORE: ${value}`);
}
```

- [ ] **Step 4: Update `.env.example`**

Use this complete content in `.env.example`:

```bash
OPENAI_API_KEY=
OPENAI_MODEL=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_BASE_URL=https://api.openai.com/v1

DATABASE_URL=postgres://xxyy:password@localhost:5432/xxyy_ask

RAG_VECTOR_STORE=local
RAG_TOP_K=6
RAG_INDEX_PATH=.rag/index.json
RAG_ANSWER_PROVIDER=openai
RAG_EMBEDDING_PROVIDER=local
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm test packages/rag-core/src/config.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add .env.example packages/rag-core/src/config.ts packages/rag-core/src/config.test.ts
git commit -m "feat: add vector store config"
```

---

### Task 2: OpenAI-Compatible Embedding Provider

**Files:**

- Create: `packages/knowledge/src/openai-embedding-provider.ts`
- Create: `packages/knowledge/src/openai-embedding-provider.test.ts`
- Modify: `packages/knowledge/src/index.ts`

- [ ] **Step 1: Write failing embedding provider tests**

Create `packages/knowledge/src/openai-embedding-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createOpenAiEmbeddingProvider } from './openai-embedding-provider.js';

describe('createOpenAiEmbeddingProvider', () => {
  it('embeds text batches through an OpenAI-compatible embeddings API', async () => {
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected JSON request body');
      }
      requests.push(JSON.parse(init.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { embedding: [0.1, 0.2, 0.3], index: 0 },
              { embedding: [0.4, 0.5, 0.6], index: 1 },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };

    const provider = createOpenAiEmbeddingProvider({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'text-embedding-3-small',
    });

    const embeddings = await provider.embedTexts(['XXYY Pro', 'Telegram 钱包监控']);

    expect(embeddings).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(requests).toEqual([
      {
        input: ['XXYY Pro', 'Telegram 钱包监控'],
        model: 'text-embedding-3-small',
      },
    ]);
  });

  it('fails fast when embedding configuration is incomplete', () => {
    expect(() =>
      createOpenAiEmbeddingProvider({
        apiKey: undefined,
        baseUrl: 'https://llm.example/v1',
        model: 'text-embedding-3-small',
      }),
    ).toThrow('OPENAI_API_KEY is required for embedding generation');

    expect(() =>
      createOpenAiEmbeddingProvider({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example/v1',
        model: '',
      }),
    ).toThrow('OPENAI_EMBEDDING_MODEL is required for embedding generation');
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm test packages/knowledge/src/openai-embedding-provider.test.ts
```

Expected: FAIL because `openai-embedding-provider.ts` does not exist.

- [ ] **Step 3: Implement provider**

Create `packages/knowledge/src/openai-embedding-provider.ts`:

```ts
export interface BatchEmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
}

export interface OpenAiEmbeddingProviderOptions {
  apiKey: string | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  model: string | undefined;
}

interface EmbeddingResponse {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
}

export class EmbeddingConfigurationError extends Error {}

export function createOpenAiEmbeddingProvider(
  options: OpenAiEmbeddingProviderOptions,
): BatchEmbeddingProvider {
  if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
    throw new EmbeddingConfigurationError('OPENAI_API_KEY is required for embedding generation.');
  }
  if (options.model === undefined || options.model.trim().length === 0) {
    throw new EmbeddingConfigurationError(
      'OPENAI_EMBEDDING_MODEL is required for embedding generation.',
    );
  }

  const apiKey = options.apiKey;
  const model = options.model;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/embeddings`;

  return {
    async embedTexts(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }

      const response = await fetchImpl(endpoint, {
        body: JSON.stringify({ input: texts, model }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Embedding request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as EmbeddingResponse;
      const rows = payload.data ?? [];
      const sortedRows = [...rows].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      const embeddings = sortedRows.map((row) => row.embedding);

      if (
        embeddings.length !== texts.length ||
        embeddings.some((embedding) => !Array.isArray(embedding))
      ) {
        throw new Error('Embedding response did not include all embeddings.');
      }

      return embeddings as number[][];
    },
  };
}
```

- [ ] **Step 4: Export provider**

Update `packages/knowledge/src/index.ts`:

```ts
export {
  createOpenAiEmbeddingProvider,
  EmbeddingConfigurationError,
} from './openai-embedding-provider.js';
export type {
  BatchEmbeddingProvider,
  OpenAiEmbeddingProviderOptions,
} from './openai-embedding-provider.js';
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm test packages/knowledge/src/openai-embedding-provider.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/knowledge/src/openai-embedding-provider.ts packages/knowledge/src/openai-embedding-provider.test.ts packages/knowledge/src/index.ts
git commit -m "feat: add openai embedding provider"
```

---

### Task 3: Reusable Prepared Knowledge Chunks

**Files:**

- Modify: `packages/knowledge/src/index-store.ts`
- Modify: `packages/knowledge/src/index-store.test.ts`
- Modify: `packages/knowledge/src/index.ts`

- [ ] **Step 1: Write failing prepared chunk tests**

Add to `packages/knowledge/src/index-store.test.ts`:

```ts
it('prepares chunks with tokens, searchable text, and stable content hashes', async () => {
  const documents = [
    {
      id: 'official_docs:pro',
      title: 'XXYY Pro 权益',
      module: 'XXYY Pro',
      sourceType: 'official_docs' as const,
      file: '/docs/pro.md',
      content: '# XXYY Pro 权益\n\nXXYY Pro 支持 Telegram 钱包监控。',
    },
  ];

  const chunks = prepareKnowledgeChunks(documents);

  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({
    documentId: 'official_docs:pro',
    metadata: {
      title: 'XXYY Pro 权益',
      module: 'XXYY Pro',
      sourceType: 'official_docs',
      file: 'docs/pro.md',
    },
  });
  expect(chunks[0]?.tokens).toContain('xxyy');
  expect(chunks[0]?.searchableText).toContain('Telegram 钱包监控');
  expect(chunks[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm test packages/knowledge/src/index-store.test.ts
```

Expected: FAIL because `prepareKnowledgeChunks` is not exported.

- [ ] **Step 3: Implement prepared chunks**

Update `packages/knowledge/src/index-store.ts`:

```ts
import { createHash } from 'node:crypto';
```

Add:

```ts
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

function createContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeFilePath(file: string): string {
  return file.replace(/^\/+/u, '');
}
```

Change `buildKnowledgeIndex()` to use `prepareKnowledgeChunks()`:

```ts
export async function buildKnowledgeIndex(
  documents: SourceDocument[],
  embeddingProvider: EmbeddingProvider = localHashEmbeddingProvider,
): Promise<RagIndex> {
  const chunks = prepareKnowledgeChunks(documents);
  const entries: IndexEntry[] = [];

  for (const chunk of chunks) {
    const { contentHash: _contentHash, searchableText, ...entry } = chunk;
    entries.push({
      ...entry,
      embedding: await embeddingProvider.embed(searchableText, entry),
    });
  }

  return {
    version: INDEX_VERSION,
    builtAt: DETERMINISTIC_BUILT_AT,
    entries,
  };
}
```

- [ ] **Step 4: Export prepared chunk helpers**

Update `packages/knowledge/src/index.ts`:

```ts
export {
  buildKnowledgeIndex,
  createLocalHashEmbedding,
  loadKnowledgeIndex,
  localHashEmbeddingProvider,
  prepareKnowledgeChunks,
  saveKnowledgeIndex,
} from './index-store.js';
export type { EmbeddingProvider, PreparedKnowledgeChunk } from './index-store.js';
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm test packages/knowledge/src/index-store.test.ts
pnpm check
```

Expected: PASS.

Commit:

```bash
git add packages/knowledge/src/index-store.ts packages/knowledge/src/index-store.test.ts packages/knowledge/src/index.ts
git commit -m "feat: prepare reusable knowledge chunks"
```

---

### Task 4: Retriever Interface And Async ChatService

**Files:**

- Create: `packages/rag-core/src/retriever.ts`
- Modify: `packages/rag-core/src/chat-service.ts`
- Modify: `packages/rag-core/src/chat-service.test.ts`
- Modify: `packages/rag-core/src/index.ts`

- [ ] **Step 1: Write failing ChatService retriever tests**

Add to `packages/rag-core/src/chat-service.test.ts`:

```ts
it('uses an async retriever for grounded product questions', async () => {
  const retrievedQuestions: string[] = [];
  const answerProvider: AnswerProvider = {
    answer({ retrievedChunks }) {
      return Promise.resolve({
        answer: 'XXYY Pro 支持 Telegram 钱包监控。',
        citations: retrievedChunks.map((chunk) => ({
          excerpt: chunk.text,
          file: chunk.metadata.file,
          title: chunk.metadata.title,
        })),
        confidence: 0.9,
        intent: 'product_qa',
      });
    },
  };
  const service = createChatService({
    answerProvider,
    retriever: {
      retrieve(question) {
        retrievedQuestions.push(question);
        return Promise.resolve([
          {
            ...createFixtureIndex([
              {
                id: 'official_docs:pro:chunk:0001',
                title: 'XXYY Pro 权益',
                sourceType: 'official_docs',
                file: 'docs/pro.md',
                text: 'XXYY Pro 支持 Telegram 钱包监控。',
              },
            ]).entries[0],
            lexicalScore: 1,
            rank: 1,
            score: 1,
            vectorScore: 1,
          },
        ]);
      },
    },
  });

  const response = await service.ask({
    channel: 'web',
    message: 'XXYY Pro 支持什么？',
  });

  expect(response.citations).toHaveLength(1);
  expect(retrievedQuestions).toEqual(['XXYY Pro 支持什么？']);
});

it('does not call the async retriever for boundary questions', async () => {
  const service = createChatService({
    retriever: {
      retrieve() {
        throw new Error('retriever should not be called');
      },
    },
  });

  const response = await service.ask({
    channel: 'web',
    message: '帮我查一下钱包余额',
  });

  expect(response.intent).toBe('realtime_account_query');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm test packages/rag-core/src/chat-service.test.ts
```

Expected: FAIL because `CreateChatServiceOptions` does not support `retriever` yet.

- [ ] **Step 3: Create retriever interface**

Create `packages/rag-core/src/retriever.ts`:

```ts
import type { RagIndex } from '@xxyy/shared';

import { retrieve, type RetrieveOptions, type RetrievedChunk } from './retrieve.js';

export interface Retriever {
  retrieve(
    question: string,
    options: RetrieveOptions,
  ): Promise<RetrievedChunk[]> | RetrievedChunk[];
}

export function createLocalRetriever(index: RagIndex): Retriever {
  return {
    retrieve(question: string, options: RetrieveOptions): RetrievedChunk[] {
      return retrieve(question, index, options);
    },
  };
}
```

- [ ] **Step 4: Update ChatService**

Modify `packages/rag-core/src/chat-service.ts`:

```ts
import type { Retriever } from './retriever.js';
import { createLocalRetriever } from './retriever.js';
```

Change options:

```ts
export interface CreateChatServiceOptions {
  index?: RagIndex;
  retriever?: Retriever;
  answerProvider?: AnswerProvider;
  config?: Partial<RagConfig>;
}
```

Add resolver:

```ts
function createRetriever(options: CreateChatServiceOptions): Retriever {
  if (options.retriever !== undefined) {
    return options.retriever;
  }

  if (options.index !== undefined) {
    return createLocalRetriever(options.index);
  }

  throw new Error('createChatService requires either index or retriever.');
}
```

Use it in `createChatService()`:

```ts
const retriever = createRetriever(options);
```

Replace direct local retrieval:

```ts
const retrievedChunks = await retriever.retrieve(request.message, { topK: config.topK });
```

- [ ] **Step 5: Export retriever**

Update `packages/rag-core/src/index.ts`:

```ts
export { createLocalRetriever } from './retriever.js';
export type { Retriever } from './retriever.js';
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm test packages/rag-core/src/chat-service.test.ts packages/rag-core/src/index.test.ts
pnpm typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/rag-core/src/retriever.ts packages/rag-core/src/chat-service.ts packages/rag-core/src/chat-service.test.ts packages/rag-core/src/index.ts packages/rag-core/src/index.test.ts
git commit -m "feat: add retriever abstraction"
```

---

### Task 5: pgvector Store Schema, Upsert, And Retrieval

**Files:**

- Modify: `packages/rag-core/package.json`
- Create: `packages/rag-core/src/pgvector-store.ts`
- Create: `packages/rag-core/src/pgvector-store.test.ts`
- Modify: `packages/rag-core/src/index.ts`

- [ ] **Step 1: Add dependency**

Run:

```bash
pnpm --filter @xxyy/rag-core add pg
pnpm --filter @xxyy/rag-core add -D @types/pg
```

Expected: `packages/rag-core/package.json` and `pnpm-lock.yaml` update.

- [ ] **Step 2: Write failing pgvector tests**

Create `packages/rag-core/src/pgvector-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createPgVectorStore, toPgVectorLiteral } from './pgvector-store.js';

class FakePgClient {
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: unknown[] = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: this.rows as T[] });
  }
}

describe('toPgVectorLiteral', () => {
  it('formats vectors for pgvector parameters', () => {
    expect(toPgVectorLiteral([0.1, -0.2, 0])).toBe('[0.1,-0.2,0]');
  });
});

describe('createPgVectorStore', () => {
  it('migrates the knowledge chunk schema', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.migrate();

    expect(client.queries.map((query) => query.sql).join('\n')).toContain(
      'create table if not exists knowledge_chunks',
    );
  });

  it('upserts embedded chunks', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.upsertChunks([
      {
        contentHash: 'hash-1',
        documentId: 'official_docs:pro',
        embedding: [0.1, 0.2, 0.3],
        id: 'official_docs:pro:chunk:0001',
        metadata: {
          file: 'docs/pro.md',
          headingPath: ['XXYY Pro 权益'],
          module: 'XXYY Pro',
          sourceType: 'official_docs',
          title: 'XXYY Pro 权益',
        },
        searchableText: 'XXYY Pro 权益\nXXYY Pro 支持 Telegram 钱包监控。',
        text: 'XXYY Pro 支持 Telegram 钱包监控。',
        tokens: ['xxyy', 'pro', 'telegram'],
      },
    ]);

    expect(client.queries[0]?.sql).toContain('insert into knowledge_chunks');
    expect(client.queries[0]?.values).toContain('[0.1,0.2,0.3]');
  });

  it('retrieves and maps pgvector rows into RetrievedChunk results', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content: 'XXYY Pro 支持 Telegram 钱包监控。',
        document_id: 'official_docs:pro',
        embedding_distance: 0.1,
        file: 'docs/pro.md',
        heading_path: ['XXYY Pro 权益'],
        id: 'official_docs:pro:chunk:0001',
        module: 'XXYY Pro',
        order_index: null,
        retrieved_at: null,
        source_type: 'official_docs',
        source_url: null,
        title: 'XXYY Pro 权益',
        tokens: ['xxyy', 'pro', 'telegram'],
      },
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([[0.1, 0.2, 0.3]]) },
    });

    const results = await store.retrieve('XXYY Pro 支持什么？', { topK: 1 });

    expect(results[0]).toMatchObject({
      id: 'official_docs:pro:chunk:0001',
      rank: 1,
      metadata: {
        file: 'docs/pro.md',
        sourceType: 'official_docs',
        title: 'XXYY Pro 权益',
      },
      text: 'XXYY Pro 支持 Telegram 钱包监控。',
    });
  });
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
pnpm test packages/rag-core/src/pgvector-store.test.ts
```

Expected: FAIL because `pgvector-store.ts` does not exist.

- [ ] **Step 4: Implement pgvector store**

Create `packages/rag-core/src/pgvector-store.ts`:

```ts
import { Pool } from 'pg';

import type { BatchEmbeddingProvider, PreparedKnowledgeChunk } from '@xxyy/knowledge';
import { tokenize } from '@xxyy/knowledge';
import type { IndexEntry, SourceType } from '@xxyy/shared';

import type { RetrieveOptions, RetrievedChunk } from './retrieve.js';
import type { Retriever } from './retriever.js';

export interface PgClientLike {
  query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface EmbeddedKnowledgeChunk extends PreparedKnowledgeChunk {
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
            retrieved_at = excluded.retrieved_at,
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
            undefined,
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

      const topK = retrieveOptions.topK ?? 6;
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
```

- [ ] **Step 5: Export pgvector store**

Update `packages/rag-core/src/index.ts`:

```ts
export {
  createPgPool,
  createPgVectorStore,
  toPgVectorLiteral,
  VectorStoreConfigurationError,
} from './pgvector-store.js';
export type {
  EmbeddedKnowledgeChunk,
  PgClientLike,
  PgVectorStore,
  PgVectorStoreOptions,
} from './pgvector-store.js';
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm test packages/rag-core/src/pgvector-store.test.ts packages/rag-core/src/index.test.ts
pnpm check
```

Expected: PASS.

Commit:

```bash
git add packages/rag-core/package.json pnpm-lock.yaml packages/rag-core/src/pgvector-store.ts packages/rag-core/src/pgvector-store.test.ts packages/rag-core/src/index.ts packages/rag-core/src/index.test.ts
git commit -m "feat: add pgvector retriever"
```

---

### Task 6: CLI Local And pgvector Ingest/Ask Routing

**Files:**

- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/index.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Add to `apps/cli/src/index.test.ts`:

```ts
it('formats pgvector ingest summaries', () => {
  expect(
    formatIngestSummary({
      chunkCount: 491,
      documentCount: 65,
      indexPath: 'pgvector',
    }),
  ).toContain('Saved index: pgvector');
});

it('prints database configuration errors from pgvector mode', async () => {
  const stderr: string[] = [];
  const exitCode = await runCli(['ask', 'XXYY Pro 有哪些权益？'], {
    cwd: process.cwd(),
    env: {
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'test-model',
      RAG_VECTOR_STORE: 'pgvector',
    },
    stderr: { write: (message: string) => void stderr.push(message) },
    stdout: { write: () => undefined },
  });

  expect(exitCode).toBe(1);
  expect(stderr.join('')).toContain('DATABASE_URL is required when RAG_VECTOR_STORE=pgvector');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm test apps/cli/src/index.test.ts
```

Expected: FAIL because pgvector mode is not routed yet.

- [ ] **Step 3: Implement pgvector ingest helpers**

In `apps/cli/src/index.ts`, import:

```ts
import {
  EmbeddingConfigurationError,
  createOpenAiEmbeddingProvider,
  prepareKnowledgeChunks,
  type PreparedKnowledgeChunk,
} from '@xxyy/knowledge';
import {
  createPgPool,
  createPgVectorStore,
  VectorStoreConfigurationError,
  type ChatService,
  type EmbeddedKnowledgeChunk,
} from '@xxyy/rag-core';
```

Add:

```ts
const EMBEDDING_BATCH_SIZE = 64;
```

Change `ingest()`:

```ts
async function ingest(io: CliIo): Promise<IngestSummary> {
  const config = loadRagConfig(io.env);
  const documents = await loadProductDocuments({ cwd: io.cwd });

  if (config.vectorStore === 'pgvector') {
    const chunks = prepareKnowledgeChunks(documents);
    const pool = createPgPool(config.databaseUrl);
    const embeddingProvider = createOpenAiEmbeddingProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      model: config.openAiEmbeddingModel,
    });
    const embeddedChunks = await embedPreparedChunks(chunks, embeddingProvider);
    try {
      const store = createPgVectorStore({ client: pool, embeddingProvider });
      await store.migrate();
      await store.upsertChunks(embeddedChunks);
    } finally {
      await pool.end();
    }

    return {
      documentCount: documents.length,
      chunkCount: chunks.length,
      indexPath: 'pgvector',
    };
  }

  const index = await buildKnowledgeIndex(documents);
  const absoluteIndexPath = path.resolve(io.cwd, config.indexPath);
  await saveKnowledgeIndex(absoluteIndexPath, index);

  return {
    documentCount: documents.length,
    chunkCount: index.entries.length,
    indexPath: config.indexPath,
  };
}
```

Add:

```ts
async function embedPreparedChunks(
  chunks: PreparedKnowledgeChunk[],
  embeddingProvider: { embedTexts(texts: string[]): Promise<number[][]> },
): Promise<EmbeddedKnowledgeChunk[]> {
  const embeddedChunks: EmbeddedKnowledgeChunk[] = [];

  for (let index = 0; index < chunks.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(index, index + EMBEDDING_BATCH_SIZE);
    const embeddings = await embeddingProvider.embedTexts(
      batch.map((chunk) => chunk.searchableText),
    );
    batch.forEach((chunk, batchIndex) => {
      const embedding = embeddings[batchIndex];
      if (embedding === undefined) {
        throw new Error(`Missing embedding for chunk ${chunk.id}.`);
      }
      embeddedChunks.push({ ...chunk, embedding });
    });
  }

  return embeddedChunks;
}
```

- [ ] **Step 4: Implement pgvector ask/evaluate routing**

Replace local-only service creation in `runCli()`:

```ts
const runtime = await createCliChatRuntime(config, workspaceCwd);
try {
  const service = runtime.service;

  if (parsed.command === 'ask') {
    const request: ChatRequest = { channel: 'cli', message: parsed.question };
    const response = await service.ask(request);
    writeLine(io.stdout, formatChatResponse(response));
    return 0;
  }

  const report = await evaluateCases(BUILT_IN_EVALUATION_CASES, service);
  writeLine(io.stdout, formatEvaluationReport(report));
  return report.passed === report.total ? 0 : 1;
} finally {
  await runtime.close();
}
```

Add:

```ts
interface CliChatRuntime {
  service: ChatService;
  close(): Promise<void>;
}

async function createCliChatRuntime(
  config: ReturnType<typeof loadRagConfig>,
  workspaceCwd: string,
): Promise<CliChatRuntime> {
  if (config.vectorStore === 'pgvector') {
    const pool = createPgPool(config.databaseUrl);
    const embeddingProvider = createOpenAiEmbeddingProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      model: config.openAiEmbeddingModel,
    });
    const retriever = createPgVectorStore({ client: pool, embeddingProvider });
    return {
      service: createChatService({ config, retriever }),
      close: () => pool.end(),
    };
  }

  const index = await loadKnowledgeIndex(path.resolve(workspaceCwd, config.indexPath));
  return {
    service: createChatService({ config, index }),
    close: () => Promise.resolve(),
  };
}
```

Change error handling:

```ts
if (error instanceof EmbeddingConfigurationError) {
  writeLine(io.stderr, error.message);
  return 1;
}

if (error instanceof VectorStoreConfigurationError) {
  writeLine(io.stderr, error.message);
  return 1;
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm test apps/cli/src/index.test.ts
pnpm check
```

Expected: PASS.

Commit:

```bash
git add apps/cli/src/index.ts apps/cli/src/index.test.ts
git commit -m "feat: route cli through pgvector"
```

---

### Task 7: API pgvector Loader And Error Responses

**Files:**

- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/index.test.ts`

- [ ] **Step 1: Write failing API tests**

Add to `apps/api/src/index.test.ts`:

```ts
it('returns a useful 503 when pgvector configuration is missing', async () => {
  const handler = createRequestHandler({
    env: {
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'test-model',
      RAG_VECTOR_STORE: 'pgvector',
    },
  });

  const response = await callHandler(handler, {
    method: 'POST',
    url: '/api/chat',
    body: { message: 'XXYY Pro 有哪些权益？' },
  });

  expect(response.statusCode).toBe(503);
  expect(JSON.parse(response.body)).toEqual({
    error: 'vector_store_configuration_missing',
    message: 'DATABASE_URL is required when RAG_VECTOR_STORE=pgvector.',
  });
});

it('returns a useful 503 when embedding configuration is missing', async () => {
  const handler = createRequestHandler({
    env: {
      DATABASE_URL: 'postgres://xxyy:password@localhost:5432/xxyy_ask',
      OPENAI_MODEL: 'test-model',
      RAG_VECTOR_STORE: 'pgvector',
    },
  });

  const response = await callHandler(handler, {
    method: 'POST',
    url: '/api/chat',
    body: { message: 'XXYY Pro 有哪些权益？' },
  });

  expect(response.statusCode).toBe(503);
  expect(JSON.parse(response.body)).toEqual({
    error: 'embedding_configuration_missing',
    message: 'OPENAI_API_KEY is required for embedding generation.',
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm test apps/api/src/index.test.ts
```

Expected: FAIL because API does not catch `VectorStoreConfigurationError`.

- [ ] **Step 3: Implement API loader**

In `apps/api/src/index.ts`, import:

```ts
import { createOpenAiEmbeddingProvider, EmbeddingConfigurationError } from '@xxyy/knowledge';
import { createPgPool, createPgVectorStore, VectorStoreConfigurationError } from '@xxyy/rag-core';
```

Change cached loader to receive `config` and choose vector store:

```ts
function createCachedChatServiceLoader(
  absoluteIndexPath: string,
  displayIndexPath: string,
  config: ReturnType<typeof loadRagConfig>,
): () => Promise<ChatService> {
  let cachedService: ChatService | undefined;

  return async () => {
    if (cachedService !== undefined) {
      return cachedService;
    }

    if (config.vectorStore === 'pgvector') {
      const pool = createPgPool(config.databaseUrl);
      const embeddingProvider = createOpenAiEmbeddingProvider({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: config.openAiEmbeddingModel,
      });
      const retriever = createPgVectorStore({ client: pool, embeddingProvider });
      cachedService = createChatService({ config, retriever });
      return cachedService;
    }

    try {
      const index = await loadKnowledgeIndex(absoluteIndexPath);
      cachedService = createChatService({ config, index });
      return cachedService;
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new MissingIndexError(displayIndexPath);
      }
      throw error;
    }
  };
}
```

Add API catch:

```ts
if (error instanceof EmbeddingConfigurationError) {
  sendJson(response, 503, {
    error: 'embedding_configuration_missing',
    message: error.message,
  });
  return;
}

if (error instanceof VectorStoreConfigurationError) {
  sendJson(response, 503, {
    error: 'vector_store_configuration_missing',
    message: error.message,
  });
  return;
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
pnpm test apps/api/src/index.test.ts
pnpm check
```

Expected: PASS.

Commit:

```bash
git add apps/api/src/index.ts apps/api/src/index.test.ts
git commit -m "feat: route api through pgvector"
```

---

### Task 8: Documentation, Docker, And Final Verification

**Files:**

- Create: `docker-compose.yml`
- Modify: `docs/README.md`
- Modify: `.env.example`

- [ ] **Step 1: Create Docker Compose for local pgvector**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: xxyy_ask
      POSTGRES_PASSWORD: password
      POSTGRES_USER: xxyy
    ports:
      - '5432:5432'
    volumes:
      - xxyy_pgdata:/var/lib/postgresql/data

volumes:
  xxyy_pgdata:
```

- [ ] **Step 2: Update docs**

Add this section to `docs/README.md`:

````md
## 正式 RAG：Postgres + pgvector

开发环境可以启动本地 pgvector：

```bash
docker compose up -d postgres
```

配置：

```bash
export RAG_VECTOR_STORE=pgvector
export DATABASE_URL="postgres://xxyy:password@localhost:5432/xxyy_ask"
export OPENAI_API_KEY="你的 API Key"
export OPENAI_MODEL="你的回答模型"
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
```

写入知识库：

```bash
pnpm rag:ingest
```

运行 API：

```bash
pnpm start
```

本地 fallback 仍可使用：

```bash
export RAG_VECTOR_STORE=local
pnpm rag:ingest
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```
````

- [ ] **Step 3: Run final verification**

Run:

```bash
pnpm check
pnpm rag:ingest
env -u OPENAI_API_KEY -u OPENAI_MODEL pnpm rag:ask -- "帮我查一下钱包余额"
env -u DATABASE_URL RAG_VECTOR_STORE=pgvector OPENAI_API_KEY=test-key OPENAI_MODEL=test-model OPENAI_EMBEDDING_MODEL=text-embedding-3-small pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

Expected:

- `pnpm check`: PASS.
- `pnpm rag:ingest`: local mode indexes documents into `.rag/index.json`.
- boundary ask: exit 0 with `Intent: realtime_account_query`.
- pgvector missing database ask: exit 1 with `DATABASE_URL is required when RAG_VECTOR_STORE=pgvector`.

- [ ] **Step 4: Commit docs and final state**

Commit:

```bash
git add docker-compose.yml docs/README.md .env.example
git commit -m "docs: add pgvector setup"
```

Then verify:

```bash
git status --short --branch
```

Expected: clean branch with no unstaged changes.

---

## Self-Review Coverage

- Spec goal `Postgres + pgvector + OpenAI embeddings`: covered by Tasks 1, 2, 5, 6, and 7.
- Local fallback: covered by Tasks 1, 3, 4, 6, and 8.
- Ingest writes pgvector: covered by Tasks 3, 5, and 6.
- Chat retrieves from pgvector: covered by Tasks 4, 5, 6, and 7.
- API/CLI explicit errors: covered by Tasks 6 and 7.
- Documentation and Docker setup: covered by Task 8.
- Boundary questions avoid retrieval and LLM: covered by Task 4 and final verification in Task 8.
