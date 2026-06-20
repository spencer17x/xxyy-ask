import type { RagIndex } from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  type AnswerProvider,
  type RagConfig,
  type Retriever,
  type TxAnalysisProvider,
} from '@xxyy/rag-core';

import { planAnswer } from './answer-planner.js';
import type { ToolAuditSink } from './audit.js';
import {
  createLangGraphCustomerRuntime,
  type CustomerAgentRuntime,
} from './langgraph-customer-runtime.js';
import { createOpenAiCompatiblePlannerModel, type PlannerModel } from './planner-model.js';
import type { QualitySignalSink } from './quality-signals.js';
import type { SessionContextStore } from './session-context.js';
import { createProductTools } from './tools/product-tools.js';
import { createTxAnalysisTools } from './tools/tx-analysis-tools.js';
import { createToolRegistry } from './tool-registry.js';

export interface CreateCustomerAgentChatServiceOptions {
  answerProvider: AnswerProvider;
  /** @deprecated Compatibility field retained during LangGraph migration. */
  audit?: ToolAuditSink;
  config?: Partial<RagConfig>;
  index?: RagIndex;
  planner?: PlannerModel;
  /** @deprecated Compatibility field retained during LangGraph migration. */
  qualityConfidenceThreshold?: number;
  /** @deprecated Compatibility field retained during LangGraph migration. */
  qualitySignals?: QualitySignalSink;
  retriever?: Retriever;
  /** @deprecated Compatibility field retained during LangGraph migration. */
  sessionContext?: SessionContextStore;
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
    planner: options.planner ?? createDefaultPlannerModel(),
    registry,
  });
}

function createDefaultPlannerModel(): PlannerModel {
  if (hasOpenAiPlannerConfiguration()) {
    return createOpenAiCompatiblePlannerModel({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL,
    });
  }

  return {
    plan(input) {
      const classification = classifyQuestion(input.request.message);
      const plan = planAnswer({
        classification,
        resolvedMessage: input.request.message,
      });

      if (plan.route === 'product_answer') {
        return Promise.resolve({
          input: {
            channel: input.request.channel,
            question: plan.messageForTool,
          },
          kind: 'tool',
          reason: 'Compatibility planner selected the product answer tool.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        });
      }

      if (plan.route === 'transaction_analysis') {
        return Promise.resolve({
          input: {
            txHash: plan.messageForTool,
          },
          kind: 'tool',
          reason: 'Compatibility planner selected the transaction analysis tool.',
          route: 'transaction_analysis',
          toolName: 'analyze_transaction',
        });
      }

      if (plan.route === 'boundary') {
        return Promise.resolve({
          kind: 'final',
          reason: 'Compatibility planner returned a boundary response.',
          response: createBoundaryAnswer(plan.classification),
          route: 'boundary',
        });
      }

      if (plan.route === 'clarify') {
        return Promise.resolve({
          kind: 'final',
          reason: plan.clarificationReason,
          response: {
            answer: plan.clarificationQuestion,
            citations: [],
            confidence:
              plan.clarificationReason === 'ambiguous_transaction_reference' ? 0.55 : 0.45,
            intent: plan.classification.intent,
          },
          route: 'clarify',
        });
      }

      return Promise.resolve({
        kind: 'final',
        reason: 'Compatibility planner could not select a supported route.',
        response: {
          answer: '当前没有足够信息生成可靠回答。请补充具体功能、配置步骤或单笔公开交易哈希。',
          citations: [],
          confidence: 0.35,
          intent: classification.intent,
        },
        route: 'clarify',
      });
    },
  };
}

function hasOpenAiPlannerConfiguration(): boolean {
  return (
    process.env.OPENAI_API_KEY !== undefined &&
    process.env.OPENAI_API_KEY.trim().length > 0 &&
    process.env.OPENAI_MODEL !== undefined &&
    process.env.OPENAI_MODEL.trim().length > 0
  );
}
