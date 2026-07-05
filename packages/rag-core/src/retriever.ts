import type { RagIndex } from '@xxyy/shared';
import { tokenize } from '@xxyy/knowledge';

import { retrieve, type RetrieveOptions, type RetrievedChunk } from './retrieve.js';

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
}

const METADATA_RERANK_WEIGHT = 0.2;
const CHAIN_COVERAGE_BONUS_PER_CHAIN = 1.2;
const BROAD_CHAIN_COVERAGE_BONUS = 5;

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
      const reranked = await reranker.rerank({ chunks: candidates, question, topK });
      return reranked.slice(0, topK).map((chunk, index) => ({ ...chunk, rank: index + 1 }));
    },
  };
}

export function createMetadataReranker(): Reranker {
  return {
    rerank({ chunks, question }) {
      const queryTokens = new Set(tokenize(question));
      return [...chunks].sort((left, right) => {
        const rightScore = rerankScore(right, queryTokens, question);
        const leftScore = rerankScore(left, queryTokens, question);

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
  let score = 0;

  for (const token of tokenize(metadataText)) {
    if (queryTokens.has(token)) {
      score += token.length > 1 ? 2 : 1;
    }
  }

  return score;
}

function rerankScore(chunk: RetrievedChunk, queryTokens: Set<string>, question: string): number {
  return (
    chunk.score +
    metadataMatchScore(chunk, queryTokens) * METADATA_RERANK_WEIGHT +
    contentShapeScore(chunk, question)
  );
}

function contentShapeScore(chunk: RetrievedChunk, question: string): number {
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();
  if (!isSupportedChainCoverageQuestion(normalizedQuestion)) {
    return 0;
  }

  const normalizedEvidence = [
    chunk.metadata.title,
    chunk.metadata.module,
    ...chunk.metadata.headingPath,
    chunk.text,
  ]
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
  const chainCount = countChainMentions(normalizedEvidence);
  let score = chainCount * CHAIN_COVERAGE_BONUS_PER_CHAIN;

  if (
    chainCount >= 3 ||
    /支持\s*(?:\d+|[一二三四五六七八九十]+)\s*大?公链/u.test(normalizedEvidence)
  ) {
    score += BROAD_CHAIN_COVERAGE_BONUS;
  }

  if (normalizedQuestion.includes('跟单') && normalizedEvidence.includes('跟单')) {
    score += 1;
  }

  return score;
}

function isSupportedChainCoverageQuestion(normalizedQuestion: string): boolean {
  return /(?:支持|哪些|哪几条|哪几种).*(?:链|公链)|(?:链|公链).*(?:支持|哪些|哪几条|哪几种)/u.test(
    normalizedQuestion,
  );
}

function countChainMentions(normalizedEvidence: string): number {
  const chainPatterns = [
    /(?:^|[^a-z0-9])sol(?:$|[^a-z0-9])/u,
    /solana/u,
    /(?:^|[^a-z0-9])bsc(?:$|[^a-z0-9])/u,
    /bnb\s*chain/u,
    /(?:^|[^a-z0-9])base(?:$|[^a-z0-9])/u,
    /(?:^|[^a-z0-9])eth(?:$|[^a-z0-9])/u,
    /ethereum/u,
    /x\s*layer|xlayer/u,
    /plasma/u,
  ];

  return chainPatterns.filter((pattern) => pattern.test(normalizedEvidence)).length;
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
