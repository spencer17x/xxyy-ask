import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOpenAiEmbeddingProvider } from '@xxyy/knowledge';
import { createPgKnowledgeOpsStore } from '@xxyy/knowledge-ops';
import {
  createLazyRetriever,
  createOpenAiAnswerProvider,
  createPgPool,
  createPgVectorStore,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
  type AnswerProvider,
} from '@xxyy/rag-core';

import { createProductQaMcpServer } from './server.js';
import { createProductQaToolHandlers } from './tools.js';
import { createProductQaMcpQualitySignalRuntime } from './quality-signals.js';

const env = loadWorkspaceEnv({
  cwd: resolveWorkspaceCwd(process.cwd(), process.env),
  env: process.env,
});
const config = loadRagConfig(env);
let vectorPool: ReturnType<typeof createPgPool> | undefined;
let qualityPool: ReturnType<typeof createPgPool> | undefined;

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
    return createPgVectorStore({ client: nextPool, embeddingProvider });
  } catch (error) {
    await nextPool.end();
    throw error;
  }
});
const qualitySignals = createProductQaMcpQualitySignalRuntime({
  getStore() {
    qualityPool ??= createPgPool(config.databaseUrl);
    return createPgKnowledgeOpsStore({ client: qualityPool });
  },
});

const server = createProductQaMcpServer({
  handlers: createProductQaToolHandlers({
    answerProvider: createLazyAnswerProvider(),
    config,
    retriever,
  }),
  qualitySignals: qualitySignals.sink,
});
const transport = new StdioServerTransport();

await server.connect(transport);

process.on('SIGINT', () => {
  void server
    .close()
    .finally(async () => {
      const pool = vectorPool;
      const qualitySignalPool = qualityPool;
      vectorPool = undefined;
      qualityPool = undefined;
      await qualitySignals.close();
      await pool?.end();
      await qualitySignalPool?.end();
    })
    .finally(() => {
      process.exit(0);
    });
});

function createLazyAnswerProvider(): AnswerProvider {
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
  };
}
