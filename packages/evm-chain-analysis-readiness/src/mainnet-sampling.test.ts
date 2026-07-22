import { describe, expect, it } from 'vitest';

import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';

import {
  contractEvmHash,
  contractHash,
  createContractOnlyManifestForSlot,
  createContractOnlySamplingFixture,
} from './fixtures/contract-fixtures.test-helper.js';
import {
  createMainnetSamplingPolicy,
  createPublicChainSampleManifest,
  evaluateMainnetSamplingCoverage,
  mainnetSamplingPlanSchema,
  materializeMainnetSamplingPlan,
} from './index.js';
import type { MainnetSamplingError } from './index.js';

describe('mainnet sampling plan and evidence-intake contracts', () => {
  it('normalizes approval evidence and deterministically expands quota slots', () => {
    const { approval, plan, policy } = createContractOnlySamplingFixture();
    const reproduced = materializeMainnetSamplingPlan(approval, policy, '2026-07-22T12:00:00.000Z');

    expect(approval.approvedByHashes).toEqual([...approval.approvedByHashes].sort());
    expect(policy.targetChainIds).toEqual(['1', '137']);
    expect(policy.totalTargetSamples).toBe(3);
    expect(plan.slots).toHaveLength(3);
    expect(new Set(plan.slots.map((slot) => slot.slotId)).size).toBe(3);
    expect(reproduced).toEqual(plan);
  });

  it('rejects a policy that omits required protocol, route, outcome, data, or incident strata', () => {
    const { approval } = createContractOnlySamplingFixture();

    expect(() =>
      createMainnetSamplingPolicy(approval, {
        createdAt: '2026-07-22T00:00:00.000Z',
        policyName: 'contract-only-incomplete-policy',
        samplingEndsAt: '2026-07-30T00:00:00.000Z',
        samplingStartsAt: '2026-07-23T00:00:00.000Z',
        strata: [
          {
            chainCondition: 'canonical',
            chainId: '1',
            dataCompleteness: 'complete',
            protocol: 'uniswap_v2',
            routeClass: 'direct_pool',
            targetLabel: 'positive',
            targetSamples: 1,
            tokenBehavior: 'standard',
          },
        ],
      }),
    ).toThrow(/missing baseline/u);
  });

  it('rejects a self-consistent plan fingerprint when a stratum quota slot is omitted', () => {
    const { plan } = createContractOnlySamplingFixture();
    const { planFingerprint: _planFingerprint, planId: _planId, ...originalBody } = plan;
    const body = {
      ...originalBody,
      slots: plan.slots.slice(1),
      totalTargetSamples: plan.totalTargetSamples - 1,
    };
    const planFingerprint = sha256Fingerprint(body);

    expect(
      mainnetSamplingPlanSchema.safeParse({
        ...body,
        planFingerprint,
        planId: `sampling_plan_${planFingerprint.slice(7)}`,
      }).success,
    ).toBe(false);
  });

  it('binds manifests to approved sources, plan slots, dimensions, reorg evidence, and retention', () => {
    const { manifests, plan } = createContractOnlySamplingFixture();

    expect(manifests).toHaveLength(plan.totalTargetSamples);
    expect(manifests.every((manifest) => manifest.planFingerprint === plan.planFingerprint)).toBe(
      true,
    );
    expect(
      manifests.find((manifest) => manifest.chainCondition === 'provider_conflict')
        ?.providerObservationHashes,
    ).toHaveLength(2);
    expect(
      manifests.find((manifest) => manifest.chainCondition === 'reorged')?.reorgEvidence,
    ).toBeDefined();
    expect(manifests[0]!.retainUntil).toBe('2026-08-23T00:00:00.000Z');
  });

  it('fails closed when a manifest source or collection window is outside the plan', () => {
    const { plan } = createContractOnlySamplingFixture();
    const slot = plan.slots[0]!;
    const common = {
      blockHash: contractEvmHash('outside-window-block'),
      blockNumber: '20000001',
      collectedAt: '2026-08-01T00:00:00.000Z',
      credentialScan: 'passed' as const,
      privateDataScan: 'passed' as const,
      providerObservationHashes: [contractHash('provider')],
      scannedAt: '2026-08-01T00:00:00.000Z',
      scannerVersion: 'contract-only-scanner-v1',
      slotId: slot.slotId,
      sourceKind: 'public_rpc' as const,
      sourcePayloadHashes: [contractHash('payload')],
      transactionHash: contractEvmHash('outside-window-transaction'),
      transactionIndex: 0,
    };

    expect(() => createPublicChainSampleManifest(plan, common)).toThrowError(
      expect.objectContaining<Partial<MainnetSamplingError>>({ code: 'manifest_outside_window' }),
    );
    expect(() =>
      createPublicChainSampleManifest(plan, {
        ...common,
        collectedAt: '2026-07-24T00:00:00.000Z',
        scannedAt: '2026-07-24T00:00:00.000Z',
        sourceKind: 'protocol_event_archive',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<MainnetSamplingError>>({ code: 'source_not_approved' }),
    );
  });

  it('reports complete deterministic coverage for one accepted manifest per slot', () => {
    const { approval, manifests, plan } = createContractOnlySamplingFixture();
    const result = evaluateMainnetSamplingCoverage({
      approval,
      evaluatedAt: '2026-07-25T00:00:00.000Z',
      manifests: [...manifests].reverse(),
      plan,
    });
    const reproduced = evaluateMainnetSamplingCoverage({
      approval,
      evaluatedAt: '2026-07-25T00:00:00.000Z',
      manifests,
      plan,
    });

    expect(result.status).toBe('complete');
    expect(result.reasonCodes).toEqual([]);
    expect(result.coverage.every((row) => row.remainingSamples === 0)).toBe(true);
    expect(reproduced.runFingerprint).toBe(result.runFingerprint);
  });

  it('deduplicates chain/transaction identities across quota slots', () => {
    const { approval, manifests, plan } = createContractOnlySamplingFixture();
    const chainOneSlots = plan.slots.filter((slot) => {
      const stratum = plan.strata.find((candidate) => candidate.stratumId === slot.stratumId)!;
      return stratum.chainId === '1';
    });
    const first = createContractOnlyManifestForSlot(
      plan,
      chainOneSlots[0]!.slotId,
      7,
      contractEvmHash('duplicate-transaction'),
    );
    const second = createContractOnlyManifestForSlot(
      plan,
      chainOneSlots[1]!.slotId,
      8,
      contractEvmHash('duplicate-transaction'),
    );
    const other = manifests.find((manifest) => manifest.chainId === '137')!;
    const result = evaluateMainnetSamplingCoverage({
      approval,
      evaluatedAt: '2026-07-25T00:00:00.000Z',
      manifests: [first, second, other],
      plan,
    });

    expect(result.status).toBe('in_progress');
    expect(result.reasonCodes).toContain('duplicate_sample_identity');
    expect(result.reasonCodes).toContain('quota_missing');
    expect(result.rejectedManifests).toHaveLength(1);
  });

  it('blocks coverage evaluation after approval expiry even when quotas are present', () => {
    const { approval, manifests, plan } = createContractOnlySamplingFixture();
    const result = evaluateMainnetSamplingCoverage({
      approval,
      evaluatedAt: approval.validUntil,
      manifests,
      plan,
    });

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toContain('approval_expired');
  });
});
