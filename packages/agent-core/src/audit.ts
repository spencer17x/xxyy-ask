export type ToolAuditStatus = 'failure' | 'success';

export interface ToolAuditEvent {
  candidateId?: string;
  channel?: string;
  citationCount?: number;
  errorCode?: string;
  intent?: string;
  latencyMs: number;
  reportId?: string;
  sessionIdPresent?: boolean;
  sourceId?: string;
  status: ToolAuditStatus;
  toolName: string;
  userIdPresent?: boolean;
}

export interface ToolAuditSink {
  record(event: ToolAuditEvent): void;
}

export interface InMemoryAuditSink extends ToolAuditSink {
  events(): ToolAuditEvent[];
}

export function createNoopAuditSink(): ToolAuditSink {
  return {
    record() {
      // Intentionally ignored.
    },
  };
}

export function createInMemoryAuditSink(): InMemoryAuditSink {
  const recordedEvents: ToolAuditEvent[] = [];

  return {
    record(event) {
      recordedEvents.push({ ...event });
    },

    events() {
      return recordedEvents.map((event) => ({ ...event }));
    },
  };
}
