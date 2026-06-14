import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createConfiguredTxAnalysisProvider,
  createConfiguredTxAnalysisReportReader,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
} from '@xxyy/rag-core';

import { createTxAnalysisMcpServer } from './server.js';
import { createTxAnalysisToolHandlers } from './tools.js';

const env = loadWorkspaceEnv({
  cwd: resolveWorkspaceCwd(process.cwd(), process.env),
  env: process.env,
});
const config = loadRagConfig(env);
const provider = createConfiguredTxAnalysisProvider(config);
const reportReader = createConfiguredTxAnalysisReportReader(config);
const server = createTxAnalysisMcpServer({
  handlers: createTxAnalysisToolHandlers({ provider, reportReader }),
});
const transport = new StdioServerTransport();

await server.connect(transport);

process.on('SIGINT', () => {
  void server.close().finally(() => {
    process.exit(0);
  });
});
