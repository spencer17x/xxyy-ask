import { createCustomerAgentChatService } from '@xxyy/agent-core';
import { createOpenAiEmbeddingProvider } from '@xxyy/knowledge';
import {
  createLazyRetriever,
  createOpenAiAnswerProvider,
  createPgPool,
  createPgVectorStore,
  type AnswerProvider,
  type ChatService,
  type RagConfig,
} from '@xxyy/rag-core';

export interface TelegramChatRuntime {
  close(): Promise<void>;
  service: ChatService;
}

export function createTelegramChatRuntime(config: RagConfig): TelegramChatRuntime {
  let vectorPool: ReturnType<typeof createPgPool> | undefined;

  const retriever = createLazyRetriever(async () => {
    const nextPool = createPgPool(config.databaseUrl);

    try {
      const embeddingProvider = createOpenAiEmbeddingProvider({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        maxRetries: config.openAiMaxRetries,
        model: config.openAiEmbeddingModel,
        requestTimeoutMs: config.openAiRequestTimeoutMs,
      });
      vectorPool = nextPool;
      return createPgVectorStore({
        client: nextPool,
        embeddingDimension: config.embeddingDimension,
        embeddingProvider,
      });
    } catch (error) {
      await nextPool.end();
      throw error;
    }
  });

  return {
    async close() {
      const pool = vectorPool;
      vectorPool = undefined;
      await pool?.end();
    },
    service: createCustomerAgentChatService({
      answerProvider: createLazyAnswerProvider(config),
      config,
      retriever,
    }),
  };
}

function createLazyAnswerProvider(config: RagConfig): AnswerProvider {
  let cachedProvider: AnswerProvider | undefined;

  function getProvider(): AnswerProvider {
    cachedProvider ??= createOpenAiAnswerProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    return cachedProvider;
  }

  return {
    answer(input) {
      return getProvider().answer(input);
    },
    stream(input) {
      const provider = getProvider();
      if (provider.stream === undefined) {
        throw new Error('Answer provider does not support streaming.');
      }
      return provider.stream(input);
    },
  };
}
