import { describe, expect, it } from 'vitest';

import {
  createTxAnalysisMcpServer,
  TX_ANALYSIS_MCP_INSTRUCTIONS,
  TX_ANALYSIS_MCP_TOOL_NAMES,
} from './server.js';

const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

interface RegisteredToolForTest {
  handler: (
    input: { chain?: 'base'; channel?: 'ops'; txHash: string },
    extra: unknown,
  ) => Promise<unknown>;
}

function getAnalyzeTransactionToolHandler(
  server: ReturnType<typeof createTxAnalysisMcpServer>,
): RegisteredToolForTest['handler'] {
  const registeredTools = (
    server as unknown as { _registeredTools: Record<string, RegisteredToolForTest | undefined> }
  )._registeredTools;
  const tool = registeredTools.analyze_transaction;
  if (tool === undefined) {
    throw new Error('analyze_transaction tool was not registered');
  }
  return tool.handler;
}

describe('tx analysis MCP server', () => {
  it('declares stable tool names', () => {
    expect(TX_ANALYSIS_MCP_TOOL_NAMES).toEqual([
      'analyze_transaction',
      'get_analysis_report',
      'list_analysis_reports',
    ]);
  });

  it('creates a server with transaction analysis instructions', () => {
    const server = createTxAnalysisMcpServer({
      handlers: {
        analyzeTransaction() {
          throw new Error('not called during construction');
        },
      },
    });

    expect(server).toBeDefined();
    expect(TX_ANALYSIS_MCP_INSTRUCTIONS).toContain('unknown');
    expect(TX_ANALYSIS_MCP_INSTRUCTIONS).toContain('Do not provide investment advice');
  });

  it('forwards the MCP channel marker to the transaction handler', async () => {
    let receivedInput: unknown;
    const server = createTxAnalysisMcpServer({
      handlers: {
        analyzeTransaction(input) {
          receivedInput = input;
          return Promise.resolve({
            failure: {
              message: 'not configured',
              reason: 'not_configured',
            },
            status: 'failure',
          });
        },
      },
    });

    const handler = getAnalyzeTransactionToolHandler(server);
    await handler({ chain: 'base', channel: 'ops', txHash: evmTx }, {});

    expect(receivedInput).toEqual({
      chain: 'base',
      channel: 'ops',
      txHash: evmTx,
    });
  });
});
