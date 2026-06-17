import { describe, expect, it, vi } from 'vitest';

import { createInMemoryAuditSink } from './audit.js';
import { createKnowledgeOpsAgentRuntime } from './knowledge-ops-agent-runtime.js';
import { createToolRegistry } from './tool-registry.js';
import {
  createKnowledgeOpsTools,
  type CreateKnowledgeOpsToolsOptions,
} from './tools/knowledge-ops-tools.js';

describe('createKnowledgeOpsAgentRuntime', () => {
  it('requires ops authorization before executing knowledge operations tools', async () => {
    const registry = createToolRegistry();
    const audit = createInMemoryAuditSink();
    const reviewCandidate = vi.fn(() => {
      throw new Error('reviewCandidate should not be called');
    });
    registerKnowledgeOpsTools(registry, {
      reviewCandidate,
    });

    await expect(
      createKnowledgeOpsAgentRuntime({
        audit,
        opsAuthorized: false,
        registry,
      }).reviewCandidate({
        action: 'approve',
        id: 'kc_telegram_setup',
        reviewer: 'ops@example.com',
      }),
    ).rejects.toThrow('Knowledge operations agent requires ops authorization.');
    expect(reviewCandidate).not.toHaveBeenCalled();
    expect(audit.events()).toEqual([
      expect.objectContaining({
        candidateId: 'kc_telegram_setup',
        errorCode: 'KnowledgeOpsAgentUnauthorizedError',
        status: 'failure',
        toolName: 'review_knowledge_candidate',
      }),
    ]);
  });

  it('executes review, publish, and gate tools with success audit when authorized', async () => {
    const registry = createToolRegistry();
    const audit = createInMemoryAuditSink();
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
    const publishKnowledgeCandidate = vi.fn(() =>
      Promise.resolve({
        candidateId: 'kc_telegram_setup',
        publishedTarget: 'pages/support-faq.md#kc_telegram_setup',
        publishRunId: 'publish_20260617T050000Z_abcd1234',
      }),
    );
    const runKnowledgeGate = vi.fn(() =>
      Promise.resolve({
        candidateId: 'kc_telegram_setup',
        evaluation: { passed: 1, total: 1 },
        status: 'passed' as const,
      }),
    );
    registerKnowledgeOpsTools(registry, {
      publishKnowledgeCandidate,
      reviewCandidate,
      runKnowledgeGate,
    });
    const runtime = createKnowledgeOpsAgentRuntime({
      audit,
      opsAuthorized: true,
      registry,
    });

    await expect(
      runtime.reviewCandidate({
        action: 'approve',
        id: 'kc_telegram_setup',
        reviewer: 'ops@example.com',
      }),
    ).resolves.toMatchObject({
      candidate: { id: 'kc_telegram_setup', status: 'approved' },
    });
    await expect(
      runtime.publishKnowledgeCandidate({
        id: 'kc_telegram_setup',
        target: 'pages/support-faq.md',
      }),
    ).resolves.toMatchObject({
      candidateId: 'kc_telegram_setup',
      publishRunId: 'publish_20260617T050000Z_abcd1234',
    });
    await expect(
      runtime.runKnowledgeGate({
        fast: true,
        id: 'kc_telegram_setup',
      }),
    ).resolves.toMatchObject({
      candidateId: 'kc_telegram_setup',
      status: 'passed',
    });
    expect(audit.events()).toEqual([
      expect.objectContaining({
        candidateId: 'kc_telegram_setup',
        status: 'success',
        toolName: 'review_knowledge_candidate',
      }),
      expect.objectContaining({
        candidateId: 'kc_telegram_setup',
        status: 'success',
        toolName: 'publish_knowledge_candidate',
      }),
      expect.objectContaining({
        candidateId: 'kc_telegram_setup',
        status: 'success',
        toolName: 'run_knowledge_gate',
      }),
    ]);
  });

  it('executes list and sync tools with success audit when authorized', async () => {
    const registry = createToolRegistry();
    const audit = createInMemoryAuditSink();
    const listCandidates = vi.fn(() => Promise.resolve([]));
    const syncTelegramSupport = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: 'synced',
      }),
    );
    registerKnowledgeOpsTools(registry, {
      listCandidates,
      syncTelegramSupport,
    });
    const runtime = createKnowledgeOpsAgentRuntime({
      audit,
      opsAuthorized: true,
      registry,
    });

    await expect(runtime.listKnowledgeCandidates({ limit: 10 })).resolves.toEqual({
      candidates: [],
      count: 0,
    });
    await expect(runtime.syncTelegramSupport()).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'synced',
    });
    expect(audit.events()).toEqual([
      expect.objectContaining({
        status: 'success',
        toolName: 'list_knowledge_candidates',
      }),
      expect.objectContaining({
        status: 'success',
        toolName: 'sync_telegram_support',
      }),
    ]);
  });
});

function registerKnowledgeOpsTools(
  registry: ReturnType<typeof createToolRegistry>,
  overrides: Partial<CreateKnowledgeOpsToolsOptions> = {},
): void {
  const defaults: CreateKnowledgeOpsToolsOptions = {
    listCandidates() {
      return Promise.resolve([]);
    },
    publishKnowledgeCandidate() {
      return Promise.resolve({
        candidateId: 'candidate',
        publishedTarget: 'pages/support.md#candidate',
        publishRunId: 'publish_run',
      });
    },
    reviewCandidate() {
      return Promise.reject(new Error('reviewCandidate not configured'));
    },
    runKnowledgeGate() {
      return Promise.resolve({
        candidateId: 'candidate',
        status: 'passed',
      });
    },
    syncTelegramSupport() {
      return Promise.resolve({
        exitCode: 0,
      });
    },
  };

  for (const tool of createKnowledgeOpsTools({ ...defaults, ...overrides })) {
    registry.register(tool);
  }
}
