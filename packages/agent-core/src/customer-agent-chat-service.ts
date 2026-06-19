import type { RagIndex } from '@xxyy/shared';
import type {
  AnswerProvider,
  RagConfig,
  Retriever,
  TxAnalysisProvider,
  TxAnalysisReportReader,
} from '@xxyy/rag-core';

import type { ToolAuditSink } from './audit.js';
import { createCustomerAgentRuntime, type CustomerAgentRuntime } from './customer-agent-runtime.js';
import type { QualitySignalSink } from './quality-signals.js';
import type { SessionContextStore } from './session-context.js';
import { createProductTools } from './tools/product-tools.js';
import { createTxAnalysisTools } from './tools/tx-analysis-tools.js';
import { createToolRegistry } from './tool-registry.js';

export interface CreateCustomerAgentChatServiceOptions {
  answerProvider: AnswerProvider;
  audit?: ToolAuditSink;
  config?: Partial<RagConfig>;
  index?: RagIndex;
  qualityConfidenceThreshold?: number;
  qualitySignals?: QualitySignalSink;
  retriever?: Retriever;
  sessionContext?: SessionContextStore;
  txAnalysisProvider: TxAnalysisProvider | undefined;
  txAnalysisReportReader?: TxAnalysisReportReader;
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
    ...(options.txAnalysisReportReader === undefined
      ? {}
      : { reportReader: options.txAnalysisReportReader }),
  })) {
    registry.register(tool);
  }

  return createCustomerAgentRuntime({
    registry,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.qualityConfidenceThreshold === undefined
      ? {}
      : { qualityConfidenceThreshold: options.qualityConfidenceThreshold }),
    ...(options.qualitySignals === undefined ? {} : { qualitySignals: options.qualitySignals }),
    ...(options.sessionContext === undefined ? {} : { sessionContext: options.sessionContext }),
  });
}
