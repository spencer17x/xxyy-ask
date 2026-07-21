import { describe, expect, it } from 'vitest';

import type { EvaluationReport, EvaluationResult } from './evaluate.js';
import { formatEvaluationFailureJsonl } from './evaluation-failures.js';

describe('formatEvaluationFailureJsonl', () => {
  it('exports only failed cases as redacted review candidates', () => {
    const email = 'alice@example.com';
    const address = '0x1111111111111111111111111111111111111111';
    const transactionHash = `0x${'2'.repeat(64)}`;
    const apiKey = 'sk-live-super-secret';
    const failed = createResult({
      failureReasons: [`answer contains forbidden text: ${apiKey}`],
      name: 'failed answer',
      passed: false,
      question: `email ${email} address ${address} tx ${transactionHash} api key: ${apiKey}`,
      response: {
        agentRoute: 'product_answer',
        answer: `联系 ${email}，钱包 ${address}，交易 ${transactionHash}，api key: ${apiKey}`,
        citations: [
          {
            excerpt: `address ${address}`,
            file: '/docs/wallet.md',
            title: '钱包说明',
          },
        ],
        confidence: 0.6,
        intent: 'product_qa',
      },
      retrievedChunkIds: ['chunk-current'],
      toolNames: ['search_product_docs'],
    });
    const report: EvaluationReport = {
      passed: 1,
      results: [createResult({ name: 'passing answer', passed: true }), failed],
      total: 2,
    };

    const output = formatEvaluationFailureJsonl(report);
    const records = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      _review: {
        failureReasons: [expect.stringContaining('[sensitive_credential]')],
        observedAgentRoute: 'product_answer',
        observedCitations: [{ file: '/docs/wallet.md', title: '钱包说明' }],
        retrievedChunkIds: ['chunk-current'],
        reviewRequired: true,
        source: 'rag_evaluate',
        toolNames: ['search_product_docs'],
      },
      boundaryExpected: false,
      expectedAgentRoute: 'product_answer',
      expectedIntent: 'product_qa',
      name: 'failed answer',
      referenceFacts: ['5000个地址'],
      relevantChunkIds: ['chunk-current'],
    });
    expect(output).toContain('[email]');
    expect(output).toContain('[evm_address]');
    expect(output).toContain('[transaction_hash]');
    expect(output).not.toContain(email);
    expect(output).not.toContain(address);
    expect(output).not.toContain(transactionHash);
    expect(output).not.toContain(apiKey);
  });

  it('returns an empty string when every case passed', () => {
    expect(
      formatEvaluationFailureJsonl({
        passed: 1,
        results: [createResult({ passed: true })],
        total: 1,
      }),
    ).toBe('');
  });
});

function createResult(overrides: Partial<EvaluationResult>): EvaluationResult {
  return {
    actualAgentRoute: 'product_answer',
    actualIntent: 'product_qa',
    citationCount: 0,
    expectedAgentRoute: 'product_answer',
    expectedIntent: 'product_qa',
    expectedToolNames: ['search_product_docs'],
    failureReasons: [],
    forbiddenChunkIds: ['chunk-old'],
    minCitations: 0,
    name: 'case',
    passed: false,
    question: 'question',
    referenceFacts: ['5000个地址'],
    relevantChunkIds: ['chunk-current'],
    response: {
      answer: 'answer',
      citations: [],
      confidence: 0.8,
      intent: 'product_qa',
    },
    retrievedChunkIds: [],
    toolNames: [],
    ...overrides,
  };
}
