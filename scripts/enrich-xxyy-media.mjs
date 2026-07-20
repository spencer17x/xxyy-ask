#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VIDEO_SOURCES } from './xxyy-video-sources.mjs';

export { VIDEO_SOURCES } from './xxyy-video-sources.mjs';

const PRODUCT_FEATURES_DIR = path.join('docs', 'product-features');
const ASSET_MANIFEST = path.join(PRODUCT_FEATURES_DIR, 'assets', 'xxyy-docs-assets.json');
const PAGE_MANIFEST = path.join(PRODUCT_FEATURES_DIR, 'manifest.jsonl');
const IMAGE_OUTPUT_DIR = path.join(PRODUCT_FEATURES_DIR, 'enriched', 'media');
const VIDEO_OUTPUT_DIR = path.join(PRODUCT_FEATURES_DIR, 'enriched', 'videos');
const MANIFEST_FILE = 'manifest.json';
const OCR_VERSION = 1;
const VIDEO_ENRICHMENT_VERSION = 3;
const FRAME_INTERVAL_SECONDS = 2;
const DEFAULT_OCR_CONFIDENCE = 0.28;

export async function enrichXxyyMedia(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const runCommand = options.runCommand ?? runProcess;
  const ocrImages = options.ocrImages ?? (await createOcrProvider({ cwd, env, runCommand }));
  const images = await enrichImageAssets({ cwd, env, now, ocrImages });
  const videos = await enrichVideos({
    cwd,
    env,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    fetchVideoTranscript: options.fetchVideoTranscript,
    now,
    ocrImages,
    runCommand,
    videoSources: options.videoSources ?? VIDEO_SOURCES,
  });
  return { images, videos };
}

export async function enrichImageAssets({ cwd, env = process.env, now, ocrImages }) {
  const assetManifestPath = path.resolve(cwd, ASSET_MANIFEST);
  const outputDir = path.resolve(cwd, IMAGE_OUTPUT_DIR);
  const parsedManifest = validateAssetManifest(
    JSON.parse(await readFile(assetManifestPath, 'utf8')),
  );
  const pages = await readPageMetadata(path.resolve(cwd, PAGE_MANIFEST));
  const previous = await readOptionalJson(path.join(outputDir, MANIFEST_FILE));
  const previousById = new Map(
    Array.isArray(previous?.assets)
      ? previous.assets
          .filter((entry) => isObject(entry) && typeof entry.id === 'string')
          .map((entry) => [entry.id, entry])
      : [],
  );
  const force = env.MEDIA_FORCE === 'true';
  const reusable = [];
  const pending = [];

  for (const asset of parsedManifest.assets) {
    const prior = previousById.get(asset.id);
    const canReuse =
      !force &&
      isReusableImageResult(prior, asset) &&
      (prior.output === undefined ||
        (await fileHashMatches(path.join(outputDir, prior.output), prior.output_sha256)));
    if (canReuse) {
      reusable.push(prior);
    } else {
      pending.push(asset);
    }
  }

  if (pending.length === 0 && reusable.length === parsedManifest.assets.length) {
    return summarizeImageResults(reusable, true);
  }

  const absolutePaths = pending.map((asset) =>
    path.resolve(cwd, PRODUCT_FEATURES_DIR, 'assets', asset.file),
  );
  const rawResults = pending.length === 0 ? new Map() : await ocrImages(absolutePaths);
  const retrievedAt = now().toISOString();
  await mkdir(outputDir, { recursive: true });
  const generated = [];

  for (const [index, asset] of pending.entries()) {
    const assetPath = absolutePaths[index];
    if (assetPath === undefined) {
      throw new Error(`Missing OCR path for asset ${asset.id}`);
    }
    const rawResult = rawResults.get(assetPath);
    if (rawResult === undefined) {
      throw new Error(`OCR provider returned no result for ${asset.file}`);
    }
    if (rawResult.error !== undefined) {
      throw new Error(`OCR failed for ${asset.file}: ${rawResult.error}`);
    }
    const lines = sanitizeOcrLines(rawResult.lines);
    const entry = {
      id: asset.id,
      file: asset.file,
      sha256: asset.sha256,
      source_pages: asset.source_pages,
      status: lines.length === 0 ? 'no_text' : 'extracted',
      line_count: lines.length,
      ...(lines.length === 0 ? {} : { output: `${asset.id}.md` }),
    };
    if (lines.length > 0) {
      const document = createImageOcrDocument({ asset, lines, pages, retrievedAt });
      entry.output_sha256 = sha256(document);
      await atomicWriteFile(path.join(outputDir, entry.output), document);
    }
    generated.push(entry);
  }

  const results = [...reusable, ...generated].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  await pruneMarkdown(outputDir, new Set(results.flatMap((entry) => entry.output ?? [])));
  await atomicWriteFile(
    path.join(outputDir, MANIFEST_FILE),
    `${JSON.stringify(
      {
        version: OCR_VERSION,
        provider: 'local-ocr',
        generated_at: retrievedAt,
        source_manifest: normalizePath(path.relative(cwd, assetManifestPath)),
        assets: results,
      },
      null,
      2,
    )}\n`,
  );
  return summarizeImageResults(results, false);
}

