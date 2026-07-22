import { beforeAll, describe, expect, it } from 'vitest';

import {
  chainAnalysisCorpusSchema,
  evmChainAnalysisPipelineInputSchema,
  type ChainAnalysisCorpus,
} from './index.js';
import { createSyntheticChainAnalysisCorpus } from './fixtures/synthetic-corpus.test-helper.js';

let corpus: ChainAnalysisCorpus;

beforeAll(async () => {
  corpus = await createSyntheticChainAnalysisCorpus();
});

describe('chain analysis composition contracts', () => {
  it('keeps the future capability input transport-neutral and bounded', () => {
    const input = corpus.cases[0]!.input;

    expect(() =>
      evmChainAnalysisPipelineInputSchema.parse({
        ...input,
        endpoint: 'https://rpc.example/private',
      }),
    ).toThrow();
    expect(() =>
      evmChainAnalysisPipelineInputSchema.parse({
        ...input,
        requests: input.requests.map((request, index) =>
          index === 0 ? { ...request, providerId: 'rpc_primary' } : request,
        ),
      }),
    ).toThrow();
    expect(() =>
      evmChainAnalysisPipelineInputSchema.parse({
        ...input,
        requests: [input.requests[0], input.requests[0]],
      }),
    ).toThrow();
  });

  it('requires reviewed cases to be privacy-safe and independently attributable', () => {
    const reviewed = structuredClone(corpus);
    const first = reviewed.cases[0]!;
    first.review = {
      reviewedAt: '2026-07-22T01:00:00.000Z',
      reviewerIdHash: `sha256:${'11'.repeat(32)}`,
      sourcePayloadHashes: [`sha256:${'22'.repeat(32)}`],
      tier: 'reviewed',
    };

    expect(() => chainAnalysisCorpusSchema.parse(reviewed)).toThrow(/public-chain address policy/u);

    const privateCorpus = structuredClone(corpus);
    privateCorpus.cases[0]!.privacy.containsPrivateData = true as false;
    expect(() => chainAnalysisCorpusSchema.parse(privateCorpus)).toThrow();
  });

  it('aligns expected capability labels exactly with request order', () => {
    const invalid = structuredClone(corpus);
    invalid.cases[0]!.expected.capabilities.reverse();
    expect(() => chainAnalysisCorpusSchema.parse(invalid)).toThrow(/request order/u);
  });
});
