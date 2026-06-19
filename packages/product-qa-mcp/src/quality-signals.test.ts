import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeCandidateStore } from '@xxyy/knowledge-ops';

import { createProductQaMcpQualitySignalRuntime } from './quality-signals.js';

describe('product QA MCP quality signal runtime', () => {
  it('captures recorded quality signals and waits for them before closing', async () => {
    const events: string[] = [];
    const signal = {
      answer: '当前知识库没有足够资料确认这个问题。',
      channel: 'agent',
      citationCount: 0,
      confidence: 0.2,
      intent: 'product_qa',
      reason: 'missing_citations',
      redactedQuestion: 'XXYY Pro 价格是多少？',
      sessionIdPresent: false,
      userIdPresent: false,
    } as const;
    const store = {
      addCandidates: vi.fn(() => Promise.resolve([])),
    } as unknown as KnowledgeCandidateStore;
    const captureAnswerQualitySignals = vi.fn(
      async (input: { getStore?: () => unknown; signals: readonly unknown[] }) => {
        events.push('capture:start');
        expect(input.signals).toEqual([signal]);
        expect(input.getStore?.()).toBe(store);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        events.push('capture:done');
        return {
          candidates: [],
          candidatesCreated: 0,
          signalsRead: 1,
          signalsSkipped: 1,
          storedCandidates: [],
        };
      },
    );
    const runtime = createProductQaMcpQualitySignalRuntime({
      captureAnswerQualitySignals,
      getStore: () => store,
    });

    runtime.sink.record(signal);
    await runtime.close();
    events.push('closed');

    expect(events).toEqual(['capture:start', 'capture:done', 'closed']);
    expect(captureAnswerQualitySignals).toHaveBeenCalledTimes(1);
  });
});