export function createImageOcrDocument({ asset, lines, pages, retrievedAt }) {
  const sourcePages = asset.source_pages;
  const page = pages.get(sourcePages[0]);
  const pageTitle = page?.title ?? 'XXYY 产品文档';
  const title = `${pageTitle}：截图文字`;
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `section: ${JSON.stringify(`${page?.section ?? '产品文档'} / 图片 OCR`)}`,
    `source_url: ${JSON.stringify(sourcePages[0])}`,
    `retrieved_at: ${JSON.stringify(retrievedAt)}`,
    'status: current',
    '---',
    '',
    `# ${title}`,
    '',
    '> 以下文字由本地 OCR 从官方文档截图提取，仅作为页面正文的补充证据；排版、图标和个别字符可能识别不准确。',
    '',
    `- 图片文件：${asset.file}`,
    `- 图片 SHA-256：${asset.sha256}`,
    `- 来源页面：${sourcePages.join('、')}`,
    '',
    '## OCR 文字',
    '',
    ...lines.map((line) => line.text),
    '',
  ].join('\n');
}

export async function enrichVideos({
  cwd,
  env,
  fetchImpl,
  fetchVideoTranscript,
  now,
  ocrImages,
  runCommand,
  videoSources,
}) {
  const outputDir = path.resolve(cwd, VIDEO_OUTPUT_DIR);
  const previous = await readOptionalJson(path.join(outputDir, MANIFEST_FILE));
  const previousById = new Map(
    Array.isArray(previous?.videos)
      ? previous.videos
          .filter((entry) => isObject(entry) && typeof entry.id === 'string')
          .map((entry) => [entry.id, entry])
      : [],
  );
  const force = env.MEDIA_FORCE === 'true';
  const retrievedAt = now().toISOString();
  const results = [];
  const notices = [];
  const warnings = [];
  await mkdir(outputDir, { recursive: true });

  for (const source of videoSources) {
    let textCoverage;
    let textCoverageError;
    try {
      textCoverage = await resolveVideoTextCoverage(cwd, source);
    } catch (error) {
      textCoverageError = error instanceof Error ? error.message : String(error);
    }
    const fingerprint = await videoFingerprint(cwd, source, textCoverage);
    if (fingerprint === undefined) {
      warnings.push(`${source.id}: source file is missing`);
      results.push({ id: source.id, kind: source.kind, status: 'missing' });
      continue;
    }
    const prior = previousById.get(source.id);
    if (
      !force &&
      isObject(prior) &&
      prior.fingerprint === fingerprint &&
      typeof prior.output === 'string' &&
      (await fileHashMatches(path.join(outputDir, prior.output), prior.output_sha256))
    ) {
      results.push(prior);
      continue;
    }

    try {
      const extracted =
        source.kind === 'local'
          ? await extractLocalVideo({ cwd, env, ocrImages, runCommand, source })
          : await extractYoutubeVideo({
              cwd,
              env,
              fetchImpl,
              fetchVideoTranscript,
              runCommand,
              source,
            });
      const output = `${source.id}.md`;
      const document = createVideoDocument({ extracted, retrievedAt, source });
      await atomicWriteFile(path.join(outputDir, output), document);
      results.push({
        id: source.id,
        kind: source.kind,
        source_url: source.sourceUrl,
        fingerprint,
        method: extracted.method,
        output,
        output_sha256: sha256(document),
        extraction_status: 'extracted',
        knowledge_coverage: 'video_extracted',
        status: 'extracted',
        text_chars: extracted.text.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (textCoverage !== undefined) {
        notices.push(
          `${source.id}: video extraction is unavailable, but ${textCoverage.level} text coverage was verified`,
        );
        results.push({
          id: source.id,
          kind: source.kind,
          source_url: source.sourceUrl,
          fingerprint,
          status: 'covered_by_text',
          extraction_status: 'unavailable',
          extraction_error: message,
          knowledge_coverage: textCoverage.level,
          coverage_note: textCoverage.rationale,
          context_sources: textCoverage.sources,
        });
      } else {
        const details =
          textCoverageError === undefined
            ? message
            : `${message}; text coverage could not be verified: ${textCoverageError}`;
        warnings.push(`${source.id}: ${details}`);
        results.push({
          id: source.id,
          kind: source.kind,
          source_url: source.sourceUrl,
          fingerprint,
          status: 'unavailable',
          error: details,
        });
      }
    }
  }

  await pruneMarkdown(outputDir, new Set(results.flatMap((entry) => entry.output ?? [])));
  await atomicWriteFile(
    path.join(outputDir, MANIFEST_FILE),
    `${JSON.stringify(
      {
        version: VIDEO_ENRICHMENT_VERSION,
        generated_at: retrievedAt,
        videos: results,
        notices,
        warnings,
      },
      null,
      2,
    )}\n`,
  );
  const extracted = results.filter((entry) => entry.status === 'extracted').length;
  const coveredByText = results.filter((entry) => entry.status === 'covered_by_text').length;
  return {
    coveredByText,
    extracted,
    knowledgeCovered: extracted + coveredByText,
    notices,
    total: results.length,
    unextracted: results.length - extracted,
    warnings,
  };
}

export async function resolveVideoTextCoverage(cwd, source) {
  const configured = source.textCoverage;
  if (configured === undefined) {
    return undefined;
  }
  if (
    (configured.level !== 'full' && configured.level !== 'core') ||
    typeof configured.rationale !== 'string' ||
    configured.rationale.trim().length === 0 ||
    !Array.isArray(configured.sources) ||
    configured.sources.length === 0
  ) {
    throw new Error(`${source.id}: invalid text coverage configuration`);
  }

  const productDir = path.resolve(cwd, PRODUCT_FEATURES_DIR);
  const sources = [];
  for (const reference of configured.sources) {
    if (
      !isObject(reference) ||
      typeof reference.file !== 'string' ||
      reference.file.length === 0 ||
      !Array.isArray(reference.requiredMarkers) ||
      reference.requiredMarkers.length === 0
    ) {
      throw new Error(`${source.id}: invalid text coverage source`);
    }
    const absoluteFile = path.resolve(productDir, reference.file);
    if (absoluteFile !== productDir && !absoluteFile.startsWith(`${productDir}${path.sep}`)) {
      throw new Error(`${source.id}: text coverage source escapes the product directory`);
    }
    const content = await readFile(absoluteFile, 'utf8');
    const missingMarker = reference.requiredMarkers.find(
      (marker) => typeof marker !== 'string' || !content.includes(marker),
    );
    if (missingMarker !== undefined) {
      throw new Error(
        `${source.id}: ${reference.file} is missing coverage marker ${JSON.stringify(missingMarker)}`,
      );
    }
    sources.push({
      file: normalizePath(path.relative(productDir, absoluteFile)),
      sha256: sha256(content),
    });
  }

  return {
    level: configured.level,
    rationale: configured.rationale,
    sources,
  };
}

export function createVideoDocument({ extracted, retrievedAt, source }) {
  const evidenceLabel = extracted.method === 'keyframe-ocr' ? '关键帧 OCR 文字' : '字幕 / 转写文本';
  return [
    '---',
    `title: ${JSON.stringify(source.title)}`,
    'section: "产品教程视频"',
    `source_url: ${JSON.stringify(source.sourceUrl)}`,
    `retrieved_at: ${JSON.stringify(retrievedAt)}`,
    'status: current',
    '---',
    '',
    `# ${source.title}`,
    '',
    `> 以下内容通过${extracted.method === 'keyframe-ocr' ? '本地关键帧 OCR' : '视频字幕或音频转写'}提取，仅作为官方视频的可检索文本补充。`,
    '',
    `- 视频：${source.sourceUrl}`,
    `- 提取方式：${extracted.method}`,
    ...(extracted.language === undefined ? [] : [`- 语言：${extracted.language}`]),
    '',
    ...(source.reviewedSummary === undefined
      ? []
      : ['## 已审核操作摘要', '', source.reviewedSummary, '']),
    `## ${evidenceLabel}`,
    '',
    extracted.text,
    '',
  ].join('\n');
}

async function extractLocalVideo({ cwd, env, ocrImages, runCommand, source }) {
  if (!(await commandExists('ffmpeg', runCommand))) {
    throw new Error('ffmpeg is required for local video keyframe extraction');
  }
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'xxyy-video-frames-'));
  try {
    const absoluteVideo = path.resolve(cwd, source.path);
    const framePattern = path.join(temporaryDir, 'frame-%04d.jpg');
    const result = await runCommand('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      absoluteVideo,
      '-vf',
      `fps=1/${env.MEDIA_VIDEO_FRAME_INTERVAL_SECONDS ?? FRAME_INTERVAL_SECONDS}`,
      '-q:v',
      '2',
      framePattern,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`ffmpeg failed: ${truncate(result.stderr, 500)}`);
    }
    const frameFiles = (await readdir(temporaryDir))
      .filter((file) => /^frame-\d+\.jpg$/u.test(file))
      .sort()
      .map((file) => path.join(temporaryDir, file));
    if (frameFiles.length === 0) {
      throw new Error('ffmpeg produced no keyframes');
    }
    const ocrResults = await ocrImages(frameFiles);
    const segments = [];
    let lastSignature = '';
    const interval = Number(env.MEDIA_VIDEO_FRAME_INTERVAL_SECONDS ?? FRAME_INTERVAL_SECONDS);
    for (const [index, frame] of frameFiles.entries()) {
      const resultForFrame = ocrResults.get(frame);
      if (resultForFrame?.error !== undefined) {
        throw new Error(`OCR failed for ${path.basename(frame)}: ${resultForFrame.error}`);
      }
      const lines = sanitizeOcrLines(resultForFrame?.lines ?? []);
      const signature = lines
        .map((line) => line.text)
        .join('\n')
        .normalize('NFKC')
        .toLowerCase();
      if (signature.length === 0 || signature === lastSignature) {
        continue;
      }
      lastSignature = signature;
      segments.push(
        `[${formatTimestamp(index * interval)}]\n${lines.map((line) => line.text).join('\n')}`,
      );
    }
    if (segments.length === 0) {
      throw new Error('no readable text was found in video keyframes');
    }
    return { method: 'keyframe-ocr', text: segments.join('\n\n') };
  } finally {
    await rm(temporaryDir, { force: true, recursive: true });
  }
}

