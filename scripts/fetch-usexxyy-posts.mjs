#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT = 'useXXYYio';
const X_HOME_URL = 'https://x.com';
const X_PROFILE_URL = `${X_HOME_URL}/${ACCOUNT}`;
const GUEST_ACTIVATE_URL = 'https://api.twitter.com/1.1/guest/activate.json';
const OUTPUT_DIR = path.join('docs', 'product-features', 'sources');
const JSONL_FILE = 'usexxyyio-x-posts.jsonl';
const META_FILE = 'usexxyyio-x-posts.meta.json';
const UPDATES_FILE = path.join('docs', 'product-features', 'xxyy-x-updates.md');
const RAW_INDEX_HEADING = '## 可溯源原始消息索引';
const USER_BY_SCREEN_NAME = 'UserByScreenName';
const USER_TWEETS = 'UserTweets';

export async function main(args = process.argv.slice(2)) {
  const options = parseScrapeArgs(args);
  const runtimeConfig = loadScrapeRuntimeConfig();
  const cwd = process.cwd();
  const fetchedAt = new Date().toISOString();
  const outputDir = path.join(cwd, OUTPUT_DIR);
  const jsonlPath = path.join(outputDir, JSONL_FILE);
  const localPosts = await readExistingXPosts(jsonlPath);
  const existingPosts = options.full ? [] : localPosts;
  const cutoff = options.full ? undefined : getLatestPostCutoff(existingPosts);

  const webConfig = await loadXWebConfig();
  const guestToken = await activateGuest(webConfig.bearerToken);
  const headers = createXHeaders(webConfig.bearerToken, guestToken);
  const account = await fetchAccount(webConfig, headers);
  const timelineResult = await fetchTimelinePosts(webConfig, headers, account, {
    cutoff,
    fetchedAt,
    runtimeConfig,
  });
  const fetchedPosts = timelineResult.posts;
  if (options.full) {
    validateFullRefresh({
      allowShrink: options.allowShrink,
      completed: timelineResult.completed,
      existingPostCount: localPosts.length,
      fetchedPostCount: fetchedPosts.length,
      stoppedAtPageCap: timelineResult.stoppedAtPageCap,
    });
  }
  const posts = options.full ? fetchedPosts : mergeXPosts(existingPosts, fetchedPosts);

  await mkdir(outputDir, { recursive: true });
  await writeJsonl(jsonlPath, posts);
  await writeMeta(path.join(outputDir, META_FILE), {
    account,
    coverage: {
      endpoint: 'X web GraphQL UserTweets',
      fetchedPosts: fetchedPosts.length,
      mode: options.full ? 'full' : 'incremental',
      note: 'Covers public profile timeline posts visible to the anonymous X web client. Replies not shown in UserTweets are not included unless X exposes them in the profile timeline.',
      pageSize: runtimeConfig.pageSize,
      traversalCompleted: timelineResult.completed,
      traversalStoppedAtPageCap: timelineResult.stoppedAtPageCap,
      ...(cutoff === undefined
        ? {}
        : {
            cutoffCreatedAtIso: cutoff.createdAtIso,
            cutoffPostId: cutoff.id,
          }),
      totalPosts: posts.length,
    },
    fetchedAt,
    configAssetUrl: webConfig.configAssetUrl,
    operations: {
      userByScreenName: webConfig.operations[USER_BY_SCREEN_NAME],
      userTweets: webConfig.operations[USER_TWEETS],
    },
  });
  await updateRawIndexSection(path.join(cwd, UPDATES_FILE), posts, fetchedAt);

  console.log(
    options.full
      ? `Fetched ${posts.length} @${ACCOUNT} posts.`
      : `Fetched ${fetchedPosts.length} new @${ACCOUNT} posts after ${
          cutoff?.createdAtIso ?? 'the local source start'
        }.`,
  );
  console.log(`Wrote ${posts.length} total @${ACCOUNT} posts.`);
  console.log(`Wrote ${path.join(OUTPUT_DIR, JSONL_FILE)}`);
  console.log(`Wrote ${path.join(OUTPUT_DIR, META_FILE)}`);
  console.log(`Updated ${UPDATES_FILE}`);
}

export function parseScrapeArgs(args) {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  let allowShrink = false;
  let full = false;

  for (const option of normalizedArgs) {
    if (option === '--full') {
      full = true;
      continue;
    }
    if (option === '--allow-shrink') {
      allowShrink = true;
      continue;
    }

    throw new Error(`Unknown option: ${option}`);
  }

  if (allowShrink && !full) {
    throw new Error('--allow-shrink requires --full.');
  }

  return { allowShrink, full };
}

