import { describe, expect, it } from 'vitest';

import {
  KNOWLEDGE_OPS_MCP_INSTRUCTIONS,
  KNOWLEDGE_OPS_MCP_TOOL_NAMES,
  createKnowledgeOpsMcpServer,
} from './server.js';

interface RegisteredToolForTest<Input = unknown> {
  handler: (input: Input, extra: unknown) => Promise<unknown>;
}

function getRegisteredTools(
  server: ReturnType<typeof createKnowledgeOpsMcpServer>,
): Record<string, RegisteredToolForTest | undefined> {
  return (
    server as unknown as { _registeredTools: Record<string, RegisteredToolForTest | undefined> }
  )._registeredTools;
}

function getToolHandler<Input>(
  server: ReturnType<typeof createKnowledgeOpsMcpServer>,
  name: string,
): RegisteredToolForTest<Input>['handler'] {
  const tool = getRegisteredTools(server)[name] as RegisteredToolForTest<Input> | undefined;
  if (tool === undefined) {
    throw new Error(`${name} tool was not registered`);
  }
  return tool.handler;
}

describe('knowledge ops MCP server', () => {
  it('declares stable internal knowledge operations tool names', () => {
    expect(KNOWLEDGE_OPS_MCP_TOOL_NAMES).toEqual([
      'list_knowledge_candidates',
      'review_knowledge_candidate',
      'publish_knowledge_candidate',
      'run_knowledge_gate',
      'sync_telegram_support',
    ]);
  });

  it('creates a server with human-review safety instructions', () => {
    const server = createKnowledgeOpsMcpServer({
      handlers: createThrowingHandlers(),
    });

    expect(server).toBeDefined();
    expect(KNOWLEDGE_OPS_MCP_INSTRUCTIONS).toContain('human review');
    expect(KNOWLEDGE_OPS_MCP_INSTRUCTIONS).toContain('must not publish unreviewed');
  });

  it('registers all declared tools', () => {
    const server = createKnowledgeOpsMcpServer({
      handlers: createThrowingHandlers(),
    });

    expect(Object.keys(getRegisteredTools(server)).sort()).toEqual(
      [...KNOWLEDGE_OPS_MCP_TOOL_NAMES].sort(),
    );
  });

  it('returns structured content for review_knowledge_candidate', async () => {
    let receivedInput: unknown;
    const server = createKnowledgeOpsMcpServer({
      handlers: {
        ...createThrowingHandlers(),
        reviewKnowledgeCandidate(input) {
          receivedInput = input;
          return Promise.resolve({
            candidate: {
              confidence: 0.82,
              createdAt: '2026-06-17T02:00:00.000Z',
              existingKnowledgeMatches: [],
              generatedEvalCases: [],
              id: input.id,
              proposedAnswer: '在钱包监控里配置 Telegram Bot。',
              question: 'Telegram 通知怎么设置？',
              redactionReport: { entities: [], riskFlags: [], riskLevel: 'low' },
              reviewer: input.reviewer,
              riskLevel: 'low',
              sourceRefs: [],
              status: 'approved',
              targetCategory: 'product_faq',
              type: 'faq',
              updatedAt: '2026-06-17T03:00:00.000Z',
            },
          });
        },
      },
    });

    const handler = getToolHandler<{
      action: 'approve';
      id: string;
      reviewer: string;
    }>(server, 'review_knowledge_candidate');
    const output = await handler(
      {
        action: 'approve',
        id: 'kc_telegram_setup',
        reviewer: 'ops@example.com',
      },
      {},
    );

    expect(receivedInput).toEqual({
      action: 'approve',
      id: 'kc_telegram_setup',
      reviewer: 'ops@example.com',
    });
    expect(output).toMatchObject({
      structuredContent: {
        candidate: {
          id: 'kc_telegram_setup',
          status: 'approved',
        },
      },
    });
  });
});

function createThrowingHandlers() {
  return {
    listKnowledgeCandidates() {
      throw new Error('listKnowledgeCandidates should not be called');
    },
    publishKnowledgeCandidate() {
      throw new Error('publishKnowledgeCandidate should not be called');
    },
    reviewKnowledgeCandidate() {
      throw new Error('reviewKnowledgeCandidate should not be called');
    },
    runKnowledgeGate() {
      throw new Error('runKnowledgeGate should not be called');
    },
    syncTelegramSupport() {
      throw new Error('syncTelegramSupport should not be called');
    },
  };
}