async function extractYoutubeVideo({
  cwd,
  env,
  fetchImpl,
  fetchVideoTranscript,
  runCommand,
  source,
}) {
  const injected =
    fetchVideoTranscript === undefined ? undefined : await fetchVideoTranscript(source);
  if (injected !== undefined) {
    return injected;
  }

  const ytDlp = await resolveYtDlp(env, runCommand);
  if (ytDlp !== undefined) {
    const subtitle = await fetchYoutubeSubtitlesWithYtDlp(source.sourceUrl, runCommand, ytDlp);
    if (subtitle !== undefined) {
      return subtitle;
    }
  }

  const directCaption = await fetchYoutubeCaptionTrack(source.sourceUrl, fetchImpl);
  if (directCaption !== undefined) {
    return directCaption;
  }

  const transcriptionConfig = createTranscriptionConfig(env);
  if (transcriptionConfig !== undefined && ytDlp !== undefined) {
    return transcribeYoutubeAudio({
      config: transcriptionConfig,
      cwd,
      fetchImpl,
      runCommand,
      sourceUrl: source.sourceUrl,
      ytDlp,
    });
  }

  throw new Error(
    'the video has no public captions; configure TRANSCRIPTION_MODEL for audio fallback and, if YouTube blocks download, set MEDIA_YTDLP_COOKIES_FROM_BROWSER explicitly',
  );
}

