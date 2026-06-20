import { z } from 'zod';

import {
  analyzeTransaction,
  type AnalyzeTransactionInput,
  type AnalyzeTransactionOutput,
  type TxAnalysisProvider,
} from '@xxyy/rag-core';

import type { ToolDefinition } from '../tool-registry.js';

export const TX_ANALYSIS_TOOL_NAMES = ['analyze_transaction'] as const;

export type TxAnalysisToolName = (typeof TX_ANALYSIS_TOOL_NAMES)[number];

export type TxAnalysisToolChannel = 'agent' | 'cli' | 'ops' | 'support' | 'telegram' | 'web';

export type AnalyzeTransactionToolInput = AnalyzeTransactionInput & {
  channel?: TxAnalysisToolChannel | undefined;
};

export interface CreateTxAnalysisToolsOptions {
  provider: TxAnalysisProvider | undefined;
}

const txAnalysisToolPolicy = {
  allowExternalMcp: true,
  requiresOpsAuth: false,
};

const txAnalysisChainSchema = z.enum(['solana', 'base', 'ethereum', 'bsc', 'unknown']);
const txAnalysisChannelSchema = z.enum(['agent', 'cli', 'ops', 'support', 'telegram', 'web']);
const nonEmptyStringSchema = z.string().trim().min(1);
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
  txHash: nonEmptyStringSchema,
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

type AnalyzeTransactionToolDefinition = ToolDefinition<
  'analyze_transaction',
  typeof analyzeTransactionInputSchema,
  typeof analyzeTransactionOutputSchema
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

  return [analyzeTransactionTool];
}

export function toRagAnalyzeTransactionInput(
  input: AnalyzeTransactionToolInput,
): AnalyzeTransactionInput {
  return input.chain === undefined
    ? { txHash: input.txHash }
    : { chain: input.chain, txHash: input.txHash };
}

export type AnalyzeTransactionToolOutput = AnalyzeTransactionOutput;
