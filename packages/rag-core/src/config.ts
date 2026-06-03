export interface RagConfig {
  topK: number;
  answerProvider: string;
  databaseUrl: string | undefined;
  openAiApiKey: string | undefined;
  openAiApiKeyPresent: boolean;
  openAiBaseUrl: string;
  openAiModel: string | undefined;
  openAiEmbeddingModel: string;
}

export type RagEnv = Partial<
  Record<
    | 'DATABASE_URL'
    | 'OPENAI_API_KEY'
    | 'OPENAI_BASE_URL'
    | 'OPENAI_EMBEDDING_MODEL'
    | 'OPENAI_MODEL'
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
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_POSTGRES_HOST = 'localhost';
const DEFAULT_POSTGRES_PORT = '5432';

export function loadRagConfig(env: RagEnv = process.env): RagConfig {
  const config: RagConfig = {
    topK: parseTopK(env.RAG_TOP_K),
    answerProvider: env.RAG_ANSWER_PROVIDER ?? 'openai',
    databaseUrl: env.DATABASE_URL ?? buildPostgresUrl(env),
    openAiApiKey: env.OPENAI_API_KEY,
    openAiApiKeyPresent: Boolean(env.OPENAI_API_KEY),
    openAiBaseUrl: env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    openAiModel: env.OPENAI_MODEL,
    openAiEmbeddingModel: env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
  };

  return config;
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
  if (value === undefined) {
    return DEFAULT_TOP_K;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_TOP_K;
  }

  return parsed;
}