async function fetchYoutubeSubtitlesWithYtDlp(sourceUrl, runCommand, ytDlp) {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'xxyy-youtube-subs-'));
  try {
    const result = await runYtDlp(ytDlp, runCommand, [
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'zh.*,en.*',
      '--sub-format',
      'vtt',
      '--output',
      path.join(temporaryDir, '%(id)s.%(ext)s'),
      sourceUrl,
    ]);
    if (result.exitCode !== 0) {
      return undefined;
    }
    const subtitleFiles = (await readdir(temporaryDir))
      .filter((file) => file.endsWith('.vtt'))
      .sort(compareSubtitleFiles);
    for (const subtitleFile of subtitleFiles) {
      const text = parseVtt(await readFile(path.join(temporaryDir, subtitleFile), 'utf8'));
      if (text.length > 0) {
        return {
          language: languageFromSubtitleFile(subtitleFile),
          method: 'youtube-subtitles',
          text,
        };
      }
    }
    return undefined;
  } finally {
    await rm(temporaryDir, { force: true, recursive: true });
  }
}

export async function fetchYoutubeCaptionTrack(sourceUrl, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(sourceUrl, {
    headers: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    },
  });
  if (!response.ok) {
    return undefined;
  }
  const html = await response.text();
  const captionJson = extractJsonArrayAfterMarker(html, '"captionTracks":');
  if (captionJson === undefined) {
    return undefined;
  }
  let tracks;
  try {
    tracks = JSON.parse(captionJson);
  } catch {
    return undefined;
  }
  if (!Array.isArray(tracks)) {
    return undefined;
  }
  const track = tracks
    .filter(
      (item) =>
        isObject(item) && typeof item.baseUrl === 'string' && typeof item.languageCode === 'string',
    )
    .sort(
      (left, right) =>
        captionLanguageRank(left.languageCode) - captionLanguageRank(right.languageCode),
    )[0];
  if (!isObject(track) || typeof track.baseUrl !== 'string') {
    return undefined;
  }
  const captionResponse = await fetchImpl(`${track.baseUrl}&fmt=vtt`);
  if (!captionResponse.ok) {
    return undefined;
  }
  const rawCaption = await captionResponse.text();
  const text = rawCaption.startsWith('WEBVTT') ? parseVtt(rawCaption) : parseTimedText(rawCaption);
  if (text.length === 0) {
    return undefined;
  }
  return {
    language: typeof track.languageCode === 'string' ? track.languageCode : undefined,
    method: 'youtube-caption-track',
    text,
  };
}

