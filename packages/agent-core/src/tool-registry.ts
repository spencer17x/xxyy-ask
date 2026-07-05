import type { z } from 'zod';

import { chatStreamEventSchema } from '@xxyy/shared';

export interface ToolPolicy {
  requiresOpsAuth: boolean;
}

export interface ToolContext {
  channel?: string | undefined;
  opsAuthPresent?: boolean | undefined;
  requestId?: string | undefined;
  sessionId?: string | undefined;
  userIdPresent?: boolean | undefined;
}

export interface ToolDefinition<
  Name extends string = string,
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  name: Name;
  description: string;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  policy: ToolPolicy;
  execute: (
    input: z.output<InputSchema>,
    context: ToolContext,
  ) => z.input<OutputSchema> | Promise<z.input<OutputSchema>>;
  stream?: (input: z.output<InputSchema>, context: ToolContext) => AsyncIterable<unknown>;
}

type RegisteredToolDefinition = Omit<ToolDefinition, 'execute' | 'stream'> & {
  execute: (input: unknown, context: ToolContext) => unknown;
  stream?: (input: unknown, context: ToolContext) => AsyncIterable<unknown>;
};

export class ToolRegistryDuplicateNameError extends Error {
  constructor(name: string) {
    super(`Tool already registered: ${name}`);
    this.name = 'ToolRegistryDuplicateNameError';
  }
}

export class ToolRegistryToolNotFoundError extends Error {
  constructor(name: string) {
    super(`Tool not found: ${name}`);
    this.name = 'ToolRegistryToolNotFoundError';
  }
}

export class ToolRegistryOpsAuthRequiredError extends Error {
  constructor(name: string) {
    super(`Tool requires ops authorization: ${name}`);
    this.name = 'ToolRegistryOpsAuthRequiredError';
  }
}

export interface ToolRegistry {
  execute(name: string, input: unknown, context?: ToolContext): Promise<z.output<z.ZodType>>;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  register<Name extends string, InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
    definition: ToolDefinition<Name, InputSchema, OutputSchema>,
  ): void;
  stream(name: string, input: unknown, context?: ToolContext): AsyncIterable<unknown> | undefined;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredToolDefinition>();

  return {
    async execute(name, input, context = {}) {
      const definition = tools.get(name);
      if (!definition) {
        throw new ToolRegistryToolNotFoundError(name);
      }

      assertToolPolicyAllowsExecution(definition, context);
      const parsedInput = definition.inputSchema.parse(input);
      const output = await definition.execute(parsedInput, context);
      return definition.outputSchema.parse(output);
    },

    get(name) {
      return tools.get(name);
    },

    list() {
      return Array.from(tools.values());
    },

    register(definition) {
      if (tools.has(definition.name)) {
        throw new ToolRegistryDuplicateNameError(definition.name);
      }

      tools.set(definition.name, definition as RegisteredToolDefinition);
    },

    stream(name, input, context = {}) {
      const definition = tools.get(name);
      if (!definition) {
        throw new ToolRegistryToolNotFoundError(name);
      }

      assertToolPolicyAllowsExecution(definition, context);
      const parsedInput = definition.inputSchema.parse(input);
      const stream = definition.stream?.(parsedInput, context);
      return stream === undefined ? undefined : validateChatStreamEvents(stream);
    },
  };
}

function assertToolPolicyAllowsExecution(
  definition: RegisteredToolDefinition,
  context: ToolContext,
): void {
  if (definition.policy.requiresOpsAuth && context.opsAuthPresent !== true) {
    throw new ToolRegistryOpsAuthRequiredError(definition.name);
  }
}

async function* validateChatStreamEvents(stream: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const event of stream) {
    yield chatStreamEventSchema.parse(event);
  }
}
