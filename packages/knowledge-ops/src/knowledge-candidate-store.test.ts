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
    await expect(store.getCandidate('candidate_1')).resolves.toEqual(candidate());
    await expect(store.getCandidate('missing')).resolves.toBeUndefined();
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

  it('marks only approved candidates as published', async () => {
    const store = createInMemoryKnowledgeCandidateStore();
    await store.addCandidates([
      candidate({ status: 'approved' }),
      candidate({ id: 'candidate_2', status: 'needs_review' }),
    ]);

    const published = await store.markCandidatePublished('candidate_1', {
      publishedAt: '2026-06-17T05:00:00.000Z',
      publishedTarget: 'pages/65-reviewed-support-knowledge.md#candidate_1',
    });

    expect(published).toMatchObject({
      publishedTarget: 'pages/65-reviewed-support-knowledge.md#candidate_1',
      status: 'published',
      updatedAt: '2026-06-17T05:00:00.000Z',
    });
    await expect(
      store.markCandidatePublished('candidate_2', {
        publishedAt: '2026-06-17T05:00:00.000Z',
        publishedTarget: 'pages/65-reviewed-support-knowledge.md#candidate_2',
      }),
    ).rejects.toThrow(
      'Knowledge candidate candidate_2 must be approved before publishing; current status is needs_review.',
    );
    await expect(
      store.markCandidatePublished('missing', {
        publishedAt: '2026-06-17T05:00:00.000Z',
        publishedTarget: 'pages/65-reviewed-support-knowledge.md#missing',
      }),
    ).rejects.toThrow('Knowledge candidate not found: missing');
  });

  it('moves published candidates through ingest and eval gate statuses', async () => {
    const store = createInMemoryKnowledgeCandidateStore();
    await store.addCandidates([
      candidate({ status: 'published' }),
      candidate({ id: 'candidate_2', status: 'approved' }),
    ]);

    const ingested = await store.markCandidateIngested('candidate_1', {
      ingestedAt: '2026-06-17T06:00:00.000Z',
    });

    expect(ingested).toMatchObject({
      status: 'ingested',
      updatedAt: '2026-06-17T06:00:00.000Z',
    });

    const evaluated = await store.markCandidateEvalResult('candidate_1', {
      evaluatedAt: '2026-06-17T06:10:00.000Z',
      passed: true,
    });

    expect(evaluated).toMatchObject({
      status: 'eval_passed',
      updatedAt: '2026-06-17T06:10:00.000Z',
    });
    await expect(
      store.markCandidateIngested('candidate_2', {
        ingestedAt: '2026-06-17T06:00:00.000Z',
      }),
    ).rejects.toThrow(
      'Knowledge candidate candidate_2 cannot be marked ingested from approved; expected status is published.',
    );
    await expect(
      store.markCandidateEvalResult('missing', {
        evaluatedAt: '2026-06-17T06:10:00.000Z',
        passed: false,
      }),
    ).rejects.toThrow('Knowledge candidate not found: missing');
  });
});
