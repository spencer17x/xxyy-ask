import type { z } from 'zod';

export interface ToolPolicy {
  allowExternalMcp: boolean;
  requiresOpsAuth: boolean;
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
  execute: (input: z.output<InputSchema>) => z.input<OutputSchema> | Promise<z.input<OutputSchema>>;
}

export interface ListToolsOptions {
  externalMcpOnly?: boolean;
}

type RegisteredToolDefinition = Omit<ToolDefinition, 'execute'> & {
  execute: (input: unknown) => unknown;
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
  execute(name: string, input: unknown): Promise<z.output<z.ZodType>>;
  get(name: string): ToolDefinition | undefined;
  list(options?: ListToolsOptions): ToolDefinition[];
  register<Name extends string, InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
    definition: ToolDefinition<Name, InputSchema, OutputSchema>,
  ): void;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredToolDefinition>();

  return {
    async execute(name, input) {
      const definition = tools.get(name);
      if (!definition) {
        throw new ToolRegistryToolNotFoundError(name);
      }

      const parsedInput = definition.inputSchema.parse(input);
      const output = await definition.execute(parsedInput);
      return definition.outputSchema.parse(output);
    },

    get(name) {
      return tools.get(name);
    },

    list(options) {
      const definitions = Array.from(tools.values());
      if (options?.externalMcpOnly !== true) {
        return definitions;
      }

      return definitions.filter((definition) => definition.policy.allowExternalMcp);
    },

    register(definition) {
      if (tools.has(definition.name)) {
        throw new ToolRegistryDuplicateNameError(definition.name);
      }

      tools.set(definition.name, definition as RegisteredToolDefinition);
    },
  };
}
