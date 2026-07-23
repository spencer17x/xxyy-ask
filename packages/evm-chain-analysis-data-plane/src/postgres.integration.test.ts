import type { PoolClient, QueryResult } from 'pg';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  createGovernanceAuthorization,
  createPgEvmChainAnalysisProviderControlStore,
  migrateEvmChainAnalysisControlStore,
  type PgControlClientLike,
  type PgControlQueryResult,
  type PgControlTransactionClientLike,
} from '@xxyy/evm-chain-analysis-control-store';

import { createDataPlaneManifestFixture, testHash } from './fixtures.test-helper.js';
import { bootstrapProductionProviderControls } from './data-plane.js';
import { createManagedProviderFetch } from './managed-fetch.js';
import { resolveProductionProviders } from './secret-resolver.js';

const databaseUrl = process.env.CHAIN_DATA_PLANE_INTEGRATION_DATABASE_URL;
const integrationDescribe = databaseUrl === undefined ? describe.skip : describe;

integrationDescribe('managed data-plane PostgreSQL integration', () => {
  it('atomically persists provider usage and immutable request audit', async () => {
    if (databaseUrl === undefined) {
      throw new Error('CHAIN_DATA_PLANE_INTEGRATION_DATABASE_URL is required.');
    }
    const pool = new Pool({
      allowExitOnIdle: true,
      connectionString: databaseUrl,
      max: 4,
    });
    try {
      const client = createIntegrationControlClient(pool);
      await migrateEvmChainAnalysisControlStore(client);
      await migrateEvmChainAnalysisControlStore(client);
      expect(await tableCount(pool, 'evm_chain_control_authorizations')).toBe(0);

      const instanceIdHash = testHash('postgres-integration-runtime');
      const authorization = createGovernanceAuthorization({
        grantedAt: '2026-07-23T00:00:00.000Z',
        grantedByHash: testHash('postgres-integration-owner'),
        principalIdHash: instanceIdHash,
        roles: ['provider_operator'],
        validUntil: '2027-07-23T00:00:00.000Z',
      });
      await pool.query(
        `
          insert into evm_chain_control_authorizations (
            authorization_id,
            authorization_fingerprint,
            principal_id_hash,
            roles,
            granted_at,
            valid_until,
            payload
          ) values ($1, $2, $3, $4::text[], $5::timestamptz, $6::timestamptz, $7::jsonb)
        `,
        [
          authorization.authorizationId,
          authorization.authorizationFingerprint,
          authorization.principalIdHash,
          authorization.roles,
          authorization.grantedAt,
          authorization.validUntil,
          JSON.stringify(authorization),
        ],
      );

      const manifest = createDataPlaneManifestFixture();
      const secrets = new Map<string, string>();
      for (const binding of manifest.providers) {
        secrets.set(
          binding.descriptor.endpointSecretRef,
          `https://${binding.descriptor.providerId}.rpc.invalid/v1`,
        );
        for (const header of binding.credentialHeaders) {
          secrets.set(header.secretRef, `Bearer ${binding.descriptor.providerId}`);
        }
      }
      const resolved = await resolveProductionProviders(manifest, {
        resolve(secretRef) {
          return Promise.resolve(secrets.get(secretRef) ?? '');
        },
      });
      const store = createPgEvmChainAnalysisProviderControlStore({
        client,
        coordinatorInstanceIdHash: instanceIdHash,
        now: () => '2026-07-23T00:02:00.000Z',
      });
      await bootstrapProductionProviderControls({
        actorIdHash: instanceIdHash,
        bootstrappedAt: '2026-07-23T00:01:00.000Z',
        controls: store,
        manifest,
      });

      const provider = resolved.providers.find(
        (candidate) =>
          candidate.adapter === 'snapshot' &&
          candidate.binding.descriptor.providerId === 'snapshot_primary',
      );
      expect(provider).toBeDefined();
      if (provider === undefined) {
        throw new Error('Snapshot integration provider is missing.');
      }
      const managedFetch = createManagedProviderFetch({
        adapter: 'snapshot',
        chainId: '1',
        controls: store,
        fetchImpl: () => Promise.resolve(new Response('[]', { status: 200 })),
        instanceIdHash,
        manifestFingerprint: manifest.manifestFingerprint,
        now: () => '2026-07-23T00:02:00.000Z',
        nowMs: () => 120_000,
        providers: [provider],
        transport: manifest.transport.snapshot,
      });
      const response = await managedFetch(provider.endpoint, {
        body: JSON.stringify([{ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }]),
        headers: {
          accept: 'application/json',
          authorization: provider.headers.authorization ?? '',
          'content-type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
      });
      expect(response.status).toBe(200);

      expect(await tableCount(pool, 'evm_chain_control_budget_settlements')).toBe(1);
      expect(await tableCount(pool, 'evm_chain_control_provider_request_events')).toBe(1);
      expect(await store.readAudit()).toHaveLength(15);
      await expect(
        pool.query(`
          update evm_chain_control_provider_request_events
          set provider_id = provider_id
        `),
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  }, 30_000);
});

function createIntegrationControlClient(pool: Pool): PgControlClientLike {
  return {
    async connect(): Promise<PgControlTransactionClientLike> {
      return createTransactionClient(await pool.connect());
    },
    async query<T>(sql: string, values?: readonly unknown[]): Promise<PgControlQueryResult<T>> {
      return normalizeResult<T>(await pool.query(sql, values === undefined ? [] : [...values]));
    },
  };
}

function createTransactionClient(client: PoolClient): PgControlTransactionClientLike {
  return {
    async query<T>(sql: string, values?: readonly unknown[]): Promise<PgControlQueryResult<T>> {
      return normalizeResult<T>(await client.query(sql, values === undefined ? [] : [...values]));
    },
    release(): void {
      client.release();
    },
  };
}

function normalizeResult<T>(result: QueryResult): PgControlQueryResult<T> {
  return {
    rows: result.rows as T[],
    ...(result.rowCount === null ? {} : { rowCount: result.rowCount }),
  };
}

async function tableCount(pool: Pool, table: string): Promise<number> {
  const allowedTables = new Set([
    'evm_chain_control_authorizations',
    'evm_chain_control_budget_settlements',
    'evm_chain_control_provider_request_events',
  ]);
  if (!allowedTables.has(table)) {
    throw new Error('Integration count table is not allowlisted.');
  }
  const result = await pool.query<{ count: string }>(`select count(*) as count from ${table}`);
  return Number(result.rows[0]?.count ?? Number.NaN);
}
