import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ChatResponse } from '@xxyy/shared';
import {
  PRODUCT_TOOL_NAMES,
  answerProductQuestionInputSchema,
  searchProductDocsInputSchema,
  sanitizeSessionText,
  type QualitySignalReason,
  type QualitySignalSink,
} from '@xxyy/agent-core';

import type { ProductQaToolHandlers } from './tools.js';

export const PRODUCT_QA_MCP_TOOL_NAMES = PRODUCT_TOOL_NAMES;
const PRODUCT_ANSWER_CONFIDENCE_THRESHOLD = 0.45;

export const PRODUCT_QA_MCP_INSTRUCTIONS = [
  'Use this server for XXYY product support questions, feature explanations, setup steps, and public documentation lookup.',
  'Do not use this server for private account, wallet balance, order, private transaction history, or user identity lookup.',
  'Do not execute business actions such as opening, canceling, modifying, or recovering user account/order/product state; answer only general product steps when asked how to do it.',
  'Do not provide investment advice.',
  'Do not invent live product data when retrieval or answering is unavailable.',
  'Do not return low-confidence product answers or product answers without citations as confirmed facts.',
  'Do not promise a person will take over the conversation or create a case for the user.',
].join(' ');

export interface CreateProductQaMcpServerOptions {
  handlers: ProductQaToolHandlers;
  qualitySignals?: QualitySignalSink;
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
      const guarded = guardProductAnswerOutput(
        await options.handlers.answerProductQuestion({
          ...(channel === undefined ? {} : { channel }),
          question,
        }),
      );
      if (guarded.reason !== undefined) {
        recordProductQualitySignal(options.qualitySignals, {
          answer: guarded.response.answer,
          channel: channel ?? 'agent',
          citationCount: guarded.original.citations.length,
          confidence: guarded.original.confidence,
          intent: guarded.original.intent,
          question,
          reason: guarded.reason,
        });
      }
      const output = guarded.response;
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

interface GuardedProductAnswer {
  original: ChatResponse;
  reason?: QualitySignalReason;
  response: ChatResponse;
}

function guardProductAnswerOutput(output: ChatResponse): GuardedProductAnswer {
  if (containsCustomerHandoffPromise(output.answer)) {
    return {
      original: output,
      reason: 'handoff_wording',
      response: {
        answer:
          '当前知识库回答包含不适合自动回复的处理路径。为了避免误导，我不会替你创建处理流程；可以继续问我 XXYY 产品功能、配置步骤或权益说明。',
        citations: [],
        confidence: 0.25,
        intent: output.intent,
      },
    };
  }

  if (isGroundedProductIntent(output.intent) && hasInsufficientProductGrounding(output)) {
    return {
      original: output,
      reason: productGroundingQualityReason(output),
      response: createProductKnowledgeInsufficientAnswer(output.intent),
    };
  }

  return { original: output, response: output };
}

function recordProductQualitySignal(
  qualitySignals: QualitySignalSink | undefined,
  input: {
    answer: string;
    channel: 'agent' | 'cli' | 'telegram' | 'web';
    citationCount: number;
    confidence: number;
    intent: ChatResponse['intent'];
    question: string;
    reason: QualitySignalReason;
  },
): void {
  qualitySignals?.record({
    answer: sanitizeSessionText(input.answer),
    channel: input.channel,
    citationCount: input.citationCount,
    confidence: input.confidence,
    intent: input.intent,
    reason: input.reason,
    redactedQuestion: sanitizeSessionText(input.question),
    sessionIdPresent: false,
    userIdPresent: false,
  });
}

function createProductKnowledgeInsufficientAnswer(intent: ChatResponse['intent']): ChatResponse {
  return {
    answer:
      '当前知识库没有足够资料确认这个问题。为了避免误导，我不会编造产品细节；请补充更具体的功能、权益或配置步骤，或稍后在知识库更新后再问。',
    citations: [],
    confidence: 0.25,
    intent,
  };
}

function isGroundedProductIntent(intent: ChatResponse['intent']): boolean {
  return intent === 'product_qa' || intent === 'how_to';
}

function hasInsufficientProductGrounding(output: ChatResponse): boolean {
  return output.citations.length === 0 || output.confidence < PRODUCT_ANSWER_CONFIDENCE_THRESHOLD;
}

function productGroundingQualityReason(output: ChatResponse): QualitySignalReason {
  const missingCitations = output.citations.length === 0;
  const lowConfidence = output.confidence < PRODUCT_ANSWER_CONFIDENCE_THRESHOLD;

  if (missingCitations && lowConfidence) {
    return 'low_confidence_missing_citations';
  }

  return missingCitations ? 'missing_citations' : 'low_confidence';
}

function containsCustomerHandoffPromise(answer: string): boolean {
  return /提交工单|创建工单|工单.{0,12}(?:处理|跟进|回复)|转人工|人工接管|联系人工客服|人工客服.{0,12}(?:接管|处理|跟进|回复)|人工.{0,12}(?:接管|处理|跟进|回复)/u.test(
    answer,
  );
}
