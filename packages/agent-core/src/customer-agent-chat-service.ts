import type { RagIndex } from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  loadRagConfig,
  type AnswerProvider,
  type RagConfig,
  type Retriever,
  type TxAnalysisProvider,
} from '@xxyy/rag-core';

import {
  isAmbiguousTransactionReferenceClassification,
  isBusinessActionClassification,
  isPrivateCredentialClassification,
  isUnsafeUnsupportedClassification,
} from './classification-guards.js';
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

  if (hasOpenAiPlannerConfiguration(config)) {
    return createOpenAiCompatiblePlannerModel({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      model: config.openAiModel,
    });
  }

  return {
    plan(input) {
      const classification = classifyQuestion(input.request.message);

      if (classification.intent === 'product_qa' || classification.intent === 'how_to') {
        return Promise.resolve({
          input: {
            channel: input.request.channel,
            question: input.request.message,
          },
          kind: 'tool',
          reason: 'Compatibility planner selected the product answer tool.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        });
      }

      if (classification.intent === 'tx_sandwich_detection') {
        if (isAmbiguousTransactionReferenceClassification(classification)) {
          return Promise.resolve({
            kind: 'final',
            reason: 'ambiguous_transaction_reference',
            response: {
              answer:
                '一次只能分析一笔交易。请发送单笔完整交易哈希或对应主网浏览器链接，我会自动继续分析。',
              citations: [],
              confidence: 0.55,
              intent: classification.intent,
            },
            route: 'clarify',
          });
        }

        return Promise.resolve({
          input: {
            txHash: input.request.message,
          },
          kind: 'tool',
          reason: 'Compatibility planner selected the transaction analysis tool.',
          route: 'transaction_analysis',
          toolName: 'analyze_transaction',
        });
      }

      if (
        isUnsafeUnsupportedClassification(classification) ||
        isPrivateCredentialClassification(classification) ||
        isBusinessActionClassification(classification)
      ) {
        return Promise.resolve({
          kind: 'final',
          reason: 'Compatibility planner returned a boundary response.',
          response: createBoundaryAnswer(classification),
          route: 'boundary',
        });
      }

      if (classification.intent === 'unknown') {
        return Promise.resolve({
          kind: 'final',
          reason: 'unknown_intent',
          response: {
            answer:
              '我还不确定你想咨询 XXYY 的哪个功能。请补充具体功能、配置步骤、Pro 权益，或发送单笔交易哈希。',
            citations: [],
            confidence: 0.45,
            intent: classification.intent,
          },
          route: 'clarify',
        });
      }

      return Promise.resolve({
        kind: 'final',
        reason: 'Compatibility planner returned a boundary response.',
        response: createBoundaryAnswer(classification),
        route: 'boundary',
      });
    },
  };
}

function hasOpenAiPlannerConfiguration(
  config: Pick<RagConfig, 'databaseUrl' | 'openAiApiKey' | 'openAiModel'>,
): boolean {
  return (
    config.databaseUrl !== undefined &&
    config.databaseUrl.trim().length > 0 &&
    config.openAiApiKey !== undefined &&
    config.openAiApiKey.trim().length > 0 &&
    config.openAiModel !== undefined &&
    config.openAiModel.trim().length > 0
  );
}