export function loadScrapeRuntimeConfig(env = process.env) {
  return {
    maxPages: parsePositiveInteger(env.XXYY_X_MAX_PAGES, 100, 'XXYY_X_MAX_PAGES'),
    pageSize: parsePositiveInteger(env.XXYY_X_PAGE_SIZE, 40, 'XXYY_X_PAGE_SIZE'),
    requestDelayMs: parseNonNegativeInteger(
      env.XXYY_X_REQUEST_DELAY_MS,
      250,
      'XXYY_X_REQUEST_DELAY_MS',
    ),
  };
}

function parsePositiveInteger(rawValue, fallback, variableName) {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${variableName} must be a positive integer.`);
  }
  return value;
}

function parseNonNegativeInteger(rawValue, fallback, variableName) {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${variableName} must be a non-negative integer.`);
  }
  return value;
}

export function validateFullRefresh(options) {
  if (options.fetchedPostCount === 0) {
    throw new Error('Full X refresh returned no posts; existing knowledge was not replaced.');
  }
  if (!options.completed || options.stoppedAtPageCap) {
    throw new Error('Full X refresh reached the page cap before traversal completed.');
  }
  if (
    options.existingPostCount > 0 &&
    options.fetchedPostCount < options.existingPostCount * 0.8 &&
    !options.allowShrink
  ) {
    throw new Error(
      `Full X refresh shrank from ${options.existingPostCount} to ${options.fetchedPostCount} posts; rerun with --allow-shrink only after verifying the upstream change.`,
    );
  }
}

async function loadXWebConfig() {
  const html = await fetchText(X_PROFILE_URL);
  const queue = prioritizeJavaScriptAssetUrls(findJavaScriptAssetUrls(html));
  const seen = new Set();
  const operations = {};
  let bearerToken;
  let configAssetUrl;

  while (
    queue.length > 0 &&
    (bearerToken === undefined ||
      operations[USER_BY_SCREEN_NAME] === undefined ||
      operations[USER_TWEETS] === undefined)
  ) {
    const assetUrl = queue.shift();
    if (assetUrl === undefined || seen.has(assetUrl)) {
      continue;
    }
    seen.add(assetUrl);

    const js = await fetchText(assetUrl);
    const token = findBearerTokenInText(js);
    if (bearerToken === undefined && token !== undefined) {
      bearerToken = token;
      configAssetUrl = assetUrl;
    }

    for (const operationName of [USER_BY_SCREEN_NAME, USER_TWEETS]) {
      if (operations[operationName] === undefined) {
        const operation = extractOptionalOperation(js, operationName);
        if (operation !== undefined) {
          operations[operationName] = operation;
          configAssetUrl ??= assetUrl;
        }
      }
    }

    for (const importedAssetUrl of findRelativeJavaScriptImports(js, assetUrl).reverse()) {
      if (!seen.has(importedAssetUrl)) {
        queue.unshift(importedAssetUrl);
      }
    }
  }

  if (bearerToken === undefined) {
    throw new Error('Unable to find X web bearer token.');
  }
  for (const operationName of [USER_BY_SCREEN_NAME, USER_TWEETS]) {
    if (operations[operationName] === undefined) {
      throw new Error(`Unable to find X GraphQL operation ${operationName}.`);
    }
  }

  return {
    bearerToken,
    configAssetUrl: configAssetUrl ?? X_PROFILE_URL,
    operations,
  };
}

