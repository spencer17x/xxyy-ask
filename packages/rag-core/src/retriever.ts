import type { RagIndex } from '@xxyy/shared';

import { retrieve, type RetrieveOptions, type RetrievedChunk } from './retrieve.js';

export interface Retriever {
  retrieve(
    question: string,
    options: RetrieveOptions,
  ): Promise<RetrievedChunk[]> | RetrievedChunk[];
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

export function createLocalRetriever(index: RagIndex): Retriever {
  return {
    retrieve(question: string, options: RetrieveOptions): RetrievedChunk[] {
      return retrieve(question, index, options);
    },
  };
}
