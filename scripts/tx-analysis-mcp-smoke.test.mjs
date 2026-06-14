import { describe, expect, it } from 'vitest';

import {
  normalizeTxAnalysisMcpSmokeSample,
  validateTxAnalysisMcpSmokeToolOutput,
} from './tx-analysis-mcp-smoke.mjs';

describe('tx-analysis MCP smoke output validation', () => {
  it('requires failure reason and message even when the sample only expects failure status', () => {
    const sample = normalizeTxAnalysisMcpSmokeSample({
      expectedStatus: 'failure',
      label: 'failure payload',
      txHash: 'not-a-transaction-hash',
    });

    expect(
      validateTxAnalysisMcpSmokeToolOutput(sample, {
        structuredContent: {
          failure: {},
          status: 'failure',
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('failure.reason must be one of:'),
        'failure.message must be a non-empty string.',
      ]),
    );
  });

  it('accepts a supported failure reason and non-empty message', () => {
    const sample = normalizeTxAnalysisMcpSmokeSample({
      expectedStatus: 'failure',
      label: 'failure payload',
      txHash: 'not-a-transaction-hash',
    });

    expect(
      validateTxAnalysisMcpSmokeToolOutput(sample, {
        structuredContent: {
          failure: {
            message: 'Transaction reference is invalid or ambiguous.',
            reason: 'invalid_reference',
          },
          status: 'failure',
        },
      }),
    ).toEqual([]);
  });
});
