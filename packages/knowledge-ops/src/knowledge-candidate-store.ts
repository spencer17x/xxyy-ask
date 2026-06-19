import type {
  KnowledgeCandidate,
  KnowledgeCandidateSource,
  KnowledgeCandidateStatus,
} from './types.js';

export interface ListKnowledgeCandidatesFilter {
  createdAtGte?: string;
  createdAtLt?: string;
  limit?: number;
  qualitySignalAgentRoute?: string;
  qualitySignalClusterKey?: string;
  qualitySignalReason?: string;
  source?: KnowledgeCandidateSource;
  status?: KnowledgeCandidateStatus;
  type?: KnowledgeCandidate['type'];
  riskLevel?: KnowledgeCandidate['riskLevel'];
}

export type KnowledgeCandidateRunType = 'publish' | 'ingest' | 'eval';
export type KnowledgeCandidateRunStatus = 'completed' | 'failed' | 'passed';

export interface KnowledgeCandidateRun {
  candidateId: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  runId: string;
  runType: KnowledgeCandidateRunType;
  status: KnowledgeCandidateRunStatus;
}

export interface RecordKnowledgeCandidateRunInput {
  candidateId: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  runId: string;
  runType: KnowledgeCandidateRunType;
  status: KnowledgeCandidateRunStatus;
}

export type KnowledgeCandidateReviewAction =
  | 'approve'
  | 'reject'
  | 'request_changes'
  | 'merge_duplicate';

export interface ReviewKnowledgeCandidateInput {
  action: KnowledgeCandidateReviewAction;
  mergedIntoCandidateId?: string;
  reviewer: string;
  reviewedAt?: string;
  notes?: string;
}

export interface MarkKnowledgeCandidatePublishedInput {
  publishedAt?: string;
  publishedTarget: string;
}

export interface MarkKnowledgeCandidateIngestedInput {
  ingestedAt?: string;
}

export interface MarkKnowledgeCandidateEvalResultInput {
  evaluatedAt?: string;
  passed: boolean;
}