export function findJavaScriptAssetUrls(html) {
  return Array.from(
    new Set(
      Array.from(
        html.matchAll(
          /https:\/\/abs\.twimg\.com\/(?:responsive-web\/client-web|x-web\/x-web)\/[^"'<>\s]+\.js/gu,
        ),
        (match) => match[0],
      ),
    ),
  );
}

function prioritizeJavaScriptAssetUrls(urls) {
  return [...urls].sort((left, right) => assetPriority(right) - assetPriority(left));
}

function assetPriority(url) {
  if (url.includes('/main.')) {
    return 100;
  }
  if (url.includes('guest-token')) {
    return 90;
  }
  if (url.includes('user-profile')) {
    return 80;
  }
  if (url.includes('profile')) {
    return 70;
  }
  return 0;
}

function findRelativeJavaScriptImports(js, baseUrl) {
  return Array.from(
    new Set(
      Array.from(js.matchAll(/(?:from|import\s*\()\s*[`'"]\.\/([^`'"]+\.js)[`'"]/gu), (match) =>
        new URL(match[1], baseUrl).toString(),
      ),
    ),
  );
}

function findBearerTokenInText(js) {
  const match = /Bearer ([A-Za-z0-9%]+)/u.exec(js);
  const encoded = match?.[1];
  if (encoded === undefined) {
    return undefined;
  }

  return decodeURIComponent(encoded);
}

export function extractOperation(js, operationName) {
  const legacyOperation = extractLegacyOperation(js, operationName);
  if (legacyOperation !== undefined) {
    return legacyOperation;
  }

  const relayOperation = extractRelayOperation(js, operationName);
  if (relayOperation !== undefined) {
    return relayOperation;
  }

  throw new Error(`Unable to find X GraphQL operation ${operationName}.`);
}

function extractOptionalOperation(js, operationName) {
  try {
    return extractOperation(js, operationName);
  } catch {
    return undefined;
  }
}

function extractLegacyOperation(js, operationName) {
  const operationPattern = new RegExp(
    `queryId:"([^"]+)",operationName:"${escapeRegExp(operationName)}",operationType:"query",metadata:\\{featureSwitches:\\[(.*?)\\],fieldToggles:\\[(.*?)\\]`,
    'u',
  );
  const match = operationPattern.exec(js);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return undefined;
  }

  return {
    queryId: match[1],
    operationName,
    features: Object.fromEntries(extractQuotedValues(match[2]).map((feature) => [feature, true])),
    fieldToggles: Object.fromEntries(
      extractQuotedValues(match[3] ?? '').map((fieldToggle) => [fieldToggle, true]),
    ),
    variableStyle: operationName === USER_TWEETS ? 'userId' : 'screenName',
  };
}

function extractRelayOperation(js, operationName) {
  const operationPattern = new RegExp(
    `params:\\{id:\`([^\`]+)\`,metadata:\\{[^}]*\\},name:\`${escapeRegExp(
      operationName,
    )}\`,operationKind:\`query\`,text:null(?:,providedVariables:\\{([^}]*)\\})?`,
    'u',
  );
  const match = operationPattern.exec(js);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const providedVariables = extractProvidedVariables(match[2] ?? '');

  return {
    queryId: match[1],
    operationName,
    features: {},
    fieldToggles: {},
    ...(Object.keys(providedVariables).length === 0 ? {} : { providedVariables }),
    variableStyle: 'screenName',
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractQuotedValues(value) {
  return Array.from(value.matchAll(/"([^"]+)"/gu), (match) => match[1]).filter(
    (item) => item !== undefined,
  );
}

function extractProvidedVariables(value) {
  return Object.fromEntries(
    Array.from(new Set(Array.from(value.matchAll(/([A-Za-z_$][\w$]*)\s*:/gu), (match) => match[1])))
      .filter((name) => name !== undefined)
      .map((name) => [name, resolveProvidedVariableValue(name)]),
  );
}

function resolveProvidedVariableValue(name) {
  if (name === '__relay_internal__pv__appviewerisloggedinprovider') {
    return false;
  }

  return false;
}

async function activateGuest(bearerToken) {
  const response = await fetchWithRetry(GUEST_ACTIVATE_URL, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'User-Agent': 'Mozilla/5.0',
    },
    method: 'POST',
  });
  const payload = await response.json();
  if (typeof payload.guest_token !== 'string') {
    throw new Error('X guest activation did not return a guest token.');
  }

  return payload.guest_token;
}

function createXHeaders(bearerToken, guestToken) {
  return {
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Authorization: `Bearer ${bearerToken}`,
    'User-Agent': 'Mozilla/5.0',
    'x-guest-token': guestToken,
    'x-twitter-active': 'yes',
    'x-twitter-client-language': 'zh-cn',
  };
}

async function fetchAccount(webConfig, headers) {
  const operation = webConfig.operations[USER_BY_SCREEN_NAME];
  const payload = await fetchGraphql(operation, headers, {
    [operation.variableStyle === 'screenName' ? 'screenName' : 'screen_name']: ACCOUNT,
  });
  const result =
    payload.data?.user?.result ?? payload.data?.user_result_by_screen_name?.result ?? {};
  const user = result.user ?? result;
  if (user.rest_id === undefined) {
    throw new Error(`Unable to resolve @${ACCOUNT}.`);
  }

  return {
    createdAt: user.core?.created_at ?? toUtcDate(user.core?.created_at_ms),
    description: user.legacy?.description ?? user.profile_bio?.description,
    name: user.core?.name,
    restId: user.rest_id,
    screenName: user.core?.screen_name,
    url: `https://x.com/${ACCOUNT}`,
  };
}

async function fetchTimelinePosts(webConfig, headers, account, options) {
  const operation = webConfig.operations[USER_TWEETS];
  const { maxPages, pageSize, requestDelayMs } = options.runtimeConfig;
  const seen = new Map();
  let completed = false;
  let cursor;
  let stoppedAtPageCap = false;

  for (let page = 0; page < maxPages; page += 1) {
    const variables = createTimelineVariables(operation, account, cursor, pageSize);
    const payload = await fetchGraphql(operation, headers, variables);
    const { bottomCursor, tweets } = extractTimelinePage(payload);
    let reachedCutoff = false;
    let newCount = 0;

    for (const tweet of tweets) {
      const record = normalizeTweet(tweet, options.fetchedAt);
      if (record.id === undefined) {
        continue;
      }
      if (!shouldKeepFetchedPost(record, options.cutoff)) {
        reachedCutoff = true;
        continue;
      }
      if (!seen.has(record.id)) {
        seen.set(record.id, record);
        newCount += 1;
      }
    }

    if (reachedCutoff || bottomCursor === undefined || bottomCursor === cursor) {
      completed = true;
      break;
    }
    if (newCount === 0) {
      break;
    }
    if (page + 1 >= maxPages) {
      stoppedAtPageCap = true;
      break;
    }

    cursor = bottomCursor;
    await delay(requestDelayMs);
  }

  return {
    completed,
    posts: Array.from(seen.values()).sort((left, right) =>
      right.createdAtIso.localeCompare(left.createdAtIso),
    ),
    stoppedAtPageCap,
  };
}

function createTimelineVariables(operation, account, cursor, pageSize) {
  if (operation.variableStyle === 'screenName') {
    return {
      screenName: account.screenName ?? ACCOUNT,
      count: pageSize,
      cursor: cursor ?? null,
    };
  }

  return {
    userId: account.restId,
    count: pageSize,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

async function readExistingXPosts(filePath) {
  let rawContent;
  try {
    rawContent = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  return rawContent
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid X post source entry on line ${index + 1}.`, { cause: error });
      }
    });
}

export function getLatestPostCutoff(posts) {
  const latest = posts
    .filter((post) => typeof post.createdAtIso === 'string' && post.createdAtIso.length > 0)
    .sort((left, right) => right.createdAtIso.localeCompare(left.createdAtIso))[0];

  if (latest?.createdAtIso === undefined) {
    return undefined;
  }

  return {
    createdAtIso: latest.createdAtIso,
    id: latest.id,
  };
}

export function shouldKeepFetchedPost(post, cutoff) {
  if (cutoff === undefined) {
    return true;
  }
  if (typeof post.createdAtIso !== 'string' || post.createdAtIso.length === 0) {
    return true;
  }

  return post.createdAtIso > cutoff.createdAtIso;
}

export function mergeXPosts(existingPosts, fetchedPosts) {
  const merged = new Map();

  for (const post of existingPosts) {
    if (typeof post.id === 'string') {
      merged.set(post.id, post);
    }
  }
  for (const post of fetchedPosts) {
    if (typeof post.id === 'string') {
      merged.set(post.id, post);
    }
  }

  return Array.from(merged.values()).sort(comparePostsByCreatedAtDesc);
}

function comparePostsByCreatedAtDesc(left, right) {
  const dateCompare = String(right.createdAtIso ?? '').localeCompare(
    String(left.createdAtIso ?? ''),
  );
  if (dateCompare !== 0) {
    return dateCompare;
  }

  return String(right.id ?? '').localeCompare(String(left.id ?? ''));
}

async function fetchGraphql(operation, headers, variables) {
  const params = createGraphqlRequestParams(operation, variables);
  const url = `https://x.com/i/api/graphql/${operation.queryId}/${operation.operationName}?${params.toString()}`;
  const response = await fetchWithRetry(url, { headers });

  return response.json();
}

export function createGraphqlRequestParams(operation, variables) {
  const params = new URLSearchParams({
    variables: JSON.stringify({
      ...(operation.providedVariables ?? {}),
      ...variables,
    }),
    features: JSON.stringify(operation.features),
  });
  if (Object.keys(operation.fieldToggles).length > 0) {
    params.set('fieldToggles', JSON.stringify(operation.fieldToggles));
  }
  return params;
}

async function fetchWithRetry(url, init = {}) {
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}: ${url}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      await delay(500 * (attempt + 1));
    }
  }

  throw lastError;
}

async function fetchText(url) {
  const response = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });
  return response.text();
}

