import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createSkillResultSchema,
  evidenceItemSchema,
  skillResultSchema,
} from './domain-contract.js';

function createValidResult() {
  return {
    diagnostics: [
      {
        code: 'calculation_complete',
        evidenceIds: ['calc:fee:1'],
        retryable: false,
        stage: 'calculate',
      },
    ],
    evidence: [
      {
        confidence: 1,
        id: 'calc:fee:1',
        kind: 'calculation',
        source: 'fixture',
        structuredData: { feeWei: '21000' },
        supports: ['fee_finding'],
      },
    ],
    findings: [
      {
        confidence: 1,
        evidenceIds: ['calc:fee:1'],
        id: 'fee_finding',
        inference: false,
        statement: 'The fee is 21000 wei.',
      },
    ],
    skill: 'transaction_analysis',
    status: 'success',
    summary: 'Transaction analysis completed.',
    version: '1.0.0',
    warnings: [],
  } as const;
}

describe('domain evidence contract', () => {
  it('accepts bounded evidence with lossless chain identifiers', () => {
    expect(
      evidenceItemSchema.parse({
        blockNumber: '900719925474099312345',
        chainId: '1',
        confidence: 0.95,
        id: 'tx:1:abc',
        kind: 'transaction',
        source: 'rpc-primary',
        supports: ['execution_status'],
        transactionHash: '0xabc',
      }),
    ).toMatchObject({
      blockNumber: '900719925474099312345',
      confidence: 0.95,
    });
  });

  it('represents independently sourced protocol metadata without calling it a document', () => {
    expect(
      evidenceItemSchema.parse({
        chainId: '1',
        confidence: 1,
        id: 'pool:1:abc',
        kind: 'metadata',
        source: 'pool-registry',
        structuredData: { protocol: 'uniswap_v3' },
        supports: ['dex_swaps'],
      }),
    ).toMatchObject({ kind: 'metadata', source: 'pool-registry' });
  });

  it('rejects out-of-range confidence and evidence without supported claims', () => {
    expect(() =>
      evidenceItemSchema.parse({
        confidence: 1.1,
        id: 'evidence:1',
        kind: 'calculation',
        source: 'fixture',
        supports: [],
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects structured evidence that is not JSON-safe', () => {
    expect(() =>
      evidenceItemSchema.parse({
        confidence: 1,
        id: 'evidence:1',
        kind: 'calculation',
        source: 'fixture',
        structuredData: { exactAmount: 1n },
        supports: ['exact_amount'],
      }),
    ).toThrow(z.ZodError);
  });
});

describe('skill result contract', () => {
  it('accepts a result whose findings, evidence, and diagnostics are referentially complete', () => {
    expect(skillResultSchema.parse(createValidResult())).toEqual(createValidResult());
  });

  it('rejects duplicate ids and references to unknown findings or evidence', () => {
    const valid = createValidResult();

    expect(() =>
      skillResultSchema.parse({
        ...valid,
        evidence: [valid.evidence[0], valid.evidence[0]],
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      skillResultSchema.parse({
        ...valid,
        evidence: [{ ...valid.evidence[0], supports: ['missing_finding'] }],
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      skillResultSchema.parse({
        ...valid,
        findings: [{ ...valid.findings[0], evidenceIds: ['missing:evidence'] }],
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      skillResultSchema.parse({
        ...valid,
        diagnostics: [{ ...valid.diagnostics[0], evidenceIds: ['missing:evidence'] }],
      }),
    ).toThrow(z.ZodError);
  });

  it('preserves reference validation when a domain skill extends the common result', () => {
    const extendedSchema = createSkillResultSchema({
      skill: z.literal('transaction_analysis'),
      transactionHash: z.string(),
    });

    expect(
      extendedSchema.parse({
        ...createValidResult(),
        transactionHash: '0xabc',
      }),
    ).toMatchObject({ skill: 'transaction_analysis', transactionHash: '0xabc' });
    expect(() =>
      extendedSchema.parse({
        ...createValidResult(),
        evidence: [],
        transactionHash: '0xabc',
      }),
    ).toThrow(z.ZodError);
  });
});