export function parseVtt(content) {
  const output = [];
  const seenConsecutive = new Set();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = decodeEntities(
      rawLine
        .replace(/<\/?c(?:\.[^>]*)?>/giu, '')
        .replace(/<\d\d:\d\d:\d\d\.\d+>/gu, '')
        .replace(/<[^>]+>/gu, '')
        .trim(),
    );
    if (
      line.length === 0 ||
      line === 'WEBVTT' ||
      /^Kind:|^Language:|^NOTE\b|^\d+$/iu.test(line) ||
      /-->/.test(line)
    ) {
      if (line.length === 0) {
        seenConsecutive.clear();
      }
      continue;
    }
    const normalized = line.normalize('NFKC').toLowerCase();
    if (seenConsecutive.has(normalized)) {
      continue;
    }
    seenConsecutive.add(normalized);
    output.push(line);
  }
  return output.join('\n').trim();
}

function parseTimedText(content) {
  return [...content.matchAll(/<text\b[^>]*>([^]*?)<\/text>/giu)]
    .map((match) =>
      decodeEntities(match[1] ?? '')
        .replace(/<[^>]+>/gu, '')
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join('\n');
}

async function transcribeYoutubeAudio({ config, fetchImpl, runCommand, sourceUrl, ytDlp }) {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'xxyy-youtube-audio-'));
  try {
    const outputTemplate = path.join(temporaryDir, 'audio.%(ext)s');
    const download = await runYtDlp(ytDlp, runCommand, [
      '--format',
      'bestaudio/best',
      '--extract-audio',
      '--audio-format',
      'mp3',
      '--max-filesize',
      '50M',
      '--output',
      outputTemplate,
      sourceUrl,
    ]);
    if (download.exitCode !== 0) {
      throw new Error(`yt-dlp audio download failed: ${truncate(download.stderr, 500)}`);
    }
    const audioFile = (await readdir(temporaryDir)).find((file) => file.startsWith('audio.'));
    if (audioFile === undefined) {
      throw new Error('yt-dlp produced no audio file');
    }
    const form = new FormData();
    form.append('model', config.model);
    form.append('file', new Blob([await readFile(path.join(temporaryDir, audioFile))]), audioFile);
    const response = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`transcription endpoint returned HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (
      !isObject(payload) ||
      typeof payload.text !== 'string' ||
      payload.text.trim().length === 0
    ) {
      throw new Error('transcription endpoint returned no text');
    }
    return { method: 'audio-transcription', text: payload.text.trim() };
  } finally {
    await rm(temporaryDir, { force: true, recursive: true });
  }
}

function createTranscriptionConfig(env) {
  const model = optionalText(env.TRANSCRIPTION_MODEL);
  const apiKey = optionalText(env.TRANSCRIPTION_API_KEY) ?? optionalText(env.OPENAI_API_KEY);
  const baseUrl = stripTrailingSlash(
    optionalText(env.TRANSCRIPTION_BASE_URL) ?? optionalText(env.OPENAI_BASE_URL),
  );
  return model === undefined || apiKey === undefined || baseUrl === undefined
    ? undefined
    : { apiKey, baseUrl, model };
}

async function createOcrProvider({ cwd, env, runCommand }) {
  const provider = optionalText(env.MEDIA_OCR_PROVIDER)?.toLowerCase() ?? 'auto';
  if (
    (provider === 'auto' || provider === 'macos-vision') &&
    process.platform === 'darwin' &&
    (await commandExists('swiftc', runCommand))
  ) {
    const source = path.resolve(cwd, 'scripts', 'media-ocr-macos.swift');
    const binary = path.resolve(cwd, '.rag', 'bin', 'xxyy-media-ocr');
    await compileSwiftOcrIfNeeded({ binary, runCommand, source });
    return (imagePaths) => runMacOcr(binary, imagePaths, runCommand);
  }
  if (
    (provider === 'auto' || provider === 'tesseract') &&
    (await commandExists('tesseract', runCommand))
  ) {
    return (imagePaths) => runTesseractOcr(imagePaths, env, runCommand);
  }
  throw new Error(
    `No OCR provider is available for MEDIA_OCR_PROVIDER=${provider}. Use macOS Vision or install Tesseract.`,
  );
}

async function compileSwiftOcrIfNeeded({ binary, runCommand, source }) {
  const [sourceStat, binaryStat] = await Promise.all([stat(source), optionalStat(binary)]);
  if (binaryStat !== undefined && binaryStat.mtimeMs >= sourceStat.mtimeMs) {
    return;
  }
  await mkdir(path.dirname(binary), { recursive: true });
  const result = await runCommand('swiftc', [source, '-o', binary]);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to compile macOS OCR helper: ${truncate(result.stderr, 800)}`);
  }
}

