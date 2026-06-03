export interface RagConfig {
  topK: number;
  answerProvider: string;
  embeddingProvider: string;
  indexPath: string;
  openAiApiKey: string | undefined;
  openAiApiKeyPresent: boolean;
  openAiBaseUrl: string;
  openAiModel: string | undefined;
}

export type RagEnv = Partial<
  Record<
    | 'OPENAI_API_KEY'
    | 'OPENAI_BASE_URL'
    | 'OPENAI_MODEL'
    | 'RAG_ANSWER_PROVIDER'
    | 'RAG_EMBEDDING_PROVIDER'
    | 'RAG_INDEX_PATH'
    | 'RAG_TOP_K',
    string
  >
>;

const DEFAULT_TOP_K = 6;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function loadRagConfig(env: RagEnv = process.env): RagConfig {
  const config: RagConfig = {
    topK: parseTopK(env.RAG_TOP_K),
    answerProvider: env.RAG_ANSWER_PROVIDER ?? 'openai',
    embeddingProvider: env.RAG_EMBEDDING_PROVIDER ?? 'local',
    indexPath: env.RAG_INDEX_PATH ?? '.rag/index.json',
    openAiApiKey: env.OPENAI_API_KEY,
    openAiApiKeyPresent: Boolean(env.OPENAI_API_KEY),
    openAiBaseUrl: env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    openAiModel: env.OPENAI_MODEL,
  };

  return config;
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
