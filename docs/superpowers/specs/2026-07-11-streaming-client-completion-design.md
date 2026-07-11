# Web and Telegram Streaming Completion Design

**Date:** 2026-07-11

## Goal

Complete the existing progressive-answer interaction on both supported clients without changing the shared chat contract or Agent runtime behavior.

## Confirmed Root Causes

- The Web client removes `statusMessage` when the first answer delta arrives but leaves the same text in `meta`, so the bubble can show stale analysis status beside a progressing answer.
- The Telegram bot contains a private-chat streaming path that calls `sendMessageDraft`, but the production Telegram API client does not expose that method. Production therefore fails the streaming capability check and falls back to the non-streaming `ask` path.
- `toAsyncIterable` became unused after the answer-provider streaming refactor and now fails the workspace TypeScript unused-local check.

## Design

### Web

When an `answer_delta` arrives, remove both transient status fields from the assistant message before appending the delta. Final metadata continues to replace `meta` with intent and confidence. No component, protocol, or visual-layout changes are required.

### Telegram

Add `sendMessageDraft` to the production Telegram API client using the existing `callTelegramMethod` transport and request naming conventions:

- API method: `sendMessageDraft`
- Payload: `chat_id`, `draft_id`, and `text`
- Scope: the existing private-chat streaming branch only

The bot keeps the current resilience behavior: if a draft update fails, it stops attempting further draft updates for that response and still sends the complete persistent message through `sendMessage`. Non-private chats and clients without draft support continue to use the existing non-streaming fallback.

### Typecheck cleanup

Delete the unused `toAsyncIterable` helper. No replacement abstraction is needed because the current streaming implementation no longer consumes it.

## Testing Strategy

Each behavior change starts with a focused regression test:

1. Web stream handling demonstrates that the first answer delta removes stale analysis metadata while appending text.
2. The production Telegram API client demonstrates that `sendMessageDraft` calls the correct Bot API method with the expected payload.
3. Existing Telegram bot streaming tests continue to prove progressive draft updates, final persistent delivery, and fallback behavior.

After targeted red-green cycles, run the relevant Web, Telegram, and answer-provider tests, then the full `pnpm check`. Rebuild and manually exercise the Web client with a deliberately slow SSE response to verify observable progressive rendering and absence of browser console errors.

## Success Criteria

- The production Telegram client exposes and correctly sends `sendMessageDraft` requests.
- Private Telegram chats use the existing progressive draft path when the chat service supports streaming.
- Web answer deltas do not retain stale processing metadata.
- Workspace typecheck no longer reports the unused `toAsyncIterable` helper.
- Targeted tests and `pnpm check` pass.
- A manual slow-stream Web test visibly renders an intermediate partial answer before completion.
