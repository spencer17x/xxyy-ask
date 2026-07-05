import { createLocalHashEmbedding, tokenize } from '@xxyy/knowledge';
import type { IndexEntry, RagIndex, SourceType } from '@xxyy/shared';

export interface RetrieveOptions {
  topK?: number;
}

export interface RetrievedChunk extends IndexEntry {
  rank: number;
  score: number;
  lexicalScore: number;
  sourceBoost: number;
  vectorScore: number;
  freshnessBoost?: number;
}

const DEFAULT_TOP_K = 6;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const VECTOR_WEIGHT = 0.35;
const LEXICAL_WEIGHT = 1;
const VECTOR_ONLY_MATCH_THRESHOLD = 0.9;
const TIE_EPSILON = 1e-12;
const CURRENT_STATUS_BOOST = 0.2;
const CURRENT_X_UPDATE_BOOST = 0.25;
const HISTORICAL_STATUS_PENALTY = -0.45;
const DEPRECATED_STATUS_PENALTY = -8;
const EFFECTIVE_AT_EPOCH = Date.UTC(2024, 0, 1);
const FRESHNESS_BOOST_PER_YEAR = 0.08;
const MAX_FRESHNESS_BOOST = 0.4;

export function retrieve(
  question: string,
  index: RagIndex,
  options: RetrieveOptions = {},
): RetrievedChunk[] {
  const queryTokens = createRetrieveQueryTokens(question);
  const topK = normalizeTopK(options.topK);

  if (queryTokens.length === 0 || index.entries.length === 0 || topK <= 0) {
    return [];
  }

  const documentFrequency = createDocumentFrequency(index.entries);
  const averageDocumentLength = averageTokenLength(index.entries);
  const queryEmbedding = createLocalHashEmbedding(question);

  const scored = index.entries
    .map((entry) => {
      const lexicalScore = calculateBm25(
        queryTokens,
        entry,
        documentFrequency,
        index.entries.length,
        averageDocumentLength,
      );
      const vectorScore = Math.max(0, cosineSimilarity(queryEmbedding, entry.embedding));
      const contextScore = calculateContextScore(question, entry);
      const sourceBoost = calculateSourceBoost(entry.metadata.sourceType);
      const freshnessBoost = calculateFreshnessBoost(question, entry);
      const score = roundScore(
        LEXICAL_WEIGHT * lexicalScore +
          VECTOR_WEIGHT * vectorScore +
          contextScore +
          sourceBoost +
          freshnessBoost,
      );

      return {
        ...entry,
        freshnessBoost: roundScore(freshnessBoost),
        lexicalScore: roundScore(lexicalScore),
        vectorScore: roundScore(vectorScore),
        sourceBoost: roundScore(sourceBoost),
        score,
      };
    })
    .filter(
      (entry) =>
        entry.lexicalScore > 0 ||
        (entry.lexicalScore === 0 && entry.vectorScore >= VECTOR_ONLY_MATCH_THRESHOLD),
    )
    .sort(compareScoredEntries)
    .slice(0, topK);

  return scored.map((entry, indexOfEntry) => ({
    ...entry,
    rank: indexOfEntry + 1,
  }));
}

export function createRetrieveQueryTokens(question: string): string[] {
  return expandQueryTokens(uniqueTokens(tokenize(question)), question);
}

function expandQueryTokens(tokens: string[], question: string): string[] {
  const expanded = [...tokens];
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();

  if (
    /付费套餐|付费会员|高级会员|会员套餐|会员权益|高级版|专业版|\bpro\b/u.test(normalizedQuestion)
  ) {
    expanded.push(...tokenize('Pro 权益'));
  }

  if (/基础套餐|基础版|免费版|\bbasic\b/u.test(normalizedQuestion)) {
    expanded.push(...tokenize('Basic 基础'));
  }

  if (/地址|追踪|跟踪/u.test(normalizedQuestion)) {
    expanded.push(...tokenize('钱包 监控'));
  }

  return uniqueTokens(expanded);
}

function calculateBm25(
  queryTokens: string[],
  entry: IndexEntry,
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageDocumentLength: number,
): number {
  const termFrequency = createTermFrequency(entry.tokens);
  let score = 0;

  for (const token of queryTokens) {
    const frequency = termFrequency.get(token) ?? 0;
    if (frequency === 0) {
      continue;
    }

    const documentsWithToken = documentFrequency.get(token) ?? 0;
    const idf = Math.log(
      1 + (documentCount - documentsWithToken + 0.5) / (documentsWithToken + 0.5),
    );
    const lengthNorm =
      BM25_K1 * (1 - BM25_B + BM25_B * (entry.tokens.length / averageDocumentLength));
    score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + lengthNorm));
  }

  return score;
}

function calculateSourceBoost(sourceType: SourceType): number {
  return sourceType === 'official_docs' ? 0.05 : 0;
}

