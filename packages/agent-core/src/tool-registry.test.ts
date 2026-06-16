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
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
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
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
      execute: () => '42',
    });

    await expect(registry.execute('string_to_number', {})).resolves.toBe(42);
  });

  it('rejects duplicate tool names with ToolRegistryDuplicateNameError', () => {
    const registry = createToolRegistry();
    const definition = {
      name: 'duplicate_tool',
      description: 'A test tool.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      policy: { allowExternalMcp: false, requiresOpsAuth: false },
      execute: () => ({ ok: true }),
    };

    registry.register(definition);

    expect(() => registry.register(definition)).toThrow(ToolRegistryDuplicateNameError);
  });

  it('filters externally callable tools with list({ externalMcpOnly: true })', () => {
    const registry = createToolRegistry();

    registry.register({
      name: 'external_tool',
      description: 'Externally callable.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      policy: { allowExternalMcp: true, requiresOpsAuth: false },
      execute: () => ({ ok: true }),
    });
    registry.register({
      name: 'internal_tool',
      description: 'Internal only.',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      policy: { allowExternalMcp: false, requiresOpsAuth: false },
      execute: () => ({ ok: true }),
    });

    expect(registry.list({ externalMcpOnly: true }).map((tool) => tool.name)).toEqual([
      'external_tool',
    ]);
    expect(registry.list().map((tool) => tool.name)).toEqual(['external_tool', 'internal_tool']);
  });

  it("throws stable ToolRegistryToolNotFoundError from execute('missing_tool', {})", async () => {
    const registry = createToolRegistry();

    await expect(registry.execute('missing_tool', {})).rejects.toThrow(
      ToolRegistryToolNotFoundError,
    );
  });
});
