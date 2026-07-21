import { Buffer } from 'node:buffer';

import type { z } from 'zod';

import { noopQualityTracer, type QualityTracer } from '@xxyy/rag-core';

import {
  capabilityIdSchema,
  capabilityInvocationContextSchema,
  parseCapabilityManifest,
  type CapabilityAdapterRequest,
  type CapabilityDefinition,
  type CapabilityExecutionContext,
  type CapabilityInvocationContext,
  type CapabilityManifest,
} from './capability-contract.js';
import {
  createDenyByDefaultCapabilityPolicy,
  type CapabilityPolicy,
  type CapabilityPolicyDecision,
  type CapabilityPolicyDenialReason,
} from './capability-policy.js';

const DEFAULT_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
const ABSOLUTE_MAX_TIMEOUT_MS = 120_000;
const ABSOLUTE_MAX_OUTPUT_BYTES = 1_048_576;

type RegisteredCapabilityDefinition = CapabilityDefinition<z.ZodType, z.ZodType>;

export class CapabilityRegistryDuplicateIdError extends Error {
  constructor(public readonly capabilityId: string) {
    super(`Capability already registered: ${capabilityId}`);
    this.name = 'CapabilityRegistryDuplicateIdError';
  }
}

export class CapabilityRegistryNotFoundError extends Error {
  constructor(public readonly capabilityId: string) {
    super(`Capability not found: ${capabilityId}`);
    this.name = 'CapabilityRegistryNotFoundError';
  }
}

export class CapabilityAdapterSourceMismatchError extends Error {
  constructor(
    public readonly capabilityId: string,
    public readonly manifestSource: string,
    public readonly adapterSource: string,
  ) {
    super(
      `Capability ${capabilityId} declares source ${manifestSource}, but its adapter uses ${adapterSource}.`,
    );
    this.name = 'CapabilityAdapterSourceMismatchError';
  }
}

export class CapabilityPolicyDeniedError extends Error {
  constructor(
    public readonly capabilityId: string,
    public readonly reason: CapabilityPolicyDenialReason,
  ) {
    super(`Capability invocation denied: ${capabilityId} (${reason}).`);
    this.name = 'CapabilityPolicyDeniedError';
  }
}

