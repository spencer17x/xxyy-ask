import type { z } from 'zod';

import { chatStreamEventSchema, type ChatStreamEvent } from '@xxyy/shared';
import { noopQualityTracer, type QualityTracer } from '@xxyy/rag-core';

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

export interface ToolRegistry {
  execute(name: string, input: unknown, context?: ToolContext): Promise<z.output<z.ZodType>>;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  register<Name extends string, InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
    definition: ToolDefinition<Name, InputSchema, OutputSchema>,
  ): void;
  stream(name: string, input: unknown, context?: ToolContext): AsyncIterable<unknown> | undefined;
}

export interface CreateToolRegistryOptions {
  tracer?: QualityTracer;
}

export function createToolRegistry(options: CreateToolRegistryOptions = {}): ToolRegistry {
  const tools = new Map<string, RegisteredToolDefinition>();
  const tracer = options.tracer ?? noopQualityTracer;

  return {
    async execute(name, input, context = {}) {
      const definition = tools.get(name);
      if (!definition) {
        throw new ToolRegistryToolNotFoundError(name);
      }

      const parsedInput = definition.inputSchema.parse(input);
      return tracer.run(
        createToolSpan(name, parsedInput, context, summarizeToolOutput),
        async () => {
          const output = await definition.execute(parsedInput, context);
          return definition.outputSchema.parse(output);
        },
      );
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

      const parsedInput = definition.inputSchema.parse(input);
      const stream = definition.stream?.(parsedInput, context);
      if (stream === undefined) {
        return undefined;
      }
      return tracer.stream(createToolStreamSpan(name, parsedInput, context), () =>
        validateChatStreamEvents(stream),
      );
    },
  };
}

function createToolSpan<T>(
  name: string,
  input: unknown,
  context: ToolContext,
  output: (value: T) => Record<string, unknown>,
) {
  return {
    inputs: { inputKeys: objectKeys(input) },
    metadata: toolMetadata(name, context),
    name: 'agent.tool',
    output,
    runType: 'tool' as const,
  };
}

function createToolStreamSpan(name: string, input: unknown, context: ToolContext) {
  return {
    event: summarizeStreamEvent,
    inputs: { inputKeys: objectKeys(input) },
    metadata: toolMetadata(name, context),
    name: 'agent.tool',
    output: (events: readonly Record<string, unknown>[]) => ({
      eventCount: events.length,
      eventTypes: events.map((event) => event.type),
    }),
    runType: 'tool' as const,
  };
}

function toolMetadata(name: string, context: ToolContext): Record<string, unknown> {
  return {
    ...(context.channel === undefined ? {} : { channel: context.channel }),
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    toolName: name,
    userIdPresent: context.userIdPresent === true,
  };
}

function summarizeToolOutput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { outputType: typeof value };
  }
  return {
    ...(Array.isArray(value.attachments) ? { attachmentCount: value.attachments.length } : {}),
    ...(Array.isArray(value.chunks) ? { chunkCount: value.chunks.length } : {}),
    ...(Array.isArray(value.citations) ? { citationCount: value.citations.length } : {}),
    ...(typeof value.intent === 'string' ? { intent: value.intent } : {}),
    outputKeys: Object.keys(value).sort(),
  };
}

function summarizeStreamEvent(event: unknown): Record<string, unknown> {
  const parsed = chatStreamEventSchema.parse(event) as ChatStreamEvent;
  if (parsed.type === 'metadata') {
    return {
      attachmentCount: parsed.attachments?.length ?? 0,
      citationCount: parsed.citations.length,
      intent: parsed.intent,
      type: parsed.type,
    };
  }
  return parsed.type === 'status'
    ? { phase: parsed.phase, type: parsed.type }
    : { type: parsed.type };
}

function objectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function* validateChatStreamEvents(stream: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const event of stream) {
    yield chatStreamEventSchema.parse(event);
  }
}
