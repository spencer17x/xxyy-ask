# XXYY Ask Repository Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the ten confirmed repository-review defects while preserving XXYY Ask's knowledge-only product-support boundary and the user's current uncommitted RAG/Agent work.

**Architecture:** Deliver three gated batches: deterministic security boundaries, grounded RAG and atomic knowledge operations, then Web/API/Telegram reliability. Every task begins with a focused failing regression test and ends with targeted verification; the final gate builds the Web app and runs the full repository check.

**Tech Stack:** TypeScript ESM, Node.js HTTP/fetch, LangGraph JS, pnpm workspace, Vitest, Postgres + pgvector, React + Vite.

## Global Constraints

- Preserve the existing package boundaries documented in `AGENTS.md`.
- Do not expose transaction analysis, account/order/balance access, private records, or investment advice.
- Do not delete or modify ignored local transaction-analysis artifacts; only prevent public serving.
- Keep production chat authentication enabled by default.
- Keep the Web token in React memory only; never write it to browser storage or generated assets.
- Do not automatically destroy an embedding column during ordinary `rag:migrate`.
- Use TDD for every behavior change: verify the regression test fails for the reviewed reason before editing production code.
- The working tree already contains user-owned changes in `packages/rag-core` and `packages/agent-core`; do not revert them and do not create implementation commits that would absorb those changes.

---

### Task 1: Lock down product assets and byte-accurate API bodies

**Files:**