export interface KnowledgeCandidateStore {
  addCandidates(candidates: KnowledgeCandidate[]): Promise<KnowledgeCandidate[]>;
  getCandidate(candidateId: string): Promise<KnowledgeCandidate | undefined>;
  listCandidates(filter?: ListKnowledgeCandidatesFilter): Promise<KnowledgeCandidate[]>;
  markCandidateEvalResult(
    candidateId: string,
    input: MarkKnowledgeCandidateEvalResultInput,
  ): Promise<KnowledgeCandidate>;
  markCandidateIngested(
    candidateId: string,
    input?: MarkKnowledgeCandidateIngestedInput,
  ): Promise<KnowledgeCandidate>;
  markCandidatePublished(
    candidateId: string,
    input: MarkKnowledgeCandidatePublishedInput,
  ): Promise<KnowledgeCandidate>;
  listCandidateRuns(candidateId: string): Promise<KnowledgeCandidateRun[]>;
  recordCandidateRun(input: RecordKnowledgeCandidateRunInput): Promise<KnowledgeCandidateRun>;
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

export class KnowledgeCandidateInvalidPublishStatusError extends Error {
  constructor(candidateId: string, currentStatus: KnowledgeCandidateStatus) {
    super(
      `Knowledge candidate ${candidateId} must be approved before publishing; current status is ${currentStatus}.`,
    );
    this.name = 'KnowledgeCandidateInvalidPublishStatusError';
  }
}

export class KnowledgeCandidateInvalidStatusTransitionError extends Error {
  constructor(
    candidateId: string,
    action: string,
    currentStatus: KnowledgeCandidateStatus,
    expectedStatus: KnowledgeCandidateStatus,
  ) {
    super(
      `Knowledge candidate ${candidateId} cannot be marked ${action} from ${currentStatus}; expected status is ${expectedStatus}.`,
    );
    this.name = 'KnowledgeCandidateInvalidStatusTransitionError';
  }
}

export function createInMemoryKnowledgeCandidateStore(
  initialCandidates: KnowledgeCandidate[] = [],
): KnowledgeCandidateStore {
  const candidates = new Map<string, KnowledgeCandidate>(
    initialCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const candidateRuns = new Map<string, KnowledgeCandidateRun[]>();

  return {
    addCandidates(newCandidates) {
      for (const candidate of newCandidates) {
        candidates.set(candidate.id, candidate);
      }

      return Promise.resolve(newCandidates);
    },

    getCandidate(candidateId) {
      return Promise.resolve(candidates.get(candidateId));
    },

    listCandidates(filter = {}) {
      return Promise.resolve(
        Array.from(candidates.values())
          .filter((candidate) => matchesFilter(candidate, filter))
          .slice(0, normalizeLimit(filter.limit)),
      );
    },

    markCandidateEvalResult(candidateId, input) {
      const candidate = candidates.get(candidateId);
      if (candidate === undefined) {
        return Promise.reject(new KnowledgeCandidateNotFoundError(candidateId));
      }
      if (!canMarkEvalResult(candidate)) {
        return Promise.reject(
          new KnowledgeCandidateInvalidStatusTransitionError(
            candidateId,
            input.passed ? 'eval_passed' : 'eval_failed',
            candidate.status,
            'ingested',
          ),
        );
      }

      const evaluated = applyEvalResult(candidate, input);
      candidates.set(candidateId, evaluated);
      return Promise.resolve(evaluated);
    },

    markCandidateIngested(candidateId, input = {}) {
      const candidate = candidates.get(candidateId);
      if (candidate === undefined) {
        return Promise.reject(new KnowledgeCandidateNotFoundError(candidateId));
      }
      if (candidate.status !== 'published') {
        return Promise.reject(
          new KnowledgeCandidateInvalidStatusTransitionError(
            candidateId,
            'ingested',
            candidate.status,
            'published',
          ),
        );
      }

      const ingested = applyIngested(candidate, input);
      candidates.set(candidateId, ingested);
      return Promise.resolve(ingested);
    },

    markCandidatePublished(candidateId, input) {
      const candidate = candidates.get(candidateId);
      if (candidate === undefined) {
        return Promise.reject(new KnowledgeCandidateNotFoundError(candidateId));
      }
      if (candidate.status !== 'approved') {
        return Promise.reject(
          new KnowledgeCandidateInvalidPublishStatusError(candidateId, candidate.status),
        );
      }

      const published = applyPublished(candidate, input);
      candidates.set(candidateId, published);
      return Promise.resolve(published);
    },

    listCandidateRuns(candidateId) {
      return Promise.resolve(
        [...(candidateRuns.get(candidateId) ?? [])].sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        ),
      );
    },

    recordCandidateRun(input) {
      if (!candidates.has(input.candidateId)) {
        return Promise.reject(new KnowledgeCandidateNotFoundError(input.candidateId));
      }

      const run = applyCandidateRun(input);
      const existingRuns = candidateRuns.get(input.candidateId) ?? [];
      const nextRuns = [
        ...existingRuns.filter(
          (existing) =>
            existing.runId !== run.runId ||
            existing.runType !== run.runType ||
            existing.candidateId !== run.candidateId,
        ),
        run,
      ];
      candidateRuns.set(input.candidateId, nextRuns);
      return Promise.resolve(run);
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

  if (
    filter.source !== undefined &&
    !candidate.sourceRefs.some((sourceRef) => sourceRef.source === filter.source)
  ) {
    return false;
  }

  if (
    filter.createdAtGte !== undefined &&
    !isCreatedAtAtOrAfter(candidate.createdAt, filter.createdAtGte)
  ) {
    return false;
  }

  if (
    filter.createdAtLt !== undefined &&
    !isCreatedAtBefore(candidate.createdAt, filter.createdAtLt)
  ) {
    return false;
  }

  if (
    filter.qualitySignalClusterKey !== undefined &&
    !candidate.sourceRefs.some(
      (sourceRef) =>
        sourceRef.source === 'answer_quality_signal' &&
        sourceRef.qualitySignalClusterKey === filter.qualitySignalClusterKey,
    )
  ) {
    return false;
  }

  if (
    filter.qualitySignalReason !== undefined &&
    !candidate.sourceRefs.some(
      (sourceRef) =>
        sourceRef.source === 'answer_quality_signal' &&
        sourceRef.qualitySignalReason === filter.qualitySignalReason,
    )
  ) {
    return false;
  }

  if (
    filter.qualitySignalAgentRoute !== undefined &&
    !candidate.sourceRefs.some(
      (sourceRef) =>
        sourceRef.source === 'answer_quality_signal' &&
        sourceRef.qualitySignalAgentRoute === filter.qualitySignalAgentRoute,
    )
  ) {
    return false;
  }

  return true;
}

function isCreatedAtAtOrAfter(createdAt: string, threshold: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  const thresholdMs = Date.parse(threshold);
  return Number.isFinite(createdAtMs) && Number.isFinite(thresholdMs) && createdAtMs >= thresholdMs;
}

function isCreatedAtBefore(createdAt: string, threshold: string): boolean {
  const createdAtMs = Date.parse(createdAt);
  const thresholdMs = Date.parse(threshold);
  return Number.isFinite(createdAtMs) && Number.isFinite(thresholdMs) && createdAtMs < thresholdMs;
}

function canMarkEvalResult(candidate: KnowledgeCandidate): boolean {
  return candidate.status === 'ingested' || isApprovedEvalOnlyCandidate(candidate);
}

function isApprovedEvalOnlyCandidate(candidate: KnowledgeCandidate): boolean {
  return (
    candidate.status === 'approved' &&
    candidate.type === 'eval_case' &&
    candidate.targetCategory === 'eval_case'
  );
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
    ...reviewNotesPatch(input),
    updatedAt,
  };
}

function reviewNotesPatch(
  input: ReviewKnowledgeCandidateInput,
): Pick<KnowledgeCandidate, 'reviewNotes'> | Record<string, never> {
  const reviewNotes = createReviewNotes(input);
  return reviewNotes === undefined ? {} : { reviewNotes };
}

function createReviewNotes(input: ReviewKnowledgeCandidateInput): string | undefined {
  if (input.action !== 'merge_duplicate' || input.mergedIntoCandidateId === undefined) {
    return input.notes;
  }

  const mergeNote = `Merged duplicate into ${input.mergedIntoCandidateId}.`;
  return input.notes === undefined ? mergeNote : `${mergeNote}\n\n${input.notes}`;
}

function applyPublished(
  candidate: KnowledgeCandidate,
  input: MarkKnowledgeCandidatePublishedInput,
): KnowledgeCandidate {
  const updatedAt = input.publishedAt ?? new Date().toISOString();

  return {
    ...candidate,
    publishedTarget: input.publishedTarget,
    status: 'published',
    updatedAt,
  };
}

function applyIngested(
  candidate: KnowledgeCandidate,
  input: MarkKnowledgeCandidateIngestedInput,
): KnowledgeCandidate {
  const updatedAt = input.ingestedAt ?? new Date().toISOString();

  return {
    ...candidate,
    status: 'ingested',
    updatedAt,
  };
}

function applyEvalResult(
  candidate: KnowledgeCandidate,
  input: MarkKnowledgeCandidateEvalResultInput,
): KnowledgeCandidate {
  const updatedAt = input.evaluatedAt ?? new Date().toISOString();

  return {
    ...candidate,
    status: input.passed ? 'eval_passed' : 'eval_failed',
    updatedAt,
  };
}

function applyCandidateRun(input: RecordKnowledgeCandidateRunInput): KnowledgeCandidateRun {
  return {
    candidateId: input.candidateId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    metadata: input.metadata ?? {},
    runId: input.runId,
    runType: input.runType,
    status: input.status,
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
