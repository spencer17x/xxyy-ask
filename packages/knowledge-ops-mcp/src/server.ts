import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  KNOWLEDGE_OPS_TOOL_NAMES,
  listKnowledgeCandidatesInputSchema,
  publishKnowledgeCandidateInputSchema,
  reviewKnowledgeCandidateInputSchema,
  runKnowledgeGateInputSchema,
  syncTelegramSupportInputSchema,
} from '@xxyy/agent-core';

import type { KnowledgeOpsToolHandlers } from './tools.js';

export const KNOWLEDGE_OPS_MCP_TOOL_NAMES = KNOWLEDGE_OPS_TOOL_NAMES;

export const KNOWLEDGE_OPS_MCP_INSTRUCTIONS = [
  'Use this internal server for XXYY knowledge operations: Telegram support sync, knowledge candidate review, approved-only publishing, and post-publish eval gates.',
  'First version requires human review before publishing; tools must not publish unreviewed or rejected knowledge candidates.',
  'Unreviewed Telegram support messages must remain candidate knowledge and must not enter the production RAG knowledge base.',
].join(' ');

export interface CreateKnowledgeOpsMcpServerOptions {
  handlers: KnowledgeOpsToolHandlers;
}

export function createKnowledgeOpsMcpServer(
  options: CreateKnowledgeOpsMcpServerOptions,
): McpServer {
  const server = new McpServer(
    {
      name: 'xxyy-knowledge-ops',
      version: '0.1.0',
    },
    {
      instructions: KNOWLEDGE_OPS_MCP_INSTRUCTIONS,
    },
  );

  server.registerTool(
    KNOWLEDGE_OPS_MCP_TOOL_NAMES[0],
    {
      description: 'List XXYY knowledge candidates in the human review queue.',
      inputSchema: listKnowledgeCandidatesInputSchema,
      title: 'List Knowledge Candidates',
    },
    async (input) => toMcpToolOutput(await options.handlers.listKnowledgeCandidates(input)),
  );

  server.registerTool(
    KNOWLEDGE_OPS_MCP_TOOL_NAMES[1],
    {
      description: 'Apply a human review decision to one XXYY knowledge candidate.',
      inputSchema: reviewKnowledgeCandidateInputSchema,
      title: 'Review Knowledge Candidate',
    },
    async (input) => toMcpToolOutput(await options.handlers.reviewKnowledgeCandidate(input)),
  );

  server.registerTool(
    KNOWLEDGE_OPS_MCP_TOOL_NAMES[2],
    {
      description: 'Publish one approved XXYY knowledge candidate to reviewed support knowledge.',
      inputSchema: publishKnowledgeCandidateInputSchema,
      title: 'Publish Knowledge Candidate',
    },
    async (input) => toMcpToolOutput(await options.handlers.publishKnowledgeCandidate(input)),
  );

  server.registerTool(
    KNOWLEDGE_OPS_MCP_TOOL_NAMES[3],
    {
      description: 'Run ingest, embeddings, and targeted eval gate for a published candidate.',
      inputSchema: runKnowledgeGateInputSchema,
      title: 'Run Knowledge Gate',
    },
    async (input) => toMcpToolOutput(await options.handlers.runKnowledgeGate(input)),
  );

  server.registerTool(
    KNOWLEDGE_OPS_MCP_TOOL_NAMES[4],
    {
      description: 'Run authorized Telegram support sync to create review-only candidates.',
      inputSchema: syncTelegramSupportInputSchema,
      title: 'Sync Telegram Support Knowledge',
    },
    async (input) => toMcpToolOutput(await options.handlers.syncTelegramSupport(input)),
  );

  return server;
}

function toMcpToolOutput(output: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  };
}
