import type {
  BrowserTxAnalysisReview,
  BrowserTxAnalysisReviewer,
  BrowserTxAnalysisReviewInput,
} from './browser-tx-analysis.js';
import { LlmConfigurationError } from './openai-answer-provider.js';

export interface OpenAiTxAnalysisReviewerOptions {
  apiKey: string | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  model: string | undefined;
  requestTimeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const VALID_VERDICTS = new Set(['sandwiched', 'not_sandwiched', 'inconclusive']);
const VALID_EVIDENCE_SEVERITIES = new Set(['info', 'warning', 'critical']);
const MAX_REVIEW_CONTEXT_CHARS = 9000;

export function createOpenAiTxAnalysisReviewer(
  options: OpenAiTxAnalysisReviewerOptions,
): BrowserTxAnalysisReviewer {
  if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
    throw new LlmConfigurationError('OPENAI_API_KEY is required for transaction analysis review.');
  }
  if (options.model === undefined || options.model.trim().length === 0) {
    throw new LlmConfigurationError('OPENAI_MODEL is required for transaction analysis review.');
  }

  const apiKey = options.apiKey;
  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = normalizeNonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES);
  const model = options.model;
  const requestTimeoutMs = normalizePositiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );

  return {
    async review(
      input: BrowserTxAnalysisReviewInput,
    ): Promise<BrowserTxAnalysisReview | undefined> {
      const response = await fetchChatCompletion(fetchImpl, endpoint, {
        apiKey,
        body: createReviewBody(input, model),
        maxRetries,
        requestTimeoutMs,
      });
      if (response === undefined) {
        return undefined;
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const content = normalizeChatContent(payload.choices?.[0]?.message?.content);
      if (content === undefined) {
        return undefined;
      }

      return parseReviewContent(content);
    },
  };
}

async function fetchChatCompletion(
  fetchImpl: typeof fetch,
  endpoint: string,
  options: {
    apiKey: string;
    body: Record<string, unknown>;
    maxRetries: number;
    requestTimeoutMs: number;
  },
): Promise<Response | undefined> {
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    const response = await fetchWithTimeout(
      fetchImpl,
      endpoint,
      {
        body: JSON.stringify(options.body),
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      options.requestTimeoutMs,
    ).catch(() => undefined);

    if (response === undefined) {
      continue;
    }
    if (response.ok) {
      return response;
    }
    if (!isRetryableStatus(response.status)) {
      return undefined;
    }
  }

  return undefined;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(endpoint, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function createReviewBody(
  input: BrowserTxAnalysisReviewInput,
  model: string,
): Record<string, unknown> {
  return {
    messages: [
      {
        content: [
          '你是 XXYY 交易夹子检测复核器。',
          '只能基于用户提供的交易窗口、规则分析和证据做复核；不要访问外部数据，不要给投资建议。',
          '如果证据不足或模式有歧义，优先返回 inconclusive。',
          '只输出 JSON，不要输出 Markdown。',
          'JSON 字段：verdict 为 sandwiched/not_sandwiched/inconclusive；confidence 为 0 到 1；summary 为中文一句话；evidence 为数组，元素包含 label/detail/severity。',
        ].join('\n'),
        role: 'system',
      },
      {
        content: truncateReviewContext(
          JSON.stringify(
            {
              chain: input.chain,
              contractAddress: input.contractAddress,
              poolAddress: input.poolAddress,
              requestedTxHash: input.requestedTxHash,
              ruleAnalysis: input.ruleAnalysis,
              targetTrade: input.targetTrade,
              tradeWindow: input.tradeWindow,
            },
            null,
            2,
          ),
        ),
        role: 'user',
      },
    ],
    model,
    temperature: 0,
  };
}

function truncateReviewContext(context: string): string {
  if (context.length <= MAX_REVIEW_CONTEXT_CHARS) {
    return context;
  }

  return `${context.slice(0, MAX_REVIEW_CONTEXT_CHARS)}\n[内容已截断]`;
}

function parseReviewContent(content: string): BrowserTxAnalysisReview | undefined {
  const jsonText = extractReviewJsonText(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = reviewRecordFromParsedJson(parsed);
  if (record === undefined) {
    return undefined;
  }

  return parseReviewRecord(record);
}

function reviewRecordFromParsedJson(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  return (
    recordWithReviewFields(record) ??
    recordWithReviewFields(record.result) ??
    recordWithReviewFields(record.review) ??
    recordWithReviewFields(record.analysis) ??
    recordWithReviewFields(record.data)
  );
}

function recordWithReviewFields(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return [
    'confidence',
    'confidenceScore',
    'confidence_score',
    'evidence',
    'evidences',
    'findings',
    'hasSandwich',
    'has_sandwich',
    'isSandwich',
    'is_sandwich',
    'isSandwiched',
    'is_sandwiched',
    'sandwiched',
    'sandwichDetected',
    'sandwich_detected',
    'score',
    'probability',
    'likelihood',
    'summary',
    'verdict',
  ].some((key) => key in record)
    ? record
    : undefined;
}

function parseReviewRecord(record: Record<string, unknown>): BrowserTxAnalysisReview | undefined {
  const verdict =
    parseVerdict(record.verdict) ??
    parseBooleanVerdict(
      record.isSandwiched ??
        record.is_sandwiched ??
        record.isSandwich ??
        record.is_sandwich ??
        record.hasSandwich ??
        record.has_sandwich ??
        record.sandwichDetected ??
        record.sandwich_detected ??
        record.sandwiched,
    );
  const confidence = parseConfidence(
    record.confidence ??
      record.confidenceScore ??
      record.confidence_score ??
      record.score ??
      record.probability ??
      record.likelihood,
  );
  const summary = parseText(record.summary);
  const evidence = parseEvidence(record.evidence ?? record.evidences ?? record.findings);
  if (
    verdict === undefined &&
    confidence === undefined &&
    summary === undefined &&
    evidence === undefined
  ) {
    return undefined;
  }

  return {
    ...(confidence === undefined ? {} : { confidence }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(summary === undefined ? {} : { summary }),
    ...(verdict === undefined ? {} : { verdict }),
  };
}

function normalizeChatContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .flatMap((part): string[] => {
      if (typeof part === 'string') {
        return [part];
      }
      if (typeof part !== 'object' || part === null) {
        return [];
      }

      const record = part as Record<string, unknown>;
      return typeof record.text === 'string' ? [record.text] : [];
    })
    .join('\n')
    .trim();

  return text.length === 0 ? undefined : text;
}

function extractReviewJsonText(content: string): string {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }

  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1).trim();
  }

  return trimmed;
}

