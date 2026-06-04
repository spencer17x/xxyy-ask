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

function isNumericEmbedding(embedding: unknown): embedding is number[] {
  return (
    Array.isArray(embedding) &&
    embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
  );
}

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
        const detail = await readErrorDetail(response);
        throw new Error(`Embedding request failed with status ${response.status}${detail}`);
      }

      const payload = await readJsonResponse<EmbeddingResponse>(response);
      const rows = payload.data ?? [];
      const embeddings = new Array<number[] | undefined>(texts.length);
      const seenIndexes = new Set<number>();

      if (rows.length !== texts.length) {
        throw new Error('Embedding response did not include all embeddings.');
      }

      for (const row of rows) {
        if (
          row.index === undefined ||
          !Number.isInteger(row.index) ||
          row.index < 0 ||
          row.index >= texts.length ||
          seenIndexes.has(row.index) ||
          !isNumericEmbedding(row.embedding)
        ) {
          throw new Error('Embedding response did not include all embeddings.');
        }

        seenIndexes.add(row.index);
        embeddings[row.index] = row.embedding;
      }

      if (embeddings.some((embedding) => embedding === undefined)) {
        throw new Error('Embedding response did not include all embeddings.');
      }

      return embeddings as number[][];
    },
  };
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.length > 0 && !contentType.toLowerCase().includes('json')) {
    throw new Error('Embedding response was not JSON. Check OPENAI_BASE_URL.');
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('Embedding response was not valid JSON. Check OPENAI_BASE_URL.');
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return '';
  }

  try {
    const payload = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = payload.error?.message ?? payload.message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return `: ${message.trim()}`;
    }
  } catch {
    return `: ${truncateErrorDetail(text)}`;
  }

  return `: ${truncateErrorDetail(text)}`;
}

function truncateErrorDetail(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 300);
}
