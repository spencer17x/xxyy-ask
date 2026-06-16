import { describe, expect, it } from 'vitest';

import { createInMemoryAuditSink } from './audit.js';
import type { ToolAuditEvent } from './audit.js';

describe('createInMemoryAuditSink', () => {
  it('records immutable audit events', () => {
    const sink = createInMemoryAuditSink();
    const event: ToolAuditEvent = {
      channel: 'web',
      latencyMs: 12,
      status: 'success',
      toolName: 'answer_product_question',
    };
    const expectedEvent = { ...event };

    sink.record(event);
    event.latencyMs = 99;

    const events = sink.events();
    events[0]!.latencyMs = 42;

    expect(events).toEqual([{ ...expectedEvent, latencyMs: 42 }]);
    expect(sink.events()).toEqual([expectedEvent]);
  });
});
