import { describe, expect, it } from 'vitest';

import {
  composeQualityTracers,
  createInMemoryQualityTracer,
  noopQualityTracer,
} from './quality-trace.js';

describe('noopQualityTracer', () => {
  it('preserves values, events, and errors without evaluating summaries', async () => {
    let summaries = 0;
    await expect(
      noopQualityTracer.run(
        {
          name: 'test.run',
          output: () => {
            summaries += 1;
            return {};
          },
          runType: 'chain',
        },
        () => Promise.resolve('value'),
      ),
    ).resolves.toBe('value');

    const events: string[] = [];
    for await (const event of noopQualityTracer.stream(
      {
        event: () => {
          summaries += 1;
          return {};
        },
        name: 'test.stream',
        runType: 'chain',
      },
      async function* () {
        yield 'a';
        yield 'b';
      },
    )) {
      events.push(event);
    }

    await expect(
      noopQualityTracer.run({ name: 'test.error', runType: 'chain' }, () =>
        Promise.reject(new TypeError('boom')),
      ),
    ).rejects.toThrow('boom');
    expect(events).toEqual(['a', 'b']);
    expect(summaries).toBe(0);
  });
});

describe('createInMemoryQualityTracer', () => {
  it('records concurrent nested spans with independent parent trees and sanitized data', async () => {
    let now = 100;
    const { records, tracer } = createInMemoryQualityTracer({ now: () => now++ });

    await Promise.all(
      ['request-a', 'request-b'].map((requestId) =>
        tracer.run(
          {
            inputs: {
              apiKey: 'secret-key',
              email: 'alice@example.com',
              requestId,
            },
            name: 'chat.request',
            output: (value) => ({ result: value }),
            runType: 'chain',
          },
          () =>
            tracer.run(
              { metadata: { requestId }, name: 'llm.planner', runType: 'llm' },
              () => Promise.resolve(requestId),
            ),
        ),
      ),
    );

    const roots = records.filter((record) => record.name === 'chat.request');
    const children = records.filter((record) => record.name === 'llm.planner');
    expect(roots).toHaveLength(2);
    expect(children).toHaveLength(2);
    for (const child of children) {
      const parent = roots.find(
        (root) => root.inputs?.requestId === child.metadata?.requestId,
      );
      expect(child.parentId).toBe(parent?.id);
    }
    expect(JSON.stringify(records)).not.toContain('secret-key');
    expect(JSON.stringify(records)).not.toContain('alice@example.com');
    expect(records.every((record) => record.status === 'success')).toBe(true);
    expect(records.every((record) => record.durationMs >= 0)).toBe(true);
  });

  it('records errors without stacks and marks early stream return as cancelled', async () => {
    const { records, tracer } = createInMemoryQualityTracer();

    await expect(
      tracer.run({ name: 'failed', runType: 'tool' }, () =>
        Promise.reject(new RangeError('sensitive failure detail')),
      ),
    ).rejects.toThrow('sensitive failure detail');

    const rawDeltas: string[] = [];
    for await (const event of tracer.stream(
      {
        event: (value: { delta: string; type: string }) => {
          rawDeltas.push(value.delta);
          return { type: value.type };
        },
        name: 'streamed',
        output: (events) => ({ eventCount: events.length, events }),
        runType: 'chain',
      },
      async function* () {
        yield { delta: 'raw-secret-delta', type: 'answer_delta' };
        yield { delta: 'another-delta', type: 'answer_delta' };
      },
    )) {
      expect(event.type).toBe('answer_delta');
      break;
    }

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ errorName: 'RangeError', name: 'failed', status: 'error' }),
        expect.objectContaining({
          name: 'streamed',
          outputs: { eventCount: 1, events: [{ type: 'answer_delta' }] },
          status: 'cancelled',
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain('sensitive failure detail');
    expect(JSON.stringify(records)).not.toContain('raw-secret-delta');
    expect(rawDeltas).toEqual(['raw-secret-delta']);
  });

  it('records failed streams', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const consume = async () => {
      for await (const _event of tracer.stream(
        { name: 'failed.stream', runType: 'chain' },
        async function* () {
          yield 'first';
          throw new SyntaxError('bad stream');
        },
      )) {
        // consume
      }
    };

    await expect(consume()).rejects.toThrow('bad stream');
    expect(records).toContainEqual(
      expect.objectContaining({ errorName: 'SyntaxError', status: 'error' }),
    );
  });
});

describe('composeQualityTracers', () => {
  it('records the same nested spans without executing work twice', async () => {
    const first = createInMemoryQualityTracer();
    const second = createInMemoryQualityTracer();
    const tracer = composeQualityTracers([first.tracer, second.tracer]);
    let executions = 0;

    const result = await tracer.run({ name: 'outer', runType: 'chain' }, () =>
      tracer.run({ name: 'inner', runType: 'tool' }, () => {
        executions += 1;
        return Promise.resolve('ok');
      }),
    );

    expect(result).toBe('ok');
    expect(executions).toBe(1);
    expect(first.records.map((record) => record.name)).toEqual(['outer', 'inner']);
    expect(second.records.map((record) => record.name)).toEqual(['outer', 'inner']);
    expect(first.records[1]?.parentId).toBe(first.records[0]?.id);
    expect(second.records[1]?.parentId).toBe(second.records[0]?.id);
  });
});
