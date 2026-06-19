import { describe, expect, it, vi } from 'vitest';

import { captureAnswerQualitySignals } from './quality-signal-capture.js';
import type { KnowledgeCandidateStore } from './knowledge-candidate-store.js';

const now = '2026-06-19T09:00:00.000Z';

describe('captureAnswerQualitySignals', () => {
  it('mines answer quality signals and stores the generated needs-review candidates', async () => {
    const storedCandidates: unknown[] = [];
    const addCandidates = vi.fn((candidates: unknown[]) => {
      storedCandidates.push(...candidates);
      return Promise.resolve(candidates);
    });
    const store = { addCandidates } as unknown as KnowledgeCandidateStore;

    const result = await captureAnswerQualitySignals({
      now,
      signals: [
        {
          answer:
            '当前知识库没有足够资料确认这个问题。为了避免误导，我不会编造产品细节；请补充更具体的功能、权益或配置步骤，或稍后在知识库更新后再问。',
          channel: 'web',
          citationCount: 0,
          confidence: 0.2,
          intent: 'product_qa',
          reason: 'low_confidence_missing_citations',
          redactedQuestion: 'XXYY Pro 价格是多少？',
          sessionIdPresent: true,
          userIdPresent: false,
        },
      ],
      store,
    });

    expect(result).toMatchObject({
      candidatesCreated: 1,
      signalsRead: 1,
      signalsSkipped: 0,
    });
    expect(result.storedCandidates).toHaveLength(1);
    expect(result.storedCandidates[0]).toMatchObject({
      createdAt: now,
      question: 'XXYY Pro 价格是多少？',
      status: 'needs_review',
      targetCategory: 'eval_case',
      type: 'eval_case',
    });
    expect(addCandidates).toHaveBeenCalledWith(result.candidates);
    expect(storedCandidates).toEqual(result.storedCandidates);
  });

  it('skips store writes when quality signals do not produce candidates', async () => {
    const addCandidates = vi.fn(() => Promise.resolve([]));
    const store = { addCandidates } as unknown as KnowledgeCandidateStore;

    const result = await captureAnswerQualitySignals({
      now,
      signals: [
        {
          channel: 'web',
          confidence: 0.2,
          intent: 'unknown',
          reason: 'unknown_intent',
          redactedQuestion: '   ',
          sessionIdPresent: false,
          userIdPresent: false,
        },
      ],
      store,
    });

    expect(result).toEqual({
      candidates: [],
      candidatesCreated: 0,
      signalsRead: 1,
      signalsSkipped: 1,
      storedCandidates: [],
    });
    expect(addCandidates).not.toHaveBeenCalled();
  });
});
