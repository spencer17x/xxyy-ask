import { describe, expect, it } from 'vitest';

import { toReviewCandidateInput } from './review-input.js';

describe('toReviewCandidateInput', () => {
  it('preserves merge-duplicate target candidates for the store layer', () => {
    expect(
      toReviewCandidateInput({
        action: 'merge_duplicate',
        mergedIntoCandidateId: 'kc_quality_cluster_primary',
        notes: '同一组质量缺口。',
        reviewedAt: '2026-06-17T03:00:00.000Z',
        reviewer: 'ops@example.com',
      }),
    ).toEqual({
      action: 'merge_duplicate',
      mergedIntoCandidateId: 'kc_quality_cluster_primary',
      notes: '同一组质量缺口。',
      reviewedAt: '2026-06-17T03:00:00.000Z',
      reviewer: 'ops@example.com',
    });
  });
});
