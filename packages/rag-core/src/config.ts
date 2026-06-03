export type VectorStoreKind = 'local' | 'pgvector';

export interface RagConfig {
  topK: number;
  answerProvider: string;
  embeddingProvider: string;
  indexPath: string;
  vectorStore: VectorStoreKind;
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
    | 'RAG_ANSWER_PROVIDER'
    | 'RAG_EMBEDDING_PROVIDER'
    | 'RAG_INDEX_PATH'
    | 'RAG_TOP_K'
    | 'RAG_VECTOR_STORE',
    string
  >
>;

const DEFAULT_TOP_K = 6;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

export function loadRagConfig(env: RagEnv = process.env): RagConfig {
  const config: RagConfig = {
    topK: parseTopK(env.RAG_TOP_K),
    answerProvider: env.RAG_ANSWER_PROVIDER ?? 'openai',
    embeddingProvider: env.RAG_EMBEDDING_PROVIDER ?? 'local',
    indexPath: env.RAG_INDEX_PATH ?? '.rag/index.json',
    vectorStore: parseVectorStore(env.RAG_VECTOR_STORE),
    databaseUrl: env.DATABASE_URL,
    openAiApiKey: env.OPENAI_API_KEY,
    openAiApiKeyPresent: Boolean(env.OPENAI_API_KEY),
    openAiBaseUrl: env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    openAiModel: env.OPENAI_MODEL,
    openAiEmbeddingModel: env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
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

function parseVectorStore(value: string | undefined): VectorStoreKind {
  if (value === undefined || value === 'local' || value === 'pgvector') {
    return value ?? 'local';
  }

  throw new Error(`Unsupported RAG_VECTOR_STORE: ${value}`);
}
