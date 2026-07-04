import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import { LlmConfigurationError } from '@xxyy/rag-core';

import { createLangGraphCustomerRuntime } from './langgraph-customer-runtime.js';
import {
  PlannerModelParseError,
  PlannerModelRequestError,
  createScriptedPlannerModel,
} from './planner-model.js';
import { createToolRegistry } from './tool-registry.js';

const toolPolicy = {
  requiresOpsAuth: false,
};

describe('createLangGraphCustomerRuntime', () => {
  it('answers product questions through the planner-selected product tool', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY Pro 提供更高监控上限。',
      citations: [
        {
          excerpt: 'XXYY Pro 提供更高监控上限。',
          file: 'docs/product-features/pro.md',
          title: 'XXYY Pro',
        },
      ],
      confidence: 0.82,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute,
    });

    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    });

    await expect(
      runtime.ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 'session-1',
        userId: 'user-1',
      }),
    ).resolves.toEqual({
      ...response,
      agentRoute: 'product_answer',
    });
    expect(execute).toHaveBeenCalledWith(
      { question: 'XXYY Pro 有哪些权益？' },
      { channel: 'web', sessionId: 'session-1', userIdPresent: true },
    );
  });

  it('uses the original user message for planner-selected product question tools', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY 支持跟单功能。',
      citations: [],
      confidence: 0.82,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute,
    });

    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'Does XXYY support generic Copy Trading?' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    });

    await expect(
      runtime.ask({
        channel: 'telegram',
        message: 'xxyy支持跟单么',
      }),
    ).resolves.toEqual({
      ...response,
      agentRoute: 'product_answer',
    });
    expect(execute).toHaveBeenCalledWith(
      { question: 'xxyy支持跟单么' },
      { channel: 'telegram', sessionId: undefined, userIdPresent: false },
    );
  });

  it('returns boundary answers before planner execution for obvious private lookup requests', async () => {
    const registry = createToolRegistry();
    const planner = {
      plan: vi.fn(() => Promise.reject(new LlmConfigurationError('planner unavailable'))),
    };

    const response = await createLangGraphCustomerRuntime({
      planner,
      registry,
    }).ask({
      channel: 'web',
      message: '帮我查一下我的钱包余额',
    });

    expect(response).toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'realtime_account_query',
    });
    expect(response.answer).toContain('我不能直接查询你的钱包余额');
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('does not block product capability questions that mention wallet balances', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY 产品界面提供钱包相关入口说明。',
      citations: [],
      confidence: 0.82,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute,
    });

    await expect(
      createLangGraphCustomerRuntime({
        planner: createScriptedPlannerModel([
          {
            input: { question: 'XXYY 支持查看钱包余额吗？' },
            kind: 'tool',
            reason: 'Use product docs.',
            route: 'product_answer',
            toolName: 'answer_product_question',
          },
        ]),
        registry,
      }).ask({
        channel: 'web',
        message: 'XXYY 支持查看钱包余额吗？',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'product_answer',
      intent: 'product_qa',
    });
    expect(execute).toHaveBeenCalled();
  });

  it('pre-blocks realtime account requests instead of asking the planner', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool should not be called');
    });
    const planner = {
      plan: vi.fn(() =>
        Promise.resolve({
          kind: 'final' as const,
          reason: 'The agent cannot access private wallet balances.',
          response: {
            answer: '我无法直接查询你的私有钱包余额，但可以说明 XXYY 支持哪些公开功能。',
            citations: [],
            confidence: 0.72,
            intent: 'realtime_account_query' as const,
          },
          route: 'boundary' as const,
        }),
      ),
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute,
    });

    const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
      channel: 'cli',
      message: '帮我查一下钱包余额',
    });

    expect(response).toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'realtime_account_query',
    });
    expect(response.answer).toContain('我不能直接查询你的钱包余额');
    expect(planner.plan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['unsafe attack request', 'How to hack XXYY account?', '不能帮助攻击'],
    ['business action request', '帮我取消订单并退款', '不能代你开通、取消、修改'],
    ['private credential request', '我的私钥是 test-secret-key', '发送私钥'],
  ])('pre-blocks %s instead of asking the planner', async (_name, message, expectedText) => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool should not be called');
    });
    const planner = {
      plan: vi.fn(() =>
        Promise.resolve({
          kind: 'final' as const,
          reason: 'The planner chose a final support boundary response.',
          response: {
            answer: expectedText,
            citations: [],
            confidence: 0.64,
            intent: 'unknown' as const,
          },
          route: 'boundary' as const,
        }),
      ),
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute,
    });

    const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
      channel: 'web',
      message,
    });

    expect(response).toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'unknown',
    });
    expect(response.answer).toContain(expectedText);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns clarification when the planner requests an unauthorized tool', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool should not be called');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: {},
          kind: 'tool',
          reason: 'Invalid tool request.',
          route: 'product_answer',
          toolName: 'delete_user_account' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns clarification when an allowed planner tool is not registered', async () => {
    const registry = createToolRegistry();

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product knowledge.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'unknown',
    });
  });

  it.each([
    ['parse', new PlannerModelParseError('invalid planner json')],
    ['request', new PlannerModelRequestError('planner request failed')],
  ])(
    'returns clarification when planner has an expected %s failure twice',
    async (_name, error) => {
      const registry = createToolRegistry();
      const planner = {
        plan: vi.fn(() => Promise.reject(error)),
      };

      const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      });

      expect(response).toMatchObject({
        agentRoute: 'clarify',
        citations: [],
        intent: 'unknown',
      });
      expect(planner.plan).toHaveBeenCalledTimes(2);
    },
  );

  it('retries planner parsing failure and uses the repaired product tool plan', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY 支持跟单相关产品能力说明。',
      citations: [],
      confidence: 0.81,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));
    const planner = {
      plan: vi
        .fn()
        .mockRejectedValueOnce(new PlannerModelParseError('invalid route'))
        .mockResolvedValueOnce({
          input: { question: 'XXYY支持跟单么' },
          kind: 'tool' as const,
          reason: 'Use product docs after retry.',
          route: 'product_answer' as const,
          toolName: 'answer_product_question' as const,
        }),
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute,
    });

    await expect(
      createLangGraphCustomerRuntime({ planner, registry }).ask({
        channel: 'cli',
        message: 'XXYY支持跟单么',
      }),
    ).resolves.toEqual({
      ...response,
      agentRoute: 'product_answer',
    });
    expect(planner.plan).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      { question: 'XXYY支持跟单么' },
      { channel: 'cli', sessionId: undefined, userIdPresent: false },
    );
  });

  it('returns clarification when a tool throws', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool failed');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'unknown',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('derives the final route from the executed product tool when planner route mismatches', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY Pro 提供更高监控上限。',
      citations: [],
      confidence: 0.82,
      intent: 'product_qa',
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute: () => Promise.resolve(response),
    });

    await expect(
      createLangGraphCustomerRuntime({
        planner: createScriptedPlannerModel([
          {
            input: { question: 'XXYY Pro 有哪些权益？' },
            kind: 'tool',
            reason: 'Mismatched route.',
            route: 'unsupported',
            toolName: 'answer_product_question',
          },
        ]),
        registry,
      }).ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'product_answer',
      intent: 'product_qa',
    });
  });

  it.each(['product_answer'] as const)(
    'normalizes unsafe final %s planner routes without tool evidence',
    async (route) => {
      const registry = createToolRegistry();
      const planner = {
        plan: vi.fn(() =>
          Promise.resolve({
            kind: 'final',
            reason: 'malicious planner route',
            response: {
              answer: 'I claim a tool-backed route without evidence.',
              citations: [],
              confidence: 0.99,
              intent: 'product_qa',
            },
            route,
          } as never),
        ),
      };

      const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      });

      expect(response).toMatchObject({
        agentRoute: 'clarify',
        citations: [],
        intent: 'unknown',
      });
      expect(response.answer).not.toContain('tool-backed route');
      expect(planner.plan).toHaveBeenCalledOnce();
    },
  );

  it('streams metadata from the composed response', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: '带附件回答',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/png',
          title: '截图',
          url: '/assets/screenshot.png',
        },
      ],
      citations: [],
      confidence: 0.82,
      intent: 'product_qa',
      tokenUsage: {
        completionTokens: 3,
        promptTokens: 7,
        totalTokens: 10,
      },
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute: () => Promise.resolve(response),
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    }).stream({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        delta: '带附件回答',
        type: 'answer_delta',
      },
      {
        agentRoute: 'product_answer',
        attachments: response.attachments,
        citations: [],
        confidence: 0.82,
        intent: 'product_qa',
        tokenUsage: response.tokenUsage,
        type: 'metadata',
      },
    ]);
  });

  it('streams planner-selected product tool events without using the non-streaming execute path', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('execute should not be used when the tool has a stream path');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute,
      async *stream() {
        await Promise.resolve();
        yield { type: 'answer_delta' as const, delta: 'streamed ' };
        yield {
          type: 'metadata' as const,
          citations: [],
          confidence: 0.84,
          intent: 'product_qa' as const,
        };
      },
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    }).stream({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'answer_delta', delta: 'streamed ' },
      {
        agentRoute: 'product_answer',
        citations: [],
        confidence: 0.84,
        intent: 'product_qa',
        type: 'metadata',
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns clarification at the step limit without executing tools', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool should not be called');
    });
    const planner = {
      plan: vi.fn(() => {
        throw new Error('planner should not be called');
      }),
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      maxSteps: 0,
      planner,
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
    });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
