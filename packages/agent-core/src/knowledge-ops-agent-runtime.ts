import { createNoopAuditSink, type ToolAuditEvent, type ToolAuditSink } from './audit.js';
import type { ToolRegistry } from './tool-registry.js';
import type {
  KnowledgeOpsCandidate,
  KnowledgeOpsToolName,
  ListKnowledgeCandidatesInput,
  PublishKnowledgeCandidateInput,
  PublishKnowledgeCandidateOutput,
  ReviewKnowledgeCandidateInput,
  RunKnowledgeGateInput,
  RunKnowledgeGateOutput,
  SyncTelegramSupportInput,
  SyncTelegramSupportOutput,
} from './tools/knowledge-ops-tools.js';

export interface KnowledgeOpsAgentRuntime {
  listKnowledgeCandidates(
    input?: ListKnowledgeCandidatesInput,
  ): Promise<{ candidates: KnowledgeOpsCandidate[]; count: number }>;
  publishKnowledgeCandidate(
    input: PublishKnowledgeCandidateInput,
  ): Promise<PublishKnowledgeCandidateOutput>;
  reviewCandidate(
    input: ReviewKnowledgeCandidateInput,
  ): Promise<{ candidate: KnowledgeOpsCandidate }>;
  runKnowledgeGate(input: RunKnowledgeGateInput): Promise<RunKnowledgeGateOutput>;
  syncTelegramSupport(input?: SyncTelegramSupportInput): Promise<SyncTelegramSupportOutput>;
}

export interface CreateKnowledgeOpsAgentRuntimeOptions {
  registry: ToolRegistry;
  audit?: ToolAuditSink;
  opsAuthorized: boolean;
}

export class KnowledgeOpsAgentUnauthorizedError extends Error {
  constructor() {
    super('Knowledge operations agent requires ops authorization.');
    this.name = 'KnowledgeOpsAgentUnauthorizedError';
  }
}

export function createKnowledgeOpsAgentRuntime(
  options: CreateKnowledgeOpsAgentRuntimeOptions,
): KnowledgeOpsAgentRuntime {
  const audit = options.audit ?? createNoopAuditSink();

  async function executeKnowledgeOpsTool<Output>(
    toolName: KnowledgeOpsToolName,
    input: unknown,
    candidateId?: string,
  ): Promise<Output> {
    const startedAt = Date.now();

    if (!options.opsAuthorized) {
      const error = new KnowledgeOpsAgentUnauthorizedError();
      recordToolFailure(audit, {
        ...(candidateId === undefined ? {} : { candidateId }),
        error,
        startedAt,
        toolName,
      });
      throw error;
    }

    try {
      const output = await options.registry.execute(toolName, input);
      audit.record({
        ...(candidateId === undefined ? {} : { candidateId }),
        latencyMs: Date.now() - startedAt,
        status: 'success',
        toolName,
      });
      return output as Output;
    } catch (error) {
      recordToolFailure(audit, {
        ...(candidateId === undefined ? {} : { candidateId }),
        error,
        startedAt,
        toolName,
      });
      throw error;
    }
  }

  return {
    listKnowledgeCandidates(input = {}) {
      return executeKnowledgeOpsTool('list_knowledge_candidates', input);
    },

    publishKnowledgeCandidate(input) {
      return executeKnowledgeOpsTool('publish_knowledge_candidate', input, input.id);
    },

    reviewCandidate(input) {
      return executeKnowledgeOpsTool('review_knowledge_candidate', input, input.id);
    },

    runKnowledgeGate(input) {
      return executeKnowledgeOpsTool('run_knowledge_gate', input, input.id);
    },

    syncTelegramSupport(input = {}) {
      return executeKnowledgeOpsTool('sync_telegram_support', input);
    },
  };
}

function recordToolFailure(
  audit: ToolAuditSink,
  event: {
    candidateId?: string;
    error: unknown;
    startedAt: number;
    toolName: ToolAuditEvent['toolName'];
  },
): void {
  audit.record({
    ...(event.candidateId === undefined ? {} : { candidateId: event.candidateId }),
    errorCode: errorCodeFrom(event.error),
    latencyMs: Date.now() - event.startedAt,
    status: 'failure',
    toolName: event.toolName,
  });
}

function errorCodeFrom(error: unknown): string {
  if (error instanceof Error && error.name.trim().length > 0) {
    return error.name;
  }

  return 'unknown_error';
}
