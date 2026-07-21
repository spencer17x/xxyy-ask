import type {
  KnowledgeCandidate,
  KnowledgeCandidateHistory,
  KnowledgeCandidateStatus,
  PgKnowledgeCandidateStore,
  ReviseKnowledgeCandidateInput,
} from './knowledge-candidates.js';
import type {
  KnowledgeConflictReference,
  KnowledgeGovernanceReferenceStore,
} from './knowledge-governance-references.js';
import {
  runKnowledgeCurator,
  type KnowledgeCuratorModel,
  type KnowledgeMatchInspector,
  type KnowledgeCuratorRunResult,
} from './knowledge-curator.js';
import {
  extractTelegramKnowledgeCandidates,
  readTelegramKnowledgeExport,
} from './telegram-knowledge.js';
import type {
  ListTrustedAuthorsOptions,
  PgTrustedAuthorStore,
  TrustedAuthor,
  TrustAuthorInput,
} from './trusted-authors.js';

export interface KnowledgeGovernanceServiceOptions {
  candidateStore: PgKnowledgeCandidateStore;
  trustedAuthorStore: PgTrustedAuthorStore;
  curatorModel?: KnowledgeCuratorModel;
  inspector?: KnowledgeMatchInspector;
  referenceStore?: KnowledgeGovernanceReferenceStore;
}

export interface ImportTelegramKnowledgeInput {
  rawExport: unknown;
  currentAdministratorUserIds?: ReadonlySet<string>;
  currentAdministratorVerifiedAt?: string;
  explicitAdminUserIds?: ReadonlySet<string>;
  runId?: string;
  useAgent?: boolean;
}

export interface ImportTelegramKnowledgeResult {
  agentCandidateCount: number;
  adminReplyCount: number;
  candidateCount: number;
  created: KnowledgeCandidate[];
  deterministicCandidateCount: number;
  duplicateCount: number;
  messageCount: number;
  rejectedAgentProposalCount: number;
  runId: string;
  skippedBoundaryCount: number;
  skippedMissingReplyCount: number;
  threadCount: number;
  unverifiedAuthorMessageCount: number;
  verifiedAuthorMessageCount: number;
}

export interface KnowledgeGovernanceService {
  approve(input: {
    id: string;
    reviewedBy: string;
    effectiveAt?: string;
    note?: string;
    sourceUrl?: string;
    supersedes?: string[];
  }): Promise<KnowledgeCandidate>;
  getCandidate(id: string): Promise<KnowledgeCandidate | undefined>;
  getCandidateDetail(id: string): Promise<KnowledgeCandidateDetail | undefined>;
  getCandidateHistory(id: string): Promise<KnowledgeCandidateHistory>;
  importTelegram(input: ImportTelegramKnowledgeInput): Promise<ImportTelegramKnowledgeResult>;
  listCandidates(options?: {
    limit?: number;
    status?: KnowledgeCandidateStatus;
  }): Promise<KnowledgeCandidate[]>;
  listTrustedAuthors(options?: ListTrustedAuthorsOptions): Promise<TrustedAuthor[]>;
  migrate(): Promise<void>;
  reject(input: { id: string; reviewedBy: string; note?: string }): Promise<KnowledgeCandidate>;
  revise(input: ReviseKnowledgeCandidateInput): Promise<KnowledgeCandidate>;
  trustAuthor(input: TrustAuthorInput): Promise<TrustedAuthor>;
}

export interface KnowledgeCandidateDetail {
  candidate: KnowledgeCandidate;
  conflicts: KnowledgeConflictReference[];
  duplicates: KnowledgeCandidate[];
  history: KnowledgeCandidateHistory;
}

export class UnverifiedTelegramKnowledgeAuthorError extends Error {
  constructor() {
    super(
      'No verified Telegram knowledge author matched this export. Add a time-bounded trusted author, configure Telegram current-administrator lookup, or pass an explicit administrator ID.',
    );
    this.name = 'UnverifiedTelegramKnowledgeAuthorError';
  }
}

