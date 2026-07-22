import { describe, expect, it } from 'vitest';

import {
  evaluateEvmChainAnalysisCorpus,
  internalReadinessQualityGate,
  sha256Fingerprint,
} from '@xxyy/evm-chain-analysis-harness';
import { createSyntheticChainAnalysisCorpus } from '@xxyy/evm-chain-analysis-harness/test-fixtures';
import { evaluateProductionReadiness } from './evaluate-production-readiness.js';
import {
  CONTRACT_FIXTURE_TIMES,
  createGovernedContractCorpus,
  createPassingOperationsEvidence,
  createPassingReadinessPolicy,
} from './fixtures/contract-fixtures.test-helper.js';
import { productionReadinessEvaluationInputSchema } from './readiness-contracts.js';

describe('production chain-analysis readiness', () => {
  it('keeps contract-only reviewed data blocked until the immutable internal gate really passes', async () => {
    const { corpusExport } = await createGovernedContractCorpus();
    const corpusReport = evaluateEvmChainAnalysisCorpus(corpusExport.corpus, {
      evaluatedAt: CONTRACT_FIXTURE_TIMES.reportEvaluatedAt,
    });
    const input = {
      corpusExport,
      corpusReport,
      evaluatedAt: CONTRACT_FIXTURE_TIMES.evaluatedAt,
      operationsEvidence: createPassingOperationsEvidence(),
      policy: createPassingReadinessPolicy(),
    };
    const first = evaluateProductionReadiness(input);
    const second = evaluateProductionReadiness(structuredClone(input));

    expect(first).toEqual(second);
    expect(first.status).toBe('blocked');
    expect(first.operations.status).toBe('pass');
    expect(first.corpusQualityGate).toMatchObject({
      gateFingerprint: sha256Fingerprint(internalReadinessQualityGate),
      status: 'fail',
    });
    expect(first.reasons.map((reason) => reason.code)).toEqual(['corpus_quality_gate_failed']);
  });

  it('rejects a valid report when it does not evaluate the governed export', async () => {
    const [{ corpusExport }, syntheticCorpus] = await Promise.all([
      createGovernedContractCorpus(),
      createSyntheticChainAnalysisCorpus(),
    ]);
    const unrelatedReport = evaluateEvmChainAnalysisCorpus(syntheticCorpus, {
      evaluatedAt: CONTRACT_FIXTURE_TIMES.reportEvaluatedAt,
    });
    const result = evaluateProductionReadiness({
      corpusExport,
      corpusReport: unrelatedReport,
      evaluatedAt: CONTRACT_FIXTURE_TIMES.evaluatedAt,
      operationsEvidence: createPassingOperationsEvidence(),
      policy: createPassingReadinessPolicy(),
    });

    expect(result.status).toBe('blocked');
    expect(result.reasons).toContainEqual(
      expect.objectContaining({ code: 'corpus_report_mismatch' }),
    );
  });

  it('does not accept a caller-supplied weaker quality gate', async () => {
    const { corpusExport } = await createGovernedContractCorpus();
    const corpusReport = evaluateEvmChainAnalysisCorpus(corpusExport.corpus, {
      evaluatedAt: CONTRACT_FIXTURE_TIMES.reportEvaluatedAt,
    });
    expect(
      productionReadinessEvaluationInputSchema.safeParse({
        corpusExport,
        corpusReport,
        evaluatedAt: CONTRACT_FIXTURE_TIMES.evaluatedAt,
        operationsEvidence: createPassingOperationsEvidence(),
        policy: createPassingReadinessPolicy(),
        qualityGate: { minCases: 0 },
      }).success,
    ).toBe(false);
  });
});
