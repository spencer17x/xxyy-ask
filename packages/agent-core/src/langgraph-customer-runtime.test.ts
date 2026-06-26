import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import type { AnalyzeTransactionOutput } from '@xxyy/rag-core';

import { createLangGraphCustomerRuntime } from './langgraph-customer-runtime.js';
import {
  PlannerModelParseError,
  PlannerModelRequestError,
  createScriptedPlannerModel,
} from './planner-model.js';
import { createToolRegistry } from './tool-registry.js';

const toolPolicy = {
  allowExternalMcp: true,
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

  it('converts successful transaction tool output into a transaction analysis answer', async () => {
    const registry = createToolRegistry();
    const txHash = `0x${'a'.repeat(64)}`;
    const output: AnalyzeTransactionOutput = {
      result: {
        analyzedAt: '2026-06-20T00:00:00.000Z',
        chain: 'base',
        confidence: 0.91,
        evidence: [
          {
            detail: '前后交易围绕目标交易。',
            label: 'sandwich pattern',
            severity: 'critical',
          },
        ],
        relatedTransactions: [],
        summary: '规则命中疑似夹子交易。',
        txHash,
        verdict: 'sandwiched',
      },
      status: 'success',
    };
    const execute = vi.fn(() => Promise.resolve(output));

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { txHash },
          kind: 'tool',
          reason: 'Analyze the public transaction.',
          route: 'transaction_analysis',
          toolName: 'analyze_transaction',
        },
      ]),
      registry,
    });

    const response = await runtime.ask({
      channel: 'web',
      message: `帮我看看 ${txHash} 是否被夹`,
    });

    expect(response).toMatchObject({
      agentRoute: 'transaction_analysis',
      citations: [],
      confidence: 0.91,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain(`交易哈希：${txHash}`);
    expect(response.answer).toContain('结论：疑似被夹');
    expect(execute).toHaveBeenCalledWith(
      { txHash },
      { channel: 'web', sessionId: undefined, userIdPresent: false },
    );
  });

  it('routes one clear transaction reference to the transaction tool without planner latency', async () => {
    const registry = createToolRegistry();
    const txHash = `0x${'c'.repeat(64)}`;
    const output: AnalyzeTransactionOutput = {
      result: {
        analyzedAt: '2026-06-24T00:00:00.000Z',
        chain: 'base',
        confidence: 0.86,
        evidence: [],
        relatedTransactions: [],
        summary: '未发现明确 sandwich 模式。',
        txHash,
        verdict: 'not_sandwiched',
      },
      status: 'success',
    };
    const execute = vi.fn(() => Promise.resolve(output));
    const planner = {
      plan: vi.fn(() => Promise.reject(new PlannerModelRequestError('planner should not run'))),
    };

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({
        chain: z.string().optional(),
        txHash: z.string(),
      }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
      channel: 'web',
      message: `帮我看 https://basescan.org/tx/${txHash} 是否被夹`,
      sessionId: 'session-1',
    });

    expect(response).toMatchObject({
      agentRoute: 'transaction_analysis',
      confidence: 0.86,
      intent: 'tx_sandwich_detection',
    });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      { chain: 'base', txHash },
      { channel: 'web', sessionId: 'session-1', userIdPresent: false },
    );
  });

  it('prefers deterministic transaction routing over malformed planner tool input', async () => {
    const registry = createToolRegistry();
    const txHash =
      'UUhMpRZtCVFENshTwTGy1FSJvodiJ2DxpXqQ9KMF3aQ8KEjfcJVKMLnURRmG6VEEhFKYMTuCiU7N4SohiTuRRUF';
    const message = `查询下这笔交易是否被夹：https://solscan.io/tx/${txHash}`;
    const output: AnalyzeTransactionOutput = {
      failure: {
        message: 'Browser verification required.',
        reason: 'browser_verification_required',
        reportUrl: '/assets/tx-analysis-failure-solana.json',
      },
      status: 'failure',
    };
    const execute = vi.fn(() => Promise.resolve(output));
    const planner = {
      plan: vi.fn(() =>
        Promise.resolve({
          input: { txHash: message },
          kind: 'tool' as const,
          reason: 'Planner kept the whole user message as txHash.',
          route: 'transaction_analysis' as const,
          toolName: 'analyze_transaction' as const,
        }),
      ),
    };

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({
        chain: z.string().optional(),
        txHash: z.string(),
      }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
      channel: 'web',
      message,
    });

    expect(response).toMatchObject({
      agentRoute: 'transaction_analysis',
      confidence: 0.35,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('浏览器安全验证');
    expect(response.answer).toContain('报告：/assets/tx-analysis-failure-solana.json');
    expect(planner.plan).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      { chain: 'solana', txHash },
      { channel: 'web', sessionId: undefined, userIdPresent: false },
    );
  });

  it('lets the planner decide realtime account requests instead of pre-blocking', async () => {
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
    expect(response.answer).toContain('无法直接查询你的私有钱包余额');
    expect(planner.plan).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['unsafe attack request', 'How to hack XXYY account?', '不能帮助攻击'],
    ['business action request', '帮我取消订单并退款', '不能代你开通、取消、修改'],
    ['private credential request', '我的私钥是 test-secret-key', '不要发送私钥'],
  ])('lets the planner decide %s instead of pre-blocking', async (_name, message, expectedText) => {
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
    expect(planner.plan).toHaveBeenCalledOnce();
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
          input: { answer: 'not registered' },
          kind: 'tool',
          reason: 'Use a boundary tool.',
          route: 'boundary',
          toolName: 'boundary_reply',
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
  ])('returns clarification when planner has an expected %s failure', async (_name, error) => {
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
    expect(planner.plan).toHaveBeenCalledOnce();
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
            route: 'transaction_analysis',
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

  it.each(['product_answer', 'transaction_analysis'] as const)(
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
              intent: route === 'product_answer' ? 'product_qa' : 'tx_sandwich_detection',
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

  it('converts failed transaction tool output into a transaction unavailable answer', async () => {
    const registry = createToolRegistry();
    const txHash = `0x${'b'.repeat(64)}`;
    const output: AnalyzeTransactionOutput = {
      failure: {
        message: 'Provider is unavailable.',
        reason: 'provider_unavailable',
        reportUrl: '/assets/tx-report.json',
      },
      status: 'failure',
    };

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute: () => Promise.resolve(output),
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { txHash },
          kind: 'tool',
          reason: 'Analyze the public transaction.',
          route: 'transaction_analysis',
          toolName: 'analyze_transaction',
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: `帮我看看 ${txHash} 是否被夹`,
    });

    expect(response).toMatchObject({
      agentRoute: 'transaction_analysis',
      citations: [],
      confidence: 0.35,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('报告：/assets/tx-report.json');
  });

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
