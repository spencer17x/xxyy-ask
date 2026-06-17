import type { KnowledgeCandidate, KnowledgeCandidateStatus } from './types.js';

export interface ListKnowledgeCandidatesFilter {
  limit?: number;
  status?: KnowledgeCandidateStatus;
  type?: KnowledgeCandidate['type'];
  riskLevel?: KnowledgeCandidate['riskLevel'];
}

export type KnowledgeCandidateReviewAction =
  | 'approve'
  | 'reject'
  | 'request_changes'
  | 'merge_duplicate';

export interface ReviewKnowledgeCandidateInput {
  action: KnowledgeCandidateReviewAction;
  reviewer: string;
  reviewedAt?: string;
  notes?: string;
}

export interface KnowledgeCandidateStore {
  addCandidates(candidates: KnowledgeCandidate[]): Promise<KnowledgeCandidate[]>;
  listCandidates(filter?: ListKnowledgeCandidatesFilter): Promise<KnowledgeCandidate[]>;
  reviewCandidate(
    candidateId: string,
    input: ReviewKnowledgeCandidateInput,
  ): Promise<KnowledgeCandidate>;
}

export class KnowledgeCandidateNotFoundError extends Error {
  constructor(candidateId: string) {
    super(`Knowledge candidate not found: ${candidateId}`);
    this.name = 'KnowledgeCandidateNotFoundError';
  }
}

export function createInMemoryKnowledgeCandidateStore(
  initialCandidates: KnowledgeCandidate[] = [],
): KnowledgeCandidateStore {
  const candidates = new Map<string, KnowledgeCandidate>(
    initialCandidates.map((candidate) => [candidate.id, candidate]),
  );

  return {
    addCandidates(newCandidates) {
      for (const candidate of newCandidates) {
        candidates.set(candidate.id, candidate);
      }

      return Promise.resolve(newCandidates);
    },

    listCandidates(filter = {}) {
      return Promise.resolve(
        Array.from(candidates.values())
          .filter((candidate) => matchesFilter(candidate, filter))
          .slice(0, normalizeLimit(filter.limit)),
      );
    },

    reviewCandidate(candidateId, input) {
      const candidate = candidates.get(candidateId);
      if (candidate === undefined) {
        return Promise.reject(new KnowledgeCandidateNotFoundError(candidateId));
      }

      const updated = applyReview(candidate, input);
      candidates.set(candidateId, updated);
      return Promise.resolve(updated);
    },
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return limit;
}

function matchesFilter(
  candidate: KnowledgeCandidate,
  filter: ListKnowledgeCandidatesFilter,
): boolean {
  if (filter.status !== undefined && candidate.status !== filter.status) {
    return false;
  }

  if (filter.type !== undefined && candidate.type !== filter.type) {
    return false;
  }

  if (filter.riskLevel !== undefined && candidate.riskLevel !== filter.riskLevel) {
    return false;
  }

  return true;
}

function applyReview(
  candidate: KnowledgeCandidate,
  input: ReviewKnowledgeCandidateInput,
): KnowledgeCandidate {
  const updatedAt = input.reviewedAt ?? new Date().toISOString();
  const status = reviewActionToStatus(input.action);

  return {
    ...candidate,
    status,
    reviewer: input.reviewer,
    ...(input.notes === undefined ? {} : { reviewNotes: input.notes }),
    updatedAt,
  };
}

function reviewActionToStatus(action: KnowledgeCandidateReviewAction): KnowledgeCandidateStatus {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'reject':
    case 'merge_duplicate':
      return 'rejected';
    case 'request_changes':
      return 'draft';
  }
}
