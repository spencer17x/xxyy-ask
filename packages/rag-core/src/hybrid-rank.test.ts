import { describe, expect, it } from 'vitest';

import { reciprocalRankFusionScore } from './hybrid-rank.js';

describe('reciprocalRankFusionScore', () => {
  it('rewards candidates recalled by multiple independent routes', () => {
    expect(reciprocalRankFusionScore([1, 1])).toBeGreaterThan(
      reciprocalRankFusionScore([1, undefined]),
    );
  });

  it('prefers earlier ranks without depending on raw provider scores', () => {
    expect(reciprocalRankFusionScore([1])).toBeGreaterThan(reciprocalRankFusionScore([10]));
  });

  it('ignores missing and invalid ranks', () => {
    expect(reciprocalRankFusionScore([undefined, null, 0, -1, 1.5])).toBe(0);
  });
});
