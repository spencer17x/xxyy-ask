import type { RagIndex } from '@xxyy/shared';
import { tokenize } from '@xxyy/knowledge';

import { reciprocalRankFusionScore } from './hybrid-rank.js';
import { retrieve, type RetrieveOptions, type RetrievedChunk } from './retrieve.js';
import { isSupportQuestionText } from './support-entity.js';
import {
  noopQualityTracer,
  summarizeRetrievedChunks,
  type QualityTracer,
} from './quality-trace.js';

export interface Retriever {
  retrieve(
    question: string,
    options: RetrieveOptions,
  ): Promise<RetrievedChunk[]> | RetrievedChunk[];
}

export interface Reranker {
  rerank(input: {
    question: string;
    chunks: RetrievedChunk[];
    topK: number;
  }): Promise<RetrievedChunk[]> | RetrievedChunk[];
}

export interface RerankingRetrieverOptions {
  candidateMultiplier?: number;
  tracer?: QualityTracer;
}

const BASE_RANK_WEIGHT = 2;
const BASE_SCORE_WEIGHT = 7;
const METADATA_RERANK_WEIGHT = 1;
const TITLE_CONTAINMENT_WEIGHT = 2;
const CONTENT_COVERAGE_WEIGHT = 4;
const HOW_TO_DIRECT_EVIDENCE_BONUS = 3;
const STRUCTURED_ANSWER_WEIGHT = 3;
const DIRECT_SUPPORT_EVIDENCE_WEIGHT = 2;
const DIRECT_SOURCE_WEIGHT = 1;
const QUERY_STOP_TOKENS = new Set([
  'xxyy',
  '什么',
  '哪些',
  '可以',
  '如何',
  '怎么',
  '是否',
  '支持',
  '当前',
  '现在',
]);

export function createLazyRetriever(
  createRetriever: () => Promise<Retriever> | Retriever,
): Retriever {
  let cachedRetriever: Retriever | undefined;
  let pendingRetriever: Promise<Retriever> | undefined;

  async function loadRetriever(): Promise<Retriever> {
    if (cachedRetriever !== undefined) {
      return cachedRetriever;
    }

    pendingRetriever ??= Promise.resolve()
      .then(createRetriever)
      .then(
        (retriever) => {
          cachedRetriever = retriever;
          return retriever;
        },
        (error: unknown) => {
          pendingRetriever = undefined;
          throw error;
        },
      );

    return pendingRetriever;
  }

  return {
    async retrieve(question: string, options: RetrieveOptions): Promise<RetrievedChunk[]> {
      const retriever = await loadRetriever();
      return retriever.retrieve(question, options);
    },
  };
}

export function createRerankingRetriever(
  retriever: Retriever,
  reranker?: Reranker,
  options: RerankingRetrieverOptions = {},
): Retriever {
  if (reranker === undefined) {
    return retriever;
  }

  return {
    async retrieve(question: string, retrieveOptions: RetrieveOptions): Promise<RetrievedChunk[]> {
      const topK = normalizeTopK(retrieveOptions.topK);
      const candidateTopK = topK * normalizeCandidateMultiplier(options.candidateMultiplier);
      const candidates = await retriever.retrieve(question, {
        ...retrieveOptions,
        topK: candidateTopK,
      });
      const tracer = options.tracer ?? noopQualityTracer;
      return tracer.run(
        {
          inputs: { candidates: summarizeRetrievedChunks(candidates), topK },
          name: 'rag.metadata_rerank',
          output: (chunks) => ({ chunks: summarizeRetrievedChunks(chunks) }),
          runType: 'retriever',
        },
        async () => {
          const reranked = await reranker.rerank({ chunks: candidates, question, topK });
          return reranked.slice(0, topK).map((chunk, index) => ({ ...chunk, rank: index + 1 }));
        },
      );
    },
  };
}

export function createMetadataReranker(): Reranker {
  return {
    rerank({ chunks, question }) {
      const queryTokens = new Set(tokenize(question));
      const maximumScore = maximumRetrievedScore(chunks);
      return [...chunks].sort((left, right) => {
        const rightScore = rerankScore(right, queryTokens, question, maximumScore);
        const leftScore = rerankScore(left, queryTokens, question, maximumScore);

        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }

        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.id.localeCompare(right.id);
      });
    },
  };
}

export function createLocalRetriever(index: RagIndex): Retriever {
  return {
    retrieve(question: string, options: RetrieveOptions): RetrievedChunk[] {
      return retrieve(question, index, options);
    },
  };
}

function metadataMatchScore(chunk: RetrievedChunk, queryTokens: Set<string>): number {
  const metadataText = [
    chunk.metadata.title,
    chunk.metadata.module,
    ...chunk.metadata.headingPath,
  ].join(' ');
  const informativeQueryTokens = Array.from(queryTokens).filter(isInformativeQueryToken);
  if (informativeQueryTokens.length === 0) {
    return 0;
  }

  const metadataTokens = new Set(tokenize(metadataText));
  const matchedTokenCount = informativeQueryTokens.filter((token) =>
    metadataTokens.has(token),
  ).length;
  return matchedTokenCount / informativeQueryTokens.length;
}

function rerankScore(
  chunk: RetrievedChunk,
  queryTokens: Set<string>,
  question: string,
  maximumScore: number,
): number {
  const contentCoverage = contentCoverageScore(chunk, queryTokens);
  return (
    reciprocalRankFusionScore([chunk.rank]) * BASE_RANK_WEIGHT +
    normalizedRetrievedScore(chunk.score, maximumScore) * BASE_SCORE_WEIGHT +
    metadataMatchScore(chunk, queryTokens) * METADATA_RERANK_WEIGHT +
    titleContainmentScore(chunk, question) * TITLE_CONTAINMENT_WEIGHT +
    contentCoverage * CONTENT_COVERAGE_WEIGHT +
    directSourceScore(chunk) * DIRECT_SOURCE_WEIGHT +
    structuredAnswerScore(chunk, question) * contentCoverage * STRUCTURED_ANSWER_WEIGHT +
    directSupportEvidenceScore(chunk, question) * DIRECT_SUPPORT_EVIDENCE_WEIGHT +
    howToEvidenceScore(chunk, question) * (0.5 + contentCoverage * 0.5)
  );
}

