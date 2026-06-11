export interface RagConfig {
  topK: number;
  answerProvider: string;
  txAnalysisProvider: string;
  txAnalysisBrowserHeadless: boolean;
  txAnalysisBrowserTimeoutMs: number;
  txAnalysisScreenshotBaseUrl: string;
  txAnalysisBrowserUserDataDir: string | undefined;
  txAnalysisChromeExecutablePath: string | undefined;
  txAnalysisScreenshotDir: string | undefined;
  databaseUrl: string | undefined;
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
    | 'RAG_TOP_K'
    | 'TX_ANALYSIS_BROWSER_HEADLESS'
    | 'TX_ANALYSIS_BROWSER_TIMEOUT_MS'
    | 'TX_ANALYSIS_BROWSER_USER_DATA_DIR'
    | 'TX_ANALYSIS_CHROME_EXECUTABLE_PATH'
    | 'TX_ANALYSIS_PROVIDER'
    | 'TX_ANALYSIS_SCREENSHOT_BASE_URL'
    | 'TX_ANALYSIS_SCREENSHOT_DIR',
    string
  >
>;

const DEFAULT_TOP_K = 6;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_OPENAI_MAX_RETRIES = 1;
const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_POSTGRES_HOST = 'localhost';
const DEFAULT_POSTGRES_PORT = '5432';
const DEFAULT_TX_ANALYSIS_BROWSER_TIMEOUT_MS = 60000;
const DEFAULT_TX_ANALYSIS_SCREENSHOT_BASE_URL = '/assets';

export function loadRagConfig(env: RagEnv = process.env): RagConfig {
  const config: RagConfig = {
    topK: parseTopK(env.RAG_TOP_K),
    answerProvider: env.RAG_ANSWER_PROVIDER ?? 'openai',
    txAnalysisProvider: env.TX_ANALYSIS_PROVIDER ?? 'none',
    txAnalysisBrowserHeadless: parseBoolean(env.TX_ANALYSIS_BROWSER_HEADLESS, false),
    txAnalysisBrowserTimeoutMs: parsePositiveInteger(
      env.TX_ANALYSIS_BROWSER_TIMEOUT_MS,
      DEFAULT_TX_ANALYSIS_BROWSER_TIMEOUT_MS,
    ),
    txAnalysisBrowserUserDataDir: env.TX_ANALYSIS_BROWSER_USER_DATA_DIR,
    txAnalysisChromeExecutablePath: env.TX_ANALYSIS_CHROME_EXECUTABLE_PATH,
    txAnalysisScreenshotBaseUrl:
      env.TX_ANALYSIS_SCREENSHOT_BASE_URL ?? DEFAULT_TX_ANALYSIS_SCREENSHOT_BASE_URL,
    txAnalysisScreenshotDir: env.TX_ANALYSIS_SCREENSHOT_DIR,
    databaseUrl: env.DATABASE_URL ?? buildPostgresUrl(env),
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

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return fallback;
}
