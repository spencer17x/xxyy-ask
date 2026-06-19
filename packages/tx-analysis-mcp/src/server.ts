import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  TX_ANALYSIS_TOOL_NAMES,
  analyzeTransactionInputSchema,
  getAnalysisReportInputSchema,
  listAnalysisReportsInputSchema,
  sanitizeSessionText,
  type QualitySignalChannel,
  type QualitySignalSink,
} from '@xxyy/agent-core';
import type { TxAnalysisUnavailableReason } from '@xxyy/rag-core';
import type { FindTxAnalysisReportsOptions } from '@xxyy/rag-core';
import type { z } from 'zod';

import type { TxAnalysisToolHandlers } from './tools.js';

export const TX_ANALYSIS_MCP_TOOL_NAMES = TX_ANALYSIS_TOOL_NAMES;

export const TX_ANALYSIS_MCP_INSTRUCTIONS = [
  'Use this server for XXYY 交易夹子检测 when the user provides one clear transaction hash or supported explorer link.',
  'Treat unknown as bare EVM auto-detect across Base, Ethereum, and BSC. Unknown is not a real chain.',
  'Do not provide investment advice.',
  'Do not use this server for private account, wallet balance, order, or user identity lookup.',
].join(' ');

export interface CreateTxAnalysisMcpServerOptions {
  handlers: TxAnalysisToolHandlers;
  qualitySignals?: QualitySignalSink;
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
      const output = await options.handlers.analyzeTransaction({
        ...(chain === undefined ? {} : { chain }),
        ...(channel === undefined ? {} : { channel }),
        txHash,
      });
      if (output.status === 'failure') {
        recordTxAnalysisQualitySignal(options.qualitySignals, {
          answer: output.failure.message,
          channel: toQualitySignalChannel(channel),
          chain,
          reason: output.failure.reason,
          txHash,
        });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    TX_ANALYSIS_MCP_TOOL_NAMES[1],
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
    TX_ANALYSIS_MCP_TOOL_NAMES[2],
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
  input: z.output<typeof listAnalysisReportsInputSchema>,
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

function recordTxAnalysisQualitySignal(
  qualitySignals: QualitySignalSink | undefined,
  input: {
    answer: string;
    channel: QualitySignalChannel;
    chain: string | undefined;
    reason: TxAnalysisUnavailableReason;
    txHash: string;
  },
): void {
  qualitySignals?.record({
    answer: sanitizeSessionText(input.answer),
    channel: input.channel,
    errorCode: input.reason,
    intent: 'tx_sandwich_detection',
    reason: 'tx_analysis_failure',
    redactedQuestion: sanitizeSessionText(
      input.chain === undefined ? input.txHash : `${input.chain} ${input.txHash}`,
    ),
    sessionIdPresent: false,
    userIdPresent: false,
  });
}

function toQualitySignalChannel(channel: string | undefined): QualitySignalChannel {
  if (channel === 'cli' || channel === 'telegram' || channel === 'web') {
    return channel;
  }

  return 'agent';
}