function calculateFreshnessBoost(question: string, entry: IndexEntry): number {
  const status = entry.metadata.status;
  const isHistoryQuestion = isHistoricalOrTweetQuestion(question);
  let boost = 0;

  if (status === 'deprecated') {
    boost += DEPRECATED_STATUS_PENALTY;
  } else if (status === 'historical') {
    boost += isHistoryQuestion ? 0 : HISTORICAL_STATUS_PENALTY;
  } else if (status === 'current') {
    boost += isHistoryQuestion ? 0 : CURRENT_STATUS_BOOST;
    if (!isHistoryQuestion && entry.metadata.sourceType === 'x_updates') {
      boost += CURRENT_X_UPDATE_BOOST;
    }
  }

  if (!isHistoryQuestion && status === 'current') {
    boost += effectiveAtFreshnessBoost(entry.metadata.effectiveAt);
  }

  return boost;
}

function effectiveAtFreshnessBoost(effectiveAt: string | undefined): number {
  if (effectiveAt === undefined) {
    return 0;
  }

  const timestamp = Date.parse(effectiveAt);
  if (!Number.isFinite(timestamp) || timestamp <= EFFECTIVE_AT_EPOCH) {
    return 0;
  }

  const yearsSinceEpoch = (timestamp - EFFECTIVE_AT_EPOCH) / (365 * 24 * 60 * 60 * 1000);
  return Math.min(MAX_FRESHNESS_BOOST, yearsSinceEpoch * FRESHNESS_BOOST_PER_YEAR);
}

function isHistoricalOrTweetQuestion(question: string): boolean {
  return /历史|以前|之前|过去|曾经|更新日志|变更|changelog|哪条推文|哪条推特|推文|推特|tweet|x\s*post/iu.test(
    question.normalize('NFKC').toLowerCase(),
  );
}

function calculateContextScore(question: string, entry: IndexEntry): number {
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();
  if (!isTradingOperationQuestion(normalizedQuestion)) {
    return 0;
  }

  const title = entry.metadata.title.toLowerCase();
  const module = entry.metadata.module.toLowerCase();
  const headingText = entry.metadata.headingPath.join(' ').toLowerCase();
  const combinedMetadata = `${title} ${module} ${headingText}`;
  let score = 0;

  if (module.includes('交易代币')) {
    score += 6;
  }

  if (/\bswap\b|swap 交易|快捷交易/u.test(combinedMetadata)) {
    score += normalizedQuestion.includes('挂单') ? 6 : 16;
  }

  if (/挂单/u.test(combinedMetadata)) {
    score += normalizedQuestion.includes('挂单') ? 16 : 6;
  }

  if (/交易金额|一键买卖|买入.*sol|卖出代币/u.test(entry.text)) {
    score += 4;
  }

  return score;
}

function isTradingOperationQuestion(normalizedQuestion: string): boolean {
  return /买入|卖出|买卖|交易代币|\bswap\b|挂单/u.test(normalizedQuestion);
}

function createDocumentFrequency(entries: IndexEntry[]): Map<string, number> {
  const frequencies = new Map<string, number>();

  for (const entry of entries) {
    for (const token of uniqueTokens(entry.tokens)) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }

  return frequencies;
}

function createTermFrequency(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();

  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  return frequencies;
}

function averageTokenLength(entries: IndexEntry[]): number {
  const totalLength = entries.reduce((total, entry) => total + entry.tokens.length, 0);
  return totalLength / entries.length || 1;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const dimensions = Math.min(left.length, right.length);
  if (dimensions === 0) {
    return 0;
  }

  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < dimensions; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dotProduct += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function compareScoredEntries(
  left: Omit<RetrievedChunk, 'rank'>,
  right: Omit<RetrievedChunk, 'rank'>,
): number {
  if (Math.abs(right.score - left.score) > TIE_EPSILON) {
    return right.score - left.score;
  }

  const statusPreference = statusRank(left.metadata.status) - statusRank(right.metadata.status);
  if (statusPreference !== 0) {
    return statusPreference;
  }

  const effectiveAtPreference =
    effectiveAtRank(right.metadata.effectiveAt) - effectiveAtRank(left.metadata.effectiveAt);
  if (effectiveAtPreference !== 0) {
    return effectiveAtPreference;
  }

  const sourcePreference =
    sourceRank(left.metadata.sourceType) - sourceRank(right.metadata.sourceType);
  if (sourcePreference !== 0) {
    return sourcePreference;
  }

  return left.id.localeCompare(right.id);
}

function sourceRank(sourceType: SourceType): number {
  return sourceType === 'official_docs' ? 0 : 1;
}

function statusRank(status: IndexEntry['metadata']['status']): number {
  switch (status) {
    case 'current':
      return 0;
    case 'historical':
      return 1;
    case 'deprecated':
      return 2;
    case undefined:
      return 1;
  }
}

function effectiveAtRank(effectiveAt: string | undefined): number {
  if (effectiveAt === undefined) {
    return 0;
  }

  const timestamp = Date.parse(effectiveAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function uniqueTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens));
}

function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined) {
    return DEFAULT_TOP_K;
  }

  if (!Number.isInteger(topK) || topK <= 0) {
    return DEFAULT_TOP_K;
  }

  return topK;
}

function roundScore(score: number): number {
  return Number(score.toFixed(8));
}
