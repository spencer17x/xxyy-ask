import { describe, expect, it, vi } from 'vitest';

import { createKnowledgeOpsToolHandlers } from './tools.js';

describe('knowledge ops MCP tool handlers', () => {
  it('lists candidates through configured knowledge operations', async () => {
    const listCandidates = vi.fn(() =>
      Promise.resolve([
        {
          confidence: 0.82,
          createdAt: '2026-06-17T02:00:00.000Z',
          existingKnowledgeMatches: [],
          generatedEvalCases: [],
          id: 'kc_telegram_setup',
          proposedAnswer: '在钱包监控里配置 Telegram Bot。',
          question: 'Telegram 通知怎么设置？',
          redactionReport: { entities: [], riskFlags: [], riskLevel: 'low' },
          riskLevel: 'low' as const,
          sourceRefs: [],
          status: 'needs_review' as const,
          targetCategory: 'product_faq' as const,
          type: 'faq' as const,
          updatedAt: '2026-06-17T02:00:00.000Z',
        },
      ]),
    );
    const handlers = createKnowledgeOpsToolHandlers({
      listCandidates,
      publishKnowledgeCandidate() {
        throw new Error('publishKnowledgeCandidate should not be called');
      },
      reviewCandidate() {
        throw new Error('reviewCandidate should not be called');
      },
      runKnowledgeGate() {
        throw new Error('runKnowledgeGate should not be called');
      },
      syncTelegramSupport() {
        throw new Error('syncTelegramSupport should not be called');
      },
    });

    await expect(
      handlers.listKnowledgeCandidates({
        limit: 5,
        status: 'needs_review',
      }),
    ).resolves.toMatchObject({
      candidates: [{ id: 'kc_telegram_setup', status: 'needs_review' }],
      count: 1,
    });
    expect(listCandidates).toHaveBeenCalledWith({ limit: 5, status: 'needs_review' });
  });

  it('publishes candidates and runs the knowledge gate through configured operations', async () => {
    const publishKnowledgeCandidate = vi.fn(() =>
      Promise.resolve({
        candidateId: 'kc_telegram_setup',
        publishedTarget: 'pages/65-reviewed-support-knowledge.md#kc_telegram_setup',
        publishRunId: 'publish_20260617T050000Z_abcd1234',
      }),
    );
    const runKnowledgeGate = vi.fn((input: { approvedEvalOnly?: boolean; id?: string }) =>
      Promise.resolve(
        input.approvedEvalOnly === true
          ? {
              approvedEvalOnly: true,
              exitCode: 0,
              status: 'passed' as const,
              stdout: 'Approved eval knowledge gate passed: 2/2 candidates passed.',
            }
          : {
              candidateId: input.id ?? 'kc_telegram_setup',
              evaluation: { passed: 1, total: 1 },
              status: 'passed' as const,
            },
      ),
    );
    const handlers = createKnowledgeOpsToolHandlers({
      listCandidates() {
        throw new Error('listCandidates should not be called');
      },
      publishKnowledgeCandidate,
      reviewCandidate() {
        throw new Error('reviewCandidate should not be called');
      },
      runKnowledgeGate,
      syncTelegramSupport() {
        throw new Error('syncTelegramSupport should not be called');
      },
    });

    await expect(
      handlers.publishKnowledgeCandidate({
        id: 'kc_telegram_setup',
        target: 'pages/support-faq.md',
      }),
    ).resolves.toMatchObject({
      candidateId: 'kc_telegram_setup',
      publishRunId: 'publish_20260617T050000Z_abcd1234',
    });
    await expect(
      handlers.runKnowledgeGate({
        fast: true,
        id: 'kc_telegram_setup',
      }),
    ).resolves.toMatchObject({
      candidateId: 'kc_telegram_setup',
      status: 'passed',
    });
    await expect(
      handlers.runKnowledgeGate({
        approvedEvalOnly: true,
        fast: true,
      }),
    ).resolves.toMatchObject({
      approvedEvalOnly: true,
      status: 'passed',
      stdout: 'Approved eval knowledge gate passed: 2/2 candidates passed.',
    });
    expect(publishKnowledgeCandidate).toHaveBeenCalledWith({
      id: 'kc_telegram_setup',
      target: 'pages/support-faq.md',
    });
    expect(runKnowledgeGate).toHaveBeenNthCalledWith(1, {
      fast: true,
      id: 'kc_telegram_setup',
    });
    expect(runKnowledgeGate).toHaveBeenNthCalledWith(2, {
      approvedEvalOnly: true,
      fast: true,
    });
  });
});
