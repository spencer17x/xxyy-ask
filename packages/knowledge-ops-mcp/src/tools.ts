import {
  KNOWLEDGE_OPS_TOOL_NAMES,
  createKnowledgeOpsTools,
  createToolRegistry,
  type CreateKnowledgeOpsToolsOptions,
  type ListKnowledgeCandidatesInput,
  type PublishKnowledgeCandidateInput,
  type PublishKnowledgeCandidateOutput,
  type ReviewKnowledgeCandidateInput,
  type RunKnowledgeGateInput,
  type RunKnowledgeGateOutput,
  type SyncTelegramSupportInput,
  type SyncTelegramSupportOutput,
} from '@xxyy/agent-core';

export interface KnowledgeOpsToolHandlers {
  listKnowledgeCandidates(input: ListKnowledgeCandidatesInput): Promise<{
    candidates: Awaited<ReturnType<CreateKnowledgeOpsToolsOptions['listCandidates']>>;
    count: number;
  }>;
  publishKnowledgeCandidate(
    input: PublishKnowledgeCandidateInput,
  ): Promise<PublishKnowledgeCandidateOutput>;
  reviewKnowledgeCandidate(input: ReviewKnowledgeCandidateInput): Promise<{
    candidate: Awaited<ReturnType<CreateKnowledgeOpsToolsOptions['reviewCandidate']>>;
  }>;
  runKnowledgeGate(input: RunKnowledgeGateInput): Promise<RunKnowledgeGateOutput>;
  syncTelegramSupport(input: SyncTelegramSupportInput): Promise<SyncTelegramSupportOutput>;
}

export function createKnowledgeOpsToolHandlers(
  options: CreateKnowledgeOpsToolsOptions,
): KnowledgeOpsToolHandlers {
  const registry = createToolRegistry();
  for (const tool of createKnowledgeOpsTools(options)) {
    registry.register(tool);
  }

  return {
    listKnowledgeCandidates(input) {
      return registry.execute(KNOWLEDGE_OPS_TOOL_NAMES[0], input) as Promise<{
        candidates: Awaited<ReturnType<CreateKnowledgeOpsToolsOptions['listCandidates']>>;
        count: number;
      }>;
    },
    publishKnowledgeCandidate(input) {
      return registry.execute(
        KNOWLEDGE_OPS_TOOL_NAMES[2],
        input,
      ) as Promise<PublishKnowledgeCandidateOutput>;
    },
    reviewKnowledgeCandidate(input) {
      return registry.execute(KNOWLEDGE_OPS_TOOL_NAMES[1], input) as Promise<{
        candidate: Awaited<ReturnType<CreateKnowledgeOpsToolsOptions['reviewCandidate']>>;
      }>;
    },
    runKnowledgeGate(input) {
      return registry.execute(
        KNOWLEDGE_OPS_TOOL_NAMES[3],
        input,
      ) as Promise<RunKnowledgeGateOutput>;
    },
    syncTelegramSupport(input) {
      return registry.execute(
        KNOWLEDGE_OPS_TOOL_NAMES[4],
        input,
      ) as Promise<SyncTelegramSupportOutput>;
    },
  };
}

export type {
  CreateKnowledgeOpsToolsOptions,
  ListKnowledgeCandidatesInput,
  PublishKnowledgeCandidateInput,
  PublishKnowledgeCandidateOutput,
  ReviewKnowledgeCandidateInput,
  RunKnowledgeGateInput,
  RunKnowledgeGateOutput,
  SyncTelegramSupportInput,
  SyncTelegramSupportOutput,
};
