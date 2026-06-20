import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { TX_ANALYSIS_TOOL_NAMES, analyzeTransactionInputSchema } from '@xxyy/agent-core';
import type { AnalyzeTransactionOutput } from '@xxyy/rag-core';

import type { TxAnalysisToolHandlers } from './tools.js';

export const TX_ANALYSIS_MCP_TOOL_NAMES = TX_ANALYSIS_TOOL_NAMES;
type AnalyzeTransactionFailureOutput = Extract<AnalyzeTransactionOutput, { status: 'failure' }>;

export const TX_ANALYSIS_MCP_INSTRUCTIONS = [
  'Use this server for XXYY 交易夹子检测 when the user provides one clear transaction hash or supported explorer link.',
  'Treat unknown as bare EVM auto-detect across Base, Ethereum, and BSC. Unknown is not a real chain.',
  'Do not provide investment advice.',
  'Do not use this server for private account, wallet balance, order, or user identity lookup.',
].join(' ');

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
    TX_ANALYSIS_MCP_TOOL_NAMES[0],
    {
      description:
        'Analyze whether one XXYY-related transaction hash or supported explorer link was sandwiched.',
      inputSchema: analyzeTransactionInputSchema,
      title: 'Analyze Transaction Sandwich Status',
    },
    async ({ chain, channel, txHash }) => {
      let output: AnalyzeTransactionOutput;
      try {
        output = await options.handlers.analyzeTransaction({
          ...(chain === undefined ? {} : { chain }),
          ...(channel === undefined ? {} : { channel }),
          txHash,
        });
      } catch {
        output = createProviderUnavailableOutput();
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  return server;
}

function createProviderUnavailableOutput(): AnalyzeTransactionFailureOutput {
  return {
    failure: {
      message: 'Transaction analysis provider is temporarily unavailable.',
      reason: 'provider_unavailable',
    },
    status: 'failure',
  };
}