export function createKnowledgeGovernanceService(
  options: KnowledgeGovernanceServiceOptions,
): KnowledgeGovernanceService {
  return {
    approve(input) {
      return options.candidateStore.review({
        decision: 'approve',
        id: input.id,
        reviewedBy: input.reviewedBy,
        ...(input.effectiveAt === undefined ? {} : { effectiveAt: input.effectiveAt }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      });
    },

    getCandidate(id) {
      return options.candidateStore.get(id);
    },

    async getCandidateDetail(id): Promise<KnowledgeCandidateDetail | undefined> {
      const candidate = await options.candidateStore.get(id);
      if (candidate === undefined) {
        return undefined;
      }
      const history = await options.candidateStore.getHistory(id);
      const duplicates: KnowledgeCandidate[] = [];
      for (const duplicateId of candidate.duplicateCandidateIds ?? []) {
        const duplicate = await options.candidateStore.get(duplicateId);
        if (duplicate !== undefined) {
          duplicates.push(duplicate);
        }
      }
      const conflicts =
        options.referenceStore === undefined
          ? []
          : await options.referenceStore.getByIds(candidate.conflictChunkIds ?? []);
      return { candidate, conflicts, duplicates, history };
    },

    getCandidateHistory(id) {
      return options.candidateStore.getHistory(id);
    },

    async importTelegram(input): Promise<ImportTelegramKnowledgeResult> {
      if (input.useAgent === true && options.curatorModel === undefined) {
        throw new Error(
          'Knowledge Curator Agent was requested but no curator model is configured.',
        );
      }
      const normalizedExport = readTelegramKnowledgeExport(input.rawExport);
      const trustedAuthors =
        normalizedExport.chatId === undefined
          ? []
          : await options.trustedAuthorStore.list({
              chatId: normalizedExport.chatId,
              limit: 500,
            });
      const extraction = extractTelegramKnowledgeCandidates(input.rawExport, {
        trustedAuthors,
        ...(input.currentAdministratorUserIds === undefined
          ? {}
          : { currentAdministratorUserIds: input.currentAdministratorUserIds }),
        ...(input.currentAdministratorVerifiedAt === undefined
          ? {}
          : { currentAdministratorVerifiedAt: input.currentAdministratorVerifiedAt }),
        ...(input.explicitAdminUserIds === undefined
          ? {}
          : { explicitAdminUserIds: input.explicitAdminUserIds }),
      });
      if (extraction.verifiedAuthorMessageCount === 0) {
        throw new UnverifiedTelegramKnowledgeAuthorError();
      }
      const curated = await runKnowledgeCurator({
        extraction,
        ...(options.inspector === undefined ? {} : { inspector: options.inspector }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(normalizedExport.chatId === undefined ? {} : { sourceChatId: normalizedExport.chatId }),
        ...(input.useAgent === true && options.curatorModel !== undefined
          ? { model: options.curatorModel }
          : {}),
      });
      const persisted = await options.candidateStore.createMany(curated.candidates);
      return createImportResult(extraction, curated, persisted);
    },

    listCandidates(input = {}) {
      return options.candidateStore.list(input);
    },

    listTrustedAuthors(input = {}) {
      return options.trustedAuthorStore.list(input);
    },

    async migrate(): Promise<void> {
      await options.candidateStore.migrate();
    },

    reject(input) {
      return options.candidateStore.review({
        decision: 'reject',
        id: input.id,
        reviewedBy: input.reviewedBy,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
    },

    revise(input) {
      return options.candidateStore.revise(input);
    },

    trustAuthor(input) {
      return options.trustedAuthorStore.trust(input);
    },
  };
}

function createImportResult(
  extraction: ReturnType<typeof extractTelegramKnowledgeCandidates>,
  curated: KnowledgeCuratorRunResult,
  persisted: Awaited<ReturnType<PgKnowledgeCandidateStore['createMany']>>,
): ImportTelegramKnowledgeResult {
  return {
    adminReplyCount: extraction.adminReplyCount,
    agentCandidateCount: curated.agentCandidateCount,
    candidateCount: curated.candidates.length,
    created: persisted.created,
    deterministicCandidateCount: curated.deterministicCandidateCount,
    duplicateCount: persisted.duplicateCount,
    messageCount: extraction.messageCount,
    rejectedAgentProposalCount: curated.rejectedAgentProposalCount,
    runId: curated.runId,
    skippedBoundaryCount: extraction.skippedBoundaryCount,
    skippedMissingReplyCount: extraction.skippedMissingReplyCount,
    threadCount: extraction.threads.length,
    unverifiedAuthorMessageCount: extraction.unverifiedAuthorMessageCount,
    verifiedAuthorMessageCount: extraction.verifiedAuthorMessageCount,
  };
}
