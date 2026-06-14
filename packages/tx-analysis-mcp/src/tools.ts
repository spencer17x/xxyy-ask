import {
  analyzeTransaction,
  type AnalyzeTransactionInput,
  type AnalyzeTransactionOutput,
  type FindTxAnalysisReportsOptions,
  type TxAnalysisReportReader,
  type TxAnalysisProvider,
} from '@xxyy/rag-core';

export type TxAnalysisToolChannel = 'agent' | 'ops' | 'support';

export type AnalyzeTransactionToolInput = AnalyzeTransactionInput & {
  channel?: TxAnalysisToolChannel;
};

export interface TxAnalysisToolHandlersOptions {
  provider: TxAnalysisProvider | undefined;
  reportReader?: TxAnalysisReportReader;
}

export interface TxAnalysisToolHandlers {
  analyzeTransaction(input: AnalyzeTransactionToolInput): Promise<AnalyzeTransactionOutput>;
  getAnalysisReport(input: { id: string }): Promise<{ document?: unknown }>;
  listAnalysisReports(
    input: FindTxAnalysisReportsOptions,
  ): Promise<{ reports: Awaited<ReturnType<TxAnalysisReportReader['findReports']>> }>;
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
    async getAnalysisReport(input) {
      const document = await options.reportReader?.getReportDocument?.(input.id);
      return document === undefined ? {} : { document };
    },
    async listAnalysisReports(input) {
      if (options.reportReader === undefined) {
        return { reports: [] };
      }
      return { reports: await options.reportReader.findReports(input) };
    },
  };
}

function toRagAnalyzeTransactionInput(input: AnalyzeTransactionToolInput): AnalyzeTransactionInput {
  return {
    ...(input.chain === undefined ? {} : { chain: input.chain }),
    txHash: input.txHash,
  };
}
