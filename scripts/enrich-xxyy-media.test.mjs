import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { enrichXxyyMedia, parseVtt, sanitizeOcrLines } from './enrich-xxyy-media.mjs';

describe('enrichXxyyMedia', () => {
  it('creates searchable OCR sidecars and reuses hash-matched results', async () => {
    const cwd = await createFixture();
    let calls = 0;
    const ocrImages = async (paths) => {
      calls += 1;
      return new Map(
        paths.map((imagePath) => [
          imagePath,
          {
            lines: [
              { confidence: 0.9, text: '平均买入成本线' },
              { confidence: 0.2, text: 'noise' },
            ],
          },
        ]),
      );
    };

    const first = await enrichXxyyMedia({
      cwd,
      now: () => new Date('2026-07-19T00:00:00.000Z'),
      ocrImages,
      videoSources: [],
    });
    const second = await enrichXxyyMedia({
      cwd,
      now: () => new Date('2026-07-20T00:00:00.000Z'),
      ocrImages,
      videoSources: [],
    });
    const output = await readFile(
      path.join(cwd, 'docs', 'product-features', 'enriched', 'media', 'image-1.md'),
      'utf8',
    );

    expect(first.images).toMatchObject({ extracted: 1, noText: 0, skipped: false, total: 1 });
    expect(second.images).toMatchObject({ skipped: true });
    expect(calls).toBe(1);
    expect(output).toContain('图表区域：截图文字');
    expect(output).toContain('平均买入成本线');
    expect(output).not.toContain('noise');
  });

  it('creates separate video documents from an injected transcript source', async () => {
    const cwd = await createFixture();
    const result = await enrichXxyyMedia({
      cwd,
      fetchVideoTranscript: () =>
        Promise.resolve({
          language: 'zh',
          method: 'youtube-subtitles',
          text: '开启钱包监控后，在 Telegram 接收实时通知。',
        }),
      now: () => new Date('2026-07-19T00:00:00.000Z'),
      ocrImages: (paths) =>
        Promise.resolve(
          new Map(paths.map((imagePath) => [imagePath, { lines: [{ text: '图表文字' }] }])),
        ),
      videoSources: [
        {
          id: 'video-1',
          kind: 'youtube',
          sourceUrl: 'https://www.youtube.com/watch?v=video-1',
          title: '钱包监控教程',
        },
      ],
    });
    const output = await readFile(
      path.join(cwd, 'docs', 'product-features', 'enriched', 'videos', 'video-1.md'),
      'utf8',
    );

    expect(result.videos).toMatchObject({ extracted: 1, total: 1, warnings: [] });
    expect(output).toContain('开启钱包监控后，在 Telegram 接收实时通知。');
    expect(output).toContain('提取方式：youtube-subtitles');
  });

  it('records verified surrounding text as knowledge coverage when a video has no transcript', async () => {
    const cwd = await createFixture();
    const contextFile = 'pages/video-context.md';
    const absoluteContext = path.join(cwd, 'docs', 'product-features', contextFile);
    await mkdir(path.dirname(absoluteContext), { recursive: true });
    await writeFile(absoluteContext, '# 钱包监控\n\n第一步：创建 Group\n第二步：配置 Bot\n');

    const result = await enrichXxyyMedia({
      cwd,
      fetchVideoTranscript: () => Promise.reject(new Error('captions unavailable')),
      now: () => new Date('2026-07-19T00:00:00.000Z'),
      ocrImages: (paths) =>
        Promise.resolve(
          new Map(paths.map((imagePath) => [imagePath, { lines: [{ text: '图表文字' }] }])),
        ),
      videoSources: [
        {
          id: 'video-with-text',
          kind: 'youtube',
          sourceUrl: 'https://www.youtube.com/watch?v=video-with-text',
          title: '钱包监控教程',
          textCoverage: {
            level: 'full',
            rationale: '同页包含完整操作步骤。',
            sources: [
              {
                file: contextFile,
                requiredMarkers: ['第一步：创建 Group', '第二步：配置 Bot'],
              },
            ],
          },
        },
      ],
    });
    const manifest = JSON.parse(
      await readFile(
        path.join(cwd, 'docs', 'product-features', 'enriched', 'videos', 'manifest.json'),
        'utf8',
      ),
    );

    expect(result.videos).toMatchObject({
      coveredByText: 1,
      extracted: 0,
      knowledgeCovered: 1,
      total: 1,
      unextracted: 1,
      warnings: [],
    });
    expect(result.videos.notices).toEqual([
      expect.stringContaining('full text coverage was verified'),
    ]);
    expect(manifest.videos[0]).toMatchObject({
      status: 'covered_by_text',
      extraction_status: 'unavailable',
      extraction_error: 'captions unavailable',
      knowledge_coverage: 'full',
      coverage_note: '同页包含完整操作步骤。',
      context_sources: [{ file: contextFile, sha256: expect.any(String) }],
    });
  });
});

describe('media text parsing', () => {
  it('deduplicates VTT rolling captions and removes cue metadata', () => {
    const content = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      '<c>打开钱包监控</c>',
      '<c>打开钱包监控</c>',
      '',
      '00:00:02.000 --> 00:00:04.000',
      '连接 Telegram &amp; 开启通知',
    ].join('\n');

    expect(parseVtt(content)).toBe('打开钱包监控\n连接 Telegram & 开启通知');
  });

  it('filters low-confidence OCR noise and redacts probable credentials', () => {
    expect(
      sanitizeOcrLines([
        { confidence: 0.9, text: 'API key: xxyy_ak_realcredential123' },
        { confidence: 0.1, text: 'unreliable' },
        { confidence: 0.9, text: '①' },
      ]),
    ).toEqual([{ confidence: 0.9, text: 'API key: xxyy_ak_[redacted]' }]);
  });
});

async function createFixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'xxyy-media-'));
  const assetsDir = path.join(cwd, 'docs', 'product-features', 'assets');
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, 'image.png'), 'fixture image');
  await writeFile(
    path.join(assetsDir, 'xxyy-docs-assets.json'),
    `${JSON.stringify({
      source: 'https://docs.xxyy.io',
      assets: [
        {
          id: 'image-1',
          file: 'image.png',
          sha256: 'abc123',
          source_pages: ['https://docs.xxyy.io/chart'],
        },
      ],
    })}\n`,
  );
  await writeFile(
    path.join(cwd, 'docs', 'product-features', 'manifest.jsonl'),
    `${JSON.stringify({
      source_url: 'https://docs.xxyy.io/chart',
      section: 'K线区域',
      title: '图表区域',
    })}\n`,
  );
  return cwd;
}
