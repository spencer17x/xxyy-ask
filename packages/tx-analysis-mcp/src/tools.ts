import {
  analyzeTransaction,
  type AnalyzeTransactionInput,
  type AnalyzeTransactionOutput,
  type TxAnalysisProvider,
} from '@xxyy/rag-core';

export interface TxAnalysisToolHandlersOptions {
  provider: TxAnalysisProvider | undefined;
}

export interface TxAnalysisToolHandlers {
  analyzeTransaction(input: AnalyzeTransactionInput): Promise<AnalyzeTransactionOutput>;
}

export function createTxAnalysisToolHandlers(
  options: TxAnalysisToolHandlersOptions,
): TxAnalysisToolHandlers {
  return {
    analyzeTransaction(input) {
      return analyzeTransaction({
        input,
        provider: options.provider,
      });
    },
  };
}
