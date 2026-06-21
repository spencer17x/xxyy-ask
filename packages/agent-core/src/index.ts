export const workspacePackageName = '@xxyy/agent-core';

export { createCustomerAgentChatService } from './customer-agent-chat-service.js';
export type { CreateCustomerAgentChatServiceOptions } from './customer-agent-chat-service.js';
export { createLangGraphCustomerRuntime } from './langgraph-customer-runtime.js';
export type {
  CreateLangGraphCustomerRuntimeOptions,
  CustomerAgentRuntime,
} from './langgraph-customer-runtime.js';
export {
  AGENT_MAX_STEPS_DEFAULT,
  ALLOWED_AGENT_TOOL_NAMES,
  AgentStateAnnotation,
  createInitialAgentState,
  isAllowedAgentToolName,
  normalizeAgentRoute,
} from './langgraph-state.js';
export type {
  AgentEvidence,
  AgentMessage,
  AgentPlan,
  AgentPolicyDecision,
  AgentState,
  AgentToolCallRecord,
  AgentToolResultRecord,
  AllowedAgentToolName,
  FinalPlannerRoute,
  PlannerRoute,
} from './langgraph-state.js';
export {
  PlannerConfigurationError,
  PlannerModelParseError,
  PlannerModelRequestError,
  createOpenAiCompatiblePlannerModel,
  createScriptedPlannerModel,
} from './planner-model.js';
export type {
  OpenAiCompatiblePlannerModelOptions,
  PlannerModel,
  PlannerModelInput,
  PlannerToolDescriptor,
} from './planner-model.js';
export {
  PRODUCT_TOOL_NAMES,
  answerProductQuestionInputSchema,
  answerProductQuestionOutputSchema,
  createProductTools,
  searchProductDocsInputSchema,
  searchProductDocsOutputSchema,
} from './tools/product-tools.js';
export type {
  AnswerProductQuestionToolOutput,
  CreateProductToolsOptions,
  ProductToolName,
} from './tools/product-tools.js';
export {
  TX_ANALYSIS_TOOL_NAMES,
  analyzeTransactionInputSchema,
  analyzeTransactionOutputSchema,
  createTxAnalysisTools,
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
export type {
  ListToolsOptions,
  ToolContext,
  ToolDefinition,
  ToolPolicy,
  ToolRegistry,
} from './tool-registry.js';
