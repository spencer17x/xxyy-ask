import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { chainDataAdapterKinds, productionDrillKinds } from './operations-contracts.js';
import { mainnetSamplingProtocols, mainnetSamplingSourceKinds } from './sampling-contracts.js';

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(SOURCE_DIRECTORY, '../../..');
const DECISION_DOCUMENT = join(
  REPOSITORY_ROOT,
  'docs/evm-chain-analysis-production-decision-gate.md',
);

describe('production environment and governance decision gate', () => {
  it('locks the confirmed baseline while preserving every production approval boundary', async () => {
    const document = await readFile(DECISION_DOCUMENT, 'utf8');
    const snapshot = extractDecisionSnapshot(document);

    for (const decision of [
      'technical_baseline_decision: approve_recommended',
      "target_chain_ids: ['1']",
      'initial_capability_scope: full_chain_analysis',
      `required_adapters: [${chainDataAdapterKinds.join(', ')}]`,
      `protocols: [${mainnetSamplingProtocols.join(', ')}]`,
      'independent_provider_vendors_per_adapter_chain: 2',
      'deployment_boundary: dedicated_private_control_plane',
      'database_boundary: dedicated_database',
      'selected_source_kinds: [public_rpc, official_explorer_export]',
      'retention_days: 90',
      'identity_source: [platform_service_accounts, controlled_human_accounts]',
      'governance_owner: product_owner',
      'provider_operations_owner: platform_operations',
      'legal_and_retention_owner: product_owner',
      'readiness_policy_owner: technical_owner',
      'mandatory_drill_scope: all_eight_builtin_drills',
      'readiness_acceptance: evaluator_status_must_equal_ready',
    ]) {
      expect(snapshot, decision).toContain(decision);
    }

    expect(mainnetSamplingSourceKinds).toEqual(
      expect.arrayContaining(['official_explorer_export', 'public_rpc']),
    );
    expect(extractMandatoryDrills(document)).toEqual([...productionDrillKinds]);

    for (const boundary of [
      'production_approval_status: unapproved',
      'source_legal_approval_evidence: pending',
      'provider_contract_and_configuration: pending',
      'authorization_grants: pending',
      'operations_and_mainnet_evidence: pending',
      'real_provider_configured: false',
      'real_identity_grants_recorded: false',
      'real_mainnet_evidence_recorded: false',
      'readiness_status: not_evaluated',
    ]) {
      expect(document, boundary).toContain(boundary);
    }

    expect(document).not.toMatch(/\b(?:https?|wss?):\/\/\S+/u);
    expect(document).not.toMatch(/^production_approval_status:\s*approved$/mu);
    expect(document).not.toMatch(
      /^real_(?:provider_configured|identity_grants_recorded|mainnet_evidence_recorded):\s*true$/mu,
    );
    expect(document).not.toMatch(/^readiness_status:\s*ready$/mu);
  });

  it('keeps the documentation index and roadmap confirmation aligned', async () => {
    const [index, roadmap] = await Promise.all([
      readFile(join(REPOSITORY_ROOT, 'docs/README.md'), 'utf8'),
      readFile(join(REPOSITORY_ROOT, 'docs/roadmap.md'), 'utf8'),
    ]);

    expect(index).toContain(
      '[Chain Analysis Production Environment & Governance Decision Gate](evm-chain-analysis-production-decision-gate.md)',
    );
    expect(roadmap).toMatch(
      /- \[x\] 产品负责人确认首批 Ethereum 主网 full-chain-analysis、双独立 Provider/u,
    );
    expect(roadmap).toContain(
      '该技术决策仍不等于真实审批、grant、Provider 配置、主网 evidence 或 `ready` 声明。',
    );
  });
});

function extractDecisionSnapshot(document: string): string {
  const match = /## 已确认决策快照[\s\S]*?```yaml\n(?<snapshot>[\s\S]*?)\n```/u.exec(document);
  expect(match?.groups?.snapshot, 'confirmed decision snapshot').toBeDefined();
  return match?.groups?.snapshot ?? '';
}

function extractMandatoryDrills(document: string): string[] {
  const match = /mandatory_drills:\n(?<drills>(?: {2}- [a-z_]+\n?)+)/u.exec(document);
  expect(match?.groups?.drills, 'mandatory drill list').toBeDefined();
  return (match?.groups?.drills ?? '')
    .trim()
    .split('\n')
    .map((line) => line.replace(/^\s*-\s+/u, ''));
}
