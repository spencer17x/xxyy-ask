import { describe, expect, it } from 'vitest';

import { loadChainControlAuthorityConfig, loadChainControlDatabaseUrl } from './runtime-config.js';

describe('chain-control CLI runtime configuration', () => {
  it('requires a dedicated chain-control database and verified TLS remotely', () => {
    expect(() => loadChainControlDatabaseUrl({})).toThrow(/CHAIN_CONTROL_DATABASE_URL/u);
    expect(() =>
      loadChainControlDatabaseUrl({
        CHAIN_CONTROL_DATABASE_URL: 'postgres://control:secret@db.example/control',
      }),
    ).toThrow(/sslmode/u);
    expect(() =>
      loadChainControlDatabaseUrl({
        CHAIN_CONTROL_DATABASE_URL:
          'postgres://control:secret@db.example/control?sslmode=verify-full',
        DATABASE_URL:
          'postgresql://product:another-secret@db.example:5432/control?application_name=rag',
      }),
    ).toThrow(/separate/u);
    expect(() =>
      loadChainControlDatabaseUrl({
        CHAIN_CONTROL_DATABASE_URL: 'postgres://control:secret@127.0.0.1/control',
        POSTGRES_DB: 'control',
        POSTGRES_HOST: 'localhost',
        POSTGRES_PORT: '5432',
      }),
    ).toThrow(/separate/u);
    expect(() =>
      loadChainControlDatabaseUrl({
        CHAIN_CONTROL_DATABASE_URL: 'postgres://control:secret@localhost',
      }),
    ).toThrow(/explicit PostgreSQL host and database/u);
    expect(
      loadChainControlDatabaseUrl({
        CHAIN_CONTROL_DATABASE_URL:
          'postgres://control:secret@db.example/control?sslmode=verify-full',
      }),
    ).toContain('sslmode=verify-full');
    expect(
      loadChainControlDatabaseUrl({
        CHAIN_CONTROL_DATABASE_URL: 'postgres://control:secret@localhost/control',
      }),
    ).toContain('localhost');
  });

  it('requires a pinned authority id and public key file', () => {
    expect(() => loadChainControlAuthorityConfig({})).toThrow(/CHAIN_CONTROL_AUTHORITY_SYSTEM_ID/u);
    expect(
      loadChainControlAuthorityConfig({
        CHAIN_CONTROL_AUTHORITY_PUBLIC_KEY_FILE: '/run/secrets/authority-public.pem',
        CHAIN_CONTROL_AUTHORITY_SYSTEM_ID: 'platform_policy_verifier',
      }),
    ).toEqual({
      expectedAuthoritySystemId: 'platform_policy_verifier',
      publicKeyFile: '/run/secrets/authority-public.pem',
    });
  });
});
