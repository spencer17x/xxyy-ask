import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SourceDocument } from '@xxyy/shared';

import { loadProductDocuments } from './load-documents.js';

async function createProductDocsFixture(): Promise<string> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'xxyy-knowledge-docs-'));
  const pagesDir = path.join(fixtureDir, 'pages');
  await mkdir(pagesDir);

  await writeFile(
    path.join(fixtureDir, 'xxyy-product-functions.md'),
    '# XXYY 产品功能整理文档\n\nXXYY supports Solana trading.\n',
  );
  await writeFile(
    path.join(fixtureDir, 'xxyy-x-updates.md'),
    '# XXYY X 历史推文产品更新汇总\n\nTelegram monitoring shipped.\n',
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
        retrieved_at: '2026-05-24T06:41:04.265Z',
        file: '02-readme__quickstart.md',
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
    expect(documents[2]).toMatchObject({
      title: '新手必看',
      module: '新手入门',
      sourceType: 'official_docs',
      order: 2,
      sourceUrl: 'https://docs.xxyy.io/readme/quickstart',
      retrievedAt: '2026-05-24T06:41:04.265Z',
    });
    expect(documents[2]?.file).toBe(path.join(fixtureDir, 'pages', '02-readme__quickstart.md'));
    expect(documents[2]?.content).toContain('生成交易钱包后即可开始交易。');
  });
});
