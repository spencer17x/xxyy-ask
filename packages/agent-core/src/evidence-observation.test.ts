import { describe, expect, it } from 'vitest';

import {
  extractEvidenceFacets,
  isAllowedSearchQueryRewrite,
  observeProductEvidence,
  queryTargetsMissingFacet,
} from './evidence-observation.js';

describe('evidence observation', () => {
  it('accepts one cited result for a normal product question', () => {
    expect(
      observeProductEvidence(
        'XXYY Pro 有哪些权益？',
        [attempt('XXYY Pro 有哪些权益？', ['pro'], ['pro-source'], ['XXYY Pro 提供独享节点。'])],
        4,
      ),
    ).toMatchObject({
      complexity: 'single_part',
      shouldContinue: false,
      stopReason: 'sufficient',
      sufficient: true,
    });
  });

  it('identifies an uncovered comparison facet and proposes a bounded follow-up query', () => {
    const observation = observeProductEvidence(
      '请比较 XXYY Pro 权益和钱包管理上限',
      [
        attempt(
          '请比较 XXYY Pro 权益和钱包管理上限',
          ['pro'],
          ['pro-source'],
          ['XXYY Pro 权益包括独享节点。'],
        ),
      ],
      4,
    );

    expect(observation).toMatchObject({
      complexity: 'multi_part',
      coveredFacets: ['XXYY Pro 权益'],
      missingFacets: ['钱包管理上限'],
      shouldContinue: true,
      sufficient: false,
      suggestedQuery: 'XXYY 钱包管理上限',
    });
  });

  it('accepts multi-part evidence only after every extracted facet is covered', () => {
    const observation = observeProductEvidence(
      '请比较 XXYY Pro 权益和钱包管理上限',
      [
        attempt('XXYY Pro 权益', ['pro'], ['pro-source'], ['XXYY Pro 权益包括独享节点。']),
        attempt(
          '钱包管理上限',
          ['wallet'],
          ['wallet-source'],
          ['钱包管理：每条链最多创建 100 个交易钱包。'],
        ),
      ],
      4,
    );

    expect(observation).toMatchObject({
      coveredFacets: ['XXYY Pro 权益', '钱包管理上限'],
      missingFacets: [],
      stopReason: 'sufficient',
      sufficient: true,
    });
  });

  it('stops when a distinct rewritten query returns no new chunk or citation', () => {
    const observation = observeProductEvidence(
      '请比较 XXYY Pro 权益和钱包管理上限',
      [
        attempt('XXYY Pro 权益', ['pro'], ['pro-source'], ['XXYY Pro 权益包括独享节点。']),
        attempt(
          '钱包管理上限',
          ['pro'],
          ['pro-source-with-a-different-excerpt'],
          ['XXYY Pro 权益包括独享节点。'],
        ),
      ],
      4,
    );

    expect(observation).toMatchObject({
      latestNewEvidenceCount: 0,
      shouldContinue: false,
      stopReason: 'no_new_evidence',
      sufficient: false,
    });
  });

  it('stops at the configured search-step limit', () => {
    const observation = observeProductEvidence(
      '这个不存在的功能怎么配置？',
      [attempt('不存在的功能', [], [], [])],
      1,
    );

    expect(observation).toMatchObject({
      shouldContinue: false,
      stopReason: 'max_steps',
      sufficient: false,
    });
  });

  it('extracts comparison facets and validates rewritten-query focus', () => {
    const facets = extractEvidenceFacets('Pro 和永久 PRO 有什么区别？');

    expect(facets).toEqual(['Pro', '永久 PRO']);
    expect(queryTargetsMissingFacet('XXYY 永久 Pro 权益', ['永久 PRO'])).toBe(true);
    expect(queryTargetsMissingFacet('XXYY 钱包管理', ['永久 PRO'])).toBe(false);
  });

  it('rejects rewrites that leave the original scope or drop a time qualifier', () => {
    expect(
      isAllowedSearchQueryRewrite('2025 年当时 XXYY Pro 的钱包监控上限是多少？', '天气怎么样', []),
    ).toBe(false);
    expect(
      isAllowedSearchQueryRewrite(
        '2025 年当时 XXYY Pro 的钱包监控上限是多少？',
        'XXYY Pro 钱包监控上限',
        [],
      ),
    ).toBe(false);
    expect(
      isAllowedSearchQueryRewrite(
        '2025 年当时 XXYY Pro 的钱包监控上限是多少？',
        '2025 年当时 XXYY Pro 钱包监控上限',
        [],
      ),
    ).toBe(true);

    const observation = observeProductEvidence(
      '请比较 2025 年当时 XXYY Pro 权益和钱包管理上限',
      [attempt('原问题', ['pro'], ['pro-source'], ['2025 年当时 XXYY Pro 权益包括独享节点。'])],
      4,
    );
    expect(observation.suggestedQuery).toContain('2025 年');
    expect(observation.suggestedQuery).toContain('当时');
  });
});

function attempt(
  query: string,
  chunkIds: string[],
  citationKeys: string[],
  evidenceTexts: string[],
) {
  return { chunkIds, citationKeys, evidenceTexts, query };
}
