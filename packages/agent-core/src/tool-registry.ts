import type { z } from 'zod';

export interface ToolPolicy {
  requiresOpsAuth: boolean;
}

export interface ToolContext {
  channel?: string | undefined;
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
}

type RegisteredToolDefinition = Omit<ToolDefinition, 'execute'> & {
  execute: (input: unknown, context: ToolContext) => unknown;
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

export interface ToolRegistry {
  execute(name: string, input: unknown, context?: ToolContext): Promise<z.output<z.ZodType>>;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  register<Name extends string, InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
    definition: ToolDefinition<Name, InputSchema, OutputSchema>,
  ): void;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredToolDefinition>();

  return {
    async execute(name, input, context = {}) {
      const definition = tools.get(name);
      if (!definition) {
        throw new ToolRegistryToolNotFoundError(name);
      }

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
  };
}
