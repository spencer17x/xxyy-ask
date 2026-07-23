import type { Pool, PoolClient, QueryResult } from 'pg';

import type {
  PgControlClientLike,
  PgControlQueryResult,
  PgControlTransactionClientLike,
} from '@xxyy/evm-chain-analysis-control-store';

export function createPgControlClient(pool: Pool): PgControlClientLike {
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
