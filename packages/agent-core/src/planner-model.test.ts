import { describe, expect, it, vi } from 'vitest';

import {
  PlannerModelParseError,
  createOpenAiCompatiblePlannerModel,
  createScriptedPlannerModel,
} from './planner-model.js';

describe('planner model', () => {
  it('returns scripted plans in order for deterministic graph tests', async () => {
    const planner = createScriptedPlannerModel([
      {
        input: { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
        kind: 'tool',
        reason: 'product question',
        route: 'product_answer',
        toolName: 'answer_product_question',
      },
      {
        kind: 'final',
        reason: 'tool returned an answer',
        response: {
          answer: 'XXYY Pro 提供更多产品权益。',
          citations: [],
          confidence: 0.7,
          intent: 'product_qa',
        },
        route: 'product_answer',
      },
    ]);

    await expect(
      planner.plan({
        request: { channel: 'web', message: 'XXYY Pro 有哪些权益？' },
        stateSummary: 'no tools called',
        tools: [],
      }),
    ).resolves.toMatchObject({
      kind: 'tool',
      route: 'product_answer',
      toolName: 'answer_product_question',
    });

    await expect(
      planner.plan({
        request: { channel: 'web', message: 'XXYY Pro 有哪些权益？' },
        stateSummary: 'product tool returned answer',
        tools: [],
      }),
    ).resolves.toMatchObject({
      kind: 'final',
      route: 'product_answer',
      response: {
        answer: 'XXYY Pro 提供更多产品权益。',
      },
    });
  });

  it('parses OpenAI-compatible JSON planner responses', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    input: { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
                    kind: 'tool',
                    reason: 'product question',
                    route: 'product_answer',
                    toolName: 'answer_product_question',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl,
      model: 'test-model',
    });

    await expect(
      planner.plan({
        request: { channel: 'web', message: 'XXYY Pro 有哪些权益？' },
        stateSummary: 'no tools called',
        tools: [
          {
            description: 'Answer product questions.',
            name: 'answer_product_question',
          },
        ],
      }),
    ).resolves.toMatchObject({
      kind: 'tool',
      route: 'product_answer',
      toolName: 'answer_product_question',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('throws a planner parse error for unusable model output', async () => {
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
            status: 200,
          }),
        ),
      model: 'test-model',
    });

    await expect(
      planner.plan({
        request: { channel: 'web', message: 'hello' },
        stateSummary: 'no tools called',
        tools: [],
      }),
    ).rejects.toBeInstanceOf(PlannerModelParseError);
  });
});