export function extractTimelinePage(payload) {
  const entries = collectEntries(payload);
  const tweets = [];
  let bottomCursor;

  for (const entry of entries) {
    const content = entry.content ?? {};
    if (
      (content.entryType === 'TimelineTimelineCursor' ||
        content.__typename === 'TimelineTimelineCursor') &&
      (content.cursorType ?? content.cursor_type) === 'Bottom' &&
      typeof content.value === 'string'
    ) {
      bottomCursor = content.value;
    }

    for (const candidate of tweetCandidates(content)) {
      const tweet = unwrapTweet(candidate);
      if (tweet !== undefined) {
        tweets.push(tweet);
      }
    }
  }

  return { bottomCursor, tweets };
}

function collectEntries(value) {
  const entries = [];

  function walk(item) {
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (item === null || typeof item !== 'object') {
      return;
    }
    if (Array.isArray(item.entries)) {
      entries.push(...item.entries);
    }
    Object.values(item).forEach(walk);
  }

  walk(value);
  return entries;
}

function tweetCandidates(content) {
  const candidates = [];
  const itemContent = content.itemContent ?? {};
  candidates.push(itemContent.tweet_results?.result);
  candidates.push(content.content?.tweet_results?.result);
  candidates.push(content.tweet_results?.result);

  for (const moduleItem of content.items ?? []) {
    const item = moduleItem.item ?? {};
    const moduleItemContent = item.itemContent ?? moduleItem.itemContent ?? {};
    candidates.push(moduleItemContent.tweet_results?.result);
    candidates.push(item.content?.tweet_results?.result);
    candidates.push(moduleItem.content?.tweet_results?.result);
  }

  return candidates;
}

