import {
  type AnalyzeTransactionOutput,
  type FindTxAnalysisReportsOptions,
  type TxAnalysisReportReader,
  type TxAnalysisProvider,
} from '@xxyy/rag-core';
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
    getAnalysisReport(input) {
      return registry.execute(TX_ANALYSIS_TOOL_NAMES[1], input) as Promise<{ document?: unknown }>;
    },
    listAnalysisReports(input) {
      return registry.execute(TX_ANALYSIS_TOOL_NAMES[2], input) as Promise<{
        reports: Awaited<ReturnType<TxAnalysisReportReader['findReports']>>;
      }>;
    },
  };
}
