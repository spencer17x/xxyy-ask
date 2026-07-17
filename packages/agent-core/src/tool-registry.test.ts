import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createInMemoryQualityTracer } from '@xxyy/rag-core';

import {
  ToolRegistryDuplicateNameError,
  ToolRegistryToolNotFoundError,
  createToolRegistry,
} from './tool-registry.js';

describe('createToolRegistry', () => {
  it('registers and executes a tool with Zod input and output validation', async () => {
    const registry = createToolRegistry();

    registry.register({
      name: 'echo_count',
      description: 'Echo a count label.',
      inputSchema: z.object({ count: z.number().int().positive() }),
      outputSchema: z.object({ label: z.string() }),
      execute: ({ count }) => ({ label: `count:${count}` }),
    });

    await expect(registry.execute('echo_count', { count: 2 })).resolves.toEqual({
      label: 'count:2',
    });
    await expect(registry.execute('echo_count', { count: '2' })).rejects.toThrow(z.ZodError);
  });

  it('accepts handler output that is transformed by the output schema', async () => {
    const registry = createToolRegistry();

    registry.register({
      name: 'string_to_number',
      description: 'Transforms string output into a number.',
      inputSchema: z.object({}),
      outputSchema: z.string().transform((value) => Number(value)),
      execute: () => '42',
    });

    await expect(registry.execute('string_to_number', {})).resolves.toBe(42);
  });

  it('passes tool context into execute handlers', async () => {
    const registry = createToolRegistry();
    const calls: unknown[] = [];

    registry.register({
      name: 'context_tool',
      description: 'Use context.',
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ ok: z.literal(true) }),
      execute(input, context) {
        calls.push({ context, input });
        return { ok: true as const };
      },
    });

    await expect(
      registry.execute('context_tool', { value: 'x' }, { channel: 'web', requestId: 'req-1' }),
    ).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      {
        context: { channel: 'web', requestId: 'req-1' },
        input: { value: 'x' },
      },
    ]);
  });

  it('traces validated tool execution with bounded input and output summaries', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const registry = createToolRegistry({ tracer });
    registry.register({
      name: 'answer_product_question',
      description: 'Answer products.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.object({
        answer: z.string(),
        citations: z.array(z.object({ title: z.string() })),
        intent: z.literal('product_qa'),
      }),
      execute: () => ({
        answer: 'secret raw answer',
        citations: [{ title: 'Pro' }],
        intent: 'product_qa' as const,
      }),
    });

    await registry.execute(
      'answer_product_question',
      { question: 'secret raw question' },
      { channel: 'web', requestId: 'req-1', sessionId: 'session-secret' },
    );
    await expect(registry.execute('answer_product_question', { question: 42 })).rejects.toThrow(
      z.ZodError,
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputs: { inputKeys: ['question'] },
      metadata: {
        channel: 'web',
        requestId: 'req-1',
        toolName: 'answer_product_question',
      },
      name: 'agent.tool',
      outputs: {
        citationCount: 1,
        intent: 'product_qa',
        outputKeys: ['answer', 'citations', 'intent'],
      },
      runType: 'tool',
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('secret raw question');
    expect(serialized).not.toContain('secret raw answer');
    expect(serialized).not.toContain('session-secret');
  });

  it('traces streamed tool event types without retaining deltas', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const registry = createToolRegistry({ tracer });
    registry.register({
      name: 'stream_answer',
      description: 'Streams.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: () => ({}),
      async *stream() {
        await Promise.resolve();
        yield { type: 'answer_delta', delta: 'secret stream delta' };
        yield { type: 'metadata', citations: [], confidence: 0.9, intent: 'product_qa' };
      },
    });

    const events: unknown[] = [];
    for await (const event of registry.stream('stream_answer', {}) ?? []) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(records[0]).toMatchObject({
      name: 'agent.tool',
      outputs: { eventCount: 2, eventTypes: ['answer_delta', 'metadata'] },
    });
    expect(JSON.stringify(records)).not.toContain('secret stream delta');
  });

  it('rejects duplicate tool names with ToolRegistryDuplicateNameError', () => {
    const registry = createToolRegistry();
    const definition = {
      name: 'duplicate_tool',
      description: 'A test tool.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
    };

    registry.register(definition);

    expect(() => registry.register(definition)).toThrow(ToolRegistryDuplicateNameError);
  });

  it("throws stable ToolRegistryToolNotFoundError from execute('missing_tool', {})", async () => {
    const registry = createToolRegistry();

    await expect(registry.execute('missing_tool', {})).rejects.toThrow(
      ToolRegistryToolNotFoundError,
    );
  });

  it('validates every streamed chat event before yielding it', async () => {
    const registry = createToolRegistry();

    registry.register({
      name: 'stream_answer',
      description: 'Streams a valid answer.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: () => ({}),
      async *stream() {
        await Promise.resolve();
        yield { type: 'answer_delta', delta: 'hello' };
        yield { type: 'metadata', citations: [], confidence: 0.9, intent: 'product_qa' };
      },
    });

    const events: unknown[] = [];
    for await (const event of registry.stream('stream_answer', {}) ?? []) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'answer_delta', delta: 'hello' },
      { type: 'metadata', citations: [], confidence: 0.9, intent: 'product_qa' },
    ]);
  });

  it('fails fast when a streamed chat event has an invalid shape', async () => {
    const registry = createToolRegistry();

    registry.register({
      name: 'bad_stream_answer',
      description: 'Streams a malformed answer.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: () => ({}),
      async *stream() {
        await Promise.resolve();
        yield { type: 'answer_delta' };
      },
    });

    const stream = registry.stream('bad_stream_answer', {});

    await expect(async () => {
      for await (const _event of stream ?? []) {
        // Iteration triggers stream event validation.
      }
    }).rejects.toThrow(z.ZodError);
  });
});