function unwrapTweet(result) {
  if (result?.__typename === 'TweetWithVisibilityResults') {
    return unwrapTweet(result.tweet);
  }
  if (result?.__typename !== 'Tweet') {
    return undefined;
  }

  return result;
}

function normalizeTweet(tweet, fetchedAt) {
  const legacy = tweet.legacy ?? {};
  const details = tweet.details ?? {};
  const counts = tweet.counts ?? {};
  const id = tweet.rest_id ?? legacy.id_str;
  const quotedTweet = unwrapTweet(
    tweet.quoted_status_result?.result ?? tweet.quoted_tweet_results?.result,
  );
  const text = extractTweetText(tweet);
  const createdAt = legacy.created_at ?? toUtcDate(details.created_at_ms);
  const createdAtIso = toIsoDate(legacy.created_at ?? details.created_at_ms);

  return withoutUndefined({
    id,
    url: id === undefined ? undefined : `https://x.com/${ACCOUNT}/status/${id}`,
    account: ACCOUNT,
    authorId: tweet.core?.user_results?.result?.rest_id,
    createdAt,
    createdAtIso,
    fetchedAt,
    lang: legacy.lang,
    text,
    conversationId: legacy.conversation_id_str,
    inReplyToStatusId: legacy.in_reply_to_status_id_str,
    inReplyToScreenName: legacy.in_reply_to_screen_name,
    isReply: legacy.in_reply_to_status_id_str !== undefined,
    isQuote: quotedTweet !== undefined,
    quotedTweet: quotedTweet === undefined ? undefined : normalizeQuotedTweet(quotedTweet),
    hashtags: (legacy.entities?.hashtags ?? details.hashtag_entities ?? [])
      .map((hashtag) => hashtag.text)
      .filter(Boolean),
    urls: extractUrls(legacy.entities?.urls ?? tweet.url_entities ?? []),
    media: extractMedia(
      legacy.extended_entities?.media ?? legacy.entities?.media ?? tweet.media_entities2 ?? [],
    ),
    metrics: withoutUndefined({
      bookmarkCount: legacy.bookmark_count ?? counts.bookmark_count,
      favoriteCount: legacy.favorite_count ?? counts.favorite_count,
      quoteCount: legacy.quote_count ?? counts.quote_count,
      replyCount: legacy.reply_count ?? counts.reply_count,
      retweetCount: legacy.retweet_count ?? counts.retweet_count,
      viewCount: tweet.views?.count,
    }),
    source: {
      api: 'x.com/i/api/graphql',
      operation: USER_TWEETS,
    },
  });
}

