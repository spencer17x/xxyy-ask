import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REVIEWED_SUPPORT_KNOWLEDGE_TARGET,
  publishKnowledgeCandidate,
} from './publish-workflow.js';
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
    id: 'kc_telegram_setup',
    proposedAnswer: '在钱包监控里配置 Telegram Bot。',
    question: 'Telegram 通知怎么设置？',
    redactionReport: {
      entities: [],
      riskFlags: [],
      riskLevel: 'low',
    },
    reviewer: 'ops@example.com',
    riskLevel: 'low',
    sourceRefs: [
      { source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '100' },
      { source: 'telegram', chatIdHash: 'support_chat_hash', messageId: '101' },
    ],
    status: 'approved',
    targetCategory: 'product_faq',
    type: 'faq',
    updatedAt: '2026-06-17T03:00:00.000Z',
    ...overrides,
  };
}

describe('publishKnowledgeCandidate', () => {
  it('publishes an approved candidate into reviewed support knowledge markdown', async () => {
    const productFeaturesDir = await mkdtemp(path.join(tmpdir(), 'xxyy-publish-'));

    const result = await publishKnowledgeCandidate({
      candidate: candidate(),
      now: '2026-06-17T05:00:00.000Z',
      productFeaturesDir,
    });

    const publishedFile = await readFile(
      path.join(productFeaturesDir, DEFAULT_REVIEWED_SUPPORT_KNOWLEDGE_TARGET),
      'utf8',
    );
    expect(result).toMatchObject({
      publishedAt: '2026-06-17T05:00:00.000Z',
      publishedTarget: `${DEFAULT_REVIEWED_SUPPORT_KNOWLEDGE_TARGET}#kc_telegram_setup`,
    });
    expect(result.candidate).toMatchObject({
      publishedTarget: `${DEFAULT_REVIEWED_SUPPORT_KNOWLEDGE_TARGET}#kc_telegram_setup`,
      status: 'published',
      updatedAt: '2026-06-17T05:00:00.000Z',
    });
    expect(result.publishRunId).toMatch(/^publish_20260617T050000Z_/u);
    expect(publishedFile).toContain('title: "Reviewed Support Knowledge"');
    expect(publishedFile).toContain('# Reviewed Support Knowledge');
    expect(publishedFile).toContain('<!-- xxyy-knowledge-candidate:kc_telegram_setup -->');
    expect(publishedFile).toContain('## Telegram 通知怎么设置？');
    expect(publishedFile).toContain('- Candidate ID: `kc_telegram_setup`');
    expect(publishedFile).toContain('- Reviewer: `ops@example.com`');
    expect(publishedFile).toContain(
      '- Source refs: `telegram:support_chat_hash:100`, `telegram:support_chat_hash:101`',
    );
    expect(publishedFile).toContain('在钱包监控里配置 Telegram Bot。');
    expect(publishedFile).toContain('- Q: Telegram 通知怎么设置？');
    expect(publishedFile).toContain('- Expected: 在钱包监控里配置 Telegram Bot。');
  });

  it('rejects candidates that have not been approved by a human reviewer', async () => {
    const productFeaturesDir = await mkdtemp(path.join(tmpdir(), 'xxyy-publish-'));

    await expect(
      publishKnowledgeCandidate({
        candidate: candidate({ status: 'needs_review' }),
        now: '2026-06-17T05:00:00.000Z',
        productFeaturesDir,
      }),
    ).rejects.toThrow(
      'Knowledge candidate kc_telegram_setup must be approved before publishing; current status is needs_review.',
    );
  });
});