function maximumRetrievedScore(chunks: RetrievedChunk[]): number {
  const scores = chunks.map((chunk) => chunk.score).filter(Number.isFinite);
  return scores.length === 0 ? 0 : Math.max(...scores);
}

function normalizedRetrievedScore(score: number, maximumScore: number): number {
  if (!Number.isFinite(score) || maximumScore <= 0) {
    return 0;
  }

  return Math.max(0, score) / maximumScore;
}

function titleContainmentScore(chunk: RetrievedChunk, question: string): number {
  const normalizedQuestion = normalizeCompactText(question);
  const normalizedTitle = normalizeCompactText(chunk.metadata.title).replace(/^xxyy/u, '');
  if (normalizedTitle.length < 2) {
    return 0;
  }

  return normalizedQuestion.includes(normalizedTitle) ? 1 : 0;
}

function normalizeCompactText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function contentCoverageScore(chunk: RetrievedChunk, queryTokens: Set<string>): number {
  const informativeQueryTokens = Array.from(queryTokens).filter(isInformativeQueryToken);
  if (informativeQueryTokens.length === 0) {
    return 0;
  }

  const evidenceTokens = new Set(
    tokenize(
      [chunk.metadata.title, chunk.metadata.module, ...chunk.metadata.headingPath, chunk.text].join(
        ' ',
      ),
    ),
  );
  const matchedTokenCount = informativeQueryTokens.filter((token) =>
    evidenceTokens.has(token),
  ).length;
  return matchedTokenCount / informativeQueryTokens.length;
}

function isInformativeQueryToken(token: string): boolean {
  if (QUERY_STOP_TOKENS.has(token)) {
    return false;
  }

  return /^[a-z0-9][a-z0-9_-]*$/u.test(token) || token.length === 2;
}

function structuredAnswerScore(chunk: RetrievedChunk, question: string): number {
  if (!/哪些|哪几|区别|对比|多少|字段|参数|选项|包括|列表/u.test(question)) {
    return 0;
  }

  const separators = chunk.text.match(/[、，,；;]|(?:^|\n)\s*(?:[-*]|\d+[.)、])/gu)?.length ?? 0;
  const explicitCount = /\d+\s*(?:个|条|种|项|大)/u.test(chunk.text) ? 1 : 0;
  return Math.min(1, separators / 6 + explicitCount * 0.25);
}

function directSupportEvidenceScore(chunk: RetrievedChunk, question: string): number {
  if (!isSupportQuestionText(question)) {
    return 0;
  }

  const evidence = normalizeCompactText(chunk.text);
  const markers = /已支持|支持|上线|开放|适配|可用/u;
  const supportSubject = directSupportSubject(question);
  if (supportSubject === undefined) {
    return 0;
  }

  let index = evidence.indexOf(supportSubject);
  while (index >= 0) {
    const localContext = evidence.slice(
      Math.max(0, index - 10),
      index + supportSubject.length + 10,
    );
    if (markers.test(localContext)) {
      return 1;
    }
    index = evidence.indexOf(supportSubject, index + supportSubject.length);
  }

  return 0;
}

function directSupportSubject(question: string): string | undefined {
  const normalized = question.normalize('NFKC').toLowerCase();
  const subject =
    /支持\s*(?!哪些|什么|哪几)(?<subject>[^吗么嘛呢?？]{2,24})(?:吗|么|嘛|呢|\?|？|$)/u.exec(
      normalized,
    )?.groups?.subject ??
    /\bsupport(?:s|ed)?\s+(?<subject>[a-z0-9._-]{2,32})/u.exec(normalized)?.groups?.subject;
  if (subject === undefined) {
    return undefined;
  }

  const compact = normalizeCompactText(subject).replace(/^xxyy/u, '');
  if (compact.length < 2) {
    return undefined;
  }
  if (/^[a-z0-9._-]+$/u.test(compact)) {
    return compact;
  }
  return compact.length <= 6 ? compact : undefined;
}

function directSourceScore(chunk: RetrievedChunk): number {
  return chunk.metadata.sourceUrl === undefined ? 0 : 1;
}

function howToEvidenceScore(chunk: RetrievedChunk, question: string): number {
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();
  if (!/如何|怎么|怎样|从哪里|在哪(?:里)?|入口|how\s+to|where/u.test(normalizedQuestion)) {
    return 0;
  }

  const normalizedEvidence = chunk.text.normalize('NFKC').toLowerCase();
  return /点击|选择|输入|填写|下载|上传|勾选|入口|直达|链接|菜单|网站|提前设置|设置.{0,8}(?:条件|金额|比例|模式|买入|卖出)/u.test(
    normalizedEvidence,
  )
    ? HOW_TO_DIRECT_EVIDENCE_BONUS
    : 0;
}

function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined || !Number.isInteger(topK) || topK <= 0) {
    return 6;
  }

  return topK;
}

function normalizeCandidateMultiplier(candidateMultiplier: number | undefined): number {
  if (
    candidateMultiplier === undefined ||
    !Number.isInteger(candidateMultiplier) ||
    candidateMultiplier <= 1
  ) {
    return 3;
  }

  return Math.min(candidateMultiplier, 10);
}
