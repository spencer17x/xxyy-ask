import { describe, expect, it, vi } from 'vitest';

import { createToolRegistry } from '../tool-registry.js';
import {
  KNOWLEDGE_OPS_TOOL_NAMES,
  createKnowledgeOpsTools,
  listKnowledgeCandidatesInputSchema,
  reviewKnowledgeCandidateInputSchema,
  runKnowledgeGateInputSchema,
} from './knowledge-ops-tools.js';

describe('createKnowledgeOpsTools', () => {
  it('exports knowledge operations tool names in registration order', () => {
    expect(KNOWLEDGE_OPS_TOOL_NAMES).toEqual([
      'list_knowledge_candidates',
      'review_knowledge_candidate',
      'publish_knowledge_candidate',
      'run_knowledge_gate',
      'sync_telegram_support',
    ]);
  });

  it('registers list_knowledge_candidates and forwards review queue filters', async () => {
    const registry = createToolRegistry();
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

    for (const tool of createKnowledgeOpsTools({
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
    })) {
      registry.register(tool);
    }

    await expect(
      registry.execute('list_knowledge_candidates', {
        limit: 5,
        riskLevel: 'low',
        status: 'needs_review',
        type: 'faq',
      }),
    ).resolves.toMatchObject({
      candidates: [{ id: 'kc_telegram_setup', status: 'needs_review' }],
      count: 1,
    });
    expect(listCandidates).toHaveBeenCalledWith({
      limit: 5,
      riskLevel: 'low',
      status: 'needs_review',
      type: 'faq',
    });
  });

  it('registers review_knowledge_candidate and trims reviewer inputs at the schema boundary', async () => {
    const registry = createToolRegistry();
    const reviewCandidate = vi.fn(() =>
      Promise.resolve({
        confidence: 0.82,
        createdAt: '2026-06-17T02:00:00.000Z',
        existingKnowledgeMatches: [],
        generatedEvalCases: [],
        id: 'kc_telegram_setup',
        proposedAnswer: '在钱包监控里配置 Telegram Bot。',
        question: 'Telegram 通知怎么设置？',
        redactionReport: { entities: [], riskFlags: [], riskLevel: 'low' },
        reviewer: 'ops@example.com',
        riskLevel: 'low' as const,
        sourceRefs: [],
        status: 'approved' as const,
        targetCategory: 'product_faq' as const,
        type: 'faq' as const,
        updatedAt: '2026-06-17T03:00:00.000Z',
      }),
    );

    for (const tool of createKnowledgeOpsTools({
      listCandidates() {
        throw new Error('listCandidates should not be called');
      },
      publishKnowledgeCandidate() {
        throw new Error('publishKnowledgeCandidate should not be called');
      },
      reviewCandidate,
      runKnowledgeGate() {
        throw new Error('runKnowledgeGate should not be called');
      },
      syncTelegramSupport() {
        throw new Error('syncTelegramSupport should not be called');
      },
    })) {
      registry.register(tool);
    }

    await expect(
      registry.execute('review_knowledge_candidate', {
        action: 'approve',
        id: 'kc_telegram_setup',
        notes: ' 内容准确 ',
        reviewer: ' ops@example.com ',
      }),
    ).resolves.toMatchObject({
      candidate: {
        id: 'kc_telegram_setup',
        reviewer: 'ops@example.com',
        status: 'approved',
      },
    });
    expect(reviewCandidate).toHaveBeenCalledWith('kc_telegram_setup', {
      action: 'approve',
      notes: '内容准确',
      reviewer: 'ops@example.com',
    });
  });

  it('registers publish, gate, and telegram sync operations for internal agents', async () => {
    const registry = createToolRegistry();
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
              exitCode: 0,
              status: 'passed' as const,
            },
      ),
    );
    const syncTelegramSupport = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stderr: '',
        stdout: 'Telegram support sync: fetched 2 messages.',
      }),
    );

    for (const tool of createKnowledgeOpsTools({
      listCandidates() {
        throw new Error('listCandidates should not be called');
      },
      publishKnowledgeCandidate,
      reviewCandidate() {
        throw new Error('reviewCandidate should not be called');
      },
      runKnowledgeGate,
      syncTelegramSupport,
    })) {
      registry.register(tool);
    }

    await expect(
      registry.execute('publish_knowledge_candidate', {
        id: 'kc_telegram_setup',
        target: 'pages/support-faq.md',
      }),
    ).resolves.toMatchObject({
      candidateId: 'kc_telegram_setup',
      publishRunId: 'publish_20260617T050000Z_abcd1234',
    });
    await expect(
      registry.execute('run_knowledge_gate', {
        fast: true,
        id: 'kc_telegram_setup',
      }),
    ).resolves.toMatchObject({
      candidateId: 'kc_telegram_setup',
      status: 'passed',
    });
    await expect(
      registry.execute('run_knowledge_gate', {
        approvedEvalOnly: true,
        fast: true,
      }),
    ).resolves.toMatchObject({
      approvedEvalOnly: true,
      status: 'passed',
      stdout: 'Approved eval knowledge gate passed: 2/2 candidates passed.',
    });
    await expect(registry.execute('sync_telegram_support', {})).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'Telegram support sync: fetched 2 messages.',
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
    expect(syncTelegramSupport).toHaveBeenCalledWith({});
  });

  it('rejects invalid knowledge ops inputs at the schema boundary', () => {
    expect(listKnowledgeCandidatesInputSchema.safeParse({ status: 'unknown' }).success).toBe(false);
    expect(listKnowledgeCandidatesInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(
      reviewKnowledgeCandidateInputSchema.safeParse({ id: '', action: 'approve' }).success,
    ).toBe(false);
    expect(
      reviewKnowledgeCandidateInputSchema.safeParse({
        action: 'approve',
        id: 'kc_telegram_setup',
        reviewer: '   ',
      }).success,
    ).toBe(false);
    expect(runKnowledgeGateInputSchema.safeParse({}).success).toBe(false);
    expect(
      runKnowledgeGateInputSchema.safeParse({
        approvedEvalOnly: true,
        id: 'kc_telegram_setup',
      }).success,
    ).toBe(false);
  });
});
