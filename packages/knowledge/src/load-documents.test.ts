import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SourceDocument } from '@xxyy/shared';

import { loadProductDocuments } from './load-documents.js';

async function createProductDocsFixture(): Promise<string> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'xxyy-knowledge-docs-'));
  const pagesDir = path.join(fixtureDir, 'pages');
  const sourcesDir = path.join(fixtureDir, 'sources');
  await mkdir(pagesDir);
  await mkdir(sourcesDir);

  await writeFile(
    path.join(fixtureDir, 'xxyy-product-functions.md'),
    '# XXYY 产品功能整理文档\n\nXXYY supports Solana trading.\n',
  );
  await writeFile(
    path.join(fixtureDir, 'xxyy-x-updates.md'),
    [
      '# XXYY X 历史推文产品更新汇总',
      '',
      'Telegram monitoring shipped.',
      '',
      '## 可溯源原始消息索引',
      '',
      '#### 2026-03-09T10:31:53.000Z · [2030954722350575916](https://x.com/useXXYYio/status/2030954722350575916)',
      '',
      '> 钱包备注支持最多 1 万条',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(pagesDir, '02-readme__quickstart.md'),
    [
      '---',
      'title: "Frontmatter Title"',
      'section: "Frontmatter Module"',
      '---',
      '# 新手必看',
      '',
      '生成交易钱包后即可开始交易。',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(fixtureDir, 'manifest.jsonl'),
    [
      JSON.stringify({
        order: 2,
        title: '新手必看',
        source_url: 'https://docs.xxyy.io/readme/quickstart',
        section: '新手入门',
        lastmod: '2026-03-16T11:12:30.350Z',
        retrieved_at: '2026-05-24T06:41:04.265Z',
        file: '02-readme__quickstart.md',
      }),
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(sourcesDir, 'usexxyyio-x-posts.jsonl'),
    [
      JSON.stringify({
        id: '2030954722350575916',
        url: 'https://x.com/useXXYYio/status/2030954722350575916',
        account: 'useXXYYio',
        createdAtIso: '2026-03-09T10:31:53.000Z',
        fetchedAt: '2026-06-06T04:40:24.279Z',
        media: [
          {
            type: 'photo',
            mediaUrl: 'https://pbs.twimg.com/media/example.jpg',
          },
          {
            type: 'video',
            expandedUrl: 'https://x.com/useXXYYio/status/2030954722350575916/video/2',
            mediaUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/example.jpg',
          },
        ],
        text: 'XXYY 更新。钱包备注支持最多 1 万条，快速捕捉前排地址。',
      }),
      '',
    ].join('\n'),
  );

  return fixtureDir;
}

describe('loadProductDocuments', () => {
  it('rejects malformed manifest metadata instead of trusting parsed JSON', async () => {
    const fixtureDir = await createProductDocsFixture();
    await writeFile(
      path.join(fixtureDir, 'manifest.jsonl'),
      `${JSON.stringify({
        file: '02-readme__quickstart.md',
        title: 123,
      })}\n`,
    );

    await expect(loadProductDocuments({ productFeaturesDir: fixtureDir })).rejects.toThrow(
      'Invalid product document manifest entry on line 1',
    );
  });

  it('loads core docs and manifest-enriched pages deterministically', async () => {
    const fixtureDir = await createProductDocsFixture();

    const documents: SourceDocument[] = await loadProductDocuments({
      productFeaturesDir: fixtureDir,
    });

    expect(documents.map((document) => document.id)).toEqual([
      'x_updates:xxyy-x-updates',
      'x_updates:sources/usexxyyio-x-posts/2030954722350575916',
      'official_docs:pages/02-readme__quickstart',
    ]);

    expect(documents[0]).toMatchObject({
      title: 'XXYY X 历史推文产品更新汇总',
      module: 'X Updates',
      sourceType: 'x_updates',
    });
    expect(documents[0]?.content).toContain('Telegram monitoring shipped.');
    expect(documents[0]?.content).not.toContain('可溯源原始消息索引');
    expect(documents[0]?.content).not.toContain('钱包备注支持最多 1 万条');
    expect(documents[1]).toMatchObject({
      title: 'X Post 2030954722350575916',
      module: 'X / @useXXYYio / 2026-03',
      sourceType: 'x_updates',
      sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
      effectiveAt: '2026-03-09T10:31:53.000Z',
      retrievedAt: '2026-06-06T04:40:24.279Z',
      status: 'current',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/jpeg',
          title: '@useXXYYio 更新 2030954722350575916 图片 1',
          url: 'https://pbs.twimg.com/media/example.jpg',
        },
        {
          kind: 'video',
          mediaType: 'text/html',
          posterUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/example.jpg',
          title: '@useXXYYio 更新 2030954722350575916 视频 2',
          url: 'https://x.com/useXXYYio/status/2030954722350575916/video/2',
        },
      ],
    });
    expect(documents[1]?.content).toContain('钱包备注支持最多 1 万条');
    expect(documents[1]?.content).not.toContain('Account:');
    expect(documents[1]?.content).not.toContain('Tweet ID:');
    expect(documents[1]?.content).not.toContain('Published at:');
    expect(documents[2]).toMatchObject({
      title: '新手必看',
      module: '新手入门',
      sourceType: 'official_docs',
      order: 2,
      sourceUrl: 'https://docs.xxyy.io/readme/quickstart',
      effectiveAt: '2026-03-16T11:12:30.350Z',
      retrievedAt: '2026-05-24T06:41:04.265Z',
      status: 'current',
    });
    expect(documents[2]?.file).toBe(path.join(fixtureDir, 'pages', '02-readme__quickstart.md'));
    expect(documents[2]?.content).toContain('生成交易钱包后即可开始交易。');
    expect(documents.map((document) => document.id)).not.toContain(
      'official_docs:xxyy-product-functions',
    );
  });

  it('uses the legacy product aggregate only when no synchronized page is indexable', async () => {
    const fixtureDir = await createProductDocsFixture();
    await writeFile(path.join(fixtureDir, 'pages', '02-readme__quickstart.md'), '# Empty page\n');

    const documents = await loadProductDocuments({ productFeaturesDir: fixtureDir });

    expect(documents.map((document) => document.id)).toContain(
      'official_docs:xxyy-product-functions',
    );
  });

  it('loads reviewed customer-support-group knowledge from its isolated directory', async () => {
    const fixtureDir = await createProductDocsFixture();
    const adminVerifiedDir = path.join(fixtureDir, 'admin-verified');
    await mkdir(adminVerifiedDir);
    await writeFile(
      path.join(adminVerifiedDir, 'candidate-1.md'),
      [
        '---',
        'title: "Robinhood 支持情况"',
        'section: "XXYY 客服群审核知识"',
        'effective_at: "2026-07-15T00:00:00.000Z"',
        'status: current',
        '---',
        '# Robinhood 支持情况',
        '',
        '## 用户问题',
        '',
        '支持 Robinhood 吗？',
        '',
        '## 标准答案',
        '',
        '是的，XXYY 已支持 Robinhood。',
        '',
      ].join('\n'),
    );

    const documents = await loadProductDocuments({ productFeaturesDir: fixtureDir });
    const reviewed = documents.find(
      (document) => document.id === 'admin_verified:admin-verified/candidate-1',
    );

    expect(reviewed).toMatchObject({
      effectiveAt: '2026-07-15T00:00:00.000Z',
      module: 'XXYY 客服群审核知识',
      sourceType: 'admin_verified',
      status: 'current',
      title: 'Robinhood 支持情况',
    });
  });

  it('ignores external references and loads official-document derived sidecars', async () => {
    const fixtureDir = await createProductDocsFixture();
    const externalDir = path.join(fixtureDir, 'external', 'xxyy-trade-skill');
    const mediaDir = path.join(fixtureDir, 'enriched', 'media');
    const videosDir = path.join(fixtureDir, 'enriched', 'videos');
    const reviewedDir = path.join(fixtureDir, 'enriched', 'reviewed');
    await Promise.all([
      mkdir(externalDir, { recursive: true }),
      mkdir(mediaDir, { recursive: true }),
      mkdir(videosDir, { recursive: true }),
      mkdir(reviewedDir, { recursive: true }),
    ]);
    await writeFile(
      path.join(externalDir, 'readme.md'),
      [
        '---',
        'title: "XXYY Trade Skill"',
        'section: "Developer / Agent Skill"',
        'source_url: "https://github.com/Jimmy-Holiday/xxyy-trade-skill/blob/abc/README.md"',
        'status: current',
        '---',
        '# Agent Skill',
        '',
        'The Skill wraps the XXYY API.',
      ].join('\n'),
    );
    await writeFile(
      path.join(mediaDir, 'chart-screenshot.md'),
      [
        '---',
        'title: "图表截图文字"',
        'source_url: "https://docs.xxyy.io/chart-area"',
        '---',
        '# 图表截图文字',
        '',
        '- 图片文件：xxyy-docs-chart.png',
        '',
        '平均买入成本线',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(videosDir, 'wallet-monitoring.md'),
      [
        '---',
        'title: "钱包监控教程视频"',
        'source_url: "/assets/wallet-monitoring.mp4"',
        '---',
        '# 钱包监控教程视频',
        '',
        '在 Telegram 中开启通知。',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(reviewedDir, 'avg-price-line.md'),
      [
        '---',
        'source_url: "https://docs.xxyy.io/en/chart-area/avg.-price-line"',
        '---',
        '# Avg. Price Line',
        '',
        'The average cost is recalculated after each purchase.',
      ].join('\n'),
    );

    const documents = await loadProductDocuments({ productFeaturesDir: fixtureDir });

    expect(documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'official_docs:enriched/media/chart-screenshot',
          module: '产品文档图片文字',
          attachments: [
            {
              kind: 'image',
              mediaType: 'image/png',
              title: '图表截图文字',
              url: '/assets/xxyy-docs-chart.png',
            },
          ],
        }),
        expect.objectContaining({
          id: 'official_docs:enriched/videos/wallet-monitoring',
          module: '产品教程视频',
          attachments: [
            {
              kind: 'video',
              mediaType: 'video/mp4',
              title: '钱包监控教程视频',
              url: '/assets/wallet-monitoring.mp4',
            },
          ],
        }),
        expect.objectContaining({
          id: 'official_docs:enriched/reviewed/avg-price-line',
          module: '官网人工校正',
          sourceType: 'official_docs',
        }),
      ]),
    );
    expect(documents.map((document) => document.id)).not.toContain(
      'official_docs:external/xxyy-trade-skill/readme',
    );
  });

  it('classifies curated pages from the canonical XXYY X account as X updates', async () => {
    const fixtureDir = await createProductDocsFixture();
    const pagesDir = path.join(fixtureDir, 'pages');
    await writeFile(
      path.join(pagesDir, '03-current-support.md'),
      '# Robinhood Chain\n\nXXYY 当前支持 Robinhood Chain 扫链。\n',
    );
    await writeFile(
      path.join(fixtureDir, 'manifest.jsonl'),
      [
        JSON.stringify({
          file: '02-readme__quickstart.md',
          source_url: 'https://docs.xxyy.io/readme/quickstart',
        }),
        JSON.stringify({
          file: '03-current-support.md',
          source_url: 'https://x.com/useXXYYio/status/2075547879876554811',
        }),
        '',
      ].join('\n'),
    );

    const documents = await loadProductDocuments({ productFeaturesDir: fixtureDir });
    const xPage = documents.find(
      (document) => document.id === 'x_updates:pages/03-current-support',
    );

    expect(xPage).toMatchObject({
      sourceType: 'x_updates',
      sourceUrl: 'https://x.com/useXXYYio/status/2075547879876554811',
    });
  });

  it('rejects X source records that do not belong to the canonical XXYY account', async () => {
    const fixtureDir = await createProductDocsFixture();
    await writeFile(
      path.join(fixtureDir, 'sources', 'usexxyyio-x-posts.jsonl'),
      `${JSON.stringify({
        account: 'someoneElse',
        id: '2030954722350575916',
        text: 'Not an official XXYY update.',
        url: 'https://x.com/someoneElse/status/2030954722350575916',
      })}\n`,
    );

    await expect(loadProductDocuments({ productFeaturesDir: fixtureDir })).rejects.toThrow(
      'Invalid X post source entry on line 1',
    );
  });

  it('treats present-tense access instructions as current knowledge', async () => {
    const fixtureDir = await createProductDocsFixture();
    await writeFile(
      path.join(fixtureDir, 'sources', 'usexxyyio-x-posts.jsonl'),
      `${JSON.stringify({
        id: '2059120830328770675',
        url: 'https://x.com/useXXYYio/status/2059120830328770675',
        text: '使用产品直达链接，或在网站更多工具里找到入口。',
      })}\n`,
    );

    const documents = await loadProductDocuments({ productFeaturesDir: fixtureDir });
    const accessPost = documents.find((document) => document.id.endsWith('2059120830328770675'));

    expect(accessPost?.status).toBe('current');
  });

  it('falls back to retrieved_at when lastmod metadata is empty', async () => {
    const fixtureDir = await createProductDocsFixture();
    await writeFile(
      path.join(fixtureDir, 'pages', '02-readme__quickstart.md'),
      [
        '---',
        'title: "Frontmatter Title"',
        'section: "Frontmatter Module"',
        'lastmod: ""',
        '---',
        '# 新手必看',
        '',
        '生成交易钱包后即可开始交易。',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(fixtureDir, 'manifest.jsonl'),
      `${JSON.stringify({
        file: '02-readme__quickstart.md',
        lastmod: null,
        retrieved_at: '2026-05-24T06:41:04.265Z',
      })}\n`,
    );

    const documents = await loadProductDocuments({ productFeaturesDir: fixtureDir });
    const page = documents.find(
      (document) => document.id === 'official_docs:pages/02-readme__quickstart',
    );

    expect(page?.effectiveAt).toBe('2026-05-24T06:41:04.265Z');
  });

  it('does not load explicitly skipped, heading-only, or GitBook not-found pages', async () => {
    const fixtureDir = await createProductDocsFixture();
    const pagesDir = path.join(fixtureDir, 'pages');
    await writeFile(path.join(pagesDir, '03-empty.md'), '# Trading on XXYY\n');
    await writeFile(
      path.join(pagesDir, '04-not-found.md'),
      '# Page Not Found\n\nThe URL does not exist. This page may have been moved, renamed, or deleted.\n',
    );
    await writeFile(path.join(pagesDir, '05-skipped.md'), '# Hidden\n\nShould not be loaded.\n');
    await writeFile(
      path.join(fixtureDir, 'manifest.jsonl'),
      `${JSON.stringify({ file: '05-skipped.md', ingest: false, content_state: 'empty' })}\n`,
    );

    const documents = await loadProductDocuments({ productFeaturesDir: fixtureDir });

    expect(documents.map((document) => document.id)).not.toEqual(
      expect.arrayContaining([
        'official_docs:pages/03-empty',
        'official_docs:pages/04-not-found',
        'official_docs:pages/05-skipped',
      ]),
    );
  });
});
