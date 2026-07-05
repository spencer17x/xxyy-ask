import { describe, expect, it, vi } from 'vitest';

import {
  PlannerConfigurationError,
  PlannerModelParseError,
  PlannerModelRequestError,
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
        reason: 'needs clarification',
        response: {
          answer: '请补充更具体的问题。',
          citations: [],
          confidence: 0.45,
          intent: 'unknown',
        },
        route: 'clarify',
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
      route: 'clarify',
      response: {
        answer: '请补充更具体的问题。',
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

  it('requires an API key for OpenAI-compatible planning', () => {
    expect(() =>
      createOpenAiCompatiblePlannerModel({
        apiKey: '',
        baseUrl: 'https://example.test/v1',
        model: 'test-model',
      }),
    ).toThrow(PlannerConfigurationError);
  });

  it('requires a model for OpenAI-compatible planning', () => {
    expect(() =>
      createOpenAiCompatiblePlannerModel({
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        model: ' ',
      }),
    ).toThrow(PlannerConfigurationError);
  });

  it('throws a planner request error for non-OK model responses', async () => {
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl: () => Promise.resolve(new Response('rate limited', { status: 429 })),
      model: 'test-model',
    });

    await expect(
      planner.plan({
        request: { channel: 'web', message: 'hello' },
        stateSummary: 'no tools called',
        tools: [],
      }),
    ).rejects.toBeInstanceOf(PlannerModelRequestError);
  });

  it('wraps rejected fetches in planner request errors', async () => {
    const networkError = new TypeError('fetch failed');
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl: () => Promise.reject(networkError),
      model: 'test-model',
    });

    try {
      await planner.plan({
        request: { channel: 'web', message: 'hello' },
        stateSummary: 'no tools called',
        tools: [],
      });
      throw new Error('Expected planner request to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerModelRequestError);
      expect((error as Error & { cause?: unknown }).cause).toBe(networkError);
    }
  });

  it('wraps timeout aborts in planner request errors', async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      const planner = createOpenAiCompatiblePlannerModel({
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        fetchImpl: (_input, init) => {
          capturedSignal = init?.signal as AbortSignal;
          return new Promise<Response>((_resolve, reject) => {
            capturedSignal?.addEventListener('abort', () => reject(abortError), { once: true });
          });
        },
        model: 'test-model',
        requestTimeoutMs: 10,
      });

      const planPromise = planner.plan({
        request: { channel: 'web', message: 'hello' },
        stateSummary: 'no tools called',
        tools: [],
      });
      const rejection = planPromise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);

      expect(capturedSignal?.aborted).toBe(true);
      const error = await rejection;
      expect(error).toBeInstanceOf(PlannerModelRequestError);
      expect((error as Error & { cause?: unknown }).cause).toBe(abortError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses fenced JSON planner responses', async () => {
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: [
                      '```json',
                      JSON.stringify({
                        input: { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
                        kind: 'tool',
                        reason: 'product question',
                        route: 'product_answer',
                        toolName: 'answer_product_question',
                      }),
                      '```',
                    ].join('\n'),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      model: 'test-model',
    });

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
  });

  it('sends the required OpenAI-compatible request body', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1/',
      fetchImpl: (_input, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected JSON request body.');
        }
        requestBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
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
        );
      },
      model: 'test-model',
    });

    await planner.plan({
      request: { channel: 'web', message: 'XXYY Pro 有哪些权益？' },
      stateSummary: 'no tools called',
      tools: [],
    });

    expect(Array.isArray(requestBody?.messages)).toBe(true);
    expect(requestBody).toMatchObject({
      model: 'test-model',
      response_format: { type: 'json_object' },
      temperature: 0,
    });
  });

  it('sends XXYY support context to the planner for autonomous boundary decisions', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1/',
      fetchImpl: (_input, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected JSON request body.');
        }
        requestBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      kind: 'final',
                      reason: 'account data is outside XXYY public support scope',
                      response: {
                        answer: '我无法查询私有账户数据。',
                        citations: [],
                        confidence: 0.65,
                        intent: 'realtime_account_query',
                      },
                      route: 'boundary',
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      },
      model: 'test-model',
    });

    await planner.plan({
      request: { channel: 'web', message: '帮我查一下钱包余额' },
      stateSummary: 'no tools called',
      tools: [],
    });

    const messages = requestBody?.messages;
    expect(Array.isArray(messages)).toBe(true);
    const [systemMessage] = messages as Array<{ content?: unknown; role?: unknown }>;
    expect(systemMessage).toMatchObject({ role: 'system' });
    expect(systemMessage?.content).toEqual(expect.stringContaining('XXYY support context'));
    expect(systemMessage?.content).toEqual(expect.stringContaining('private account'));
    expect(systemMessage?.content).toEqual(expect.stringContaining('return a final response'));
    expect(systemMessage?.content).toEqual(expect.stringContaining('Query rewrite policy'));
    expect(systemMessage?.content).toEqual(expect.stringContaining('Do not repeat the same tool'));
    expect(systemMessage?.content).toEqual(expect.stringContaining('search_product_docs'));
  });

  it('redacts sensitive request text and sends presence flags instead of private ids', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1/',
      fetchImpl: (_input, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected JSON request body.');
        }
        requestBody = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      input: { question: 'XXYY Pro 有哪些权益？' },
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
        );
      },
      model: 'test-model',
    });

    await planner.plan({
      request: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？ 我的密码是 hunter2 api key: sk-test-123',
        requestId: 'req-sensitive-1',
        sessionId: 'session-secret',
        userId: 'user-secret',
      },
      stateSummary: 'no tools called',
      tools: [],
    });

    const serialized = JSON.stringify(requestBody);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('sk-test-123');
    expect(serialized).not.toContain('session-secret');
    expect(serialized).not.toContain('user-secret');

    const messages = requestBody?.messages as Array<{ content?: string }>;
    const userContent = messages[1]?.content;
    if (userContent === undefined) {
      throw new Error('Expected planner user content.');
    }
    expect(JSON.parse(userContent)).toMatchObject({
      request: {
        channel: 'web',
        message:
          'XXYY Pro 有哪些权益？ 我的密码是 [sensitive_credential] api key: [sensitive_credential]',
        requestId: 'req-sensitive-1',
        sessionIdPresent: true,
        userIdPresent: true,
      },
    });
  });

  it('rejects unauthorized tool names from model output', async () => {
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      input: {},
                      kind: 'tool',
                      reason: 'ops report request',
                      route: 'product_answer',
                      toolName: 'list_analysis_reports',
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      model: 'test-model',
    });

    await expect(
      planner.plan({
        request: { channel: 'web', message: '列出分析报告' },
        stateSummary: 'no tools called',
        tools: [],
      }),
    ).rejects.toBeInstanceOf(PlannerModelParseError);
  });

  it('rejects agentRoute in final model responses', async () => {
    const planner = createOpenAiCompatiblePlannerModel({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      kind: 'final',
                      reason: 'unsupported preference capture',
                      response: {
                        agentRoute: 'ops_report',
                        answer: '我不能记录这个偏好。',
                        citations: [],
                        confidence: 0.4,
                        intent: 'unknown',
                      },
                      route: 'clarify',
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      model: 'test-model',
    });

    await expect(
      planner.plan({
        request: { channel: 'web', message: '记住我的偏好' },
        stateSummary: 'no tools called',
        tools: [],
      }),
    ).rejects.toBeInstanceOf(PlannerModelParseError);
  });

  it.each(['product_answer'] as const)(
    'rejects %s final routes from model output',
    async (route) => {
      const planner = createOpenAiCompatiblePlannerModel({
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
        fetchImpl: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        kind: 'final',
                        reason: 'model tried to claim a tool route',
                        response: {
                          answer: 'final response without tool evidence',
                          citations: [],
                          confidence: 0.4,
                          intent: 'unknown',
                        },
                        route,
                      }),
                    },
                  },
                ],
              }),
              { status: 200 },
            ),
          ),
        model: 'test-model',
      });

      await expect(
        planner.plan({
          request: { channel: 'web', message: 'XXYY Pro 有哪些权益？' },
          stateSummary: 'no tools called',
          tools: [],
        }),
      ).rejects.toBeInstanceOf(PlannerModelParseError);
    },
  );
});
