import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChatResponse } from '@xxyy/shared';
import type { AnalyzeTransactionOutput } from '@xxyy/rag-core';

import { createInMemoryAuditSink } from './audit.js';
import { createCustomerAgentRuntime } from './customer-agent-runtime.js';
import { createToolRegistry } from './tool-registry.js';

const toolPolicy = {
  allowExternalMcp: true,
  requiresOpsAuth: false,
};

describe('createCustomerAgentRuntime', () => {
  it('uses answer_product_question for product questions and records an audit event', async () => {
    const registry = createToolRegistry();
    const audit = createInMemoryAuditSink();
    const response: ChatResponse = {
      answer: 'XXYY Pro 提供更高监控上限。',
      citations: [
        {
          excerpt: 'XXYY Pro 提供更高监控上限。',
          file: 'docs/product-features/pro.md',
          title: 'XXYY Pro',
        },
      ],
      confidence: 0.8,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        channel: z.enum(['cli', 'web', 'telegram']).optional(),
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute,
    });

    await expect(
      createCustomerAgentRuntime({ audit, registry }).ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 'session-1',
      }),
    ).resolves.toEqual(response);
    expect(execute).toHaveBeenCalledWith({
      channel: 'web',
      question: 'XXYY Pro 有哪些权益？',
    });
    const auditEvents = audit.events();
    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0];
    expect(event?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(event).toMatchObject({
      channel: 'web',
      citationCount: 1,
      intent: 'product_qa',
      sessionIdPresent: true,
      status: 'success',
      toolName: 'answer_product_question',
      userIdPresent: false,
    });
  });

  it('returns realtime_account_query boundary answers without executing tools', async () => {
    const registry = createToolRegistry();
    const audit = createInMemoryAuditSink();
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

    await expect(
      createCustomerAgentRuntime({ audit, registry }).ask({
        channel: 'web',
        message: '帮我查一下钱包余额',
      }),
    ).resolves.toMatchObject({
      citations: [],
      intent: 'realtime_account_query',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(audit.events()).toEqual([]);
  });

  it('records failure audit and rethrows when answer_product_question fails', async () => {
    const registry = createToolRegistry();
    const audit = createInMemoryAuditSink();
    const error = new Error('product tool failed');
    error.name = 'ProductToolFailure';

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        channel: z.enum(['cli', 'web', 'telegram']).optional(),
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute: () => Promise.reject(error),
    });

    await expect(
      createCustomerAgentRuntime({ audit, registry }).ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 'session-1',
        userId: 'user-1',
      }),
    ).rejects.toBe(error);

    const auditEvents = audit.events();
    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0];
    expect(event?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(event).toMatchObject({
      channel: 'web',
      errorCode: 'ProductToolFailure',
      intent: 'product_qa',
      sessionIdPresent: true,
      status: 'failure',
      toolName: 'answer_product_question',
      userIdPresent: true,
    });
  });

  it('uses analyze_transaction for transaction hash questions and returns tx analysis answers', async () => {
    const registry = createToolRegistry();
    const audit = createInMemoryAuditSink();
    const txHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const output: AnalyzeTransactionOutput = {
      result: {
        analyzedAt: '2026-06-16T00:00:00.000Z',
        chain: 'base',
        confidence: 0.76,
        dataSource: 'fixture',
        evidence: [
          {
            detail: '前后存在相邻交易。',
            label: '窗口模式',
            severity: 'warning',
          },
        ],
        relatedTransactions: [
          {
            hash: txHash,
            role: 'user',
            summary: '目标交易',
          },
        ],
        summary: '检测到简单测试样本。',
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

    const response = await createCustomerAgentRuntime({ audit, registry }).ask({
      channel: 'telegram',
      message: txHash,
      userId: 'user-1',
    });

    expect(execute).toHaveBeenCalledWith({ txHash });
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.76,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('交易哈希');
    const auditEvents = audit.events();
    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0];
    expect(event?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(event).toMatchObject({
      channel: 'telegram',
      intent: 'tx_sandwich_detection',
      sessionIdPresent: false,
      status: 'success',
      toolName: 'analyze_transaction',
      userIdPresent: true,
    });
  });

  it('streams ask responses as answer_delta and metadata events', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: '根据知识库，XXYY 支持 Telegram 提醒。',
      citations: [],
      confidence: 0.72,
      intent: 'product_qa',
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        channel: z.enum(['cli', 'web', 'telegram']).optional(),
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      policy: toolPolicy,
      execute: () => Promise.resolve(response),
    });

    const events = [];
    for await (const event of createCustomerAgentRuntime({ registry }).stream({
      channel: 'web',
      message: 'XXYY 有 Telegram 提醒吗？',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        delta: response.answer,
        type: 'answer_delta',
      },
      {
        citations: [],
        confidence: 0.72,
        intent: 'product_qa',
        type: 'metadata',
      },
    ]);
  });
});
