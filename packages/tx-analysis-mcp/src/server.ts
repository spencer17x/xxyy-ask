import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { FindTxAnalysisReportsOptions, TxAnalysisUnavailableReason } from '@xxyy/rag-core';

import type { TxAnalysisToolHandlers } from './tools.js';

export const TX_ANALYSIS_MCP_TOOL_NAMES = [
  'analyze_transaction',
  'get_analysis_report',
  'list_analysis_reports',
] as const;

export const TX_ANALYSIS_MCP_INSTRUCTIONS = [
  'Use this server for XXYY 交易夹子检测 when the user provides one clear transaction hash or supported explorer link.',
  'Treat unknown as bare EVM auto-detect across Base, Ethereum, and BSC. Unknown is not a real chain.',
  'Do not provide investment advice.',
  'Do not use this server for private account, wallet balance, order, or user identity lookup.',
].join(' ');

const chainSchema = z.enum(['solana', 'base', 'ethereum', 'bsc', 'unknown']).optional();
const reportStatusSchema = z.enum(['success', 'failure']).optional();
const reviewStatusSchema = z.enum(['open', 'in_review', 'closed']).optional();
const txAnalysisUnavailableReasons = [
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
] as const satisfies readonly TxAnalysisUnavailableReason[];
const failureReasonSchema = z.enum(txAnalysisUnavailableReasons).optional();

const analyzeTransactionInputSchema = z.object({
  chain: chainSchema,
  channel: z.enum(['agent', 'ops', 'support']).optional(),
  txHash: z.string().min(1),
});
const getAnalysisReportInputSchema = z.object({
  id: z.string().min(1),
});
const listAnalysisReportsInputSchema = z.object({
  chain: chainSchema,
  limit: z.number().int().positive().optional(),
  reason: failureReasonSchema,
  reviewAssignee: z.string().min(1).optional(),
  reviewStatus: reviewStatusSchema,
  status: reportStatusSchema,
  txHash: z.string().min(1).optional(),
});

export interface CreateTxAnalysisMcpServerOptions {
  handlers: TxAnalysisToolHandlers;
}

export function createTxAnalysisMcpServer(options: CreateTxAnalysisMcpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: 'xxyy-transaction-analysis',
      version: '0.1.0',
    },
    {
      instructions: TX_ANALYSIS_MCP_INSTRUCTIONS,
    },
  );

  server.registerTool(
    'analyze_transaction',
    {
      description:
        'Analyze whether one XXYY-related transaction hash or supported explorer link was sandwiched.',
      inputSchema: analyzeTransactionInputSchema,
      title: 'Analyze Transaction Sandwich Status',
    },
    async ({ chain, channel, txHash }) => {
      const output = await options.handlers.analyzeTransaction({
        ...(chain === undefined ? {} : { chain }),
        ...(channel === undefined ? {} : { channel }),
        txHash,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    'get_analysis_report',
    {
      description: 'Fetch one stored XXYY transaction analysis report document by report id.',
      inputSchema: getAnalysisReportInputSchema,
      title: 'Get Transaction Analysis Report',
    },
    async ({ id }) => {
      const output = await options.handlers.getAnalysisReport({ id });
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    'list_analysis_reports',
    {
      description: 'List stored XXYY transaction analysis reports with optional filters.',
      inputSchema: listAnalysisReportsInputSchema,
      title: 'List Transaction Analysis Reports',
    },
    async (input) => {
      const output = await options.handlers.listAnalysisReports(toFindReportsInput(input));
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  return server;
}

function toFindReportsInput(
  input: z.infer<typeof listAnalysisReportsInputSchema>,
): FindTxAnalysisReportsOptions {
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
