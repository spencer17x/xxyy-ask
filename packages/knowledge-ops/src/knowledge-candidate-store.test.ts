import { describe, expect, it } from 'vitest';

import { createInMemoryKnowledgeCandidateStore } from './knowledge-candidate-store.js';
import type { KnowledgeCandidate } from './types.js';

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    confidence: 0.8,
    createdAt: '2026-06-17T02:00:00.000Z',
    existingKnowledgeMatches: [],
    generatedEvalCases: [
      {
        expectedAnswer: '在钱包监控里配置 Telegram Bot。',
        question: 'Telegram 通知怎么设置？',
      },
    ],
    id: 'candidate_1',
    proposedAnswer: '在钱包监控里配置 Telegram Bot。',
    question: 'Telegram 通知怎么设置？',
    redactionReport: {
      entities: [],
      riskFlags: [],
      riskLevel: 'low',
    },
    riskLevel: 'low',
    sourceRefs: [{ source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '10' }],
    status: 'needs_review',
    targetCategory: 'product_faq',
    type: 'faq',
    updatedAt: '2026-06-17T02:00:00.000Z',
    ...overrides,
  };
}

describe('createInMemoryKnowledgeCandidateStore', () => {
  it('stores candidates and lists them by review status', async () => {
    const store = createInMemoryKnowledgeCandidateStore();
    await store.addCandidates([candidate(), candidate({ id: 'candidate_2', status: 'draft' })]);

    await expect(store.listCandidates({ status: 'needs_review' })).resolves.toEqual([candidate()]);
  });

  it('records human review decisions without publishing approved candidates', async () => {
    const store = createInMemoryKnowledgeCandidateStore();
    await store.addCandidates([candidate()]);

    const reviewed = await store.reviewCandidate('candidate_1', {
      action: 'approve',
      notes: '内容可用，等待发布流程处理。',
      reviewedAt: '2026-06-17T03:00:00.000Z',
      reviewer: 'ops@example.com',
    });

    expect(reviewed.publishedTarget).toBeUndefined();
    expect(reviewed).toMatchObject({
      reviewNotes: '内容可用，等待发布流程处理。',
      reviewer: 'ops@example.com',
      status: 'approved',
      updatedAt: '2026-06-17T03:00:00.000Z',
    });
  });

  it('moves request-changes decisions back to draft and rejects unknown candidates', async () => {
    const store = createInMemoryKnowledgeCandidateStore();
    await store.addCandidates([candidate()]);

    await expect(
      store.reviewCandidate('candidate_1', {
        action: 'request_changes',
        reviewedAt: '2026-06-17T03:00:00.000Z',
        reviewer: 'ops@example.com',
      }),
    ).resolves.toMatchObject({ status: 'draft' });

    await expect(
      store.reviewCandidate('missing', {
        action: 'reject',
        reviewedAt: '2026-06-17T03:00:00.000Z',
        reviewer: 'ops@example.com',
      }),
    ).rejects.toThrow('Knowledge candidate not found: missing');
  });
});
