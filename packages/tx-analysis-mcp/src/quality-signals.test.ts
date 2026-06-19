import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeCandidateStore } from '@xxyy/knowledge-ops';

import { createTxAnalysisMcpQualitySignalRuntime } from './quality-signals.js';

describe('tx analysis MCP quality signal runtime', () => {
  it('captures recorded quality signals and waits for them before closing', async () => {
    const events: string[] = [];
    const signal = {
      answer: 'Transaction analysis provider is not configured.',
      channel: 'agent',
      errorCode: 'not_configured',
      intent: 'tx_sandwich_detection',
      reason: 'tx_analysis_failure',
      redactedQuestion: 'base [evm_tx_hash]',
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
    const runtime = createTxAnalysisMcpQualitySignalRuntime({
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
