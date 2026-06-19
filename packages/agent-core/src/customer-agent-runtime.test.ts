import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChatResponse } from '@xxyy/shared';
import type { AnalyzeTransactionOutput } from '@xxyy/rag-core';

import { createInMemoryAuditSink } from './audit.js';
import { createCustomerAgentRuntime } from './customer-agent-runtime.js';
import { createInMemoryQualitySignalSink } from './quality-signals.js';
import { createInMemorySessionContextStore } from './session-context.js';
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

  it('uses session context to resolve product follow-up questions', async () => {
    const registry = createToolRegistry();
    const sessionContext = createInMemorySessionContextStore();
    const response: ChatResponse = {
      answer: '可以在 Pro 权益页升级。',
      citations: [
        {
          excerpt: '如何升级为 Pro。',
          file: 'docs/product-features/pro-upgrade.md',
          title: '如何升级为 Pro',
        },
      ],
      confidence: 0.8,
      intent: 'how_to',
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

    const runtime = createCustomerAgentRuntime({ registry, sessionContext });
    await runtime.ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
      sessionId: 'session-product',
    });
    await runtime.ask({
      channel: 'web',
      message: '怎么升级？',
      sessionId: 'session-product',
    });

    expect(execute).toHaveBeenLastCalledWith({
      channel: 'web',
      question: 'XXYY Pro 怎么升级？',
    });
  });

  it('uses session context to resolve one recent transaction follow-up', async () => {
    const registry = createToolRegistry();
    const sessionContext = createInMemorySessionContextStore();
    const txHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const output: AnalyzeTransactionOutput = {
      result: {
        analyzedAt: '2026-06-19T00:00:00.000Z',
        chain: 'base',
        confidence: 0.7,
        dataSource: 'fixture',
        evidence: [],
        relatedTransactions: [{ hash: txHash, role: 'user', summary: '目标交易' }],
        summary: '未发现典型夹子模式。',
        txHash,
        verdict: 'not_sandwiched',
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

    const runtime = createCustomerAgentRuntime({ registry, sessionContext });
    await runtime.ask({ channel: 'web', message: txHash, sessionId: 'session-tx' });
    await runtime.ask({ channel: 'web', message: '这笔被夹了吗？', sessionId: 'session-tx' });

    expect(execute).toHaveBeenLastCalledWith({ txHash: `${txHash} 这笔被夹了吗？` });
  });

  it('asks for clarification when a transaction follow-up has multiple recent hashes', async () => {
    const registry = createToolRegistry();
    const sessionContext = createInMemorySessionContextStore();
    const firstTx = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const secondTx = '0x2222222222222222222222222222222222222222222222222222222222222222';
    const execute = vi.fn((input: { txHash: string }) =>
      Promise.resolve({
        result: {
          analyzedAt: '2026-06-19T00:00:00.000Z',
          chain: 'base',
          confidence: 0.7,
          dataSource: 'fixture',
          evidence: [],
          relatedTransactions: [{ hash: input.txHash, role: 'user', summary: '目标交易' }],
          summary: '测试样本。',
          txHash: input.txHash,
          verdict: 'inconclusive',
        },
        status: 'success',
      } satisfies AnalyzeTransactionOutput),
    );

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const runtime = createCustomerAgentRuntime({ registry, sessionContext });
    await runtime.ask({ channel: 'web', message: firstTx, sessionId: 'session-many-tx' });
    await runtime.ask({ channel: 'web', message: secondTx, sessionId: 'session-many-tx' });
    const response = await runtime.ask({
      channel: 'web',
      message: '这笔呢？',
      sessionId: 'session-many-tx',
    });

    expect(response).toMatchObject({
      citations: [],
      confidence: 0.55,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('请发送单笔完整交易哈希');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('records quality signals for low-confidence no-citation product answers', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const response: ChatResponse = {
      answer: '当前知识库没有足够信息。',
      citations: [],
      confidence: 0.2,
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

    await createCustomerAgentRuntime({
      qualityConfidenceThreshold: 0.5,
      qualitySignals,
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 价格是多少？',
      sessionId: 'session-quality',
    });

    expect(qualitySignals.signals()).toEqual([
      {
        answer: '当前知识库没有足够信息。',
        channel: 'web',
        citationCount: 0,
        confidence: 0.2,
        intent: 'product_qa',
        reason: 'low_confidence',
        redactedQuestion: 'XXYY Pro 价格是多少？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
      {
        answer: '当前知识库没有足够信息。',
        channel: 'web',
        citationCount: 0,
        confidence: 0.2,
        intent: 'product_qa',
        reason: 'missing_citations',
        redactedQuestion: 'XXYY Pro 价格是多少？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });
});
