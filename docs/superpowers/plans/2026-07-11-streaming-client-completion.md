# Web and Telegram Streaming Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete production Telegram draft streaming, clear stale Web processing metadata on answer deltas, and restore a clean workspace typecheck.

**Architecture:** Keep the existing shared stream contract and bot orchestration unchanged. Extend only the production Telegram transport, centralize the Web answer-delta message transition in a small pure helper owned by `App.tsx`, and remove the answer-provider helper made obsolete by the prior streaming refactor.

**Tech Stack:** TypeScript ESM, React 19, Node `fetch`, Telegram Bot API, Vitest, pnpm workspace

---

## File Map

- Modify `apps/telegram-bot/src/telegram-api.test.ts`: regression coverage for the production `sendMessageDraft` request.
- Modify `apps/telegram-bot/src/telegram-api.ts`: production Telegram transport implementation and method typing.
- Create `apps/web/src/App.test.ts`: focused Web message-state regression test without adding a DOM test dependency.
- Modify `apps/web/src/App.tsx`: pure answer-delta transition and its use in the stream callback.
- Modify `packages/rag-core/src/openai-answer-provider.ts`: remove the obsolete unused iterator helper.

### Task 1: Connect Telegram Draft Streaming to the Production Client

**Files:**

- Modify: `apps/telegram-bot/src/telegram-api.test.ts:42-96`
- Modify: `apps/telegram-bot/src/telegram-api.ts:1-105`

- [ ] **Step 1: Replace the negative production-client assertion with a draft request regression test**

In the existing `sends messages, typing actions, and photos through Bot API methods` test, replace `expect(api).not.toHaveProperty('sendMessageDraft')` with:

```ts
if (api.sendMessageDraft === undefined) {
  throw new Error('Expected sendMessageDraft to be implemented.');
}
await api.sendMessageDraft({ chatId: -100, draftId: 7, text: 'partial answer' });
```

Change the photo expectation from call 3 to call 4 and insert this call-3 expectation:

```ts
expect(fetch).toHaveBeenNthCalledWith(3, 'https://telegram.test/bot123:abc/sendMessageDraft', {
  body: JSON.stringify({ chat_id: -100, draft_id: 7, text: 'partial answer' }),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
});
```

- [ ] **Step 2: Run the Telegram API test and verify RED**

Run:

```bash
pnpm exec vitest run apps/telegram-bot/src/telegram-api.test.ts
```

Expected: FAIL with `Expected sendMessageDraft to be implemented.` because the production client does not expose the method.

- [ ] **Step 3: Implement the minimal Telegram API method**

Import `TelegramSendMessageDraftInput` from `./bot.js`. Add this property between `sendMessage` and `sendPhoto` in the returned API object:

```ts
sendMessageDraft(input) {
  return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'sendMessageDraft', {
    chat_id: input.chatId,
    draft_id: input.draftId,
    text: input.text,
  }).then(() => undefined);
},
```

Extend the `method` union with `'sendMessageDraft'` and the payload union with:

```ts
| Record<keyof TelegramSendMessageDraftInput, unknown>
```

- [ ] **Step 4: Run the production transport and bot streaming tests and verify GREEN**

Run:

```bash
pnpm exec vitest run apps/telegram-bot/src/telegram-api.test.ts apps/telegram-bot/src/bot.test.ts
```

Expected: both files pass, including the existing progressive-draft, final-delivery, and draft-failure fallback cases.

- [ ] **Step 5: Commit the Telegram production wiring**

```bash
git add apps/telegram-bot/src/telegram-api.ts apps/telegram-bot/src/telegram-api.test.ts
git commit -m "fix: enable production telegram draft streaming"
```

### Task 2: Clear Stale Web Status Metadata on the First Answer Delta

**Files:**

- Create: `apps/web/src/App.test.ts`
- Modify: `apps/web/src/App.tsx:97-108`

- [ ] **Step 1: Add a failing pure state-transition regression test**

