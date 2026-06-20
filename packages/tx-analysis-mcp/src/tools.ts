import { type AnalyzeTransactionOutput, type TxAnalysisProvider } from '@xxyy/rag-core';
import {
  TX_ANALYSIS_TOOL_NAMES,
  createToolRegistry,
  createTxAnalysisTools,
  type AnalyzeTransactionToolInput,
} from '@xxyy/agent-core';

export type { AnalyzeTransactionToolInput } from '@xxyy/agent-core';
export type TxAnalysisToolChannel = NonNullable<AnalyzeTransactionToolInput['channel']>;

export interface TxAnalysisToolHandlersOptions {
  provider: TxAnalysisProvider | undefined;
}

export interface TxAnalysisToolHandlers {
  analyzeTransaction(input: AnalyzeTransactionToolInput): Promise<AnalyzeTransactionOutput>;
}

export function createTxAnalysisToolHandlers(
  options: TxAnalysisToolHandlersOptions,
): TxAnalysisToolHandlers {
  const registry = createToolRegistry();
  for (const tool of createTxAnalysisTools(options)) {
    registry.register(tool);
  }

  return {
    analyzeTransaction(input) {
      return registry.execute(
        TX_ANALYSIS_TOOL_NAMES[0],
        input,
      ) as Promise<AnalyzeTransactionOutput>;
    },
  };
}
