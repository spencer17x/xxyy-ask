import type { ChatChannel, Intent } from '@xxyy/shared';

export type QualitySignalReason =
  | 'ambiguous_followup'
  | 'boundary_investment_advice'
  | 'boundary_private_data'
  | 'low_confidence'
  | 'low_confidence_missing_citations'
  | 'missing_citations'
  | 'session_unavailable'
  | 'tool_failure'
  | 'tx_analysis_failure'
  | 'unknown_intent';

export interface QualitySignal {
  answer?: string;
  channel: ChatChannel;
  citationCount?: number;
  confidence?: number;
  errorCode?: string;
  intent: Intent;
  reason: QualitySignalReason;
  redactedQuestion: string;
  sessionIdPresent: boolean;
  userIdPresent: boolean;
}

export interface QualitySignalSink {
  record(signal: QualitySignal): void;
}

export interface InMemoryQualitySignalSink extends QualitySignalSink {
  signals(): QualitySignal[];
}

export function createNoopQualitySignalSink(): QualitySignalSink {
  return {
    record: () => undefined,
  };
}

export function createInMemoryQualitySignalSink(): InMemoryQualitySignalSink {
  const recordedSignals: QualitySignal[] = [];
  return {
    record(signal) {
      recordedSignals.push(signal);
    },
    signals() {
      return [...recordedSignals];
    },
  };
}