async function runMacOcr(binary, imagePaths, runCommand) {
  if (imagePaths.length === 0) {
    return new Map();
  }
  const result = await runCommand(binary, imagePaths);
  if (result.exitCode !== 0) {
    throw new Error(`macOS Vision OCR failed: ${truncate(result.stderr, 800)}`);
  }
  const parsed = new Map();
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = JSON.parse(line);
    if (!isObject(entry) || typeof entry.path !== 'string' || !Array.isArray(entry.lines)) {
      throw new Error('macOS OCR helper returned malformed JSON');
    }
    parsed.set(entry.path, {
      ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
      lines: entry.lines,
    });
  }
  return parsed;
}

async function runTesseractOcr(imagePaths, env, runCommand) {
  const results = new Map();
  for (const imagePath of imagePaths) {
    const result = await runCommand('tesseract', [
      imagePath,
      'stdout',
      '-l',
      optionalText(env.MEDIA_OCR_LANGS) ?? 'chi_sim+eng',
    ]);
    results.set(
      imagePath,
      result.exitCode === 0
        ? { lines: result.stdout.split(/\r?\n/u).map((text) => ({ confidence: 1, text })) }
        : { error: truncate(result.stderr, 500), lines: [] },
    );
  }
  return results;
}

export function sanitizeOcrLines(lines, minimumConfidence = DEFAULT_OCR_CONFIDENCE) {
  const output = [];
  const seen = new Set();
  for (const rawLine of lines) {
    const text =
      typeof rawLine === 'string'
        ? rawLine.trim()
        : isObject(rawLine) && typeof rawLine.text === 'string'
          ? rawLine.text.trim()
          : '';
    const confidence =
      isObject(rawLine) && typeof rawLine.confidence === 'number' ? rawLine.confidence : 1;
    if (
      text.length === 0 ||
      confidence < minimumConfidence ||
      !/[\p{L}\p{N}]/u.test(text) ||
      (/^\p{N}$/u.test(text) && text.length === 1)
    ) {
      continue;
    }
    const redacted = redactSensitiveText(text.replace(/\s+/gu, ' '));
    const normalized = redacted.normalize('NFKC').toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push({ confidence, text: redacted });
  }
  return output;
}

