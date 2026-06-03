export interface RagConfig {
  topK: number;
  answerProvider: string;
  embeddingProvider: string;
  indexPath: string;
  openAiApiKeyPresent: boolean;
}

export type RagEnv = Partial<
  Record<
    | 'OPENAI_API_KEY'
    | 'RAG_ANSWER_PROVIDER'
    | 'RAG_EMBEDDING_PROVIDER'
    | 'RAG_INDEX_PATH'
    | 'RAG_TOP_K',
    string
  >
>;

const DEFAULT_TOP_K = 6;

export function loadRagConfig(env: RagEnv = process.env): RagConfig {
  return {
    topK: parseTopK(env.RAG_TOP_K),
    answerProvider: env.RAG_ANSWER_PROVIDER ?? 'extractive',
    embeddingProvider: env.RAG_EMBEDDING_PROVIDER ?? 'local',
    indexPath: env.RAG_INDEX_PATH ?? '.rag/index.json',
    openAiApiKeyPresent: Boolean(env.OPENAI_API_KEY),
  };
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
