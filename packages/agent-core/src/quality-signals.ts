import type { AgentRoute, ChatChannel, Intent } from '@xxyy/shared';

export type QualitySignalChannel = ChatChannel | 'agent';

export type QualitySignalReason =
  | 'boundary_chain_forensics'
  | 'ambiguous_transaction_reference'
  | 'ambiguous_followup'
  | 'boundary_business_action'
  | 'boundary_investment_advice'
  | 'boundary_private_data'
  | 'boundary_private_credentials'
  | 'boundary_unsafe_request'
  | 'handoff_wording'
  | 'low_confidence'
  | 'low_confidence_missing_citations'
  | 'missing_citations'
  | 'missing_followup_context'
  | 'session_unavailable'
  | 'tool_failure'
  | 'tx_analysis_failure'
  | 'unknown_intent';

export interface QualitySignal {
  agentRoute?: AgentRoute;
  answer?: string;
  channel: QualitySignalChannel;
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
