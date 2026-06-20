import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  TX_ANALYSIS_TOOL_NAMES,
  analyzeTransactionInputSchema,
  sanitizeSessionText,
  type QualitySignalChannel,
  type QualitySignalSink,
} from '@xxyy/agent-core';
import type { AnalyzeTransactionOutput, TxAnalysisUnavailableReason } from '@xxyy/rag-core';

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
      let output: AnalyzeTransactionOutput;
      let qualitySignalRecorded = false;
      try {
        output = await options.handlers.analyzeTransaction({
          ...(chain === undefined ? {} : { chain }),
          ...(channel === undefined ? {} : { channel }),
          txHash,
        });
      } catch (error) {
        const failureOutput = createProviderUnavailableOutput();
        output = failureOutput;
        recordTxAnalysisQualitySignal(options.qualitySignals, {
          answer: failureOutput.failure.message,
          channel: toQualitySignalChannel(channel),
          chain,
          errorCode: errorCodeFrom(error),
          reason: 'tool_failure',
          txHash,
        });
        qualitySignalRecorded = true;
      }
      if (!qualitySignalRecorded && output.status === 'failure') {
        recordTxAnalysisQualitySignal(options.qualitySignals, {
          answer: output.failure.message,
          channel: toQualitySignalChannel(channel),
          chain,
          errorCode: output.failure.reason,
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

function recordTxAnalysisQualitySignal(
  qualitySignals: QualitySignalSink | undefined,
  input: {
    answer: string;
    channel: QualitySignalChannel;
    chain: string | undefined;
    errorCode: string;
    reason: 'tool_failure' | TxAnalysisUnavailableReason;
    txHash: string;
  },
): void {
  qualitySignals?.record({
    answer: sanitizeSessionText(input.answer),
    channel: input.channel,
    errorCode: input.errorCode,
    intent: 'tx_sandwich_detection',
    reason: input.reason === 'tool_failure' ? 'tool_failure' : 'tx_analysis_failure',
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

function errorCodeFrom(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) {
    return error.name;
  }

  return 'unknown_error';
}
