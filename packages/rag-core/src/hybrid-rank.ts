const DEFAULT_RRF_RANK_CONSTANT = 60;
const DEFAULT_RRF_SCORE_SCALE = 30;

export function reciprocalRankFusionScore(
  ranks: ReadonlyArray<number | null | undefined>,
  options: { rankConstant?: number; scoreScale?: number } = {},
): number {
  const rankConstant = normalizePositiveNumber(options.rankConstant, DEFAULT_RRF_RANK_CONSTANT);
  const scoreScale = normalizePositiveNumber(options.scoreScale, DEFAULT_RRF_SCORE_SCALE);

  const score = ranks.reduce<number>((total, rank) => {
    if (rank === null || rank === undefined || !Number.isInteger(rank) || rank <= 0) {
      return total;
    }

    return total + scoreScale / (rankConstant + rank);
  }, 0);

  return Number(score.toFixed(8));
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
