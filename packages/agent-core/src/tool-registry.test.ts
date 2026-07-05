import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ToolRegistryDuplicateNameError,
  ToolRegistryOpsAuthRequiredError,
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
      policy: { requiresOpsAuth: false },
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
      policy: { requiresOpsAuth: false },
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
      policy: { requiresOpsAuth: false },
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

  it('requires explicit ops auth context for protected execute tools', async () => {
    const registry = createToolRegistry();

    registry.register({
      name: 'ops_tool',
      description: 'Protected tool.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.literal(true) }),
      policy: { requiresOpsAuth: true },
      execute: () => ({ ok: true as const }),
    });

    await expect(registry.execute('ops_tool', {})).rejects.toThrow(
      ToolRegistryOpsAuthRequiredError,
    );
    await expect(registry.execute('ops_tool', {}, { opsAuthPresent: true })).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects duplicate tool names with ToolRegistryDuplicateNameError', () => {
    const registry = createToolRegistry();
    const definition = {
      name: 'duplicate_tool',
      description: 'A test tool.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      policy: { requiresOpsAuth: false },
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
      policy: { requiresOpsAuth: false },
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

  it('requires explicit ops auth context for protected stream tools', async () => {
    const registry = createToolRegistry();

    registry.register({
      name: 'ops_stream',
      description: 'Protected stream.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: { requiresOpsAuth: true },
      execute: () => ({}),
      async *stream() {
        await Promise.resolve();
        yield { type: 'answer_delta', delta: 'ok' };
      },
    });

    expect(() => registry.stream('ops_stream', {})).toThrow(ToolRegistryOpsAuthRequiredError);
    const events: unknown[] = [];
    for await (const event of registry.stream('ops_stream', {}, { opsAuthPresent: true }) ?? []) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'answer_delta', delta: 'ok' }]);
  });

  it('fails fast when a streamed chat event has an invalid shape', async () => {
    const registry = createToolRegistry();

    registry.register({
      name: 'bad_stream_answer',
      description: 'Streams a malformed answer.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: { requiresOpsAuth: false },
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
