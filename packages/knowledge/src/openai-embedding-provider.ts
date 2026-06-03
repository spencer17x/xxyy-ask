export interface BatchEmbeddingProvider {
  embedTexts(texts: string[]): Promise<number[][]>;
}

export interface OpenAiEmbeddingProviderOptions {
  apiKey: string | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  model: string | undefined;
}

interface EmbeddingResponse {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
}

export class EmbeddingConfigurationError extends Error {}

export function createOpenAiEmbeddingProvider(
  options: OpenAiEmbeddingProviderOptions,
): BatchEmbeddingProvider {
  if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
    throw new EmbeddingConfigurationError('OPENAI_API_KEY is required for embedding generation.');
  }
  if (options.model === undefined || options.model.trim().length === 0) {
    throw new EmbeddingConfigurationError(
      'OPENAI_EMBEDDING_MODEL is required for embedding generation.',
    );
  }

  const apiKey = options.apiKey;
  const model = options.model;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/embeddings`;

  return {
    async embedTexts(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }

      const response = await fetchImpl(endpoint, {
        body: JSON.stringify({ input: texts, model }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Embedding request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as EmbeddingResponse;
      const rows = payload.data ?? [];
      const sortedRows = [...rows].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      const embeddings = sortedRows.map((row) => row.embedding);

      if (
        embeddings.length !== texts.length ||
        embeddings.some((embedding) => !Array.isArray(embedding))
      ) {
        throw new Error('Embedding response did not include all embeddings.');
      }

      return embeddings as number[][];
    },
  };
}
