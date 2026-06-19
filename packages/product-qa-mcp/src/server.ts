import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  PRODUCT_TOOL_NAMES,
  answerProductQuestionInputSchema,
  searchProductDocsInputSchema,
} from '@xxyy/agent-core';

import type { ProductQaToolHandlers } from './tools.js';

export const PRODUCT_QA_MCP_TOOL_NAMES = PRODUCT_TOOL_NAMES;

export const PRODUCT_QA_MCP_INSTRUCTIONS = [
  'Use this server for XXYY product support questions, feature explanations, setup steps, and public documentation lookup.',
  'Do not use this server for private account, wallet balance, order, private transaction history, or user identity lookup.',
  'Do not execute business actions such as opening, canceling, modifying, or recovering user account/order/product state; answer only general product steps when asked how to do it.',
  'Do not provide investment advice.',
  'Do not invent live product data when retrieval or answering is unavailable.',
].join(' ');

export interface CreateProductQaMcpServerOptions {
  handlers: ProductQaToolHandlers;
}

export function createProductQaMcpServer(options: CreateProductQaMcpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: 'xxyy-product-support',
      version: '0.1.0',
    },
    {
      instructions: PRODUCT_QA_MCP_INSTRUCTIONS,
    },
  );

  server.registerTool(
    PRODUCT_QA_MCP_TOOL_NAMES[0],
    {
      description: 'Search XXYY product documentation and return matching chunks with citations.',
      inputSchema: searchProductDocsInputSchema,
      title: 'Search XXYY Product Docs',
    },
    async ({ query, topK }) => {
      const output = await options.handlers.searchProductDocs({
        query,
        ...(topK === undefined ? {} : { topK }),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    PRODUCT_QA_MCP_TOOL_NAMES[1],
    {
      description: 'Answer an XXYY product support question using the product knowledge base.',
      inputSchema: answerProductQuestionInputSchema,
      title: 'Answer XXYY Product Question',
    },
    async ({ channel, question }) => {
      const output = await options.handlers.answerProductQuestion({
        ...(channel === undefined ? {} : { channel }),
        question,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
