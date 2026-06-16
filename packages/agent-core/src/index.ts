export const workspacePackageName = '@xxyy/agent-core';

export { createInMemoryAuditSink, createNoopAuditSink } from './audit.js';
export type { InMemoryAuditSink, ToolAuditEvent, ToolAuditSink, ToolAuditStatus } from './audit.js';
export {
  TX_ANALYSIS_TOOL_NAMES,
  analyzeTransactionInputSchema,
  analyzeTransactionOutputSchema,
  createTxAnalysisTools,
  getAnalysisReportInputSchema,
  getAnalysisReportOutputSchema,
  listAnalysisReportsInputSchema,
  listAnalysisReportsOutputSchema,
  toRagAnalyzeTransactionInput,
} from './tools/tx-analysis-tools.js';
export type {
  AnalyzeTransactionToolInput,
  AnalyzeTransactionToolOutput,
  CreateTxAnalysisToolsOptions,
  TxAnalysisToolChannel,
  TxAnalysisToolName,
} from './tools/tx-analysis-tools.js';
export {
  ToolRegistryDuplicateNameError,
  ToolRegistryToolNotFoundError,
  createToolRegistry,
} from './tool-registry.js';
export type { ListToolsOptions, ToolDefinition, ToolPolicy, ToolRegistry } from './tool-registry.js';
