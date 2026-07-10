import { describe, expect, it } from 'vitest';

import type { Classification } from '@xxyy/shared';

import {
  createBoundaryAnswer,
  createGroundedAnswer,
  createSupportConclusionFromEvidence,
} from './answer.js';
import { retrieve, type RetrievedChunk } from './retrieve.js';
import { createFixtureIndex } from './test-fixtures.js';

const productClassification: Classification = {
  intent: 'product_qa',
  confidence: 0.8,
  reason: 'product keyword',
};

describe('createGroundedAnswer', () => {
  it('answers product questions in Chinese using retrieved excerpts and citations', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/pro',
        file: '/docs/pro.md',
        text: 'XXYY Pro 支持 Telegram 钱包监控，并提供更高频率的产品提醒。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 支持 Telegram 钱包监控吗？', index);

    const response = createGroundedAnswer(
      'XXYY Pro 支持 Telegram 钱包监控吗？',
      productClassification,
      retrieved,
    );

    expect(response.intent).toBe('product_qa');
    expect(response.answer).toContain('支持');
    expect(response.answer).toContain('Telegram 钱包监控');
    expect(response.citations).toHaveLength(1);
    const citation = response.citations[0];
    expect(citation).toBeDefined();
    if (citation === undefined) {
      throw new Error('Expected a product answer citation');
    }
    expect(citation.excerpt).toContain('Telegram 钱包监控');
    expect(citation.file).toBe('docs/pro.md');
    expect(citation.title).toBe('XXYY Pro 权益');
    expect(citation.sourceUrl).toBe('https://docs.xxyy.io/pro');
    expect(response.confidence).toBeGreaterThan(0.5);
  });

  it('uses a conservative fallback when product context is unavailable', () => {
    const response = createGroundedAnswer('XXYY Pro 有哪些权益？', productClassification, []);

    expect(response.answer).toContain('暂时没有找到');
    expect(response.citations).toEqual([]);
    expect(response.confidence).toBeLessThan(0.5);
  });

  it('extracts video attachments from grounded product context', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:mobile-app:chunk:0001',
        title: '移动端桌面入口',
        sourceType: 'official_docs',
        file: '/docs/product-features/pages/mobile-app.md',
        text: 'XXYY 暂时没有独立 App，但可以添加到桌面，和 App 体验差不多。[添加到桌面演示](/assets/xxyy-add-to-home.mp4)',
      },
    ]);
    const retrieved = retrieve('XXYY 有 APP 吗？', index);

    const response = createGroundedAnswer('XXYY 有 APP 吗？', productClassification, retrieved);

    expect(response.answer).toContain('添加到桌面');
    expect(response.attachments).toEqual([
      {
        kind: 'video',
        mediaType: 'video/mp4',
        title: '添加到桌面演示',
        url: '/assets/xxyy-add-to-home.mp4',
      },
    ]);
  });

  it('uses only the standard customer answer chunk when it is present', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'mobile-app',
        text: '标准客服回答：可以添加到桌面，和 App 体验差不多。演示视频：[添加到桌面演示](/assets/xxyy-add-to-home.mp4)',
        title: '移动端桌面入口',
      }),
      createRetrievedChunk({
        id: 'token-info',
        text: '代币基本信息：合约地址、价格、流动性、市值、安全性数据。',
        title: '代币信息区',
      }),
    ];

    const response = createGroundedAnswer('XXYY 有 APP 吗？', productClassification, retrieved);

    expect(response.answer).toContain('添加到桌面');
    expect(response.answer).not.toContain('标准客服回答');
    expect(response.answer).not.toContain('用户问');
    expect(response.answer).not.toContain('代币基本信息');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.title).toBe('移动端桌面入口');
    expect(response.citations[0]?.excerpt).toBe('可以添加到桌面，和 App 体验差不多。');
    expect(response.attachments).toEqual([
      {
        kind: 'video',
        mediaType: 'video/mp4',
        title: '添加到桌面演示',
        url: '/assets/xxyy-add-to-home.mp4',
      },
    ]);
  });

  it('does not let a standard customer answer hide another source for comparison questions', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'pro-benefits',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
        title: 'XXYY Pro 权益',
      }),
      createRetrievedChunk({
        id: 'wallet-management',
        text: 'XXYY 每个用户每条链最多创建100个交易钱包，Pro 用户最多创建500个交易钱包。',
        title: '钱包管理',
      }),
    ];

    const response = createGroundedAnswer(
      '请比较 XXYY Pro 权益和钱包管理上限',
      productClassification,
      retrieved,
    );

    expect(response.citations).toHaveLength(2);
    expect(response.answer).toContain('独享服务器和节点');
    expect(response.answer).toContain('每个用户每条链最多创建100个交易钱包');
  });

  it('uses only the direct X post chunk for tweet source questions', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'wallet-note-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
        text: '钱包备注支持最多 1 万条，快速捕捉前排地址。',
        title: 'X Post 2030954722350575916',
      }),
      createRetrievedChunk({
        id: 'copy-trading-summary',
        sourceType: 'x_updates',
        text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
    ];

    const response = createGroundedAnswer(
      '钱包备注支持最多 1 万条是哪条推文？',
      productClassification,
      retrieved,
    );

    expect(response.answer).toContain('钱包备注支持最多 1 万条');
    expect(response.answer).not.toContain('跟单功能上线');
    expect(response.citations).toEqual([
      {
        excerpt: '钱包备注支持最多 1 万条，快速捕捉前排地址。',
        file: 'docs/wallet-note-post.md',
        sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
        title: 'X Post 2030954722350575916',
      },
    ]);
  });

  it('selects the direct X post that best matches the source question text', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'holders-note-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2063938732311601370',
        text: 'Holders数据新增备注、Dev、新钱包、老鼠仓、捆绑信息。',
        title: 'X Post 2063938732311601370',
      }),
      createRetrievedChunk({
        id: 'wallet-note-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
        text: '钱包备注支持最多 1 万条，快速捕捉前排地址。',
        title: 'X Post 2030954722350575916',
      }),
    ];

    const response = createGroundedAnswer(
      '钱包备注支持最多 1 万条是哪条推文？',
      productClassification,
      retrieved,
    );

    expect(response.citations).toEqual([
      expect.objectContaining({
        sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
        title: 'X Post 2030954722350575916',
      }),
    ]);
    expect(response.answer).toContain('钱包备注支持最多 1 万条');
    expect(response.answer).not.toContain('Holders数据');
  });

  it('keeps only strong P1/P2/P3 evidence for trade-setting preset questions', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'p123-summary',
        sourceType: 'x_updates',
        text: '支持 P1/P2/P3 交易设置档位，不同买卖和挂单场景可使用不同 gas 与滑点。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
      createRetrievedChunk({
        id: 'p123-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2026285686907883612',
        text: '交易设置多档位切换 P1 P2 P3，买卖/挂单支持不同gas与滑点。',
        title: 'X Post 2026285686907883612',
      }),
      createRetrievedChunk({
        id: 'speed-summary',
        sourceType: 'x_updates',
        text: '全面提速：扫链新盘秒出，K 线 0 延迟，图片实时推送。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
    ];

    const response = createGroundedAnswer(
      'P1/P2/P3 是什么交易设置？',
      productClassification,
      retrieved,
    );

    expect(response.answer).toContain('P1/P2/P3');
    expect(response.answer).toContain('P1 P2 P3');
    expect(response.answer).not.toContain('全面提速');
    expect(response.citations).toHaveLength(2);
    expect(response.citations.map((citation) => citation.title)).toEqual([
      'XXYY X 历史推文产品更新汇总',
      'X Post 2026285686907883612',
    ]);
  });

  it('keeps only direct Base B20 support evidence for short entity questions', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'base-b20-question',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2070536322838831188',
        text: '今晚有人一起蹲 #BASE 链的 B20 上线吗？',
        title: 'X Post 2070536322838831188',
      }),
      createRetrievedChunk({
        id: 'base-b20-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2070536322838831188',
        text: '全面支持B20代币交易，同时在代币详情和扫链页面都增加了专属标识。',
        title: 'X Post 2070536322838831188',
      }),
      createRetrievedChunk({
        id: 'generic-trade-settings',
        text: '滑点、交易模式、交易 Fee 支持自定义，设置完成后交易组件中默认使用该值。',
        title: '交易设置',
      }),
    ];

    const response = createGroundedAnswer(
      'XXYY 是否支持 Base B20？',
      productClassification,
      retrieved,
    );

    expect(response.answer).toContain('全面支持B20代币交易');
    expect(response.answer).not.toContain('有人一起蹲');
    expect(response.answer).not.toContain('交易 Fee');
    expect(response.citations).toEqual([
      expect.objectContaining({
        sourceUrl: 'https://x.com/useXXYYio/status/2070536322838831188',
        title: 'X Post 2070536322838831188',
      }),
    ]);
  });

  it('summarizes support evidence as a short conclusion instead of dumping raw excerpts', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'copy-trading-summary',
        sourceType: 'x_updates',
        text: '- FourMeme Agentic 模式支持：在 XXYY 完成 BSC 代币交易后可自动 mint Agent NFT。 - 跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链，可查看地址利润和胜率，自定义跟单金额、卖出比例、gas、滑点和过滤条件。 - 开放交易 API。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
      createRetrievedChunk({
        id: 'copy-trading-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2029522365408067746',
        text: '🔗支持6大公链，#SOL #BSC #Base #ETH #XLayer #Plasma 📈输入地址即可查看利润、胜率数据，判断是否值得跟单 ⚙️自定义跟单金额、卖出比例、gas/滑点/交易设置，速度更快',
        title: 'X Post 2029522365408067746',
      }),
    ];

    const response = createGroundedAnswer('支持跟单么', productClassification, retrieved);

    expect(response.answer).toBe(
      '支持。跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链，可查看地址利润和胜率，自定义跟单金额、卖出比例、gas、滑点和过滤条件。',
    );
    expect(response.answer).not.toContain('FourMeme');
    expect(response.answer).not.toContain('🔗');
    expect(response.citations).toHaveLength(2);
  });

  it('returns a concise insufficient-evidence answer for unsupported external support entities', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'xpl-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/1973056573695242527',
        text: 'https://t.co/vtLDOyE6Hd is the first tool to support $XPL with both charting and trading in one place🚀',
        title: 'X Post 1973056573695242527',
      }),
      createRetrievedChunk({
        id: 'scan-summary',
        sourceType: 'x_updates',
        text: '| 日期 | 更新点 | 推文 | | --- | --- | --- | | 2024-11-29 | Beta V0.1.2：秒线、1 分钟趋势、监控钱包分组 |',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
    ];

    const response = createGroundedAnswer(
      'XXYY当前是否支持robinhood',
      productClassification,
      retrieved,
    );

    expect(response.answer).toBe('当前知识库没有明确说明 XXYY 支持 robinhood，不能确认已支持。');
    expect(response.answer).not.toContain('XPL');
    expect(response.answer).not.toContain('| 日期 |');
    expect(response.citations).toEqual([]);
    expect(response.confidence).toBeLessThan(0.5);
  });

  it('does not treat roadmap language as current support evidence', () => {
    expect(
      createSupportConclusionFromEvidence('Does XXYY support Robinhood?', [
        'XXYY 计划支持 Robinhood，预计下季度上线。',
      ]),
    ).toBeUndefined();
  });

  it('matches short support entities as exact tokens instead of substrings', () => {
    expect(
      createSupportConclusionFromEvidence('XXYY 支持 OP 吗？', ['XXYY 支持 Copy Trading。']),
    ).toBeUndefined();
  });

  it('selects direct entity support evidence before an unrelated standard answer', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'mobile-app',
        text: '标准客服回答：可以添加到桌面，和 App 体验差不多。',
        title: '移动端桌面入口',
      }),
      createRetrievedChunk({
        id: 'robinhood-support',
        text: 'XXYY 当前支持 Robinhood。',
        title: 'Robinhood 支持范围',
      }),
    ];

    const response = createGroundedAnswer(
      'Does XXYY support Robinhood?',
      productClassification,
      retrieved,
    );

    expect(response.answer).toBe('支持。XXYY 当前支持 Robinhood。');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.title).toBe('Robinhood 支持范围');
  });

  it.each([
    ['realtime_account_query', '我不能直接查询你的钱包余额、订单、账户或交易记录'],
    ['investment_advice', '我不能提供买卖建议、喊单或收益承诺'],
    ['unknown', '我还不确定你想咨询的具体问题'],
  ] as const)(
    'does not use retrieved chunks as factual answers for %s',
    (intent, expectedBoundary) => {
      const index = createFixtureIndex([
        {
          id: 'official_docs:unsafe:chunk:0001',
          title: '不应被引用',
          sourceType: 'official_docs',
          text: '你的余额是 100 SOL，这笔交易确定被夹，建议马上买入。',
        },
      ]);
      const retrieved = retrieve('帮我查余额', index);
      const response = createGroundedAnswer(
        '帮我查余额',
        {
          intent,
          confidence: 0.9,
          reason: 'boundary intent',
        },
        retrieved,
      );

      expect(response.answer).toContain(expectedBoundary);
      expect(response.answer).not.toContain('100 SOL');
      expect(response.answer).not.toContain('马上买入');
      expect(response.citations).toEqual([]);
    },
  );
});

function createRetrievedChunk(input: {
  id: string;
  sourceType?: RetrievedChunk['metadata']['sourceType'];
  sourceUrl?: string;
  text: string;
  title: string;
}): RetrievedChunk {
  return {
    documentId: input.id,
    embedding: [],
    id: input.id,
    lexicalScore: 1,
    metadata: {
      file: `/docs/${input.id}.md`,
      headingPath: [input.title],
      module: input.title,
      sourceType: input.sourceType ?? 'official_docs',
      title: input.title,
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
    },
    rank: 1,
    score: 1,
    sourceBoost: 0,
    text: input.text,
    tokens: [],
    vectorScore: 1,
  };
}

describe('createBoundaryAnswer', () => {
  it('returns a business-action boundary when the unknown reason is action execution', () => {
    const response = createBoundaryAnswer({
      confidence: 0.4,
      intent: 'unknown',
      reason: 'business action execution request',
    });

    expect(response).toMatchObject({
      citations: [],
      confidence: 0.4,
      intent: 'unknown',
    });
    expect(response.answer).toContain('不能代你开通、取消、修改');
    expect(response.answer).toContain('退款、赔偿');
    expect(response.answer).toContain('可以继续问我开通或升级的操作步骤');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);
  });
});