function redactSensitiveText(text) {
  return text
    .replace(/xxyy_ak_[A-Za-z0-9_-]{8,}/gu, 'xxyy_ak_[redacted]')
    .replace(/\b0x[a-fA-F0-9]{40,}\b/gu, '[redacted identifier]')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{40,}\b/gu, '[redacted identifier]');
}

function validateAssetManifest(value) {
  if (!isObject(value) || !Array.isArray(value.assets)) {
    throw new Error('Invalid XXYY asset manifest');
  }
  const assets = value.assets.map((asset, index) => {
    if (
      !isObject(asset) ||
      typeof asset.id !== 'string' ||
      typeof asset.file !== 'string' ||
      typeof asset.sha256 !== 'string' ||
      !Array.isArray(asset.source_pages) ||
      !asset.source_pages.every((page) => typeof page === 'string') ||
      asset.source_pages.length === 0
    ) {
      throw new Error(`Invalid asset manifest entry ${index + 1}`);
    }
    return asset;
  });
  return { assets };
}

async function readPageMetadata(file) {
  const pages = new Map();
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/u)) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = JSON.parse(line);
    if (isObject(entry) && typeof entry.source_url === 'string') {
      pages.set(entry.source_url, {
        section: typeof entry.section === 'string' ? entry.section : undefined,
        title: typeof entry.title === 'string' ? entry.title : undefined,
      });
    }
  }
  return pages;
}

function isReusableImageResult(prior, asset) {
  return (
    isObject(prior) &&
    prior.sha256 === asset.sha256 &&
    JSON.stringify(prior.source_pages) === JSON.stringify(asset.source_pages) &&
    (prior.status === 'no_text' || typeof prior.output_sha256 === 'string') &&
    (prior.status === 'extracted' || prior.status === 'no_text')
  );
}

