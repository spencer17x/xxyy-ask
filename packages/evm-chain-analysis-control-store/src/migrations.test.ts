import { describe, expect, it } from 'vitest';

import {
  CHAIN_ANALYSIS_CONTROL_STORE_MIGRATIONS,
  migrateEvmChainAnalysisControlStore,
} from './index.js';
import { ScriptedPgClient } from './scripted-pg.test-helper.js';

describe('chain-analysis control-store migrations', () => {
  it('creates idempotent governance, sampling, audit, retention, budget, and circuit tables', async () => {
    const client = new ScriptedPgClient();

    await migrateEvmChainAnalysisControlStore(client);

    const sql = client.queries
      .map((query) => query.sql)
      .join('\n')
      .toLowerCase();
    expect(sql).toContain('create table if not exists evm_chain_control_replay_candidates');
    expect(sql).toContain('create table if not exists evm_chain_control_retention_jobs');
    expect(sql).toContain('create table if not exists evm_chain_control_audit_events');
    expect(sql).toContain('create table if not exists evm_chain_control_budget_windows');
    expect(sql).toContain('create table if not exists evm_chain_control_circuit_heads');
    expect(sql).toContain('create table if not exists evm_chain_control_sampling_approvals');
    expect(sql).toContain('create table if not exists evm_chain_control_sampling_plans');
    expect(sql).toContain('create table if not exists evm_chain_control_sampling_manifests');
    expect(sql).toContain(
      'create table if not exists evm_chain_control_sampling_candidate_handoffs',
    );
    expect(sql).toContain('create table if not exists evm_chain_control_sampling_jobs');
    expect(sql).toContain('create table if not exists evm_chain_control_review_work_jobs');
    expect(sql).toContain('evm_chain_control_review_work_jobs_reviewer_idx');
    expect(sql).toContain("status in ('running', 'succeeded')");
    expect(sql).toContain('before update or delete');
    expect(sql).toContain('unique (candidate_id, reviewer_id_hash)');
    expect(CHAIN_ANALYSIS_CONTROL_STORE_MIGRATIONS.length).toBeGreaterThan(20);
    expect(client.transactionEvents).toEqual(['begin', 'commit']);
  });
});
