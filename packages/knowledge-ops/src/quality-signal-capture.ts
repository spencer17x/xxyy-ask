import type { KnowledgeCandidateStore } from './knowledge-candidate-store.js';
import {
  mineAnswerQualitySignals,
  type AnswerQualitySignal,
  type MineAnswerQualitySignalsOutput,
} from './quality-signal-miner.js';
import type { KnowledgeCandidate } from './types.js';

export interface CaptureAnswerQualitySignalsInput {
  getStore?: () => KnowledgeCandidateStore | Promise<KnowledgeCandidateStore>;
  now?: string;
  signals: AnswerQualitySignal[];
  store?: KnowledgeCandidateStore;
}

export interface CaptureAnswerQualitySignalsOutput extends MineAnswerQualitySignalsOutput {
  storedCandidates: KnowledgeCandidate[];
}

export async function captureAnswerQualitySignals(
  input: CaptureAnswerQualitySignalsInput,
): Promise<CaptureAnswerQualitySignalsOutput> {
  const mined = mineAnswerQualitySignals({
    ...(input.now === undefined ? {} : { now: input.now }),
    signals: input.signals,
  });

  if (mined.candidates.length === 0) {
    return {
      ...mined,
      storedCandidates: [],
    };
  }

  const store = await resolveCandidateStore(input);
  const storedCandidates = await store.addCandidates(mined.candidates);
  return {
    ...mined,
    storedCandidates,
  };
}

async function resolveCandidateStore(
  input: CaptureAnswerQualitySignalsInput,
): Promise<KnowledgeCandidateStore> {
  if (input.store !== undefined) {
    return input.store;
  }

  if (input.getStore !== undefined) {
    return input.getStore();
  }

  throw new Error('captureAnswerQualitySignals requires store or getStore.');
}
