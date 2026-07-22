import { ChainAnalysisControlStoreError } from './contracts.js';

export interface PgControlQueryResult<T> {
  rows: T[];
  rowCount?: number;
}

export interface PgControlClientLike {
  connect?(): Promise<PgControlTransactionClientLike>;
  query<T>(sql: string, values?: readonly unknown[]): Promise<PgControlQueryResult<T>>;
  release?(): void;
}

export interface PgControlTransactionClientLike extends PgControlClientLike {
  release(): void;
}

export async function queryControlDatabase<T>(
  client: PgControlClientLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<PgControlQueryResult<T>> {
  try {
    return await client.query<T>(sql, values);
  } catch (error) {
    if (error instanceof ChainAnalysisControlStoreError) {
      throw error;
    }
    throw new ChainAnalysisControlStoreError(
      'database_unavailable',
      'Chain-analysis control database operation failed.',
      { cause: error },
    );
  }
}

export async function withControlTransaction<T>(
  source: PgControlClientLike,
  operation: (client: PgControlClientLike) => Promise<T>,
): Promise<T> {
  const ownsConnection = source.connect !== undefined && source.release === undefined;
  let client: PgControlClientLike = source;
  if (ownsConnection) {
    try {
      client = await source.connect!();
    } catch (error) {
      throw new ChainAnalysisControlStoreError(
        'database_unavailable',
        'Could not acquire a PostgreSQL control-store connection.',
        { cause: error },
      );
    }
  }
  try {
    await queryControlDatabase(client, 'begin');
    const result = await operation(client);
    await queryControlDatabase(client, 'commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // The operation error is primary; rollback failure is secondary.
    }
    throw error;
  } finally {
    if (ownsConnection) {
      client.release!();
    }
  }
}

export async function acquireControlLock(client: PgControlClientLike, key: string): Promise<void> {
  await queryControlDatabase(
    client,
    '/* control:advisory-lock */ select pg_advisory_xact_lock(hashtextextended($1, 0))',
    [key],
  );
}

export function parseSafeInteger(value: number | string, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      `PostgreSQL returned an invalid ${name}.`,
    );
  }
  return parsed;
}