function normalizeQuotedTweet(tweet) {
  const legacy = tweet.legacy ?? {};
  const id = tweet.rest_id ?? legacy.id_str;

  return withoutUndefined({
    id,
    url: id === undefined ? undefined : `https://x.com/i/web/status/${id}`,
    createdAt: legacy.created_at,
    createdAtIso: toIsoDate(legacy.created_at),
    text: extractTweetText(tweet),
    screenName: tweet.core?.user_results?.result?.core?.screen_name,
  });
}

function extractTweetText(tweet) {
  const text = (
    tweet.note_tweet?.note_tweet_results?.result?.text ??
    tweet.legacy?.full_text ??
    tweet.details?.full_text ??
    ''
  ).trim();

  return decodeHtmlEntities(text);
}

function decodeHtmlEntities(text) {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function toIsoDate(xDate) {
  if (typeof xDate !== 'string' && typeof xDate !== 'number') {
    return '';
  }

  return new Date(xDate).toISOString();
}

function toUtcDate(xDate) {
  if (typeof xDate !== 'number' && typeof xDate !== 'string') {
    return undefined;
  }

  return new Date(xDate).toUTCString();
}

function extractUrls(urls) {
  return urls
    .map((url) =>
      withoutUndefined({
        displayUrl: url.display_url,
        expandedUrl: url.expanded_url,
        url: url.url,
      }),
    )
    .filter((url) => url.url !== undefined || url.expandedUrl !== undefined);
}

function extractMedia(mediaItems) {
  return mediaItems
    .map((media) =>
      withoutUndefined({
        id: media.id_str,
        type: media.type,
        mediaUrl: media.media_url_https,
        expandedUrl: media.expanded_url,
        url: media.url,
      }),
    )
    .filter((media) => media.id !== undefined || media.mediaUrl !== undefined);
}

function withoutUndefined(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value === undefined) {
        return false;
      }
      if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) {
        return false;
      }
      return true;
    }),
  );
}

async function writeJsonl(filePath, posts) {
  const body = `${posts.map((post) => JSON.stringify(post)).join('\n')}\n`;
  await writeFileAtomically(filePath, body);
}

async function writeMeta(filePath, metadata) {
  await writeFileAtomically(filePath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function updateRawIndexSection(filePath, posts, fetchedAt) {
  const current = await readFile(filePath, 'utf8');
  const headingIndex = current.indexOf(`\n${RAW_INDEX_HEADING}\n`);
  const base = headingIndex >= 0 ? current.slice(0, headingIndex).trimEnd() : current.trimEnd();
  const section = renderRawIndexSection(posts, fetchedAt);
  await writeFileAtomically(filePath, `${base}\n\n${section}\n`);
}

async function writeFileAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, contents, 'utf8');
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function renderRawIndexSection(posts, fetchedAt) {
  const lines = [
    RAW_INDEX_HEADING,
    '',
    `抓取时间：${fetchedAt}`,
    '',
    `原始可溯源数据：[\`${JSONL_FILE}\`](sources/${JSONL_FILE})；抓取元数据：[\`${META_FILE}\`](sources/${META_FILE})。`,
    '',
    '说明：以下索引来自 X Web 公开主页时间线 `UserTweets`，每条均保留 tweet id 和原始链接，便于回溯核验。',
    '',
  ];
  let currentMonth = '';

  for (const post of posts) {
    const month = post.createdAtIso.slice(0, 7);
    if (month !== currentMonth) {
      currentMonth = month;
      lines.push(`### ${month}`, '');
    }

    lines.push(`#### ${post.createdAtIso} · [${post.id}](${post.url})`);
    lines.push('');
    lines.push(toMarkdownQuote(post.text));
    lines.push('');
  }

  return lines.join('\n');
}

function toMarkdownQuote(text) {
  const compact = text.replace(/\r?\n/gu, '\n').trim();
  if (compact.length === 0) {
    return '> ';
  }

  return compact
    .split('\n')
    .map((line) => `> ${line.trim()}`)
    .join('\n');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isMissingFileError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isDirectRun() {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
