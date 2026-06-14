import {
  analyzeTransaction,
  type AnalyzeTransactionInput,
  type AnalyzeTransactionOutput,
  type TxAnalysisProvider,
} from '@xxyy/rag-core';

export type TxAnalysisToolChannel = 'agent' | 'ops' | 'support';

export type AnalyzeTransactionToolInput = AnalyzeTransactionInput & {
  channel?: TxAnalysisToolChannel;
};

export interface TxAnalysisToolHandlersOptions {
  provider: TxAnalysisProvider | undefined;
}

export interface TxAnalysisToolHandlers {
  analyzeTransaction(input: AnalyzeTransactionToolInput): Promise<AnalyzeTransactionOutput>;
}

export function createTxAnalysisToolHandlers(
  options: TxAnalysisToolHandlersOptions,
): TxAnalysisToolHandlers {
  return {
    analyzeTransaction(input) {
      return analyzeTransaction({
        input: toRagAnalyzeTransactionInput(input),
        provider: options.provider,
      });
    },
  };
}

function toRagAnalyzeTransactionInput(input: AnalyzeTransactionToolInput): AnalyzeTransactionInput {
  return {
    ...(input.chain === undefined ? {} : { chain: input.chain }),
    txHash: input.txHash,
  };
}
