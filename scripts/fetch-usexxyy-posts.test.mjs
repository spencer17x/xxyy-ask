import { describe, expect, it } from 'vitest';

import {
  extractOperation,
  extractTimelinePage,
  findJavaScriptAssetUrls,
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

describe('X web config discovery', () => {
  it('finds current x-web JavaScript assets from modulepreload and module script tags', () => {
    const html = [
      '<link rel="modulepreload" href="https://abs.twimg.com/x-web/x-web/assets/guest-token-B4SeA9gL.js">',
      '<script type="module" src="https://abs.twimg.com/x-web/x-web/entry-client-logged-out-fTRCOKm5.js"></script>',
    ].join('');

    expect(findJavaScriptAssetUrls(html)).toEqual([
      'https://abs.twimg.com/x-web/x-web/assets/guest-token-B4SeA9gL.js',
      'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-fTRCOKm5.js',
    ]);
  });

  it('extracts current Relay persisted query params from x-web chunks', () => {
    const js =
      'params:{id:`CnSnoo277oTfdVQPIsRIbA`,metadata:{},name:`UserTweets`,operationKind:`query`,text:null}';

    expect(extractOperation(js, 'UserTweets')).toEqual({
      fieldToggles: {},
      features: {},
      operationName: 'UserTweets',
      queryId: 'CnSnoo277oTfdVQPIsRIbA',
      variableStyle: 'screenName',
    });
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

  it('extracts tweets and cursors from current x-web timeline payloads', () => {
    const payload = {
      data: {
        user_result_by_screen_name: {
          result: {
            profile_timeline_v2: {
              timeline: {
                instructions: [
                  {
                    entries: [
                      {
                        content: {
                          __typename: 'TimelineTimelineItem',
                          content: {
                            __typename: 'TimelineTweet',
                            tweet_results: {
                              result: {
                                __typename: 'Tweet',
                                core: {
                                  user_results: {
                                    result: {
                                      rest_id: 'author-1',
                                    },
                                  },
                                },
                                counts: {
                                  favorite_count: 3,
                                  reply_count: 1,
                                  retweet_count: 2,
                                },
                                details: {
                                  created_at_ms: 1781256839000,
                                  full_text: '当前 x-web payload',
                                  hashtag_entities: [{ text: 'XXYY' }],
                                },
                                rest_id: '2065366998243303666',
                              },
                            },
                          },
                        },
                      },
                      {
                        content: {
                          __typename: 'TimelineTimelineCursor',
                          cursor_type: 'Bottom',
                          value: 'bottom-cursor',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    };

    const page = extractTimelinePage(payload);

    expect(page.bottomCursor).toBe('bottom-cursor');
    expect(page.tweets).toHaveLength(1);
    expect(page.tweets[0]).toMatchObject({
      details: {
        full_text: '当前 x-web payload',
      },
      rest_id: '2065366998243303666',
    });
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
