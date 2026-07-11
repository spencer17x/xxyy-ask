import { describe, expect, it } from 'vitest';

import { aggregateRetrievalResults, evaluateRetrievalRanking } from './retrieval-evaluate.js';

describe('evaluateRetrievalRanking', () => {
  it('computes binary ranking metrics and forbidden hits at K', () => {
    const result = evaluateRetrievalRanking({
      forbiddenChunkIds: ['legacy'],
      relevantChunkIds: ['b', 'd'],
      retrievedChunkIds: ['a', 'b', 'legacy', 'd'],
      topK: 4,
    });

    expect(result).toMatchObject({
      annotated: true,
      forbiddenHitCount: 1,
      precisionAtK: 0.5,
      recallAtK: 1,
      reciprocalRank: 0.5,
      retrievedChunkIds: ['a', 'b', 'legacy', 'd'],
      topK: 4,
    });
    expect(result.ndcgAtK).toBeCloseTo(
      (1 / Math.log2(3) + 1 / Math.log2(5)) / (1 + 1 / Math.log2(3)),
    );
  });

  it('normalizes duplicate annotations and bounds K to the ranked list', () => {
    expect(
      evaluateRetrievalRanking({
        relevantChunkIds: ['b', 'b', 'missing'],
        retrievedChunkIds: ['b'],
        topK: 10,
      }),
    ).toMatchObject({
      annotated: true,
      ndcgAtK: 1,
      precisionAtK: 1,
      recallAtK: 0.5,
      reciprocalRank: 1,
      retrievedChunkIds: ['b'],
      topK: 1,
    });
  });

  it('returns zero metrics when no relevant document is retrieved', () => {
    expect(
      evaluateRetrievalRanking({
        relevantChunkIds: ['missing'],
        retrievedChunkIds: ['a'],
        topK: 1,
      }),
    ).toMatchObject({
      annotated: true,
      ndcgAtK: 0,
      precisionAtK: 0,
      recallAtK: 0,
      reciprocalRank: 0,
    });
  });

  it('does not invent metrics for an unannotated case', () => {
    expect(
      evaluateRetrievalRanking({
        retrievedChunkIds: ['a'],
        topK: 1,
      }),
    ).toEqual({
      annotated: false,
      retrievedChunkIds: ['a'],
      topK: 1,
    });
  });
});

describe('aggregateRetrievalResults', () => {
  it('averages only annotated cases and rounds public values', () => {
    const annotated = evaluateRetrievalRanking({
      relevantChunkIds: ['b'],
      retrievedChunkIds: ['a', 'b'],
      topK: 2,
    });
    const missed = evaluateRetrievalRanking({
      forbiddenChunkIds: ['legacy'],
      relevantChunkIds: ['missing'],
      retrievedChunkIds: ['legacy'],
      topK: 1,
    });
    const unannotated = evaluateRetrievalRanking({
      retrievedChunkIds: ['a'],
      topK: 1,
    });

    expect(aggregateRetrievalResults([annotated, missed, unannotated])).toEqual({
      annotatedCaseCount: 2,
      averageNdcgAtK: 0.315465,
      averagePrecisionAtK: 0.25,
      averageRecallAtK: 0.5,
      meanReciprocalRank: 0.25,
      totalForbiddenHits: 1,
    });
  });

  it('omits averages when no case is annotated', () => {
    expect(
      aggregateRetrievalResults([evaluateRetrievalRanking({ retrievedChunkIds: [], topK: 4 })]),
    ).toEqual({ annotatedCaseCount: 0, totalForbiddenHits: 0 });
  });
});
