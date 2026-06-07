import { describe, expect, it } from 'vitest';

import {
  getLatestPostCutoff,
  mergeXPosts,
  parseScrapeArgs,
  shouldKeepFetchedPost,
} from './fetch-usexxyy-posts.mjs';

describe('parseScrapeArgs', () => {
  it('defaults to incremental scraping and supports explicit full refreshes', () => {
    expect(parseScrapeArgs([])).toEqual({ full: false });
    expect(parseScrapeArgs(['--', '--full'])).toEqual({ full: true });
  });
});

describe('incremental X post helpers', () => {
  const localPosts = [
    post('2026-03-01T08:00:00.000Z', 'older'),
    post('2026-04-05T10:00:00.000Z', 'latest'),
  ];

  it('uses the newest local post date as the incremental cutoff', () => {
    expect(getLatestPostCutoff(localPosts)).toEqual({
      createdAtIso: '2026-04-05T10:00:00.000Z',
      id: 'latest',
    });
  });

  it('keeps only fetched posts newer than the local cutoff', () => {
    const cutoff = getLatestPostCutoff(localPosts);

    expect(shouldKeepFetchedPost(post('2026-04-06T00:00:00.000Z', 'newer'), cutoff)).toBe(true);
    expect(shouldKeepFetchedPost(post('2026-04-05T10:00:00.000Z', 'latest'), cutoff)).toBe(false);
    expect(shouldKeepFetchedPost(post('2026-04-04T23:59:59.000Z', 'older'), cutoff)).toBe(false);
  });

  it('merges newly fetched posts with the existing source JSONL without duplicating ids', () => {
    const merged = mergeXPosts(localPosts, [
      post('2026-04-06T00:00:00.000Z', 'newer'),
      {
        ...post('2026-04-05T10:00:00.000Z', 'latest'),
        fetchedAt: '2026-06-06T00:00:00.000Z',
        text: 'fresh copy from X',
      },
    ]);

    expect(merged.map((item) => item.id)).toEqual(['newer', 'latest', 'older']);
    expect(merged[1]?.text).toBe('fresh copy from X');
  });
});

function post(createdAtIso, id) {
  return {
    account: 'useXXYYio',
    createdAtIso,
    fetchedAt: '2026-05-01T00:00:00.000Z',
    id,
    text: `post ${id}`,
    url: `https://x.com/useXXYYio/status/${id}`,
  };
}
