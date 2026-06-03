import type { RagIndex } from '@xxyy/shared';

import { retrieve, type RetrieveOptions, type RetrievedChunk } from './retrieve.js';

export interface Retriever {
  retrieve(question: string, options: RetrieveOptions): Promise<RetrievedChunk[]> | RetrievedChunk[];
}

export function createLocalRetriever(index: RagIndex): Retriever {
  return {
    retrieve(question: string, options: RetrieveOptions): RetrievedChunk[] {
      return retrieve(question, index, options);
    },
  };
}
