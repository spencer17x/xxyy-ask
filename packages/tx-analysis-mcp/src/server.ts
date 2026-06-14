import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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

const analyzeTransactionInputSchema = z.object({
  chain: chainSchema,
  channel: z.enum(['agent', 'ops', 'support']).optional(),
  txHash: z.string().min(1),
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

  return server;
}
