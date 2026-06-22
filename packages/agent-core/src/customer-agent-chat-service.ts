import type { RagIndex } from '@xxyy/shared';
import {
  LlmConfigurationError,
  loadRagConfig,
  type AnswerProvider,
  type RagConfig,
  type Retriever,
  type TxAnalysisProvider,
} from '@xxyy/rag-core';

import {
  createLangGraphCustomerRuntime,
  type CustomerAgentRuntime,
} from './langgraph-customer-runtime.js';
import { createOpenAiCompatiblePlannerModel, type PlannerModel } from './planner-model.js';
import { createProductTools } from './tools/product-tools.js';
import { createTxAnalysisTools } from './tools/tx-analysis-tools.js';
import { createToolRegistry } from './tool-registry.js';

export interface CreateCustomerAgentChatServiceOptions {
  answerProvider: AnswerProvider;
  /** @deprecated Compatibility field retained during LangGraph migration. */
  audit?: unknown;
  config?: Partial<RagConfig>;
  index?: RagIndex;
  planner?: PlannerModel;
  /** @deprecated Compatibility field retained during LangGraph migration. */
  qualityConfidenceThreshold?: number;
  /** @deprecated Compatibility field retained during LangGraph migration. */
  qualitySignals?: unknown;
  retriever?: Retriever;
  /** @deprecated Compatibility field retained during LangGraph migration. */
  sessionContext?: unknown;
  txAnalysisProvider: TxAnalysisProvider | undefined;
}

export function createCustomerAgentChatService(
  options: CreateCustomerAgentChatServiceOptions,
): CustomerAgentRuntime {
  const registry = createToolRegistry();

  for (const tool of createProductTools({
    answerProvider: options.answerProvider,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(options.retriever === undefined ? {} : { retriever: options.retriever }),
  })) {
    registry.register(tool);
  }

  for (const tool of createTxAnalysisTools({
    provider: options.txAnalysisProvider,
  })) {
    registry.register(tool);
  }

  return createLangGraphCustomerRuntime({
    planner: options.planner ?? createDefaultPlannerModel(options.config),
    registry,
  });
}

function createDefaultPlannerModel(configOverrides: Partial<RagConfig> | undefined): PlannerModel {
  const config = {
    ...loadRagConfig(),
    ...(configOverrides ?? {}),
  };

  if (config.openAiApiKey === undefined || config.openAiApiKey.trim().length === 0) {
    return createPlannerConfigurationErrorModel(
      new LlmConfigurationError('OPENAI_API_KEY is required for agent planning.'),
    );
  }
  if (config.openAiModel === undefined || config.openAiModel.trim().length === 0) {
    return createPlannerConfigurationErrorModel(
      new LlmConfigurationError('OPENAI_MODEL is required for agent planning.'),
    );
  }

  return createOpenAiCompatiblePlannerModel({
    apiKey: config.openAiApiKey,
    baseUrl: config.openAiBaseUrl,
    model: config.openAiModel,
    requestTimeoutMs: config.openAiRequestTimeoutMs,
  });
}

function createPlannerConfigurationErrorModel(error: LlmConfigurationError): PlannerModel {
  return {
    plan() {
      return Promise.reject(error);
    },
  };
}