export class CapabilityInvocationTimeoutError extends Error {
  constructor(
    public readonly capabilityId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Capability ${capabilityId} timed out after ${timeoutMs}ms.`);
    this.name = 'CapabilityInvocationTimeoutError';
  }
}

export class CapabilityInvocationAbortedError extends Error {
  constructor(public readonly capabilityId: string) {
    super(`Capability invocation aborted: ${capabilityId}.`);
    this.name = 'CapabilityInvocationAbortedError';
  }
}

export class CapabilityOutputLimitError extends Error {
  constructor(
    public readonly capabilityId: string,
    public readonly outputBytes: number,
    public readonly maxOutputBytes: number,
  ) {
    super(
      `Capability ${capabilityId} returned ${outputBytes} bytes, exceeding the ${maxOutputBytes} byte limit.`,
    );
    this.name = 'CapabilityOutputLimitError';
  }
}

export class CapabilityOutputSerializationError extends Error {
  constructor(public readonly capabilityId: string) {
    super(`Capability ${capabilityId} returned a non-JSON-serializable output.`);
    this.name = 'CapabilityOutputSerializationError';
  }
}

export interface CapabilityRegistry {
  getManifest(capabilityId: string): CapabilityManifest | undefined;
  invoke(
    capabilityId: string,
    input: unknown,
    context: CapabilityInvocationContext,
  ): Promise<unknown>;
  list(): CapabilityManifest[];
  register<InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
    definition: CapabilityDefinition<InputSchema, OutputSchema>,
  ): void;
}

export interface CreateCapabilityRegistryOptions {
  maxOutputBytes?: number;
  maxTimeoutMs?: number;
  policy?: CapabilityPolicy;
  tracer?: QualityTracer;
}

export function createCapabilityRegistry(
  options: CreateCapabilityRegistryOptions = {},
): CapabilityRegistry {
  const definitions = new Map<string, RegisteredCapabilityDefinition>();
  const policy = options.policy ?? createDenyByDefaultCapabilityPolicy();
  const tracer = options.tracer ?? noopQualityTracer;
  const globalMaxTimeoutMs = boundedPositiveInteger(
    options.maxTimeoutMs,
    DEFAULT_MAX_TIMEOUT_MS,
    ABSOLUTE_MAX_TIMEOUT_MS,
    'maxTimeoutMs',
  );
  const globalMaxOutputBytes = boundedPositiveInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    ABSOLUTE_MAX_OUTPUT_BYTES,
    'maxOutputBytes',
  );

  return {
    getManifest(capabilityId) {
      return definitions.get(capabilityId)?.manifest;
    },

    async invoke(capabilityId, input, invocationContext) {
      const parsedCapabilityId = capabilityIdSchema.parse(capabilityId);
      const context = capabilityInvocationContextSchema.parse(invocationContext);
      const definition = definitions.get(parsedCapabilityId);
      if (definition === undefined) {
        return tracer.run(createMissingCapabilitySpan(parsedCapabilityId, input, context), () =>
          Promise.reject(new CapabilityRegistryNotFoundError(parsedCapabilityId)),
        );
      }

      const decision = enforceExecutionRequirements(
        definition.manifest,
        context,
        policy.evaluate(definition.manifest, context),
      );
      const timeoutMs = Math.min(definition.manifest.limits.timeoutMs, globalMaxTimeoutMs);
      const maxOutputBytes = Math.min(
        definition.manifest.limits.maxOutputBytes,
        globalMaxOutputBytes,
      );
      let outputBytes = 0;

      return tracer.run(
        createCapabilitySpan(
          definition.manifest,
          input,
          context,
          decision,
          timeoutMs,
          maxOutputBytes,
          () => outputBytes,
        ),
        async () => {
          if (!decision.allowed) {
            throw new CapabilityPolicyDeniedError(parsedCapabilityId, decision.reason);
          }

          const parsedInput = definition.inputSchema.parse(input);
          const rawOutput = await invokeWithBounds(definition, parsedInput, context, timeoutMs);
          const parsedOutput = definition.outputSchema.parse(rawOutput);
          outputBytes = measureJsonBytes(parsedCapabilityId, parsedOutput);
          if (outputBytes > maxOutputBytes) {
            throw new CapabilityOutputLimitError(parsedCapabilityId, outputBytes, maxOutputBytes);
          }
          return parsedOutput;
        },
      );
    },

    list() {
      return Array.from(definitions.values(), (definition) => definition.manifest).sort((a, b) =>
        a.id.localeCompare(b.id),
      );
    },

    register(definition) {
      const manifest = parseCapabilityManifest(definition.manifest);
      if (definitions.has(manifest.id)) {
        throw new CapabilityRegistryDuplicateIdError(manifest.id);
      }
      if (manifest.source !== definition.adapter.source) {
        throw new CapabilityAdapterSourceMismatchError(
          manifest.id,
          manifest.source,
          definition.adapter.source,
        );
      }

      definitions.set(manifest.id, {
        adapter: definition.adapter,
        inputSchema: definition.inputSchema,
        manifest,
        outputSchema: definition.outputSchema,
      });
    },
  };
}

function enforceExecutionRequirements(
  manifest: CapabilityManifest,
  context: CapabilityInvocationContext,
  policyDecision: CapabilityPolicyDecision,
): CapabilityPolicyDecision {
  if (!policyDecision.allowed) {
    return policyDecision;
  }
  if (manifest.requiresConfirmation && context.userConfirmed !== true) {
    return { allowed: false, reason: 'confirmation_required' };
  }
  if (manifest.idempotency === 'required' && context.idempotencyKey === undefined) {
    return { allowed: false, reason: 'idempotency_key_required' };
  }
  return policyDecision;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  upperBound: number,
  name: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > upperBound) {
    throw new RangeError(`${name} must be an integer between 1 and ${upperBound}.`);
  }
  return normalized;
}

async function invokeWithBounds(
  definition: RegisteredCapabilityDefinition,
  input: unknown,
  context: CapabilityInvocationContext,
  timeoutMs: number,
): Promise<unknown> {
  if (context.signal?.aborted === true) {
    throw new CapabilityInvocationAbortedError(definition.manifest.id);
  }

  const controller = new AbortController();
  let abortKind: 'external' | 'timeout' | undefined;
  let rejectCancellation: ((error: Error) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onInternalAbort = () => {
    rejectCancellation?.(
      abortKind === 'timeout'
        ? new CapabilityInvocationTimeoutError(definition.manifest.id, timeoutMs)
        : new CapabilityInvocationAbortedError(definition.manifest.id),
    );
  };
  controller.signal.addEventListener('abort', onInternalAbort, { once: true });

  const onExternalAbort = () => {
    abortKind = 'external';
    controller.abort();
  };
  context.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const timeout = setTimeout(() => {
    abortKind = 'timeout';
    controller.abort();
  }, timeoutMs);

  const request: CapabilityAdapterRequest = {
    capabilityId: definition.manifest.id,
    context: createExecutionContext(context, controller.signal),
    input,
    version: definition.manifest.version,
  };
  const operation = Promise.resolve().then(() => definition.adapter.invoke(request));

  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', onInternalAbort);
    context.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function createExecutionContext(
  context: CapabilityInvocationContext,
  signal: AbortSignal,
): CapabilityExecutionContext {
  return {
    channel: context.channel,
    ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
    principal: context.principal,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    signal,
    ...(context.userConfirmed === undefined ? {} : { userConfirmed: context.userConfirmed }),
  };
}

function measureJsonBytes(capabilityId: string, value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new CapabilityOutputSerializationError(capabilityId);
    }
    return Buffer.byteLength(serialized, 'utf8');
  } catch (error) {
    if (error instanceof CapabilityOutputSerializationError) {
      throw error;
    }
    throw new CapabilityOutputSerializationError(capabilityId);
  }
}

function createCapabilitySpan(
  manifest: CapabilityManifest,
  input: unknown,
  context: CapabilityInvocationContext,
  decision: CapabilityPolicyDecision,
  timeoutMs: number,
  maxOutputBytes: number,
  outputBytes: () => number,
) {
  return {
    inputs: summarizeInputShape(input),
    metadata: {
      capabilityId: manifest.id,
      channel: context.channel,
      dataScopeCount: manifest.dataScopes.length,
      idempotencyKeyPresent: context.idempotencyKey !== undefined,
      maxOutputBytes,
      policyDecision: decision.allowed ? 'allowed' : 'denied',
      policyReason: decision.reason,
      principal: context.principal,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      risk: manifest.risk,
      sideEffect: manifest.sideEffect,
      source: manifest.source,
      timeoutMs,
      userConfirmed: context.userConfirmed === true,
      version: manifest.version,
    },
    name: 'agent.capability',
    output: (value: unknown) => ({
      outputBytes: outputBytes(),
      ...summarizeOutputShape(value),
    }),
    runType: 'tool' as const,
  };
}

function createMissingCapabilitySpan(
  capabilityId: string,
  input: unknown,
  context: CapabilityInvocationContext,
) {
  return {
    inputs: summarizeInputShape(input),
    metadata: {
      capabilityId,
      channel: context.channel,
      policyDecision: 'denied',
      policyReason: 'not_registered',
      principal: context.principal,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    },
    name: 'agent.capability',
    runType: 'tool' as const,
  };
}

function summarizeInputShape(value: unknown): Record<string, unknown> {
  return {
    ...(isRecord(value) ? { inputFieldCount: Object.keys(value).length } : {}),
    ...(Array.isArray(value) ? { inputItemCount: value.length } : {}),
    inputType: outputType(value),
  };
}

function summarizeOutputShape(value: unknown): Record<string, unknown> {
  return {
    ...(isRecord(value) ? { outputFieldCount: Object.keys(value).length } : {}),
    ...(Array.isArray(value) ? { outputItemCount: value.length } : {}),
    outputType: outputType(value),
  };
}

function outputType(value: unknown): string {
  return Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