Create `apps/web/src/App.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './types.js';
import * as appModule from './App.js';

type AppendAnswerDelta = (message: ChatMessage, delta: string) => ChatMessage;

describe('appendAssistantAnswerDelta', () => {
  it('removes transient status metadata while appending streamed text', () => {
    const appendAssistantAnswerDelta = (
      appModule as typeof appModule & { appendAssistantAnswerDelta?: AppendAnswerDelta }
    ).appendAssistantAnswerDelta;
    expect(appendAssistantAnswerDelta).toBeTypeOf('function');
    if (appendAssistantAnswerDelta === undefined) {
      throw new Error('Expected appendAssistantAnswerDelta to be implemented.');
    }

    const message: ChatMessage = {
      attachments: [],
      citations: [],
      id: 'assistant-1',
      meta: '正在分析问题…',
      rawAnswer: '第一段',
      role: 'assistant',
      status: 'streaming',
      statusMessage: '正在分析问题…',
      text: '第一段',
    };

    expect(appendAssistantAnswerDelta(message, '第二段')).toEqual({
      attachments: [],
      citations: [],
      id: 'assistant-1',
      rawAnswer: '第一段第二段',
      role: 'assistant',
      status: 'streaming',
      text: '第一段第二段',
    });
  });
});
```

- [ ] **Step 2: Run the Web regression test and verify RED**

Run:

```bash
pnpm exec vitest run apps/web/src/App.test.ts
```

Expected: FAIL because `appendAssistantAnswerDelta` is undefined.

- [ ] **Step 3: Add and use the minimal pure transition**

Add this exported helper after the constants in `App.tsx`:

```ts
export function appendAssistantAnswerDelta(message: ChatMessage, delta: string): ChatMessage {
  const { meta: _meta, statusMessage: _statusMessage, ...rest } = message;
  return {
    ...rest,
    rawAnswer: message.rawAnswer + delta,
    text: message.text + delta,
  };
}
```

Replace the inline updater in the `answer_delta` branch with:

```ts
updateAssistantMessage(assistantId, (message) => appendAssistantAnswerDelta(message, delta));
```

- [ ] **Step 4: Run Web tests, typecheck, and build and verify GREEN**

Run:

```bash
pnpm --filter @xxyy/web test
pnpm --filter @xxyy/web typecheck
pnpm --filter @xxyy/web build
```

Expected: all commands exit 0 and the new regression test passes.

- [ ] **Step 5: Commit the Web state fix**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.ts
git commit -m "fix: clear stale web stream status"
```

### Task 3: Restore Workspace Typecheck

**Files:**

- Modify: `packages/rag-core/src/openai-answer-provider.ts:464-469`

- [ ] **Step 1: Reproduce the existing unused-local failure**

Run:

```bash
pnpm --filter @xxyy/rag-core typecheck
```

Expected: FAIL with `TS6133: 'toAsyncIterable' is declared but its value is never read.`

- [ ] **Step 2: Remove only the obsolete helper**

Delete:

```ts
async function* toAsyncIterable<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}
```

- [ ] **Step 3: Verify the package typecheck and answer-provider tests**

Run:

```bash
pnpm --filter @xxyy/rag-core typecheck
pnpm exec vitest run packages/rag-core/src/openai-answer-provider.test.ts
```

Expected: both commands exit 0.

- [ ] **Step 4: Commit the typecheck cleanup**

```bash
git add packages/rag-core/src/openai-answer-provider.ts
git commit -m "fix: remove obsolete answer stream helper"
```

### Task 4: Full Verification and Manual Web Interaction

**Files:**

- No production files

- [ ] **Step 1: Run the complete repository quality gate**

Run:

```bash
pnpm check
```

Expected: Web build, lint, formatting, workspace typecheck, Vitest, and deterministic golden QA all exit 0.

- [ ] **Step 2: Verify the slow Web stream in a real browser**

Start a temporary local server from the built Web assets that serves three SSE frames with visible delays. Open it in the in-app browser, submit one prompt, and capture three states: processing status, intermediate partial answer, and final answer with metadata.

Expected observations:

- The intermediate answer appears before the final frame.
- The partial-answer bubble no longer displays `正在分析问题…` as its metadata.
- The final answer displays intent/confidence metadata.
- Browser console error and warning filters return no entries.

- [ ] **Step 3: Inspect final repository state**

Run:

```bash
git status --short --branch
git log -5 --oneline
```

Expected: no unstaged or untracked implementation files; the branch contains the design, plan, and three focused fix commits.
