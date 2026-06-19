import { describe, expect, it } from 'vitest';

import {
  PRODUCT_QA_MCP_INSTRUCTIONS,
  PRODUCT_QA_MCP_TOOL_NAMES,
  createProductQaMcpServer,
} from './server.js';

interface RegisteredToolForTest<Input = unknown> {
  handler: (input: Input, extra: unknown) => Promise<unknown>;
}

function getRegisteredTools(
  server: ReturnType<typeof createProductQaMcpServer>,
): Record<string, RegisteredToolForTest | undefined> {
  return (
    server as unknown as { _registeredTools: Record<string, RegisteredToolForTest | undefined> }
  )._registeredTools;
}

function getToolHandler<Input>(
  server: ReturnType<typeof createProductQaMcpServer>,
  name: string,
): RegisteredToolForTest<Input>['handler'] {
  const tool = getRegisteredTools(server)[name] as RegisteredToolForTest<Input> | undefined;
  if (tool === undefined) {
    throw new Error(`${name} tool was not registered`);
  }
  return tool.handler;
}

describe('product QA MCP server', () => {
  it('declares stable tool names', () => {
    expect(PRODUCT_QA_MCP_TOOL_NAMES).toEqual(['search_product_docs', 'answer_product_question']);
  });

  it('creates a server with product support instructions', () => {
    const server = createProductQaMcpServer({
      handlers: {
        answerProductQuestion() {
          throw new Error('not called during construction');
        },
        searchProductDocs() {
          throw new Error('not called during construction');
        },
      },
    });

    expect(server).toBeDefined();
    expect(PRODUCT_QA_MCP_INSTRUCTIONS).toContain('XXYY product');
    expect(PRODUCT_QA_MCP_INSTRUCTIONS).toContain('Do not use this server for private account');
    expect(PRODUCT_QA_MCP_INSTRUCTIONS).toContain('Do not execute business actions');
    expect(PRODUCT_QA_MCP_INSTRUCTIONS).not.toMatch(
      /human handoff|ticket|support channel|authenticated support/iu,
    );
  });

  it('registers all declared tools', () => {
    const server = createProductQaMcpServer({
      handlers: {
        answerProductQuestion() {
          throw new Error('not called during construction');
        },
        searchProductDocs() {
          throw new Error('not called during construction');
        },
      },
    });

    expect(Object.keys(getRegisteredTools(server)).sort()).toEqual(
      [...PRODUCT_QA_MCP_TOOL_NAMES].sort(),
    );
  });

  it('returns structured content for search_product_docs', async () => {
    const server = createProductQaMcpServer({
      handlers: {
        answerProductQuestion() {
          throw new Error('answer should not be called');
        },
        searchProductDocs(input) {
          expect(input).toEqual({ query: 'Telegram 通知如何配置？', topK: 2 });
          return Promise.resolve({
            chunks: [
              {
                documentId: 'telegram',
                id: 'telegram-setup',
                lexicalScore: 1,
                metadata: {
                  file: 'docs/product-features/telegram.md',
                  headingPath: ['Telegram 通知'],
                  module: '通知',
                  sourceType: 'official_docs',
                  title: 'Telegram 通知',
                },
                rank: 1,
                score: 1,
                text: 'Telegram 通知可以在 XXYY 内配置。',
                vectorScore: 0,
              },
            ],
            citations: [
              {
                excerpt: 'Telegram 通知可以在 XXYY 内配置。',
                file: 'docs/product-features/telegram.md',
                title: 'Telegram 通知',
              },
            ],
            confidence: 1,
          });
        },
      },
    });

    const handler = getToolHandler<{ query: string; topK?: number }>(server, 'search_product_docs');
    const output = await handler({ query: 'Telegram 通知如何配置？', topK: 2 }, {});

    expect(output).toMatchObject({
      structuredContent: {
        chunks: [{ id: 'telegram-setup' }],
        citations: [{ title: 'Telegram 通知' }],
        confidence: 1,
      },
    });
  });

  it('forwards the MCP channel marker to answer_product_question', async () => {
    let receivedInput: unknown;
    const server = createProductQaMcpServer({
      handlers: {
        answerProductQuestion(input) {
          receivedInput = input;
          return Promise.resolve({
            answer: 'XXYY Pro 提供更多权益。',
            citations: [
              {
                excerpt: 'XXYY Pro 提供更多权益。',
                file: 'docs/product-features/pro.md',
                title: 'XXYY Pro',
              },
            ],
            confidence: 0.8,
            intent: 'product_qa',
          });
        },
        searchProductDocs() {
          throw new Error('search should not be called');
        },
      },
    });

    const handler = getToolHandler<{ channel?: 'agent'; question: string }>(
      server,
      'answer_product_question',
    );
    const output = await handler({ channel: 'agent', question: 'XXYY Pro 有哪些权益？' }, {});

    expect(receivedInput).toEqual({ channel: 'agent', question: 'XXYY Pro 有哪些权益？' });
    expect(output).toMatchObject({
      structuredContent: {
        answer: 'XXYY Pro 提供更多权益。',
        intent: 'product_qa',
      },
    });
  });

  it('blocks answer_product_question output with missing citations', async () => {
    const qualitySignals: unknown[] = [];
    const server = createProductQaMcpServer({
      handlers: {
        answerProductQuestion() {
          return Promise.resolve({
            answer: 'XXYY 一定支持这个未引用功能。',
            citations: [],
            confidence: 0.9,
            intent: 'product_qa',
          });
        },
        searchProductDocs() {
          throw new Error('search should not be called');
        },
      },
      qualitySignals: {
        record(signal) {
          qualitySignals.push(signal);
        },
      },
    });

    const handler = getToolHandler<{ question: string }>(server, 'answer_product_question');
    const output = await handler({ question: 'XXYY 支持这个功能吗？' }, {});

    expect(output).toMatchObject({
      structuredContent: {
        citations: [],
        confidence: 0.25,
        intent: 'product_qa',
      },
    });
    expect(JSON.stringify(output)).toContain('当前知识库没有足够资料确认这个问题');
    expect(JSON.stringify(output)).not.toContain('一定支持');
    expect(qualitySignals).toEqual([
      {
        answer:
          '当前知识库没有足够资料确认这个问题。为了避免误导，我不会编造产品细节；请补充更具体的功能、权益或配置步骤，或稍后在知识库更新后再问。',
        channel: 'agent',
        citationCount: 0,
        confidence: 0.9,
        intent: 'product_qa',
        reason: 'missing_citations',
        redactedQuestion: 'XXYY 支持这个功能吗？',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('blocks answer_product_question output with low confidence', async () => {
    const qualitySignals: unknown[] = [];
    const server = createProductQaMcpServer({
      handlers: {
        answerProductQuestion() {
          return Promise.resolve({
            answer: 'XXYY Pro 价格是 999 USDT。',
            citations: [
              {
                excerpt: 'XXYY Pro 权益说明。',
                file: 'docs/product-features/pro.md',
                title: 'XXYY Pro',
              },
            ],
            confidence: 0.2,
            intent: 'product_qa',
          });
        },
        searchProductDocs() {
          throw new Error('search should not be called');
        },
      },
      qualitySignals: {
        record(signal) {
          qualitySignals.push(signal);
        },
      },
    });

    const handler = getToolHandler<{ question: string }>(server, 'answer_product_question');
    const output = await handler({ question: 'XXYY Pro 价格是多少？' }, {});

    expect(output).toMatchObject({
      structuredContent: {
        citations: [],
        confidence: 0.25,
        intent: 'product_qa',
      },
    });
    expect(JSON.stringify(output)).toContain('当前知识库没有足够资料确认这个问题');
    expect(JSON.stringify(output)).not.toContain('999 USDT');
    expect(qualitySignals).toEqual([
      {
        answer:
          '当前知识库没有足够资料确认这个问题。为了避免误导，我不会编造产品细节；请补充更具体的功能、权益或配置步骤，或稍后在知识库更新后再问。',
        channel: 'agent',
        citationCount: 1,
        confidence: 0.2,
        intent: 'product_qa',
        reason: 'low_confidence',
        redactedQuestion: 'XXYY Pro 价格是多少？',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('blocks answer_product_question output that promises ticket or human handoff handling', async () => {
    const qualitySignals: unknown[] = [];
    const server = createProductQaMcpServer({
      handlers: {
        answerProductQuestion() {
          return Promise.resolve({
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
          });
        },
        searchProductDocs() {
          throw new Error('search should not be called');
        },
      },
      qualitySignals: {
        record(signal) {
          qualitySignals.push(signal);
        },
      },
    });

    const handler = getToolHandler<{ question: string }>(server, 'answer_product_question');
    const output = await handler({ question: 'XXYY Pro 异常怎么处理？' }, {});

    expect(output).toMatchObject({
      structuredContent: {
        citations: [],
        confidence: 0.25,
        intent: 'product_qa',
      },
    });
    expect(JSON.stringify(output)).toContain('不适合自动回复');
    expect(JSON.stringify(output)).not.toMatch(/提交工单|人工客服|人工接管|转人工/u);
    expect(qualitySignals).toEqual([
      {
        answer:
          '当前知识库回答包含不适合自动回复的处理路径。为了避免误导，我不会替你创建处理流程；可以继续问我 XXYY 产品功能、配置步骤或权益说明。',
        channel: 'agent',
        citationCount: 1,
        confidence: 0.88,
        intent: 'product_qa',
        reason: 'handoff_wording',
        redactedQuestion: 'XXYY Pro 异常怎么处理？',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('returns an automatic unavailable answer and records a quality signal when answering fails', async () => {
    const qualitySignals: unknown[] = [];
    const server = createProductQaMcpServer({
      handlers: {
        answerProductQuestion() {
          throw new Error('retriever timeout');
        },
        searchProductDocs() {
          throw new Error('search should not be called');
        },
      },
      qualitySignals: {
        record(signal) {
          qualitySignals.push(signal);
        },
      },
    });

    const handler = getToolHandler<{ channel?: 'web'; question: string }>(
      server,
      'answer_product_question',
    );
    const output = await handler({ channel: 'web', question: 'XXYY Pro 有哪些权益？' }, {});

    expect(output).toMatchObject({
      structuredContent: {
        citations: [],
        confidence: 0.25,
        intent: 'product_qa',
      },
    });
    expect(JSON.stringify(output)).toContain('当前产品知识库暂时不可用');
    expect(JSON.stringify(output)).not.toContain('retriever timeout');
    expect(qualitySignals).toEqual([
      {
        answer:
          '当前产品知识库暂时不可用，无法基于 XXYY 文档确认这个问题。为了避免误导，我不会编造产品细节；请稍后重试，或换成更具体的功能、权益或配置步骤提问。',
        channel: 'web',
        confidence: 0.25,
        errorCode: 'Error',
        intent: 'product_qa',
        reason: 'tool_failure',
        redactedQuestion: 'XXYY Pro 有哪些权益？',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });
});
