import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPgKnowledgeOpsStore } from '@xxyy/knowledge-ops';
import {
  createConfiguredTxAnalysisProvider,
  createPgPool,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
} from '@xxyy/rag-core';

import { createTxAnalysisMcpQualitySignalRuntime } from './quality-signals.js';
import { createTxAnalysisMcpServer } from './server.js';
import { createTxAnalysisToolHandlers } from './tools.js';

const env = loadWorkspaceEnv({
  cwd: resolveWorkspaceCwd(process.cwd(), process.env),
  env: process.env,
});
const config = loadRagConfig(env);
const provider = createConfiguredTxAnalysisProvider(config);
let qualityPool: ReturnType<typeof createPgPool> | undefined;
const qualitySignals = createTxAnalysisMcpQualitySignalRuntime({
  getStore() {
    qualityPool ??= createPgPool(config.databaseUrl);
    return createPgKnowledgeOpsStore({ client: qualityPool });
  },
});
const server = createTxAnalysisMcpServer({
  handlers: createTxAnalysisToolHandlers({ provider }),
  qualitySignals: qualitySignals.sink,
});
const transport = new StdioServerTransport();

await server.connect(transport);

process.on('SIGINT', () => {
  void server
    .close()
    .finally(async () => {
      const qualitySignalPool = qualityPool;
      qualityPool = undefined;
      await qualitySignals.close();
      await qualitySignalPool?.end();
    })
    .finally(() => {
      process.exit(0);
    });
});
