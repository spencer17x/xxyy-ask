import { describe, expect, it } from 'vitest';

import { createInMemoryQualitySignalSink, createNoopQualitySignalSink } from './quality-signals.js';

describe('quality signals', () => {
  it('records structured quality signals without requiring user identity', () => {
    const sink = createInMemoryQualitySignalSink();

    sink.record({
      agentRoute: 'product_answer',
      channel: 'web',
      citationCount: 0,
      confidence: 0.2,
      intent: 'product_qa',
      reason: 'missing_citations',
      redactedQuestion: 'XXYY Pro price?',
      sessionIdPresent: true,
      userIdPresent: false,
    });

    expect(sink.signals()).toEqual([
      {
        agentRoute: 'product_answer',
        channel: 'web',
        citationCount: 0,
        confidence: 0.2,
        intent: 'product_qa',
        reason: 'missing_citations',
        redactedQuestion: 'XXYY Pro price?',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('provides a noop sink for default runtime use', () => {
    const sink = createNoopQualitySignalSink();
    sink.record({
      channel: 'cli',
      intent: 'unknown',
      reason: 'unknown_intent',
      redactedQuestion: '???',
      sessionIdPresent: false,
      userIdPresent: false,
    });

    expect('signals' in sink).toBe(false);
  });
});
