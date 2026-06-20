import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChatResponse } from '@xxyy/shared';
import type { AnalyzeTransactionOutput } from '@xxyy/rag-core';

import { createLangGraphCustomerRuntime } from './langgraph-customer-runtime.js';
import { createScriptedPlannerModel } from './planner-model.js';
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

  it('blocks realtime account requests before planner or tool execution', async () => {
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

    const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
      channel: 'cli',
      message: '帮我查一下钱包余额',
    });

    expect(response).toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'realtime_account_query',
    });
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
