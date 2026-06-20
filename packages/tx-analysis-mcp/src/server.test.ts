import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import {
  createTxAnalysisMcpServer,
  TX_ANALYSIS_MCP_INSTRUCTIONS,
  TX_ANALYSIS_MCP_TOOL_NAMES,
} from './server.js';

const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

interface RegisteredToolForTest<Input = unknown> {
  handler: (input: Input, extra: unknown) => Promise<unknown>;
}

function getRegisteredTools(
  server: ReturnType<typeof createTxAnalysisMcpServer>,
): Record<string, RegisteredToolForTest | undefined> {
  return (
    server as unknown as { _registeredTools: Record<string, RegisteredToolForTest | undefined> }
  )._registeredTools;
}

function getToolHandler<Input>(
  server: ReturnType<typeof createTxAnalysisMcpServer>,
  name: string,
): RegisteredToolForTest<Input>['handler'] {
  const tool = getRegisteredTools(server)[name] as RegisteredToolForTest<Input> | undefined;
  if (tool === undefined) {
    throw new Error(`${name} tool was not registered`);
  }
  return tool.handler;
}

describe('tx analysis MCP server', () => {
  it('declares stable tool names', () => {
    expect(TX_ANALYSIS_MCP_TOOL_NAMES).toEqual(['analyze_transaction']);
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

  it('registers all declared tools', () => {
    const server = createTxAnalysisMcpServer({
      handlers: {
        analyzeTransaction() {
          throw new Error('not called during construction');
        },
      },
    });

    expect(Object.keys(getRegisteredTools(server)).sort()).toEqual(
      [...TX_ANALYSIS_MCP_TOOL_NAMES].sort(),
    );
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

    const handler = getToolHandler<{ chain?: 'base'; channel?: 'ops'; txHash: string }>(
      server,
      'analyze_transaction',
    );
    await handler({ chain: 'base', channel: 'ops', txHash: evmTx }, {});

    expect(receivedInput).toEqual({
      chain: 'base',
      channel: 'ops',
      txHash: evmTx,
    });
  });

  it('returns analyze_transaction structured content through the MCP transport', async () => {
    let receivedInput: unknown;
    const server = createTxAnalysisMcpServer({
      handlers: {
        analyzeTransaction(input) {
          receivedInput = input;
          return Promise.resolve({
            result: {
              analyzedAt: '2026-06-14T00:00:00.000Z',
              chain: 'base',
              confidence: 0.6,
              dataSource: 'fixture',
              evidence: [],
              relatedTransactions: [],
              summary: '未发现典型 sandwich。',
              txHash: evmTx,
              verdict: 'not_sandwiched',
            },
            status: 'success',
          });
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'tx-analysis-mcp-test', version: '0.0.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        arguments: { chain: 'base', channel: 'web', txHash: evmTx },
        name: 'analyze_transaction',
      });

      expect(receivedInput).toEqual({ chain: 'base', channel: 'web', txHash: evmTx });
      expect(result.structuredContent).toMatchObject({
        result: {
          chain: 'base',
          txHash: evmTx,
          verdict: 'not_sandwiched',
        },
        status: 'success',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('records quality signals for failed transaction analysis results', async () => {
    const qualitySignals: unknown[] = [];
    const server = createTxAnalysisMcpServer({
      handlers: {
        analyzeTransaction() {
          return Promise.resolve({
            failure: {
              message: 'Transaction analysis provider is not configured.',
              reason: 'not_configured',
            },
            status: 'failure',
          });
        },
      },
      qualitySignals: {
        record(signal) {
          qualitySignals.push(signal);
        },
      },
    });

    const handler = getToolHandler<{ chain?: 'base'; channel?: 'ops'; txHash: string }>(
      server,
      'analyze_transaction',
    );

    await handler({ chain: 'base', channel: 'ops', txHash: evmTx }, {});

    expect(qualitySignals).toEqual([
      {
        answer: 'Transaction analysis provider is not configured.',
        channel: 'agent',
        errorCode: 'not_configured',
        intent: 'tx_sandwich_detection',
        reason: 'tx_analysis_failure',
        redactedQuestion: 'base [evm_tx_hash]',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });

  it('returns provider_unavailable and records tool failure quality signals when analysis throws', async () => {
    const qualitySignals: unknown[] = [];
    const server = createTxAnalysisMcpServer({
      handlers: {
        analyzeTransaction() {
          throw new Error('browser crashed with sensitive stack');
        },
      },
      qualitySignals: {
        record(signal) {
          qualitySignals.push(signal);
        },
      },
    });

    const handler = getToolHandler<{ chain?: 'base'; channel?: 'web'; txHash: string }>(
      server,
      'analyze_transaction',
    );

    const output = await handler({ chain: 'base', channel: 'web', txHash: evmTx }, {});

    expect(output).toMatchObject({
      structuredContent: {
        failure: {
          message: 'Transaction analysis provider is temporarily unavailable.',
          reason: 'provider_unavailable',
        },
        status: 'failure',
      },
    });
    expect(JSON.stringify(output)).not.toContain('browser crashed');
    expect(qualitySignals).toEqual([
      {
        answer: 'Transaction analysis provider is temporarily unavailable.',
        channel: 'web',
        errorCode: 'Error',
        intent: 'tx_sandwich_detection',
        reason: 'tool_failure',
        redactedQuestion: 'base [evm_tx_hash]',
        sessionIdPresent: false,
        userIdPresent: false,
      },
    ]);
  });
});