- Modify: `apps/api/src/index.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**

- Consumes: existing `createRequestHandler`, `/assets/*`, `/web-assets/*`, and `API_MAX_BODY_BYTES` behavior.
- Produces: `PRODUCT_ASSET_NAMES: ReadonlySet<string>` and a `readJsonBody` implementation that buffers raw bytes.

- [ ] **Step 1: Add failing asset allowlist tests**

Add cases beside the existing static-asset tests that create both an approved `xxyy-add-to-home.mp4` and a non-approved `tx-analysis-report-index.jsonl` in the temporary asset directory:

```ts
it('serves only explicitly approved product assets', async () => {
  const assetsDir = await mkdtemp(path.join(tmpdir(), 'xxyy-api-assets-'));
  await writeFile(path.join(assetsDir, 'xxyy-add-to-home.mp4'), 'video');
  await writeFile(path.join(assetsDir, 'tx-analysis-report-index.jsonl'), '{"private":true}\n');
  const handler = createRequestHandler({ env: {}, staticAssetsDir: assetsDir });

  const approved = await callHandler(handler, {
    method: 'GET',
    url: '/assets/xxyy-add-to-home.mp4',
  });
  const blocked = await callHandler(handler, {
    method: 'GET',
    url: '/assets/tx-analysis-report-index.jsonl',
  });

  expect(approved.statusCode).toBe(200);
  expect(blocked.statusCode).toBe(404);
  expect(blocked.body).not.toContain('private');
});
```

- [ ] **Step 2: Add a failing split-UTF-8 request test**

Extend `callHandler` with `bodyChunks?: Buffer[]`, prefer it over the JSON `body` field, then split inside `你` and assert the fake service receives the original character:

```ts
it('decodes UTF-8 only after all request bytes are buffered', async () => {
  const body = Buffer.from(JSON.stringify({ channel: 'web', message: '你' }));
  const character = Buffer.from('你');
  const splitAt = body.indexOf(character) + 1;
  const ask = vi.fn(() =>
    Promise.resolve({
      answer: 'ok',
      citations: [],
      confidence: 0.8,
      intent: 'product_qa' as const,
    }),
  );
  const handler = createRequestHandler({
    env: {},
    getChatService: () =>
      Promise.resolve({
        ask,
        async *stream() {
          await Promise.resolve();
        },
      }),
  });

  await callHandler(handler, {
    bodyChunks: [body.subarray(0, splitAt), body.subarray(splitAt)],
    method: 'POST',
    url: '/api/chat',
  });

  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ message: '你' }));
});
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
pnpm exec vitest run apps/api/src/index.test.ts
```

Expected: the ignored report returns `200`, and the split character reaches the service as replacement characters.

- [ ] **Step 4: Implement the allowlist and raw-byte buffering**

In `apps/api/src/index.ts`, define the approved product set and pass it only to the product-assets branch:

```ts
const PRODUCT_ASSET_NAMES = new Set(['xxyy-add-to-home.mp4']);

if (request.method === 'GET' && requestUrl.pathname.startsWith('/assets/')) {
  await sendStaticAsset(response, staticAssetsDir, requestUrl.pathname, PRODUCT_ASSET_NAMES);
  return;
}
```

Extend `sendStaticAsset` with an optional allowlist and reject names before reading. Replace per-chunk decoding in `readJsonBody` with Buffer accumulation:

```ts
const chunks: Buffer[] = [];
let byteLength = 0;
for await (const chunk of request) {
  const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  byteLength += bytes.length;
  if (byteLength > maxBodyBytes) throw new PayloadTooLargeError();
  chunks.push(bytes);
}
const body = Buffer.concat(chunks, byteLength).toString('utf8');
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run apps/api/src/index.test.ts
```

Expected: all API tests pass; approved media remains public, report files return `404`, and split UTF-8 is unchanged.

- [ ] **Step 6: Inspect the diff checkpoint without committing**

Run `git diff --check -- apps/api/src/index.ts apps/api/src/index.test.ts` and confirm no unrelated API behavior changed.

### Task 2: Enforce deterministic transaction and MEV boundaries

**Files:**

- Modify: `packages/rag-core/src/classify.test.ts`
- Modify: `packages/rag-core/src/classify.ts`
- Modify: `packages/rag-core/src/index.test.ts`
- Modify: `packages/rag-core/src/index.ts`
- Modify: `packages/rag-core/src/answer.ts`
- Modify: `packages/agent-core/src/langgraph-customer-runtime.test.ts`
- Modify: `packages/agent-core/src/langgraph-customer-runtime.ts`
- Modify: `packages/agent-core/src/tools/product-tools.test.ts`
- Modify: `packages/agent-core/src/tools/product-tools.ts`

**Interfaces:**

- Produces: classification reason `unsupported transaction or mev analysis request`, exported `hasProductDomainSignal(question)`, and server-owned boundary copy.
- Preserves: existing `Intent` union and public chat response schema.

- [ ] **Step 1: Add failing classifier and pre-guard tests**

Add table cases for a transaction hash, explorer URL, pool lookup, and generic MEV request:

```ts
it.each([
  '这个 tx hash 是不是被夹了，有 MEV sandwich 吗？',
  '分析 https://solscan.io/tx/abc',
  '帮我查这个池子有没有夹子',
  '分析一下这笔链上交易',
])('classifies unsupported transaction analysis before product planning: %s', (question) => {
  expect(classifyQuestion(question)).toMatchObject({
    intent: 'unknown',
    reason: 'unsupported transaction or mev analysis request',
  });
});
```

In the runtime test, use planner and tool spies and assert neither is called while the response route is `boundary`.

- [ ] **Step 2: Add a failing product-tool override test**

Call `answer_product_question` with the MEV prompt and assert the injected answer provider is not called and the returned intent remains `unknown` with no citations.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/rag-core/src/classify.test.ts packages/agent-core/src/langgraph-customer-runtime.test.ts packages/agent-core/src/tools/product-tools.test.ts
```

Expected: the new prompts are generic `unknown`, reach planner/product override, or return planner-authored content.

- [ ] **Step 4: Implement deterministic patterns and owned boundary response**

Add transaction/MEV patterns before product rules in `classify.ts` and export the positive product-domain predicate through `rag-core/src/index.ts`:

```ts
const unsupportedTransactionAnalysisPatterns = [
  /\b(?:0x)?[a-f0-9]{64}\b/u,
  /(?:solscan\.io|etherscan\.io|bscscan\.com|basescan\.org)\/(?:tx|transaction)\//u,
  /交易哈希|tx\s*hash|explorer|浏览器链接|池子查询|链上取证|夹子|sandwich|\bmev\b/u,
];

export function hasProductDomainSignal(question: string): boolean {
  const normalized = question.normalize('NFKC').trim().toLowerCase();
  return (
    /\bxxyy\b|\bpro\b|产品|功能|权益|配置|设置|更新/u.test(normalized) ||
    productSupportDomainPattern.test(normalized)
  );
}
```

Return the dedicated classification before product rules. Add the new reason to `isBoundaryUnknownReason` and map it to fixed boundary text in `createBoundaryAnswer`:

```ts
return '当前不分析交易哈希、explorer 链接、池子、链上取证或 MEV/夹子问题，也不会编造实时链上结论。可以继续咨询 XXYY 产品功能、配置步骤、权益说明或官方更新。';
```

Change planner product override to import and require `hasProductDomainSignal(question)`; a generic `unknown` is insufficient:

```ts
function canPlannerSafelyOverrideProductClassification(
  classification: Classification,
  question: string,
): boolean {
  return (
    classification.intent === 'unknown' &&
    classification.reason === 'no deterministic product support intent matched' &&
    hasProductDomainSignal(question)
  );
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 3. Expected: all targeted tests pass and every boundary case avoids planner/tool calls.

- [ ] **Step 6: Run the documented boundary smoke command**

Run:

```bash
env -u DATABASE_URL -u POSTGRES_DB -u POSTGRES_USER -u POSTGRES_PASSWORD -u OPENAI_API_KEY -u OPENAI_MODEL pnpm rag:ask -- "这个 tx hash 是不是被夹了，有 MEV sandwich 吗？"
```

Expected: a boundary response without configuration access.

### Task 3: Make support conclusions entity-exact and time-aware

**Files:**

- Modify: `packages/rag-core/src/answer.test.ts`
- Modify: `packages/rag-core/src/answer.ts`
- Modify: `packages/rag-core/src/classify.test.ts`
- Modify: `packages/rag-core/src/classify.ts`
- Modify: `packages/rag-core/src/openai-answer-provider.test.ts`

**Interfaces:**

- Consumes: `tokenize`, `selectGroundingChunks`, and deterministic support-answer exports.
- Produces: exact entity evidence matching and future-marker rejection.

- [ ] **Step 1: Add failing support-evidence tests**

Add exact reproductions:

```ts
expect(
  createSupportConclusionFromEvidence('Does XXYY support Robinhood?', [
    'XXYY 计划支持 Robinhood，预计下季度上线。',
  ]),
).toBeUndefined();

expect(
  createSupportConclusionFromEvidence('XXYY 支持 OP 吗？', ['XXYY 支持 Copy Trading。']),
).toBeUndefined();
```

Add a grounding test where an unrelated top-ranked standard-answer chunk must not satisfy `Does XXYY support Robinhood?`, and a positive control where direct `Robinhood` current-support evidence succeeds.

- [ ] **Step 2: Add a failing generic-English-support classifier test**

Assert `Can you support me with my homework?` is `unknown`, while `Does XXYY support Robinhood?` remains `product_qa`.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/rag-core/src/answer.test.ts packages/rag-core/src/classify.test.ts packages/rag-core/src/openai-answer-provider.test.ts
```

Expected: roadmap and substring cases return affirmative answers, the unrelated standard answer is cited, and generic support is classified as product QA.

- [ ] **Step 4: Implement exact tokens, future markers, and selection ordering**

Create token-set helpers using `tokenize`, require every support entity keyword in both the selected chunk and sentence, and reject support sentences matching:

```ts
const FUTURE_SUPPORT_PATTERN = /计划|即将|预计|未来|下季度|稍后|soon|coming|roadmap|will support/iu;

function containsAllEvidenceTokens(text: string, tokens: string[]): boolean {
  const evidenceTokens = new Set(tokenize(normalizeForEvidenceMatch(text)));
  return tokens.every((token) => evidenceTokens.has(token));
}

function isCurrentSupportSentence(sentence: string): boolean {
  return (
    !FUTURE_SUPPORT_PATTERN.test(sentence) &&
    /支持|上线|可用|暂时没有|不支持|未支持|尚未支持/u.test(sentence)
  );
}
```

Move support entity/topical validation before the standard-answer early return. Tighten external support classification to require either a known product domain or explicit `xxyy` plus an external entity.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: all targeted tests pass and direct current-support controls still produce affirmative answers.

### Task 4: Add a pgvector relevance gate

**Files:**

- Modify: `packages/rag-core/src/pgvector-store.test.ts`
- Modify: `packages/rag-core/src/pgvector-store.ts`

**Interfaces:**

- Produces: named `MIN_VECTOR_SCORE = 0.25` relevance rule.

- [ ] **Step 1: Add failing below-threshold and positive-control tests**

Configure the fake database row with `embedding_distance: 2`, no token overlap, and current official metadata; assert retrieval returns `[]`. Add controls showing lexical overlap survives and `embedding_distance: 0.7` (`vectorScore: 0.3`) survives without lexical overlap.

- [ ] **Step 2: Run the store tests and verify RED**

Run `pnpm exec vitest run packages/rag-core/src/pgvector-store.test.ts`.

Expected: the zero-relevance row is returned because boosts raise its total score.

- [ ] **Step 3: Implement the post-map relevance filter**

Add:

```ts
const MIN_VECTOR_SCORE = 0.25;

function hasMinimumRetrievalEvidence(chunk: RetrievedChunk): boolean {
  return chunk.lexicalScore > 0 || chunk.vectorScore >= MIN_VECTOR_SCORE;
}
```

Apply it immediately after `mapRow` and before sorting/slicing.

- [ ] **Step 4: Run the store tests and verify GREEN**

Run the Step 2 command and confirm all pgvector tests pass.

### Task 5: Restore ask/stream multi-step parity

**Files:**

- Modify: `packages/agent-core/src/langgraph-customer-runtime.test.ts`
- Modify: `packages/agent-core/src/langgraph-customer-runtime.ts`

**Interfaces:**

- Consumes: existing planner, registry, `plannerNode`, `toolExecutorNode`, `observeNode`, and state reducers.
- Produces: a stream transition loop equivalent to the compiled graph while preserving terminal tool streaming.

- [ ] **Step 1: Add failing parity tests**

Mirror the existing two-module ask test through `.stream()` and reconstruct the answer/citations from events. Assert two search executions and both citation files. Add stream cases for repeated empty input and two distinct empty searches, matching existing ask clarification behavior.

- [ ] **Step 2: Run the runtime test and verify RED**

Run `pnpm exec vitest run packages/agent-core/src/langgraph-customer-runtime.test.ts`.

Expected: stream executes one search and omits the second citation/clarification transition.

- [ ] **Step 3: Extract shared state patch application**

Add a local `applyStatePatch` that mirrors LangGraph reducers by appending `errors`, `evidence`, `toolCalls`, and `toolResults`, while replacing scalar state fields. Cover it through the parity tests rather than exporting a test-only API:

```ts
function applyStatePatch(
  state: LangGraphAgentState,
  patch: Partial<AgentState>,
): LangGraphAgentState {
  return {
    ...state,
    ...patch,
    errors: [...state.errors, ...(patch.errors ?? [])],
    evidence: [...state.evidence, ...(patch.evidence ?? [])],
    toolCalls: [...state.toolCalls, ...(patch.toolCalls ?? [])],
    toolResults: [...state.toolResults, ...(patch.toolResults ?? [])],
    finalResponse: patch.finalResponse ?? state.finalResponse,
    plan: patch.plan ?? state.plan,
    policyDecision: patch.policyDecision ?? state.policyDecision,
    route: patch.route ?? state.route,
  };
}
```

- [ ] **Step 4: Replace the one-step stream implementation**

Loop through planner and search-tool transitions until a final response or terminal `answer_product_question` plan. Execute search tools through the shared executor/observer functions; when the terminal tool exposes `registry.stream`, forward validated events with `product_answer` route:

```ts
let state = createInitialAgentState(request, { maxSteps }) as LangGraphAgentState;
while (state.finalResponse === undefined) {
  state = applyStatePatch(state, await plannerNode(state, options));
  if (state.finalResponse !== undefined || state.plan?.kind === 'final') break;
  if (state.plan?.kind !== 'tool') break;

  if (state.plan.toolName === 'answer_product_question') {
    const toolStream = options.registry.stream(
      state.plan.toolName,
      inputForToolExecution(state.plan, request),
      toolContextFromRequest(request),
    );
    if (toolStream !== undefined) {
      for await (const event of toolStream) {
        yield withStreamAgentRoute(event as ChatStreamEvent, 'product_answer');
      }
      return;
    }
  }

  state = applyStatePatch(state, await toolExecutorNode(state, options.registry));
  state = applyStatePatch(state, observeNode(state));
}
yield *
  streamChatResponse(
    answerComposerNode(state).finalResponse ??
      state.finalResponse ??
      createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
  );
```

Adjust the final composition call to use one local `finalResponse` variable so TypeScript does not rely on the broad `Partial<AgentState>` type. Respect `maxSteps`, repeated inputs, and configuration errors exactly as ask does.

- [ ] **Step 5: Run runtime tests and verify GREEN**

Run the Step 2 command. Expected: ask and stream parity cases pass and existing incremental tool-stream tests still prove `execute` is not used for the terminal streamed answer.

### Task 6: Make full X refresh fail closed

**Files:**

- Modify: `scripts/fetch-usexxyy-posts.test.mjs`
- Modify: `scripts/fetch-usexxyy-posts.mjs`

**Interfaces:**

- Produces: `loadScrapeRuntimeConfig`, traversal completion metadata, `validateFullRefresh`, and `--allow-shrink`.

- [ ] **Step 1: Add failing configuration and coverage tests**

Test that `0`, `NaN`, negative page size, and negative delay throw before fetch. Test `validateFullRefresh` for empty output, a live bottom cursor at the page cap, `79/100` posts without override, and `79/100` with `allowShrink: true`.

- [ ] **Step 2: Run scraper tests and verify RED**

Run `pnpm exec vitest run scripts/fetch-usexxyy-posts.test.mjs`.

Expected: invalid numbers currently produce zero-loop behavior and no completeness validation exists.

- [ ] **Step 3: Implement explicit runtime config and completion result**

Replace module-level numeric constants with:

```js
export function loadScrapeRuntimeConfig(env = process.env) {
  return {
    maxPages: parsePositiveInteger(env.XXYY_X_MAX_PAGES, 100, 'XXYY_X_MAX_PAGES'),
    pageSize: parsePositiveInteger(env.XXYY_X_PAGE_SIZE, 40, 'XXYY_X_PAGE_SIZE'),
    requestDelayMs: parseNonNegativeInteger(
      env.XXYY_X_REQUEST_DELAY_MS,
      250,
      'XXYY_X_REQUEST_DELAY_MS',
    ),
  };
}
```

Return `{ posts, completed, stoppedAtPageCap }` from timeline traversal. Parse `--allow-shrink` only with `--full` and validate before any write.

- [ ] **Step 4: Make authoritative writes individually atomic**

Implement `writeFileAtomically(filePath, contents)` using a sibling temporary file and `rename`, and route JSONL, metadata, and rendered update-index writes through it after validation.

```js
async function writeFileAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, contents, 'utf8');
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
```

- [ ] **Step 5: Run scraper tests and verify GREEN**

Run the Step 2 command and confirm existing extraction/merge tests remain green.

### Task 7: Make knowledge replacement atomic and dimension-aware

**Files:**

- Modify: `packages/rag-core/src/pgvector-store.test.ts`
- Modify: `packages/rag-core/src/pgvector-store.ts`
- Modify: `apps/cli/src/index.test.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `README.md`
- Modify: `docs/production-readiness.md`

**Interfaces:**

- Changes: `replaceChunks(chunks, ingestionRun, options?)` owns audit recording.
- Adds: `migrate({ allowEmbeddingDimensionMismatch?: boolean })` and explicit CLI `ingest --rebuild-embedding-schema`.

- [ ] **Step 1: Add failing transaction tests**

Use a fake pool whose `connect()` returns a recording transaction client. Assert the query sequence contains `begin`, upserts, prune, ingestion insert, `commit`, and `release`. Make one upsert and one ingestion insert fail in separate tests; assert `rollback` occurs and `commit` does not.

- [ ] **Step 2: Add failing dimension tests**

Make the schema inspection return `vector(1536)` while the store is configured for `3072`; assert ordinary `migrate()` rejects with `VectorStoreConfigurationError` mentioning `--rebuild-embedding-schema`. Add a CLI parse test for `ingest --rebuild-embedding-schema`.

- [ ] **Step 3: Run store and CLI tests and verify RED**

Run:

```bash
pnpm exec vitest run packages/rag-core/src/pgvector-store.test.ts apps/cli/src/index.test.ts
```

Expected: replace operations use the pool directly without transaction ownership, dimension mismatch is not detected, and the CLI option is rejected.

- [ ] **Step 4: Implement transaction ownership and audit inclusion**

Extend the client type with optional `connect`, create `withTransaction`, move chunk upsert to accept an explicit client, and make `replaceChunks` record the ingestion run inside the same transaction:

```ts
interface PgTransactionClientLike extends PgClientLike {
  release(): void;
}

async function withTransaction<T>(
  pool: PgClientLike & { connect?: () => Promise<PgTransactionClientLike> },
  operation: (client: PgClientLike) => Promise<T>,
): Promise<T> {
  if (pool.connect === undefined) {
    throw new VectorStoreConfigurationError('Atomic knowledge replacement requires a pg Pool.');
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const value = await operation(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
```

Update full ingest to call only the atomic replacement; incremental sync continues to use `upsertChunks` and its separate incremental audit record.

- [ ] **Step 5: Implement dimension inspection and explicit rebuild**

Query `format_type` for `knowledge_chunks.embedding`. Ordinary migration throws on mismatch. Rebuild ingest calls migration with mismatch allowed, embeds all chunks, then runs transactional SQL that truncates knowledge rows, drops the vector index, recreates the embedding column at the configured dimension, recreates the index, inserts all chunks, and records the ingestion run before commit:

```sql
truncate table knowledge_chunks;
drop index if exists knowledge_chunks_embedding_idx;
alter table knowledge_chunks drop column embedding;
alter table knowledge_chunks add column embedding vector(3072) not null;
create index knowledge_chunks_embedding_idx
  on knowledge_chunks using ivfflat (embedding vector_cosine_ops);
```

Generate the dimension token from the already validated positive integer; do not accept raw SQL input.

- [ ] **Step 6: Update operator documentation**

Document the exact command:

```bash
pnpm rag:ingest -- --rebuild-embedding-schema
```

State that it is required only for intentional embedding-dimension changes and that ordinary migrate is non-destructive.

- [ ] **Step 7: Run store and CLI tests and verify GREEN**

Run the Step 3 command and confirm transaction, rollback, dimension, and CLI parsing tests pass.

### Task 8: Build Web assets and add in-memory Web authentication

**Files:**

- Create: `apps/web/src/api-auth.ts`
- Create: `apps/web/src/api-auth.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/ai-service-check.ts`
- Modify: `apps/web/src/ai-service-check.test.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `scripts/start-agent.mjs`
- Modify: `scripts/start-agent.test.mjs`
- Modify: `package.json`
- Modify: `scripts/check-script.test.mjs`
- Modify: `README.md`

**Interfaces:**

- Produces: `createApiHeaders(token?: string)` and optional `authToken` parameter for `checkAiService`.
- Changes: app start plan includes `pnpm --filter @xxyy/web build` before API start.

- [ ] **Step 1: Add failing header-helper tests**

Create `api-auth.test.ts` asserting empty input returns only JSON content type and trimmed input adds `Authorization: Bearer <token>`. Update AI-service-check tests to assert the header is forwarded.

- [ ] **Step 2: Add a failing startup-plan test**

Assert `runAgentStart` invokes `build Web` after knowledge preparation and before `start API and Web`. Update `check-script.test.mjs` to require `@xxyy/web build` in the root check command.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
pnpm exec vitest run apps/web/src scripts/start-agent.test.mjs scripts/check-script.test.mjs
```

Expected: helper/module is missing, AI check cannot accept a token, and startup/check omit the Web build.

- [ ] **Step 4: Implement request headers and token UI**

Add:

```ts
export function createApiHeaders(token?: string): Record<string, string> {
  const normalized = token?.trim();
  return {
    'Content-Type': 'application/json',
    ...(normalized === undefined || normalized.length === 0
      ? {}
      : { Authorization: `Bearer ${normalized}` }),
  };
}
```

Keep `authToken` in `useState('')`, render a password input labelled `API token`, pass it to chat and AI checks, and never use storage APIs for it.

- [ ] **Step 5: Implement build integration**

Add a `buildWeb` command to `start-agent.mjs`, run it before `startService`, and prepend `pnpm --filter @xxyy/web build` to the root `check` script.

```js
buildWeb: {
  args: ['--filter', '@xxyy/web', 'build'],
  command: 'pnpm',
  label: 'build Web',
},
```

After knowledge preparation succeeds, call `runLoggedCommand` for `COMMANDS.buildWeb`; only start the API when that exit code is zero.

- [ ] **Step 6: Run focused tests and production build**

Run:

```bash
pnpm exec vitest run apps/web/src scripts/start-agent.test.mjs scripts/check-script.test.mjs
pnpm --filter @xxyy/web build
```

Expected: tests and build pass, and the generated bundle contains no configured API token.

### Task 9: Isolate Telegram failures and keep long messages valid

**Files:**

- Modify: `apps/telegram-bot/src/bot.test.ts`
- Modify: `apps/telegram-bot/src/bot.ts`

**Interfaces:**

- Preserves: short-message Telegram HTML formatting.
- Changes: oversized responses use plain-text chunks; per-update failures are logged and skipped.

- [ ] **Step 1: Add failing poison-update test**

Return two updates, make the first handling call throw permanently, and assert the second update is still handled, the error logger is called once, and the next `getUpdates` receives the second update's successor offset.

- [ ] **Step 2: Add failing long-format test**

Create an answer containing more than 4096 characters inside bold Markdown. Assert every sent message is at most 4096 characters and either has no `parseMode` or contains balanced `<b>...</b>` markup.

- [ ] **Step 3: Run bot tests and verify RED**

Run `pnpm exec vitest run apps/telegram-bot/src/bot.test.ts`.

Expected: the first error aborts polling and current chunks split an HTML closing tag.

- [ ] **Step 4: Implement per-update isolation**

Wrap each `handleUpdate` in its own `try/catch/finally`, log through `options.logger?.error`, and advance `offset` in `finally`. Leave `getUpdates` failures to the outer polling retry loop:

```ts
for (const update of updates) {
  try {
    await handleUpdate(update);
  } catch (error) {
    options.logger?.error(`Telegram update ${update.update_id} failed.`, error);
  } finally {
    offset = update.update_id + 1;
  }
}
```

- [ ] **Step 5: Implement the oversized plain-text fallback**

Keep existing HTML formatting only when the complete formatted message fits the limit. Otherwise format a plain-text answer/citation representation and send `splitTelegramMessage` chunks without `parseMode`:

```ts
const htmlMessage = formatTelegramChatResponse(response, attachmentLines);
if (htmlMessage.length <= TELEGRAM_MESSAGE_LIMIT) {
  await api.sendMessage({ chatId, parseMode: 'HTML', text: htmlMessage });
} else {
  const plainText = formatTelegramPlainTextResponse(response, attachmentLines);
  for (const chunk of splitTelegramMessage(plainText, TELEGRAM_MESSAGE_LIMIT)) {
    await api.sendMessage({ chatId, text: chunk });
  }
}
```

- [ ] **Step 6: Run bot tests and verify GREEN**

Run the Step 3 command and confirm all Telegram tests pass.

### Task 10: Final integration, docs, and release gate

**Files:**

- Modify only files required by failures discovered in this task.
- Verify: all files changed by Tasks 1-9.

**Interfaces:**

- Produces: a repository-wide verified hardening patch with no new public contract regressions.

- [ ] **Step 1: Run targeted subsystem suites**

Run:

```bash
pnpm exec vitest run apps/api/src apps/web/src apps/telegram-bot/src packages/knowledge/src packages/rag-core/src packages/agent-core/src scripts
```

Expected: all targeted tests pass without unhandled rejections or warnings.

- [ ] **Step 2: Run boundary commands without infrastructure**

Run:

```bash
env -u DATABASE_URL -u POSTGRES_DB -u POSTGRES_USER -u POSTGRES_PASSWORD -u OPENAI_API_KEY -u OPENAI_MODEL pnpm rag:ask -- "帮我查一下钱包余额"
env -u DATABASE_URL -u POSTGRES_DB -u POSTGRES_USER -u POSTGRES_PASSWORD -u OPENAI_API_KEY -u OPENAI_MODEL pnpm rag:ask -- "分析这个 tx hash 有没有 MEV sandwich"
```

Expected: both return deterministic boundary responses without configuration failures.

- [ ] **Step 3: Run the production Web build**

Run `pnpm --filter @xxyy/web build`. Expected: Vite exits `0` and emits `dist/web-assets/index.js` and `index.css`.

- [ ] **Step 4: Run the complete repository gate**

Run `pnpm check`. Expected: lint, format check, typecheck, all Vitest files, Web build, and deterministic golden QA pass.

- [ ] **Step 5: Inspect final scope and preserve user ownership**

Run:

```bash
git diff --check
git status --short --branch
git diff --stat
```

Confirm every changed line traces to the approved design, no ignored transaction report is staged, and the user's pre-existing RAG/Agent changes remain present. Do not stage or commit implementation files without explicit user instruction.
