import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChatResponse } from '@xxyy/shared';
import {
  LlmConfigurationError,
  VectorStoreConfigurationError,
  type AnalyzeTransactionOutput,
} from '@xxyy/rag-core';

import { createInMemoryAuditSink } from './audit.js';
import { createCustomerAgentRuntime } from './customer-agent-runtime.js';
import { createInMemoryQualitySignalSink } from './quality-signals.js';
import {
  createInMemorySessionContextStore,
  type SessionContextStore,
  type SessionTurn,
} from './session-context.js';
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
      tokenUsage: {
        completionTokens: 35,
        promptTokens: 120,
        totalTokens: 155,
      },
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
    ).resolves.toEqual({
      ...response,
      agentRoute: 'product_answer',
    });
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
      completionTokenCount: 35,
      intent: 'product_qa',
      sessionIdPresent: true,
      status: 'success',
      toolName: 'answer_product_question',
      promptTokenCount: 120,
      totalTokenCount: 155,
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
      agentRoute: 'boundary',
      citations: [],
      intent: 'realtime_account_query',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(audit.events()).toEqual([]);
  });

  it('returns unsafe request boundary answers without tool calls or human handoff', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const productExecute = vi.fn(() => {
      throw new Error('product tool should not be called');
    });
    const txExecute = vi.fn(() => {
      throw new Error('transaction tool should not be called');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute: productExecute,
    });
    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute: txExecute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: 'How to hack XXYY account?',
      sessionId: 'session-unsafe',
    });

    expect(productExecute).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.3,
      intent: 'unknown',
    });
    expect(response.answer).toContain('不能帮助攻击、盗号、破解或钓鱼');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'boundary',
        answer: response.answer,
        channel: 'web',
        confidence: 0.3,
        intent: 'unknown',
        reason: 'boundary_unsafe_request',
        redactedQuestion: 'How to hack XXYY account?',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('returns business-action boundary answers without executing tools or promising handoff', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const productExecute = vi.fn(() => {
      throw new Error('product tool should not be called');
    });
    const txExecute = vi.fn(() => {
      throw new Error('transaction tool should not be called');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute: productExecute,
    });
    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute: txExecute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: '帮我开通 XXYY Pro',
      sessionId: 'session-business-action',
    });

    expect(productExecute).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.4,
      intent: 'unknown',
    });
    expect(response.answer).toContain('不能代你开通、取消、修改');
    expect(response.answer).toContain('退款、赔偿');
    expect(response.answer).toContain('可以继续问我开通或升级的操作步骤');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'boundary',
        answer: response.answer,
        channel: 'web',
        confidence: 0.4,
        intent: 'unknown',
        reason: 'boundary_business_action',
        redactedQuestion: '帮我开通 XXYY Pro',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('returns refund and compensation boundary answers without executing tools or promising handoff', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const productExecute = vi.fn(() => {
      throw new Error('product tool should not be called');
    });
    const txExecute = vi.fn(() => {
      throw new Error('transaction tool should not be called');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute: productExecute,
    });
    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute: txExecute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: '麻烦帮我退费并赔偿',
      sessionId: 'session-refund-action',
    });

    expect(productExecute).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.4,
      intent: 'unknown',
    });
    expect(response.answer).toContain('不能代你');
    expect(response.answer).toContain('退款');
    expect(response.answer).toContain('赔偿');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'boundary',
        answer: response.answer,
        channel: 'web',
        confidence: 0.4,
        intent: 'unknown',
        reason: 'boundary_business_action',
        redactedQuestion: '麻烦帮我退费并赔偿',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('returns private credential boundary answers without storing pasted seed phrases', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const productExecute = vi.fn(() => {
      throw new Error('product tool should not be called');
    });
    const txExecute = vi.fn(() => {
      throw new Error('transaction tool should not be called');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute: productExecute,
    });
    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute: txExecute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message:
        '我的助记词是 abandon ability able about above absent absorb abstract absurd abuse access accident',
      sessionId: 'session-secret',
    });

    expect(productExecute).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.35,
      intent: 'unknown',
    });
    expect(response.answer).toContain('不要发送私钥、助记词或 seed phrase');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'boundary',
        answer: response.answer,
        channel: 'web',
        confidence: 0.35,
        intent: 'unknown',
        reason: 'boundary_private_credentials',
        redactedQuestion: '我的助记词是 [sensitive_credential]',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('returns private credential boundary answers for pasted passwords without tool calls', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const productExecute = vi.fn(() => {
      throw new Error('product tool should not be called');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute: productExecute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: '我的密码是 hunter2',
      sessionId: 'session-password',
    });

    expect(productExecute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.35,
      intent: 'unknown',
    });
    expect(response.answer).toContain('不要发送私钥、助记词或 seed phrase');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'boundary',
        answer: response.answer,
        channel: 'web',
        confidence: 0.35,
        intent: 'unknown',
        reason: 'boundary_private_credentials',
        redactedQuestion: '我的密码是 [sensitive_credential]',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('records chain-forensics boundary answers as quality signals', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const productExecute = vi.fn(() => {
      throw new Error('product tool should not be called');
    });
    const txExecute = vi.fn(() => {
      throw new Error('transaction tool should not be called');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      policy: toolPolicy,
      execute: productExecute,
    });
    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute: txExecute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: '什么是 MEV sandwich？',
      sessionId: 'session-mev-boundary',
    });

    expect(productExecute).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.7,
      intent: 'mev_or_chain_forensics',
    });
    expect(response.answer).toContain('不能仅凭当前问题判断某笔交易是否被夹或存在 MEV');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'boundary',
        answer: response.answer,
        channel: 'web',
        confidence: 0.7,
        intent: 'mev_or_chain_forensics',
        reason: 'boundary_chain_forensics',
        redactedQuestion: '什么是 MEV sandwich？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('routes inverted chain-forensics definition questions to boundary answers', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const txExecute = vi.fn(() => {
      throw new Error('transaction tool should not be called');
    });

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute: txExecute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: 'MEV sandwich 是什么？',
      sessionId: 'session-inverted-mev-boundary',
    });

    expect(txExecute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.7,
      intent: 'mev_or_chain_forensics',
    });
    expect(response.answer).toContain('不能仅凭当前问题判断某笔交易是否被夹或存在 MEV');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'boundary',
        answer: response.answer,
        channel: 'web',
        confidence: 0.7,
        intent: 'mev_or_chain_forensics',
        reason: 'boundary_chain_forensics',
        redactedQuestion: 'MEV sandwich 是什么？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('returns an automatic product fallback when answer_product_question fails', async () => {
    const registry = createToolRegistry();
    const audit = createInMemoryAuditSink();
    const qualitySignals = createInMemoryQualitySignalSink();
    const sessionContext = createInMemorySessionContextStore();
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

    const response = await createCustomerAgentRuntime({
      audit,
      qualitySignals,
      registry,
      sessionContext,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
      sessionId: 'session-1',
      userId: 'user-1',
    });

    expect(response).toMatchObject({
      citations: [],
      confidence: 0.25,
      intent: 'product_qa',
    });
    expect(response.answer).toContain('产品知识库暂时不可用');
    expect(response.answer).toContain('不会编造产品细节');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);

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
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'product_answer',
        answer: response.answer,
        channel: 'web',
        errorCode: 'ProductToolFailure',
        intent: 'product_qa',
        reason: 'tool_failure',
        redactedQuestion: 'XXYY Pro 有哪些权益？',
        sessionIdPresent: true,
        userIdPresent: true,
      },
    ]);
    const sessionTurns = await sessionContext.getRecentTurns('session-1');
    expect(sessionTurns).toHaveLength(2);
    expect(sessionTurns[0]).toMatchObject({
      content: 'XXYY Pro 有哪些权益？',
      metadata: { intent: 'product_qa' },
      role: 'user',
    });
    expect(typeof sessionTurns[0]?.createdAt).toBe('string');
    expect(sessionTurns[1]).toMatchObject({
      content: response.answer,
      metadata: {
        citationCount: 0,
        confidence: 0.25,
        intent: 'product_qa',
      },
      role: 'assistant',
    });
    expect(typeof sessionTurns[1]?.createdAt).toBe('string');
  });

  it('keeps product configuration errors visible to API and CLI callers', async () => {
    const registry = createToolRegistry();
    const vectorError = new VectorStoreConfigurationError(
      'DATABASE_URL is required for pgvector retrieval.',
    );
    const llmError = new LlmConfigurationError(
      'OPENAI_API_KEY is required for LLM answer generation.',
    );
    const execute = vi.fn().mockRejectedValueOnce(vectorError).mockRejectedValueOnce(llmError);

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

    const runtime = createCustomerAgentRuntime({ registry });

    await expect(
      runtime.ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).rejects.toBe(vectorError);
    await expect(
      runtime.ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).rejects.toBe(llmError);
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
      agentRoute: 'transaction_analysis',
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

  it('asks for clarification without calling analyze_transaction when a message has multiple transaction hashes', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const firstTxHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const secondTxHash = '0x2222222222222222222222222222222222222222222222222222222222222222';
    const execute = vi.fn(() => {
      throw new Error('transaction tool should not be called');
    });

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: ['帮我查这两笔哪个被夹了', firstTxHash, secondTxHash].join(' '),
      sessionId: 'session-multi-tx',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      confidence: 0.55,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('一次只能分析一笔交易');
    expect(response.answer).toContain('单笔完整交易哈希');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.55,
        intent: 'tx_sandwich_detection',
        reason: 'ambiguous_transaction_reference',
        redactedQuestion: '帮我查这两笔哪个被夹了 [evm_tx_hash] [evm_tx_hash]',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('returns an automatic transaction fallback when analyze_transaction fails', async () => {
    const registry = createToolRegistry();
    const audit = createInMemoryAuditSink();
    const qualitySignals = createInMemoryQualitySignalSink();
    const txHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const error = new Error('tx tool failed');
    error.name = 'TxToolFailure';

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute: () => Promise.reject(error),
    });

    const response = await createCustomerAgentRuntime({
      audit,
      qualitySignals,
      registry,
    }).ask({
      channel: 'web',
      message: txHash,
    });

    expect(response).toMatchObject({
      citations: [],
      confidence: 0.35,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('交易分析数据源暂时不可用');
    expect(response.answer).toContain('当前不会编造链上分析结论');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);
    expect(audit.events()).toMatchObject([
      {
        channel: 'web',
        errorCode: 'TxToolFailure',
        intent: 'tx_sandwich_detection',
        sessionIdPresent: false,
        status: 'failure',
        toolName: 'analyze_transaction',
        userIdPresent: false,
      },
    ]);
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'transaction_analysis',
        answer: response.answer,
        channel: 'web',
        errorCode: 'TxToolFailure',
        intent: 'tx_sandwich_detection',
        reason: 'tool_failure',
        redactedQuestion: '[evm_tx_hash]',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('records unavailable answers on transaction analysis failure quality signals', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const txHash = '0x1111111111111111111111111111111111111111111111111111111111111111';

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute: () =>
        Promise.resolve({
          failure: {
            message: '交易哈希夹子检测功能暂未启用。',
            reason: 'not_configured',
          },
          status: 'failure',
        } satisfies AnalyzeTransactionOutput),
    });

    const response = await createCustomerAgentRuntime({
      qualitySignals,
      registry,
    }).ask({
      channel: 'web',
      message: txHash,
      sessionId: 'session-tx-failure',
    });

    expect(response).toMatchObject({
      citations: [],
      confidence: 0.35,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('交易哈希夹子检测功能暂未启用');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'transaction_analysis',
        answer: response.answer,
        channel: 'web',
        confidence: 0.35,
        intent: 'tx_sandwich_detection',
        reason: 'tx_analysis_failure',
        redactedQuestion: '[evm_tx_hash]',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('streams ask responses as answer_delta and metadata events', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: '根据知识库，XXYY 支持 Telegram 提醒。',
      citations: [
        {
          excerpt: 'XXYY 支持 Telegram 提醒。',
          file: 'docs/product-features/telegram.md',
          title: 'Telegram 提醒',
        },
      ],
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
        agentRoute: 'product_answer',
        citations: response.citations,
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

  it('uses safe session summaries to resolve product follow-ups after older turns are pruned', async () => {
    const registry = createToolRegistry();
    const sessionContext = createInMemorySessionContextStore({ maxTurnsPerSession: 2 });
    const response: ChatResponse = {
      answer: '移动端可以使用手机号或钱包入口登录。',
      citations: [
        {
          excerpt: '移动端登录入口说明。',
          file: 'docs/product-features/mobile.md',
          title: '移动端登录',
        },
      ],
      confidence: 0.82,
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
      message: '我主要用手机端。',
      sessionId: 'session-product-summary',
    });
    await runtime.ask({
      channel: 'web',
      message: '帮我查一下钱包余额',
      sessionId: 'session-product-summary',
    });
    await runtime.ask({
      channel: 'web',
      message: '怎么登录？',
      sessionId: 'session-product-summary',
    });

    expect(execute).toHaveBeenLastCalledWith({
      channel: 'web',
      question: 'XXYY 移动端登录 怎么登录？',
    });
  });

  it('uses session context to resolve product upgrade-location follow-ups', async () => {
    const registry = createToolRegistry();
    const sessionContext = createInMemorySessionContextStore();
    const response: ChatResponse = {
      answer: '可以在 XXYY Pro 权益页查看升级入口。',
      citations: [
        {
          excerpt: 'XXYY Pro 升级入口。',
          file: 'docs/product-features/pro-upgrade.md',
          title: '如何升级为 Pro',
        },
      ],
      confidence: 0.82,
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
      sessionId: 'session-upgrade-location',
    });
    const followUpResponse = await runtime.ask({
      channel: 'web',
      message: '在哪里升级？',
      sessionId: 'session-upgrade-location',
    });

    expect(followUpResponse.answer).toContain('升级入口');
    expect(execute).toHaveBeenLastCalledWith({
      channel: 'web',
      question: 'XXYY Pro 在哪里升级？',
    });
  });

  it('uses session context to resolve product entry-location follow-ups', async () => {
    const registry = createToolRegistry();
    const sessionContext = createInMemorySessionContextStore();
    const response: ChatResponse = {
      answer: 'XXYY Pro 入口在权益页。',
      citations: [
        {
          excerpt: 'XXYY Pro 入口在权益页。',
          file: 'docs/product-features/pro-upgrade.md',
          title: '如何升级为 Pro',
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
      sessionId: 'session-entry-location',
    });
    const followUpResponse = await runtime.ask({
      channel: 'web',
      message: '入口在哪？',
      sessionId: 'session-entry-location',
    });

    expect(followUpResponse.answer).toContain('入口');
    expect(execute).toHaveBeenLastCalledWith({
      channel: 'web',
      question: 'XXYY Pro 入口在哪？',
    });
  });

  it('uses session context to resolve product price follow-ups', async () => {
    const registry = createToolRegistry();
    const sessionContext = createInMemorySessionContextStore();
    const response: ChatResponse = {
      answer: 'XXYY Pro 价格以产品页面展示为准。',
      citations: [
        {
          excerpt: 'XXYY Pro 价格以产品页面展示为准。',
          file: 'docs/product-features/pro-upgrade.md',
          title: 'XXYY Pro',
        },
      ],
      confidence: 0.78,
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

    const runtime = createCustomerAgentRuntime({ registry, sessionContext });
    await runtime.ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
      sessionId: 'session-price-followup',
    });
    const followUpResponse = await runtime.ask({
      channel: 'web',
      message: '多少钱？',
      sessionId: 'session-price-followup',
    });

    expect(followUpResponse.answer).toContain('价格');
    expect(execute).toHaveBeenLastCalledWith({
      channel: 'web',
      question: 'XXYY Pro 多少钱？',
    });
  });

  it('uses session context to resolve product validity-period follow-ups', async () => {
    const registry = createToolRegistry();
    const sessionContext = createInMemorySessionContextStore();
    const response: ChatResponse = {
      answer: 'XXYY Pro 有效期以产品页面展示为准。',
      citations: [
        {
          excerpt: 'XXYY Pro 有效期以产品页面展示为准。',
          file: 'docs/product-features/pro-upgrade.md',
          title: 'XXYY Pro',
        },
      ],
      confidence: 0.78,
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

    const runtime = createCustomerAgentRuntime({ registry, sessionContext });
    await runtime.ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
      sessionId: 'session-validity-followup',
    });
    const followUpResponse = await runtime.ask({
      channel: 'web',
      message: '有效期多久？',
      sessionId: 'session-validity-followup',
    });

    expect(followUpResponse.answer).toContain('有效期');
    expect(execute).toHaveBeenLastCalledWith({
      channel: 'web',
      question: 'XXYY Pro 有效期多久？',
    });
  });

  it('uses safe session preferences to resolve product follow-ups through the runtime', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const sessionContext = createInMemorySessionContextStore();
    const response: ChatResponse = {
      answer: '可以在 XXYY 移动端登录页完成登录。',
      citations: [
        {
          excerpt: '移动端登录步骤。',
          file: 'docs/product-features/mobile-login.md',
          title: '移动端登录',
        },
      ],
      confidence: 0.82,
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

    const runtime = createCustomerAgentRuntime({ qualitySignals, registry, sessionContext });
    const preferenceResponse = await runtime.ask({
      channel: 'web',
      message: '我主要用手机端。',
      sessionId: 'session-mobile-preference',
    });

    expect(preferenceResponse).toMatchObject({
      citations: [],
      confidence: 0.6,
      intent: 'product_qa',
    });
    expect(preferenceResponse.answer).toContain('已记录');
    expect(preferenceResponse.answer).toContain('移动端');
    expect(qualitySignals.signals()).toEqual([]);

    await runtime.ask({
      channel: 'web',
      message: '怎么登录？',
      sessionId: 'session-mobile-preference',
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenLastCalledWith({
      channel: 'web',
      question: 'XXYY 移动端登录 怎么登录？',
    });
  });

  it('clears session context on explicit reset requests without calling answer tools', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const sessionContext = createInMemorySessionContextStore();
    const response: ChatResponse = {
      answer: '可以在 XXYY 移动端登录页完成登录。',
      citations: [
        {
          excerpt: '移动端登录步骤。',
          file: 'docs/product-features/mobile-login.md',
          title: '移动端登录',
        },
      ],
      confidence: 0.82,
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

    const runtime = createCustomerAgentRuntime({ qualitySignals, registry, sessionContext });
    await runtime.ask({
      channel: 'web',
      message: '我主要用手机端。',
      sessionId: 'session-clear-context',
    });

    const clearResponse = await runtime.ask({
      channel: 'web',
      message: '清除本次会话上下文',
      sessionId: 'session-clear-context',
    });

    expect(clearResponse).toMatchObject({
      agentRoute: 'preference_capture',
      citations: [],
      confidence: 0.65,
      intent: 'product_qa',
    });
    expect(clearResponse.answer).toContain('已清除');
    expect(execute).not.toHaveBeenCalled();
    await expect(sessionContext.getRecentTurns('session-clear-context')).resolves.toEqual([]);
    await expect(sessionContext.getSessionSummary('session-clear-context')).resolves.toBeNull();

    const followUpAfterClear = await runtime.ask({
      channel: 'web',
      message: '怎么登录？',
      sessionId: 'session-clear-context',
    });

    expect(followUpAfterClear).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'how_to',
    });
    expect(followUpAfterClear.answer).toContain('不能确定你想继续咨询哪个具体功能');
    expect(execute).not.toHaveBeenCalled();
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: followUpAfterClear.answer,
        channel: 'web',
        confidence: 0.55,
        intent: 'how_to',
        reason: 'missing_followup_context',
        redactedQuestion: '怎么登录？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('does not claim a safe product preference was recorded without session persistence', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const sessionContext = createInMemorySessionContextStore();
    const execute = vi.fn(() =>
      Promise.resolve({
        answer: 'tool should not be called',
        citations: [],
        confidence: 0.8,
        intent: 'product_qa',
      } satisfies ChatResponse),
    );

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

    const response = await createCustomerAgentRuntime({
      qualitySignals,
      registry,
      sessionContext,
    }).ask({
      channel: 'web',
      message: '我主要用手机端。',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'product_qa',
    });
    expect(response.answer).toContain('无法把这个偏好保存到后续追问');
    expect(response.answer).toContain('移动端');
    expect(response.answer).not.toContain('已记录');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'preference_capture',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        intent: 'product_qa',
        reason: 'session_unavailable',
        redactedQuestion: '我主要用手机端。',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('does not claim a safe product preference was recorded when session append fails', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const execute = vi.fn(() =>
      Promise.resolve({
        answer: 'tool should not be called',
        citations: [],
        confidence: 0.8,
        intent: 'product_qa',
      } satisfies ChatResponse),
    );

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

    const response = await createCustomerAgentRuntime({
      qualitySignals,
      registry,
      sessionContext: {
        appendTurn: () => Promise.reject(new Error('session append unavailable')),
        clearSession: () => Promise.resolve(),
        getRecentTurns: () => Promise.resolve([]),
        getSessionSummary: () => Promise.resolve(null),
      },
    }).ask({
      channel: 'web',
      message: '我主要用手机端。',
      sessionId: 'session-mobile-preference-fails',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'product_qa',
    });
    expect(response.answer).toContain('无法把这个偏好保存到后续追问');
    expect(response.answer).toContain('移动端');
    expect(response.answer).not.toContain('已记录');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'preference_capture',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        errorCode: 'Error',
        intent: 'product_qa',
        reason: 'session_unavailable',
        redactedQuestion: '我主要用手机端。',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('records session_unavailable when a product follow-up has no session context store', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const execute = vi.fn(() =>
      Promise.resolve({
        answer: 'tool should not be called',
        citations: [],
        confidence: 0.8,
        intent: 'how_to',
      } satisfies ChatResponse),
    );

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

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: '怎么升级？',
      sessionId: 'missing-session-store',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'how_to',
    });
    expect(response.answer).toContain('缺少这次会话的上一轮上下文');
    expect(response.answer).toContain('具体功能');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        intent: 'how_to',
        reason: 'session_unavailable',
        redactedQuestion: '怎么升级？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('records session_unavailable when a product follow-up has no session id', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const execute = vi.fn(() =>
      Promise.resolve({
        answer: 'tool should not be called',
        citations: [],
        confidence: 0.8,
        intent: 'how_to',
      } satisfies ChatResponse),
    );

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

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: '怎么升级？',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'how_to',
    });
    expect(response.answer).toContain('缺少这次会话的上一轮上下文');
    expect(response.answer).toContain('具体功能');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        intent: 'how_to',
        reason: 'session_unavailable',
        redactedQuestion: '怎么升级？',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('records session_unavailable when a product follow-up has no session id even with a session store', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const sessionContext = createInMemorySessionContextStore();
    const execute = vi.fn(() =>
      Promise.resolve({
        answer: 'tool should not be called',
        citations: [],
        confidence: 0.8,
        intent: 'how_to',
      } satisfies ChatResponse),
    );

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

    const response = await createCustomerAgentRuntime({
      qualitySignals,
      registry,
      sessionContext,
    }).ask({
      channel: 'web',
      message: '怎么升级？',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'how_to',
    });
    expect(response.answer).toContain('缺少这次会话的上一轮上下文');
    expect(response.answer).toContain('具体功能');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        intent: 'how_to',
        reason: 'session_unavailable',
        redactedQuestion: '怎么升级？',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('keeps explicit product how-to questions self-contained without a session id', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: '可以在 Telegram 钱包监控配置页完成设置。',
      citations: [
        {
          excerpt: 'Telegram 钱包监控配置步骤。',
          file: 'docs/product-features/telegram-wallet-monitoring.md',
          title: 'Telegram 钱包监控',
        },
      ],
      confidence: 0.82,
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

    await expect(
      createCustomerAgentRuntime({ registry }).ask({
        channel: 'web',
        message: '如何设置 Telegram 钱包监控？',
      }),
    ).resolves.toEqual({
      ...response,
      agentRoute: 'product_answer',
    });
    expect(execute).toHaveBeenCalledWith({
      channel: 'web',
      question: '如何设置 Telegram 钱包监控？',
    });
  });

  it('records missing_followup_context when a product follow-up has no usable session context', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const sessionContext = createInMemorySessionContextStore();
    const execute = vi.fn(() =>
      Promise.resolve({
        answer: 'tool should not be called',
        citations: [],
        confidence: 0.8,
        intent: 'how_to',
      } satisfies ChatResponse),
    );

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

    const response = await createCustomerAgentRuntime({
      qualitySignals,
      registry,
      sessionContext,
    }).ask({
      channel: 'web',
      message: '怎么升级？',
      sessionId: 'empty-product-session',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.55,
      intent: 'how_to',
    });
    expect(response.answer).toContain('不能确定你想继续咨询哪个具体功能');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.55,
        intent: 'how_to',
        reason: 'missing_followup_context',
        redactedQuestion: '怎么升级？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('asks for clarification instead of using stale product session context', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const execute = vi.fn(() =>
      Promise.resolve({
        answer: 'tool should not be called',
        citations: [],
        confidence: 0.8,
        intent: 'how_to',
      } satisfies ChatResponse),
    );
    const sessionContext: SessionContextStore = {
      appendTurn: vi.fn(() => Promise.resolve()),
      clearSession: vi.fn(() => Promise.resolve()),
      getRecentTurns: vi.fn(() =>
        Promise.resolve([
          {
            content: 'XXYY Pro 有哪些权益？',
            createdAt: '2026-06-18T06:00:00.000Z',
            metadata: { citationCount: 2, intent: 'product_qa' },
            role: 'assistant',
          },
        ] satisfies SessionTurn[]),
      ),
      getSessionSummary: vi.fn(() =>
        Promise.resolve({
          productTopic: 'XXYY Pro',
          updatedAt: '2026-06-18T06:00:00.000Z',
        }),
      ),
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
      execute,
    });

    const response = await createCustomerAgentRuntime({
      now: () => new Date('2026-06-19T08:00:00.000Z'),
      qualitySignals,
      registry,
      sessionContext,
      sessionContextMaxAgeMs: 60 * 60 * 1000,
    }).ask({
      channel: 'web',
      message: '怎么升级？',
      sessionId: 'stale-product-session',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      confidence: 0.55,
      intent: 'how_to',
    });
    expect(response.answer).toContain('不能确定你想继续咨询哪个具体功能');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.55,
        intent: 'how_to',
        reason: 'missing_followup_context',
        redactedQuestion: '怎么升级？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
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

    expect(execute).toHaveBeenLastCalledWith({ txHash: `base ${txHash} 这笔被夹了吗？` });
  });

  it('uses session context to resolve one recent Solana transaction follow-up', async () => {
    const registry = createToolRegistry();
    const sessionContext = createInMemorySessionContextStore();
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';
    const execute = vi.fn(() =>
      Promise.resolve({
        result: {
          analyzedAt: '2026-06-19T00:00:00.000Z',
          chain: 'solana',
          confidence: 0.7,
          dataSource: 'fixture',
          evidence: [],
          relatedTransactions: [{ hash: txHash, role: 'user', summary: '目标交易' }],
          summary: '未发现典型夹子模式。',
          txHash,
          verdict: 'not_sandwiched',
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
    await runtime.ask({ channel: 'web', message: txHash, sessionId: 'session-solana-tx' });
    await runtime.ask({
      channel: 'web',
      message: '这笔被夹了吗？',
      sessionId: 'session-solana-tx',
    });

    expect(execute).toHaveBeenLastCalledWith({ txHash: `solana ${txHash} 这笔被夹了吗？` });
  });

  it('records session_unavailable when a transaction follow-up has no session context store', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const execute = vi.fn();

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: '这笔呢？',
      sessionId: 'missing-session-store',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('缺少这次会话的上一轮上下文');
    expect(response.answer).toContain('单笔完整交易哈希');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        intent: 'tx_sandwich_detection',
        reason: 'session_unavailable',
        redactedQuestion: '这笔呢？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('records session_unavailable when a transaction follow-up has no session id', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const execute = vi.fn();

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: '这笔呢？',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('缺少这次会话的上一轮上下文');
    expect(response.answer).toContain('单笔完整交易哈希');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        intent: 'tx_sandwich_detection',
        reason: 'session_unavailable',
        redactedQuestion: '这笔呢？',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('records session_unavailable when a transaction follow-up has no session id even with a session store', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const sessionContext = createInMemorySessionContextStore();
    const execute = vi.fn();

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const response = await createCustomerAgentRuntime({
      qualitySignals,
      registry,
      sessionContext,
    }).ask({
      channel: 'web',
      message: '这笔呢？',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('缺少这次会话的上一轮上下文');
    expect(response.answer).toContain('单笔完整交易哈希');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        intent: 'tx_sandwich_detection',
        reason: 'session_unavailable',
        redactedQuestion: '这笔呢？',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('records missing_followup_context when a transaction follow-up has no usable session context', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const sessionContext = createInMemorySessionContextStore();
    const execute = vi.fn();

    registry.register({
      name: 'analyze_transaction',
      description: 'Analyze transaction.',
      inputSchema: z.object({ txHash: z.string() }),
      outputSchema: z.custom<AnalyzeTransactionOutput>(() => true),
      policy: toolPolicy,
      execute,
    });

    const response = await createCustomerAgentRuntime({
      qualitySignals,
      registry,
      sessionContext,
    }).ask({
      channel: 'web',
      message: '这笔呢？',
      sessionId: 'empty-tx-session',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      citations: [],
      confidence: 0.55,
      intent: 'tx_sandwich_detection',
    });
    expect(response.answer).toContain('不能确定“这笔”指哪一笔交易');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.55,
        intent: 'tx_sandwich_detection',
        reason: 'missing_followup_context',
        redactedQuestion: '这笔呢？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('asks for clarification when a transaction follow-up has multiple recent hashes', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
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

    const runtime = createCustomerAgentRuntime({ qualitySignals, registry, sessionContext });
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
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.55,
        intent: 'tx_sandwich_detection',
        reason: 'ambiguous_followup',
        redactedQuestion: '这笔呢？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('records the clarification answer on unknown-intent quality signals', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();

    const response = await createCustomerAgentRuntime({ qualitySignals, registry }).ask({
      channel: 'web',
      message: '帮我看看这个',
      sessionId: 'session-unknown',
    });

    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'unknown',
    });
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        intent: 'unknown',
        reason: 'unknown_intent',
        redactedQuestion: '帮我看看这个',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('asks for clarification when session context lookup fails for a follow-up', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const execute = vi.fn(() =>
      Promise.resolve({
        answer: 'XXYY Pro 可以升级。',
        citations: [
          {
            excerpt: 'XXYY Pro 可以升级。',
            file: 'docs/product-features/pro.md',
            title: 'XXYY Pro',
          },
        ],
        confidence: 0.8,
        intent: 'how_to' as const,
      }),
    );

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

    const response = await createCustomerAgentRuntime({
      qualitySignals,
      registry,
      sessionContext: {
        appendTurn: () => Promise.resolve(),
        clearSession: () => Promise.resolve(),
        getRecentTurns: () => Promise.reject(new Error('session store unavailable')),
        getSessionSummary: () => Promise.resolve(null),
      },
    }).ask({
      channel: 'web',
      message: '怎么升级？',
      sessionId: 'session-broken-store',
    });

    expect(response).toMatchObject({
      citations: [],
      confidence: 0.45,
      intent: 'how_to',
    });
    expect(response.answer).toContain('我缺少这次会话的上一轮上下文');
    expect(response.answer).toContain('请补充具体功能');
    expect(execute).not.toHaveBeenCalled();
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'clarify',
        answer: response.answer,
        channel: 'web',
        confidence: 0.45,
        errorCode: 'Error',
        intent: 'how_to',
        reason: 'session_unavailable',
        redactedQuestion: '怎么升级？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('keeps returning the answer when session context append fails', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
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

    await expect(
      createCustomerAgentRuntime({
        qualitySignals,
        registry,
        sessionContext: {
          appendTurn: () => Promise.reject(new Error('session append unavailable')),
          clearSession: () => Promise.resolve(),
          getRecentTurns: () => Promise.resolve([]),
          getSessionSummary: () => Promise.resolve(null),
        },
      }).ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 'session-append-fails',
      }),
    ).resolves.toEqual({
      ...response,
      agentRoute: 'product_answer',
    });
    expect(qualitySignals.signals()).toEqual([]);
  });

  it('blocks product answers that promise ticket or human handoff handling', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const response: ChatResponse = {
      answer: '已帮你提交工单，稍后会有人工客服接管处理。',
      citations: [
        {
          excerpt: '异常处理可以联系客服。',
          file: 'docs/product-features/support.md',
          title: '异常处理',
        },
      ],
      confidence: 0.88,
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

    const finalResponse = await createCustomerAgentRuntime({
      qualitySignals,
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 异常怎么处理？',
      sessionId: 'session-handoff-wording',
    });

    expect(finalResponse).toMatchObject({
      citations: [],
      confidence: 0.25,
      intent: 'product_qa',
    });
    expect(finalResponse.answer).toContain('不适合自动回复');
    expect(finalResponse.answer).not.toMatch(/提交工单|人工客服|人工接管|转人工/u);
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'product_answer',
        answer: finalResponse.answer,
        channel: 'web',
        citationCount: 1,
        confidence: 0.88,
        intent: 'product_qa',
        reason: 'handoff_wording',
        redactedQuestion: 'XXYY Pro 异常怎么处理？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('returns a conservative fallback and records one combined quality signal for low-confidence no-citation product answers', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const response: ChatResponse = {
      answer: 'XXYY Pro 价格是 999 USDT。',
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

    const finalResponse = await createCustomerAgentRuntime({
      qualityConfidenceThreshold: 0.5,
      qualitySignals,
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 价格是多少？',
      sessionId: 'session-quality',
    });

    expect(finalResponse).toMatchObject({
      citations: [],
      confidence: 0.25,
      intent: 'product_qa',
    });
    expect(finalResponse.answer).toContain('当前知识库没有足够资料确认这个问题');
    expect(finalResponse.answer).toContain('不会编造产品细节');
    expect(finalResponse.answer).not.toContain('999 USDT');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'product_answer',
        answer: finalResponse.answer,
        channel: 'web',
        citationCount: 0,
        confidence: 0.2,
        intent: 'product_qa',
        reason: 'low_confidence_missing_citations',
        redactedQuestion: 'XXYY Pro 价格是多少？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });

  it('returns a conservative fallback for no-citation product answers even when confidence is high', async () => {
    const registry = createToolRegistry();
    const qualitySignals = createInMemoryQualitySignalSink();
    const response: ChatResponse = {
      answer: 'XXYY 一定支持这个未引用功能。',
      citations: [],
      confidence: 0.9,
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

    const finalResponse = await createCustomerAgentRuntime({
      qualityConfidenceThreshold: 0.5,
      qualitySignals,
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY 支持这个功能吗？',
      sessionId: 'session-missing-citations',
    });

    expect(finalResponse).toMatchObject({
      citations: [],
      confidence: 0.25,
      intent: 'product_qa',
    });
    expect(finalResponse.answer).toContain('当前知识库没有足够资料确认这个问题');
    expect(finalResponse.answer).not.toContain('一定支持');
    expect(qualitySignals.signals()).toEqual([
      {
        agentRoute: 'product_answer',
        answer: finalResponse.answer,
        channel: 'web',
        citationCount: 0,
        confidence: 0.9,
        intent: 'product_qa',
        reason: 'missing_citations',
        redactedQuestion: 'XXYY 支持这个功能吗？',
        sessionIdPresent: true,
        userIdPresent: false,
      },
    ]);
  });
});
