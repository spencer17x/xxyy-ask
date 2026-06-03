import type { ChatResponse, Classification } from '@xxyy/shared';

import type { RetrievedChunk } from './retrieve.js';

export interface AnswerProviderInput {
  question: string;
  classification: Classification;
  retrievedChunks: RetrievedChunk[];
}

export interface AnswerProvider {
  answer(input: AnswerProviderInput): Promise<ChatResponse>;
}
