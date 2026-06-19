import { describe, expect, it } from 'vitest';

import { toListCandidatesFilter } from './filters.js';

describe('knowledge ops MCP filters', () => {
  it('preserves quality-signal source filters for candidate queues', () => {
    expect(
      toListCandidatesFilter({
        limit: 10,
        riskLevel: 'medium',
        source: 'answer_quality_signal',
        status: 'needs_review',
        type: 'eval_case',
      }),
    ).toEqual({
      limit: 10,
      riskLevel: 'medium',
      source: 'answer_quality_signal',
      status: 'needs_review',
      type: 'eval_case',
    });
  });
});
