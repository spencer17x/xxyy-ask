import type { KnowledgeCandidateStore } from './knowledge-candidate-store.js';
import {
  mineAnswerQualitySignals,
  type AnswerQualitySignal,
  type MineAnswerQualitySignalsOutput,
} from './quality-signal-miner.js';
import type { KnowledgeCandidate } from './types.js';

export interface CaptureAnswerQualitySignalsInput {
  now?: string;
  signals: AnswerQualitySignal[];
  store: KnowledgeCandidateStore;
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

  const storedCandidates = await input.store.addCandidates(mined.candidates);
  return {
    ...mined,
    storedCandidates,
  };
}
