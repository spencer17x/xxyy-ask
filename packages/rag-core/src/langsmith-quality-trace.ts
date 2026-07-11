import { Client, type ClientConfig } from 'langsmith/client';
import { traceable } from 'langsmith/traceable';

import {
  noopQualityTracer,
  sanitizeQualityRecord,
  type QualitySpanInput,
  type QualityStreamSpanInput,
  type QualityTracer,
} from './quality-trace.js';

export type QualityTraceEnv = Record<string, string | undefined>;

interface TraceableAdapterConfig {
  aggregator?(items: unknown[]): unknown;
  client?: unknown;
  metadata?: Record<string, unknown>;
  name?: string;
  processInputs?(inputs: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>;
  processOutputs?(outputs: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>;
  project_name?: string;
  run_type?: string;
  tracingEnabled?: boolean;
}

type TraceableAdapter = <TArgs extends unknown[], TResult>(
  task: (...args: TArgs) => TResult,
  config: TraceableAdapterConfig,
) => (...args: TArgs) => TResult;

export interface LangSmithQualityTracerDependencies {
  createClient(config: ClientConfig): unknown;
  wrapTraceable: TraceableAdapter;
}

interface PrivateRunResult<T> {
  privateValue: T;
  summary: Record<string, unknown>;
}

interface PrivateStreamEvent<T> {
  eventSummary?: Record<string, unknown>;
  privateValue: T;
}

const DEFAULT_PROJECT = 'xxyy-ask';

export class QualityTracingConfigurationError extends Error {}

const defaultDependencies: LangSmithQualityTracerDependencies = {
  createClient: (config) => new Client(config),
  wrapTraceable: traceable as unknown as TraceableAdapter,
};

export function createQualityTracerFromEnv(
  env: QualityTraceEnv,
  dependencyOverrides: Partial<LangSmithQualityTracerDependencies> = {},
): QualityTracer {
  if (!isTracingEnabled(env.LANGSMITH_TRACING)) {
    return noopQualityTracer;
  }

  const apiKey = env.LANGSMITH_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new QualityTracingConfigurationError(
      'LANGSMITH_API_KEY is required when LANGSMITH_TRACING=true.',
    );
  }
  const sampleRate = parseSampleRate(env.QUALITY_TRACE_SAMPLE_RATE);
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const apiUrl = nonEmpty(env.LANGSMITH_ENDPOINT);
  const privacyTransform = (value: Record<string, unknown>): Record<string, unknown> =>
    sanitizeQualityRecord(value);
  const clientConfig: ClientConfig = {
    apiKey,
    anonymizer: privacyTransform,
    hideInputs: privacyTransform,
    hideOutputs: privacyTransform,
    omitTracedRuntimeInfo: true,
    tracingSamplingRate: sampleRate,
    ...(apiUrl === undefined ? {} : { apiUrl }),
  };
  const client = dependencies.createClient(clientConfig);
  const projectName = nonEmpty(env.LANGSMITH_PROJECT) ?? DEFAULT_PROJECT;
  const appRevision = nonEmpty(env.APP_REVISION);

  return {
    async run<T>(span: QualitySpanInput<T>, task: () => Promise<T>): Promise<T> {
      const execute = dependencies.wrapTraceable(async (): Promise<PrivateRunResult<T>> => {
        const privateValue = await task();
        return {
          privateValue,
          summary: safeOutput(span.output, privateValue),
        };
      }, createTraceableConfig(span, client, projectName, appRevision, {
        processOutputs(outputs) {
          return sanitizeQualityRecord(readRunSummary(outputs));
        },
      }));
      const result = await execute();
      return result.privateValue;
    },

    stream<T>(
      span: QualityStreamSpanInput<T>,
      task: () => AsyncIterable<T>,
    ): AsyncIterable<T> {
      const execute = dependencies.wrapTraceable(async function* (): AsyncIterable<
        PrivateStreamEvent<T>
      > {
        for await (const privateValue of task()) {
          const eventSummary = safeEvent(span.event, privateValue);
          yield {
            ...(eventSummary === undefined ? {} : { eventSummary }),
            privateValue,
          };
        }
      }, createTraceableConfig(span, client, projectName, appRevision, {
        aggregator(items) {
          const summaries = items.flatMap((item) => {
            const summary = readEventSummary(item);
            return summary === undefined ? [] : [summary];
          });
          return span.output === undefined
            ? { eventCount: summaries.length, summaries }
            : safeOutput(span.output, summaries);
        },
        processOutputs(outputs) {
          return sanitizeQualityRecord(outputs);
        },
      }));

      return unwrapStream(execute());
    },
  };
}

function createTraceableConfig(
  span: Pick<QualitySpanInput<unknown>, 'inputs' | 'metadata' | 'name' | 'runType'>,
  client: unknown,
  projectName: string,
  appRevision: string | undefined,
  extra: Pick<TraceableAdapterConfig, 'aggregator' | 'processOutputs'>,
): TraceableAdapterConfig {
  return {
    client,
    metadata: sanitizeQualityRecord({
      ...(appRevision === undefined ? {} : { appRevision }),
      ...(span.metadata ?? {}),
    }),
    name: span.name,
    processInputs: () => sanitizeQualityRecord(span.inputs ?? {}),
    project_name: projectName,
    run_type: span.runType,
    tracingEnabled: true,
    ...extra,
  };
}

async function* unwrapStream<T>(
  iterable: AsyncIterable<PrivateStreamEvent<T>>,
): AsyncIterable<T> {
  for await (const event of iterable) {
    yield event.privateValue;
  }
}

function safeOutput<T>(
  summarize: ((value: T) => Record<string, unknown>) | undefined,
  value: T,
): Record<string, unknown> {
  if (summarize === undefined) {
    return {};
  }
  try {
    return sanitizeQualityRecord(summarize(value));
  } catch (error) {
    return { summaryError: error instanceof Error ? error.name : 'UnknownError' };
  }
}

function safeEvent<T>(
  summarize: ((value: T) => Record<string, unknown> | undefined) | undefined,
  value: T,
): Record<string, unknown> | undefined {
  if (summarize === undefined) {
    return undefined;
  }
  try {
    const summary = summarize(value);
    return summary === undefined ? undefined : sanitizeQualityRecord(summary);
  } catch (error) {
    return { summaryError: error instanceof Error ? error.name : 'UnknownError' };
  }
}

function readRunSummary(outputs: Record<string, unknown>): Record<string, unknown> {
  const summary = outputs.summary;
  return isRecord(summary) ? summary : {};
}

function readEventSummary(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.eventSummary)) {
    return undefined;
  }
  return value.eventSummary;
}

function isTracingEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function parseSampleRate(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new QualityTracingConfigurationError(
      'QUALITY_TRACE_SAMPLE_RATE must be between 0 and 1.',
    );
  }
  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
