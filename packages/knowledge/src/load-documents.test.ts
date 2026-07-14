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
      'official_docs:xxyy-product-functions',
      'x_updates:xxyy-x-updates',
      'x_updates:sources/usexxyyio-x-posts/2030954722350575916',
      'official_docs:pages/02-readme__quickstart',
    ]);

    expect(documents[0]).toMatchObject({
      title: 'XXYY 产品功能整理文档',
      module: '产品功能',
      sourceType: 'official_docs',
    });
    expect(documents[1]).toMatchObject({
      title: 'XXYY X 历史推文产品更新汇总',
      module: 'X Updates',
      sourceType: 'x_updates',
    });
    expect(documents[1]?.content).toContain('Telegram monitoring shipped.');
    expect(documents[1]?.content).not.toContain('可溯源原始消息索引');
    expect(documents[1]?.content).not.toContain('钱包备注支持最多 1 万条');
    expect(documents[2]).toMatchObject({
      title: 'X Post 2030954722350575916',
      module: 'X / @useXXYYio / 2026-03',
      sourceType: 'x_updates',
      sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
      effectiveAt: '2026-03-09T10:31:53.000Z',
      retrievedAt: '2026-06-06T04:40:24.279Z',
      status: 'current',
    });
    expect(documents[2]?.content).toContain('钱包备注支持最多 1 万条');
    expect(documents[3]).toMatchObject({
      title: '新手必看',
      module: '新手入门',
      sourceType: 'official_docs',
      order: 2,
      sourceUrl: 'https://docs.xxyy.io/readme/quickstart',
      effectiveAt: '2026-03-16T11:12:30.350Z',
      retrievedAt: '2026-05-24T06:41:04.265Z',
      status: 'current',
    });
    expect(documents[3]?.file).toBe(path.join(fixtureDir, 'pages', '02-readme__quickstart.md'));
    expect(documents[3]?.content).toContain('生成交易钱包后即可开始交易。');
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
});
