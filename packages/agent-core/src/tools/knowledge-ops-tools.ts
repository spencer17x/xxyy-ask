import { z } from 'zod';

import type { ToolDefinition } from '../tool-registry.js';

export const KNOWLEDGE_OPS_TOOL_NAMES = [
  'list_knowledge_candidates',
  'review_knowledge_candidate',
  'publish_knowledge_candidate',
  'run_knowledge_gate',
  'sync_telegram_support',
] as const;

export type KnowledgeOpsToolName = (typeof KNOWLEDGE_OPS_TOOL_NAMES)[number];

const knowledgeOpsToolPolicy = {
  allowExternalMcp: true,
  requiresOpsAuth: true,
};

const nonEmptyStringSchema = z.string().trim().min(1);
const knowledgeCandidateStatusSchema = z.enum([
  'draft',
  'needs_review',
  'approved',
  'rejected',
  'published',
  'ingested',
  'eval_passed',
  'eval_failed',
]);
const knowledgeCandidateTypeSchema = z.enum(['faq', 'doc_patch', 'boundary_example', 'eval_case']);
const knowledgeRiskLevelSchema = z.enum(['low', 'medium', 'high']);
const reviewActionSchema = z.enum(['approve', 'reject', 'request_changes', 'merge_duplicate']);

const knowledgeCandidateSchema = z.object({
  confidence: z.number(),
  createdAt: z.string(),
  existingKnowledgeMatches: z.array(z.unknown()),
  generatedEvalCases: z.array(z.unknown()),
  id: z.string(),
  proposedAnswer: z.string(),
  publishedTarget: z.string().optional(),
  question: z.string(),
  redactionReport: z.unknown(),
  reviewNotes: z.string().optional(),
  reviewer: z.string().optional(),
  riskLevel: knowledgeRiskLevelSchema,
  sourceRefs: z.array(z.unknown()),
  status: knowledgeCandidateStatusSchema,
  targetCategory: z.enum(['product_faq', 'policy_boundary', 'doc_patch', 'eval_case']),
  type: knowledgeCandidateTypeSchema,
  updatedAt: z.string(),
});

export const listKnowledgeCandidatesInputSchema = z.object({
  limit: z.number().int().positive().optional(),
  riskLevel: knowledgeRiskLevelSchema.optional(),
  status: knowledgeCandidateStatusSchema.optional(),
  type: knowledgeCandidateTypeSchema.optional(),
});

export const listKnowledgeCandidatesOutputSchema = z.object({
  candidates: z.array(knowledgeCandidateSchema),
  count: z.number().int().nonnegative(),
});

export const reviewKnowledgeCandidateInputSchema = z.object({
  action: reviewActionSchema,
  id: nonEmptyStringSchema,
  notes: z.string().trim().min(1).optional(),
  reviewedAt: nonEmptyStringSchema.optional(),
  reviewer: nonEmptyStringSchema,
});

export const reviewKnowledgeCandidateOutputSchema = z.object({
  candidate: knowledgeCandidateSchema,
});

export const publishKnowledgeCandidateInputSchema = z.object({
  id: nonEmptyStringSchema,
  target: nonEmptyStringSchema.optional(),
});

export const publishKnowledgeCandidateOutputSchema = z.object({
  candidateId: z.string(),
  publishedTarget: z.string(),
  publishRunId: z.string(),
});

export const runKnowledgeGateInputSchema = z
  .object({
    approvedEvalOnly: z.boolean().optional(),
    fast: z.boolean().optional(),
    id: nonEmptyStringSchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.approvedEvalOnly === true && input.id !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'run_knowledge_gate accepts either id or approvedEvalOnly, not both.',
        path: ['approvedEvalOnly'],
      });
    }

    if (input.approvedEvalOnly !== true && input.id === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'run_knowledge_gate requires id unless approvedEvalOnly is true.',
        path: ['id'],
      });
    }
  });

