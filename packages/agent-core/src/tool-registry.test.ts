import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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
});
