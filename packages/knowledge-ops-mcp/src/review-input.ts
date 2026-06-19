import type { ReviewKnowledgeCandidateInput } from '@xxyy/knowledge-ops';

export function toReviewCandidateInput(input: {
  action: ReviewKnowledgeCandidateInput['action'];
  mergedIntoCandidateId?: string | undefined;
  notes?: string | undefined;
  reviewedAt?: string | undefined;
  reviewer: string;
}): ReviewKnowledgeCandidateInput {
  return {
    action: input.action,
    reviewer: input.reviewer,
    ...(input.mergedIntoCandidateId === undefined
      ? {}
      : { mergedIntoCandidateId: input.mergedIntoCandidateId }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.reviewedAt === undefined ? {} : { reviewedAt: input.reviewedAt }),
  };
}
