import { describe, expect, it } from 'vitest';

import type { ClientConfig } from 'langsmith/client';

import {
  createQualityTracerFromEnv,
  QualityTracingConfigurationError,
  type LangSmithQualityTracerDependencies,
} from './langsmith-quality-trace.js';
import { noopQualityTracer } from './quality-trace.js';

describe('createQualityTracerFromEnv', () => {
  it('returns the exact no-op tracer when tracing is absent or false', () => {
    let clients = 0;
    const dependencies = {
      createClient: () => {
        clients += 1;
        return {};
      },
    } satisfies Partial<LangSmithQualityTracerDependencies>;

    expect(createQualityTracerFromEnv({}, dependencies)).toBe(noopQualityTracer);
    expect(createQualityTracerFromEnv({ LANGSMITH_TRACING: 'false' }, dependencies)).toBe(
      noopQualityTracer,
    );
    expect(clients).toBe(0);
  });

  it('validates required secrets and sample rate without echoing values', () => {
    expect(() => createQualityTracerFromEnv({ LANGSMITH_TRACING: 'true' })).toThrow(
      QualityTracingConfigurationError,
    );
    expect(() =>
      createQualityTracerFromEnv({
        LANGSMITH_API_KEY: 'lsv2_secret-value',
        LANGSMITH_TRACING: 'true',
        QUALITY_TRACE_SAMPLE_RATE: '1.5',
      }),
    ).toThrow('QUALITY_TRACE_SAMPLE_RATE must be between 0 and 1');
    try {
      createQualityTracerFromEnv({
        LANGSMITH_API_KEY: 'lsv2_secret-value',
        LANGSMITH_TRACING: 'true',
        QUALITY_TRACE_SAMPLE_RATE: '-1',
      });
    } catch (error) {
      expect(String(error)).not.toContain('lsv2_secret-value');
    }
  });

  it('configures privacy transforms, project metadata, endpoint, and sampling', () => {
    const clientConfigs: ClientConfig[] = [];
    const harness = createTraceableHarness();
    createQualityTracerFromEnv(
      {
        APP_REVISION: 'sha-123',
        LANGSMITH_API_KEY: 'test-key',
        LANGSMITH_ENDPOINT: 'https://smith.example',
        LANGSMITH_PROJECT: 'quality-project',
        LANGSMITH_TRACING: 'true',
        QUALITY_TRACE_SAMPLE_RATE: '0.25',
      },
      {
        createClient(config) {
          clientConfigs.push(config);
          return {};
        },
        wrapTraceable: harness.wrapTraceable,
      },
    );

    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0]).toMatchObject({
      apiKey: 'test-key',
      apiUrl: 'https://smith.example',
      omitTracedRuntimeInfo: true,
      tracingSamplingRate: 0.25,
    });
    expect(clientConfigs[0]?.anonymizer).toBeTypeOf('function');
    expect(clientConfigs[0]?.hideInputs).toBeTypeOf('function');
    expect(clientConfigs[0]?.hideOutputs).toBeTypeOf('function');
  });

  it('traces only sanitized span summaries while preserving raw task values', async () => {
    const harness = createTraceableHarness();
    const tracer = createQualityTracerFromEnv(
      {
        APP_REVISION: 'sha-123',
        LANGSMITH_API_KEY: 'test-key',
        LANGSMITH_TRACING: 'true',
      },
      {
        createClient: () => ({}),
        wrapTraceable: harness.wrapTraceable,
      },
    );
    const rawValue = { answer: 'raw-answer-secret', route: 'product_answer' };

    await expect(
      tracer.run(
        {
          inputs: { email: 'alice@example.com', questionLength: 10 },
          metadata: { requestId: 'req-1' },
          name: 'chat.request',
          output: (value) => ({ route: value.route }),
          runType: 'chain',
        },
        () => Promise.resolve(rawValue),
      ),
    ).resolves.toBe(rawValue);

    expect(harness.configs[0]).toMatchObject({
      metadata: { appRevision: 'sha-123', requestId: 'req-1' },
      name: 'chat.request',
      project_name: 'xxyy-ask',
      run_type: 'chain',
      tracingEnabled: true,
    });
    expect(harness.inputs).toEqual([{ email: '[email]', questionLength: 10 }]);
    expect(harness.outputs).toEqual([{ route: 'product_answer' }]);
    expect(JSON.stringify(harness)).not.toContain('raw-answer-secret');
  });

  it('streams original events but aggregates only bounded event summaries', async () => {
    const harness = createTraceableHarness();
    const tracer = createQualityTracerFromEnv(
      { LANGSMITH_API_KEY: 'test-key', LANGSMITH_TRACING: 'true' },
      { createClient: () => ({}), wrapTraceable: harness.wrapTraceable },
    );
    const events: Array<{ delta: string; type: string }> = [];

    for await (const event of tracer.stream(
      {
        event: (value: { delta: string; type: string }) => ({ type: value.type }),
        name: 'chat.stream',
        output: (summaries) => ({ eventCount: summaries.length, summaries }),
        runType: 'chain',
      },
      async function* () {
        await Promise.resolve();
        yield { delta: 'first-secret-delta', type: 'answer_delta' };
        yield { delta: 'second-secret-delta', type: 'answer_delta' };
      },
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.delta)).toEqual([
      'first-secret-delta',
      'second-secret-delta',
    ]);
    expect(harness.outputs).toEqual([
      {
        eventCount: 2,
        summaries: [{ type: 'answer_delta' }, { type: 'answer_delta' }],
      },
    ]);
    expect(JSON.stringify(harness)).not.toContain('secret-delta');
  });
});

interface TraceableConfigHarness {
  aggregator?(items: unknown[]): unknown;
  metadata?: Record<string, unknown>;
  name?: string;
  processInputs?(
    inputs: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  processOutputs?(
    outputs: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  project_name?: string;
  run_type?: string;
  tracingEnabled?: boolean;
}

function createTraceableHarness() {
  const configs: TraceableConfigHarness[] = [];
  const inputs: Record<string, unknown>[] = [];
  const outputs: Record<string, unknown>[] = [];
  const wrapTraceable = <TArgs extends unknown[], TResult>(
    task: (...args: TArgs) => TResult,
    config: TraceableConfigHarness,
  ) => {
    configs.push(config);
    return (...args: TArgs): TResult => {
      const result = task(...args);
      if (isAsyncIterable(result)) {
        return (async function* () {
          inputs.push((await config.processInputs?.({})) ?? {});
          const items: unknown[] = [];
          for await (const item of result) {
            items.push(item);
            yield item;
          }
          const aggregate = config.aggregator?.(items) ?? { items };
          outputs.push(
            (await config.processOutputs?.(aggregate as Record<string, unknown>)) ??
              (aggregate as Record<string, unknown>),
          );
        })() as TResult;
      }
      return Promise.resolve(config.processInputs?.({}))
        .then((processedInputs) => {
          inputs.push(processedInputs ?? {});
          return result;
        })
        .then(async (value) => {
          const processed =
            (await config.processOutputs?.(value as Record<string, unknown>)) ??
            (value as Record<string, unknown>);
          outputs.push(processed);
          return value;
        }) as TResult;
    };
  };
  return { configs, inputs, outputs, wrapTraceable };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}
