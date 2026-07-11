export interface RetrievalEvaluationInput {
  forbiddenChunkIds?: readonly string[];
  relevantChunkIds?: readonly string[];
  retrievedChunkIds: readonly string[];
  topK: number;
}

export interface RetrievalEvaluationResult {
  annotated: boolean;
  forbiddenHitCount?: number;
  ndcgAtK?: number;
  precisionAtK?: number;
  recallAtK?: number;
  reciprocalRank?: number;
  retrievedChunkIds: string[];
  topK: number;
}

export interface RetrievalEvaluationSummary {
  annotatedCaseCount: number;
  averageNdcgAtK?: number;
  averagePrecisionAtK?: number;
  averageRecallAtK?: number;
  meanReciprocalRank?: number;
  totalForbiddenHits: number;
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function discount(rank: number): number {
  return 1 / Math.log2(rank + 1);
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function evaluateRetrievalRanking(
  input: RetrievalEvaluationInput,
): RetrievalEvaluationResult {
  const requestedTopK = Number.isFinite(input.topK) ? Math.max(0, Math.floor(input.topK)) : 0;
  const retrievedChunkIds = input.retrievedChunkIds.slice(0, requestedTopK);
  const topK = retrievedChunkIds.length;
  const relevantIds = uniqueNonEmpty(input.relevantChunkIds);

  if (relevantIds.length === 0) {
    return { annotated: false, retrievedChunkIds, topK };
  }

  const relevant = new Set(relevantIds);
  const forbidden = new Set(uniqueNonEmpty(input.forbiddenChunkIds));
  const relevantRanks = retrievedChunkIds
    .map((id, index) => (relevant.has(id) ? index + 1 : undefined))
    .filter((rank): rank is number => rank !== undefined);
  const relevantRetrieved = relevantRanks.length;
  const dcg = relevantRanks.reduce((total, rank) => total + discount(rank), 0);
  const idealCount = Math.min(relevant.size, topK);
  const idealDcg = Array.from({ length: idealCount }, (_, index) => discount(index + 1)).reduce(
    (total, value) => total + value,
    0,
  );

  return {
    annotated: true,
    forbiddenHitCount: retrievedChunkIds.filter((id) => forbidden.has(id)).length,
    ndcgAtK: idealDcg === 0 ? 0 : dcg / idealDcg,
    precisionAtK: topK === 0 ? 0 : relevantRetrieved / topK,
    recallAtK: relevantRetrieved / relevant.size,
    reciprocalRank: relevantRanks[0] === undefined ? 0 : 1 / relevantRanks[0],
    retrievedChunkIds,
    topK,
  };
}

export function aggregateRetrievalResults(
  results: readonly RetrievalEvaluationResult[],
): RetrievalEvaluationSummary {
  const annotated = results.filter(
    (result): result is Required<RetrievalEvaluationResult> => result.annotated,
  );
  const totalForbiddenHits = annotated.reduce(
    (total, result) => total + result.forbiddenHitCount,
    0,
  );

  if (annotated.length === 0) {
    return { annotatedCaseCount: 0, totalForbiddenHits };
  }

  const average = (select: (result: Required<RetrievalEvaluationResult>) => number): number =>
    roundMetric(annotated.reduce((total, result) => total + select(result), 0) / annotated.length);

  return {
    annotatedCaseCount: annotated.length,
    averageNdcgAtK: average((result) => result.ndcgAtK),
    averagePrecisionAtK: average((result) => result.precisionAtK),
    averageRecallAtK: average((result) => result.recallAtK),
    meanReciprocalRank: average((result) => result.reciprocalRank),
    totalForbiddenHits,
  };
}
