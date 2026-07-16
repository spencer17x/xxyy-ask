export interface RagConfig {
  topK: number;
  answerProvider: string;
  databaseUrl: string | undefined;
  embeddingDimension: number;
  openAiApiKey: string | undefined;
  openAiApiKeyPresent: boolean;
  openAiBaseUrl: string;
  openAiModel: string | undefined;
  openAiEmbeddingModel: string;
  openAiMaxRetries: number;
  openAiRequestTimeoutMs: number;
}

export type RagEnv = Partial<
  Record<
    | 'DATABASE_URL'
    | 'EMBEDDING_DIMENSION'
    | 'OPENAI_API_KEY'
    | 'OPENAI_BASE_URL'
    | 'OPENAI_EMBEDDING_MODEL'
    | 'OPENAI_MAX_RETRIES'
    | 'OPENAI_MODEL'
    | 'OPENAI_REQUEST_TIMEOUT_MS'
    | 'POSTGRES_DB'
    | 'POSTGRES_HOST'
    | 'POSTGRES_PASSWORD'
    | 'POSTGRES_PORT'
    | 'POSTGRES_USER'
    | 'RAG_ANSWER_PROVIDER'
    | 'RAG_TOP_K',
    string
  >
>;

const DEFAULT_TOP_K = 6;
const DEFAULT_EMBEDDING_DIMENSION = 1536;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_OPENAI_MAX_RETRIES = 1;
const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_POSTGRES_HOST = 'localhost';
const DEFAULT_POSTGRES_PORT = '5432';

export function loadRagConfig(env: RagEnv = process.env): RagConfig {
  const config: RagConfig = {
    topK: parseTopK(env.RAG_TOP_K),
    answerProvider: env.RAG_ANSWER_PROVIDER ?? 'openai',
    databaseUrl: normalizeOptionalText(env.DATABASE_URL) ?? buildPostgresUrl(env),
    embeddingDimension: parsePositiveInteger(env.EMBEDDING_DIMENSION, DEFAULT_EMBEDDING_DIMENSION),
    openAiApiKey: env.OPENAI_API_KEY,
    openAiApiKeyPresent: Boolean(env.OPENAI_API_KEY),
    openAiBaseUrl: env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    openAiModel: env.OPENAI_MODEL,
    openAiEmbeddingModel: env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
    openAiMaxRetries: parseNonNegativeInteger(env.OPENAI_MAX_RETRIES, DEFAULT_OPENAI_MAX_RETRIES),
    openAiRequestTimeoutMs: parsePositiveInteger(
      env.OPENAI_REQUEST_TIMEOUT_MS,
      DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
    ),
  };

  return config;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function buildPostgresUrl(env: RagEnv): string | undefined {
  if (
    env.POSTGRES_DB === undefined ||
    env.POSTGRES_PASSWORD === undefined ||
    env.POSTGRES_USER === undefined
  ) {
    return undefined;
  }

  const host = env.POSTGRES_HOST ?? DEFAULT_POSTGRES_HOST;
  const port = env.POSTGRES_PORT ?? DEFAULT_POSTGRES_PORT;
  return [
    'postgres://',
    encodeURIComponent(env.POSTGRES_USER),
    ':',
    encodeURIComponent(env.POSTGRES_PASSWORD),
    '@',
    host,
    ':',
    port,
    '/',
    encodeURIComponent(env.POSTGRES_DB),
  ].join('');
}

function parseTopK(value: string | undefined): number {
  return parsePositiveInteger(value, DEFAULT_TOP_K);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}