export const runKnowledgeGateOutputSchema = z.object({
  approvedEvalOnly: z.boolean().optional(),
  candidateId: z.string().optional(),
  evaluation: z
    .object({
      passed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .passthrough()
    .optional(),
  exitCode: z.number().int().optional(),
  failedCount: z.number().int().nonnegative().optional(),
  passedCount: z.number().int().nonnegative().optional(),
  status: z.enum(['passed', 'failed']),
  stderr: z.string().optional(),
  stdout: z.string().optional(),
  totalCount: z.number().int().nonnegative().optional(),
});

export const syncTelegramSupportInputSchema = z.object({});

export const syncTelegramSupportOutputSchema = z
  .object({
    exitCode: z.number().int(),
    stderr: z.string().optional(),
    stdout: z.string().optional(),
  })
  .passthrough();

export type KnowledgeOpsCandidate = z.input<typeof knowledgeCandidateSchema>;
export type ListKnowledgeCandidatesInput = z.output<typeof listKnowledgeCandidatesInputSchema>;
export type ReviewKnowledgeCandidateInput = z.output<typeof reviewKnowledgeCandidateInputSchema>;
export type PublishKnowledgeCandidateInput = z.output<typeof publishKnowledgeCandidateInputSchema>;
export type PublishKnowledgeCandidateOutput = z.input<typeof publishKnowledgeCandidateOutputSchema>;
export type RunKnowledgeGateInput = z.output<typeof runKnowledgeGateInputSchema>;
export type RunKnowledgeGateOutput = z.input<typeof runKnowledgeGateOutputSchema>;
export type SyncTelegramSupportInput = z.output<typeof syncTelegramSupportInputSchema>;
export type SyncTelegramSupportOutput = z.input<typeof syncTelegramSupportOutputSchema>;

export interface CreateKnowledgeOpsToolsOptions {
  listCandidates(input: ListKnowledgeCandidatesInput): Promise<KnowledgeOpsCandidate[]>;
  publishKnowledgeCandidate(
    input: PublishKnowledgeCandidateInput,
  ): Promise<PublishKnowledgeCandidateOutput>;
  reviewCandidate(
    id: string,
    input: Omit<ReviewKnowledgeCandidateInput, 'id'>,
  ): Promise<KnowledgeOpsCandidate>;
  runKnowledgeGate(input: RunKnowledgeGateInput): Promise<RunKnowledgeGateOutput>;
  syncTelegramSupport(input: SyncTelegramSupportInput): Promise<SyncTelegramSupportOutput>;
}

type ListKnowledgeCandidatesToolDefinition = ToolDefinition<
  'list_knowledge_candidates',
  typeof listKnowledgeCandidatesInputSchema,
  typeof listKnowledgeCandidatesOutputSchema
>;

type ReviewKnowledgeCandidateToolDefinition = ToolDefinition<
  'review_knowledge_candidate',
  typeof reviewKnowledgeCandidateInputSchema,
  typeof reviewKnowledgeCandidateOutputSchema
>;

type PublishKnowledgeCandidateToolDefinition = ToolDefinition<
  'publish_knowledge_candidate',
  typeof publishKnowledgeCandidateInputSchema,
  typeof publishKnowledgeCandidateOutputSchema
>;

type RunKnowledgeGateToolDefinition = ToolDefinition<
  'run_knowledge_gate',
  typeof runKnowledgeGateInputSchema,
  typeof runKnowledgeGateOutputSchema
>;

type SyncTelegramSupportToolDefinition = ToolDefinition<
  'sync_telegram_support',
  typeof syncTelegramSupportInputSchema,
  typeof syncTelegramSupportOutputSchema
>;

export function createKnowledgeOpsTools(
  options: CreateKnowledgeOpsToolsOptions,
): ToolDefinition<KnowledgeOpsToolName>[] {
  const listKnowledgeCandidatesTool: ListKnowledgeCandidatesToolDefinition = {
    name: 'list_knowledge_candidates',
    description: 'List XXYY knowledge candidates in the human review queue.',
    inputSchema: listKnowledgeCandidatesInputSchema,
    outputSchema: listKnowledgeCandidatesOutputSchema,
    policy: knowledgeOpsToolPolicy,
    async execute(input) {
      const candidates = await options.listCandidates(input);
      return {
        candidates,
        count: candidates.length,
      };
    },
  };

  const reviewKnowledgeCandidateTool: ReviewKnowledgeCandidateToolDefinition = {
    name: 'review_knowledge_candidate',
    description: 'Apply a human review decision to one XXYY knowledge candidate.',
    inputSchema: reviewKnowledgeCandidateInputSchema,
    outputSchema: reviewKnowledgeCandidateOutputSchema,
    policy: knowledgeOpsToolPolicy,
    async execute(input) {
      const { id, ...reviewInput } = input;
      return {
        candidate: await options.reviewCandidate(id, reviewInput),
      };
    },
  };

  const publishKnowledgeCandidateTool: PublishKnowledgeCandidateToolDefinition = {
    name: 'publish_knowledge_candidate',
    description: 'Publish one approved XXYY knowledge candidate to reviewed support knowledge.',
    inputSchema: publishKnowledgeCandidateInputSchema,
    outputSchema: publishKnowledgeCandidateOutputSchema,
    policy: knowledgeOpsToolPolicy,
    execute(input) {
      return options.publishKnowledgeCandidate(input);
    },
  };

  const runKnowledgeGateTool: RunKnowledgeGateToolDefinition = {
    name: 'run_knowledge_gate',
    description:
      'Run ingest, embeddings, and targeted eval gate for one candidate, or batch-gate approved eval-only candidates.',
    inputSchema: runKnowledgeGateInputSchema,
    outputSchema: runKnowledgeGateOutputSchema,
    policy: knowledgeOpsToolPolicy,
    execute(input) {
      return options.runKnowledgeGate(input);
    },
  };

  const syncTelegramSupportTool: SyncTelegramSupportToolDefinition = {
    name: 'sync_telegram_support',
    description: 'Run authorized Telegram support sync to create review-only knowledge candidates.',
    inputSchema: syncTelegramSupportInputSchema,
    outputSchema: syncTelegramSupportOutputSchema,
    policy: knowledgeOpsToolPolicy,
    execute(input) {
      return options.syncTelegramSupport(input);
    },
  };

  return [
    listKnowledgeCandidatesTool,
    reviewKnowledgeCandidateTool,
    publishKnowledgeCandidateTool,
    runKnowledgeGateTool,
    syncTelegramSupportTool,
  ];
}
