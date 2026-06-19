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
            citations: [],
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
});
