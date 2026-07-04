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
        const rightScore = metadataMatchScore(right, queryTokens);
        const leftScore = metadataMatchScore(left, queryTokens);

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
