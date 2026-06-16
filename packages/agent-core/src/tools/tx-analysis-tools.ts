import { z } from 'zod';

import {
  analyzeTransaction,
  type AnalyzeTransactionInput,
  type AnalyzeTransactionOutput,
  type TxAnalysisProvider,
  type TxAnalysisReportReader,
} from '@xxyy/rag-core';

import type { ToolDefinition } from '../tool-registry.js';

export const TX_ANALYSIS_TOOL_NAMES = [
  'analyze_transaction',
  'get_analysis_report',
  'list_analysis_reports',
] as const;

export type TxAnalysisToolName = (typeof TX_ANALYSIS_TOOL_NAMES)[number];

export type TxAnalysisToolChannel = 'agent' | 'cli' | 'ops' | 'support' | 'telegram' | 'web';

export type AnalyzeTransactionToolInput = AnalyzeTransactionInput & {
  channel?: TxAnalysisToolChannel | undefined;
};

export interface CreateTxAnalysisToolsOptions {
  provider: TxAnalysisProvider | undefined;
  reportReader?: TxAnalysisReportReader;
}

const txAnalysisToolPolicy = {
  allowExternalMcp: true,
  requiresOpsAuth: false,
};

const txAnalysisChainSchema = z.enum(['solana', 'base', 'ethereum', 'bsc', 'unknown']);
const txAnalysisChannelSchema = z.enum(['agent', 'cli', 'ops', 'support', 'telegram', 'web']);
const txAnalysisReportStatusSchema = z.enum(['failure', 'success']);
const txAnalysisReviewStatusSchema = z.enum(['closed', 'in_review', 'open']);
const txAnalysisUnavailableReasonSchema = z.enum([
  'not_configured',
  'provider_unavailable',
  'invalid_reference',
  'unsupported_chain',
  'browser_verification_required',
  'tx_not_found',
  'tx_failed',
  'tx_pending',
  'pool_not_found',
  'target_trade_not_found',
  'screenshot_unavailable',
  'timeout',
]);

const txAnalysisResultSchema = z
  .object({
    analyzedAt: z.string(),
    chain: txAnalysisChainSchema,
    confidence: z.number(),
    dataSource: z.string().optional(),
    evidence: z.array(z.unknown()),
    relatedTransactions: z.array(z.unknown()),
    summary: z.string(),
    txHash: z.string(),
    verdict: z.enum(['sandwiched', 'not_sandwiched', 'inconclusive']),
  })
  .passthrough();

const txAnalysisFailureSchema = z
  .object({
    message: z.string(),
    metadata: z.object({}).passthrough().optional(),
    reason: txAnalysisUnavailableReasonSchema,
    reportUrl: z.string().optional(),
  })
  .passthrough();

export const analyzeTransactionInputSchema = z.object({
  chain: z.string().optional(),
  channel: txAnalysisChannelSchema.optional(),
  txHash: z.string(),
});

export const analyzeTransactionOutputSchema = z.discriminatedUnion('status', [
  z.object({
    result: txAnalysisResultSchema,
    status: z.literal('success'),
  }),
  z.object({
    failure: txAnalysisFailureSchema,
    status: z.literal('failure'),
  }),
]);

export const getAnalysisReportInputSchema = z.object({
  id: z.string(),
});

export const getAnalysisReportOutputSchema = z.strictObject({
  document: z.unknown().optional(),
});

export const listAnalysisReportsInputSchema = z.object({
  chain: txAnalysisChainSchema.optional(),
  limit: z.number().int().positive().optional(),
  reason: txAnalysisUnavailableReasonSchema.optional(),
  reviewAssignee: z.string().optional(),
  reviewStatus: txAnalysisReviewStatusSchema.optional(),
  status: txAnalysisReportStatusSchema.optional(),
  txHash: z.string().optional(),
});

export const listAnalysisReportsOutputSchema = z.object({
  reports: z.array(z.unknown()),
});

type AnalyzeTransactionToolDefinition = ToolDefinition<
  'analyze_transaction',
  typeof analyzeTransactionInputSchema,
  typeof analyzeTransactionOutputSchema
>;

type GetAnalysisReportToolDefinition = ToolDefinition<
  'get_analysis_report',
  typeof getAnalysisReportInputSchema,
  typeof getAnalysisReportOutputSchema
>;

type ListAnalysisReportsToolDefinition = ToolDefinition<
  'list_analysis_reports',
  typeof listAnalysisReportsInputSchema,
  typeof listAnalysisReportsOutputSchema
>;

export function createTxAnalysisTools(
  options: CreateTxAnalysisToolsOptions,
): ToolDefinition<TxAnalysisToolName>[] {
  const analyzeTransactionTool: AnalyzeTransactionToolDefinition = {
    name: 'analyze_transaction',
    description: 'Analyze a public transaction for XXYY sandwich-detection support workflows.',
    inputSchema: analyzeTransactionInputSchema,
    outputSchema: analyzeTransactionOutputSchema,
    policy: txAnalysisToolPolicy,
    async execute(input) {
      return (await analyzeTransaction({
        input: toRagAnalyzeTransactionInput(input),
        provider: options.provider,
      })) as z.input<typeof analyzeTransactionOutputSchema>;
    },
  };

  const getAnalysisReportTool: GetAnalysisReportToolDefinition = {
    name: 'get_analysis_report',
    description: 'Fetch a stored transaction-analysis report document by report id.',
    inputSchema: getAnalysisReportInputSchema,
    outputSchema: getAnalysisReportOutputSchema,
    policy: txAnalysisToolPolicy,
    async execute(input) {
      const document = await options.reportReader?.getReportDocument?.(input.id);
      return document === undefined ? {} : { document };
    },
  };

  const listAnalysisReportsTool: ListAnalysisReportsToolDefinition = {
    name: 'list_analysis_reports',
    description: 'List stored transaction-analysis reports for support and review workflows.',
    inputSchema: listAnalysisReportsInputSchema,
    outputSchema: listAnalysisReportsOutputSchema,
    policy: txAnalysisToolPolicy,
    async execute(input) {
      const reports = await options.reportReader?.findReports(toReportFindOptions(input));
      return { reports: reports ?? [] };
    },
  };

  return [analyzeTransactionTool, getAnalysisReportTool, listAnalysisReportsTool];
}

export function toRagAnalyzeTransactionInput(
  input: AnalyzeTransactionToolInput,
): AnalyzeTransactionInput {
  return input.chain === undefined
    ? { txHash: input.txHash }
    : { chain: input.chain, txHash: input.txHash };
}

export type AnalyzeTransactionToolOutput = AnalyzeTransactionOutput;

function toReportFindOptions(
  input: z.output<typeof listAnalysisReportsInputSchema>,
): Parameters<TxAnalysisReportReader['findReports']>[0] {
  return {
    ...(input.chain === undefined ? {} : { chain: input.chain }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.reviewAssignee === undefined ? {} : { reviewAssignee: input.reviewAssignee }),
    ...(input.reviewStatus === undefined ? {} : { reviewStatus: input.reviewStatus }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.txHash === undefined ? {} : { txHash: input.txHash }),
  };
}