async function videoFingerprint(cwd, source, textCoverage) {
  const fingerprint = createHash('sha256')
    .update(String(VIDEO_ENRICHMENT_VERSION))
    .update('\0')
    .update(JSON.stringify(source))
    .update('\0')
    .update(JSON.stringify(textCoverage ?? null))
    .update('\0');
  if (source.kind === 'youtube') {
    return fingerprint.digest('hex');
  }
  const file = path.resolve(cwd, source.path);
  try {
    return fingerprint.update(await readFile(file)).digest('hex');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function summarizeImageResults(results, skipped) {
  return {
    extracted: results.filter((entry) => entry.status === 'extracted').length,
    noText: results.filter((entry) => entry.status === 'no_text').length,
    skipped,
    total: results.length,
  };
}

function compareSubtitleFiles(left, right) {
  return (
    captionLanguageRank(languageFromSubtitleFile(left)) -
    captionLanguageRank(languageFromSubtitleFile(right))
  );
}

function captionLanguageRank(language) {
  const normalized = language.toLowerCase();
  if (normalized.startsWith('zh-hans') || normalized.startsWith('zh-cn')) return 0;
  if (normalized.startsWith('zh')) return 1;
  if (normalized.startsWith('en')) return 2;
  return 3;
}

function languageFromSubtitleFile(file) {
  const match = /\.([^.]+)\.vtt$/u.exec(file);
  return match?.[1] ?? 'unknown';
}

function extractJsonArrayAfterMarker(content, marker) {
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const start = content.indexOf('[', markerIndex + marker.length);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }
  return undefined;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)));
}

function formatTimestamp(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

async function commandExists(command, runCommand) {
  try {
    const versionArgs = command === 'ffmpeg' ? ['-version'] : ['--version'];
    return (await runCommand(command, versionArgs)).exitCode === 0;
  } catch {
    return false;
  }
}

async function resolveYtDlp(env, runCommand) {
  const configured = optionalText(env.MEDIA_YTDLP_PATH);
  const prefixArgs = [];
  const cookiesFromBrowser = optionalText(env.MEDIA_YTDLP_COOKIES_FROM_BROWSER);
  if (cookiesFromBrowser !== undefined) {
    prefixArgs.push('--cookies-from-browser', cookiesFromBrowser);
  }
  if (await commandExists('node', runCommand)) {
    prefixArgs.push('--js-runtimes', 'node');
  }
  if (configured !== undefined) {
    return { command: configured, prefixArgs };
  }
  if (await commandExists('yt-dlp', runCommand)) {
    return { command: 'yt-dlp', prefixArgs };
  }
  if (await commandExists('uvx', runCommand)) {
    return { command: 'uvx', prefixArgs: ['--from', 'yt-dlp', 'yt-dlp', ...prefixArgs] };
  }
  return undefined;
}

function runYtDlp(ytDlp, runCommand, args) {
  return runCommand(ytDlp.command, [...ytDlp.prefixArgs, ...args]);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitCode: code ?? 1, stderr, stdout }));
  });
}

async function pruneMarkdown(directory, expected) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !expected.has(entry.name))
      .map((entry) => rm(path.join(directory, entry.name), { force: true })),
  );
}

async function atomicWriteFile(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryFile, content);
  await rename(temporaryFile, file);
}

async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function optionalStat(file) {
  try {
    return await stat(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function fileHashMatches(file, expectedHash) {
  if (typeof expectedHash !== 'string' || !(await fileExists(file))) {
    return false;
  }
  return sha256(await readFile(file)) === expectedHash;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function optionalText(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stripTrailingSlash(value) {
  return value?.replace(/\/+$/u, '');
}

function normalizePath(value) {
  return value.replaceAll(path.sep, '/');
}

function truncate(value, length) {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function errorCode(error) {
  return isObject(error) && 'code' in error ? error.code : undefined;
}

function isDirectRun() {
  const invoked = process.argv[1];
  return invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    const result = await enrichXxyyMedia();
    process.stdout.write(
      `Image OCR: ${result.images.extracted}/${result.images.total} with text, ${result.images.noText} without text.\n`,
    );
    process.stdout.write(
      `Video knowledge coverage: ${result.videos.knowledgeCovered}/${result.videos.total}; ${result.videos.extracted} extracted, ${result.videos.coveredByText} covered by verified text.\n`,
    );
    for (const notice of result.videos.notices) {
      process.stdout.write(`Notice: ${notice}\n`);
    }
    for (const warning of result.videos.warnings) {
      process.stderr.write(`Warning: ${warning}\n`);
    }
    if (process.env.MEDIA_REQUIRE_ALL === 'true' && result.videos.unextracted > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