function parseVerdict(value: unknown): BrowserTxAnalysisReview['verdict'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
  const verdict = normalizeVerdictAlias(normalized);
  if (!VALID_VERDICTS.has(verdict)) {
    return undefined;
  }

  return verdict as BrowserTxAnalysisReview['verdict'];
}

function normalizeVerdictAlias(value: string): string {
  switch (value) {
    case 'sandwich':
    case 'sandwich_detected':
      return 'sandwiched';
    case 'no_sandwich':
    case 'not_sandwich':
      return 'not_sandwiched';
    case 'insufficient_evidence':
    case 'uncertain':
    case 'unknown':
      return 'inconclusive';
    default:
      return value;
  }
}

function parseBooleanVerdict(value: unknown): BrowserTxAnalysisReview['verdict'] | undefined {
  const normalized =
    typeof value === 'boolean'
      ? value
      : typeof value === 'string'
        ? parseBooleanString(value)
        : undefined;
  if (normalized === undefined) {
    return undefined;
  }

  return normalized ? 'sandwiched' : 'not_sandwiched';
}

function parseBooleanString(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case '是':
      return true;
    case '0':
    case 'false':
    case 'no':
    case '否':
      return false;
    default:
      return undefined;
  }
}

function parseConfidence(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? parseConfidenceString(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  const normalized = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, normalized));
}

function parseConfidenceString(value: string): number {
  const normalized = value.normalize('NFKC').trim();
  if (normalized.endsWith('%')) {
    return Number(normalized.slice(0, -1).trim()) / 100;
  }

  const fraction = /^([+-]?\d+(?:\.\d+)?)\s*\/\s*([+-]?\d+(?:\.\d+)?)$/u.exec(normalized);
  if (fraction !== null) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    return denominator === 0 ? Number.NaN : numerator / denominator;
  }

  return Number(normalized);
}

function parseText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function parseEvidence(value: unknown): BrowserTxAnalysisReview['evidence'] | undefined {
  if (!Array.isArray(value) && (typeof value !== 'object' || value === null)) {
    return undefined;
  }

  const items = Array.isArray(value) ? value : [value];
  const evidence = items.flatMap((item): NonNullable<BrowserTxAnalysisReview['evidence']> => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const detail = parseText(record.detail ?? record.message ?? record.description);
    const label = parseText(record.label ?? record.title ?? record.name);
    const severity = parseSeverity(record.severity ?? record.level ?? record.riskLevel);
    if (detail === undefined || label === undefined || severity === undefined) {
      return [];
    }

    return [{ detail, label, severity }];
  });

  return evidence.length === 0 ? undefined : evidence;
}

function parseSeverity(
  value: unknown,
): NonNullable<BrowserTxAnalysisReview['evidence']>[number]['severity'] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  const severity =
    normalized === 'warn' || normalized === 'medium'
      ? 'warning'
      : normalized === 'high' || normalized === 'error'
        ? 'critical'
        : normalized === 'low'
          ? 'info'
          : normalized;
  if (!VALID_EVIDENCE_SEVERITIES.has(severity)) {
    return undefined;
  }

  return severity as NonNullable<BrowserTxAnalysisReview['evidence']>[number]['severity'];
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  return Number.isInteger(value) && value >= 0 ? value : fallback;
}
