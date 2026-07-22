import { beforeAll, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  composeEvmChainAnalysis,
  evmChainAnalysisPipelineResultSchema,
  type ChainAnalysisCorpus,
} from './index.js';
import { createSyntheticChainAnalysisCorpus } from './fixtures/synthetic-corpus.test-helper.js';

let corpus: ChainAnalysisCorpus;

beforeAll(async () => {
  corpus = await createSyntheticChainAnalysisCorpus();
});

describe('offline EVM chain analysis composition', () => {
  it('composes transaction and MEV cores with canonical provenance', () => {
    const item = getCase('synthetic.confirmed-v2');
    const result = composeEvmChainAnalysis(item.input);

    expect(result.status).toBe('success');
    expect(result.capabilities).toEqual([
      expect.objectContaining({ capability: 'chain.inspect_transaction', status: 'success' }),
      expect.objectContaining({
        capability: 'chain.detect_sandwich',
        status: 'success',
        verdict: 'confirmed',
      }),
    ]);
    expect(result.stages.map(({ name, state, status }) => ({ name, state, status }))).toEqual([
      { name: 'transaction', state: 'completed', status: 'success' },
      { name: 'execution', state: 'not_provided', status: undefined },
      { name: 'observation', state: 'completed', status: 'success' },
      { name: 'mev', state: 'completed', status: 'success' },
    ]);
    expect(result.evidence.map((item) => item.id)).toEqual([
      'pipeline:input',
      'pipeline:stage:transaction',
      'pipeline:stage:observation',
      'pipeline:stage:mev',
    ]);
    expect(result.inputFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.replayFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evmChainAnalysisPipelineResultSchema.parse(result)).toEqual(result);
    expect(canonicalJson(composeEvmChainAnalysis(structuredClone(item.input)))).toBe(
      canonicalJson(result),
    );
  });

  it('fails closed on missing observations and provider conflicts', () => {
    const missing = composeEvmChainAnalysis(getCase('synthetic.missing-observation-v2').input);
    const conflicted = composeEvmChainAnalysis(getCase('synthetic.provider-conflict-v2').input);

    expect(missing).toMatchObject({
      coverage: { mev: 'blocked', observation: 'not_provided' },
      status: 'partial',
    });
    expect(missing.mev).toBeUndefined();
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'observation_missing' }),
    );
    expect(missing.capabilities[1]).toMatchObject({
      capability: 'chain.detect_sandwich',
      refusalCodes: ['observation_missing', 'composition_conflict'],
      status: 'insufficient_data',
    });

    expect(conflicted.status).toBe('partial');
    expect(conflicted.mev?.sandwich.verdict).toBe('insufficient_data');
    expect(conflicted.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'observation_provider_conflict' }),
    );
    expect(conflicted.capabilities[0]).toMatchObject({
      refusalCodes: ['provider_conflict'],
      status: 'partial',
    });
  });

  it('blocks MEV composition when the requested pool disagrees with observation provenance', () => {
    const input = structuredClone(getCase('synthetic.confirmed-v2').input);
    const request = input.requests.find(
      (candidate) => candidate.capability === 'chain.detect_sandwich',
    );
    if (request === undefined) {
      throw new Error('Expected a detection request.');
    }
    request.poolAddress = '0x4444444444444444444444444444444444444444';

    const result = composeEvmChainAnalysis(input);
    expect(result.mev).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'observation_pool_mismatch' }),
    );
    expect(result.capabilities[1]).toMatchObject({
      capability: 'chain.detect_sandwich',
      refusalCodes: ['composition_conflict'],
      status: 'insufficient_data',
    });
  });
});

function getCase(id: string) {
  const item = corpus.cases.find((candidate) => candidate.id === id);
  if (item === undefined) {
    throw new Error(`Missing synthetic corpus case ${id}.`);
  }
  return item;
}
