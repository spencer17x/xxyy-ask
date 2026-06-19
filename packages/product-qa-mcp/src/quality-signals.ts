import type { QualitySignal, QualitySignalSink } from '@xxyy/agent-core';
import {
  captureAnswerQualitySignals as defaultCaptureAnswerQualitySignals,
  type KnowledgeCandidateStore,
} from '@xxyy/knowledge-ops';

interface CaptureAnswerQualitySignalsLike {
  (input: {
    getStore: () => KnowledgeCandidateStore | Promise<KnowledgeCandidateStore>;
    signals: QualitySignal[];
  }): Promise<unknown>;
}

export interface ProductQaMcpQualitySignalRuntime {
  sink: QualitySignalSink;
  close(): Promise<void>;
}

export interface ProductQaMcpQualitySignalRuntimeOptions {
  captureAnswerQualitySignals?: CaptureAnswerQualitySignalsLike;
  getStore(): KnowledgeCandidateStore | Promise<KnowledgeCandidateStore>;
}

export function createProductQaMcpQualitySignalRuntime(
  options: ProductQaMcpQualitySignalRuntimeOptions,
): ProductQaMcpQualitySignalRuntime {
  const captureAnswerQualitySignals =
    options.captureAnswerQualitySignals ?? defaultCaptureAnswerQualitySignals;
  const pendingCaptures = new Set<Promise<void>>();

  return {
    sink: {
      record(signal) {
        try {
          const capture = captureAnswerQualitySignals({
            getStore: () => options.getStore(),
            signals: [signal],
          })
            .then(() => undefined)
            .catch(() => undefined);
          pendingCaptures.add(capture);
          void capture.finally(() => {
            pendingCaptures.delete(capture);
          });
        } catch {
          // Quality-gap capture is best-effort and must never block MCP answers.
        }
      },
    },
    async close() {
      await Promise.allSettled([...pendingCaptures]);
    },
  };
}
