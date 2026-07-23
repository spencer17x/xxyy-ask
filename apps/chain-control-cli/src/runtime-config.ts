export type ChainControlCliEnv = Partial<
  Record<
    | 'CHAIN_CONTROL_AUTHORITY_PUBLIC_KEY_FILE'
    | 'CHAIN_CONTROL_AUTHORITY_SYSTEM_ID'
    | 'CHAIN_CONTROL_DATABASE_URL'
    | 'DATABASE_URL'
    | 'POSTGRES_DB'
    | 'POSTGRES_HOST'
    | 'POSTGRES_PORT',
    string
  >
>;

export class ChainControlCliError extends Error {
  constructor(
    readonly code:
      | 'configuration_error'
      | 'invalid_command'
      | 'invalid_input'
      | 'io_error'
      | 'not_found',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChainControlCliError';
  }
}

export interface ChainControlAuthorityConfig {
  expectedAuthoritySystemId: string;
  publicKeyFile: string;
}

export function loadChainControlDatabaseUrl(env: ChainControlCliEnv): string {
  const databaseUrl = requiredText(
    env.CHAIN_CONTROL_DATABASE_URL,
    'CHAIN_CONTROL_DATABASE_URL is required.',
  );
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch (error) {
    throw new ChainControlCliError(
      'configuration_error',
      'CHAIN_CONTROL_DATABASE_URL must be a valid PostgreSQL URL.',
      { cause: error },
    );
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ChainControlCliError(
      'configuration_error',
      'CHAIN_CONTROL_DATABASE_URL must use postgres:// or postgresql://.',
    );
  }
  if (parsed.hostname.length === 0 || parsed.pathname.length <= 1) {
    throw new ChainControlCliError(
      'configuration_error',
      'CHAIN_CONTROL_DATABASE_URL must name an explicit PostgreSQL host and database.',
    );
  }
  let controlDatabaseIdentity: string;
  try {
    controlDatabaseIdentity = databaseIdentity(parsed);
  } catch (error) {
    throw new ChainControlCliError(
      'configuration_error',
      'CHAIN_CONTROL_DATABASE_URL must contain a valid encoded database name.',
      { cause: error },
    );
  }
  const productDatabaseIdentities = productDatabaseIdentityCandidates(env);
  if (productDatabaseIdentities.has(controlDatabaseIdentity)) {
    throw new ChainControlCliError(
      'configuration_error',
      'Chain control must use a database separate from Product RAG.',
    );
  }
  if (canonicalDatabaseHost(parsed.hostname) !== 'local') {
    const sslMode = parsed.searchParams.get('sslmode');
    if (sslMode !== 'verify-ca' && sslMode !== 'verify-full') {
      throw new ChainControlCliError(
        'configuration_error',
        'Remote chain-control PostgreSQL requires sslmode=verify-ca or sslmode=verify-full.',
      );
    }
  }
  return databaseUrl;
}

export function loadChainControlAuthorityConfig(
  env: ChainControlCliEnv,
): ChainControlAuthorityConfig {
  return {
    expectedAuthoritySystemId: requiredText(
      env.CHAIN_CONTROL_AUTHORITY_SYSTEM_ID,
      'CHAIN_CONTROL_AUTHORITY_SYSTEM_ID is required.',
    ),
    publicKeyFile: requiredText(
      env.CHAIN_CONTROL_AUTHORITY_PUBLIC_KEY_FILE,
      'CHAIN_CONTROL_AUTHORITY_PUBLIC_KEY_FILE is required.',
    ),
  };
}

function requiredText(value: string | undefined, message: string): string {
  const normalized = normalizeText(value);
  if (normalized === undefined) {
    throw new ChainControlCliError('configuration_error', message);
  }
  return normalized;
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function isLocalDatabaseHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function productDatabaseIdentityCandidates(env: ChainControlCliEnv): Set<string> {
  const identities = new Set<string>();
  const productDatabaseUrl = normalizeText(env.DATABASE_URL);
  if (productDatabaseUrl !== undefined) {
    try {
      const parsed = new URL(productDatabaseUrl);
      if (
        (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
        parsed.hostname.length > 0 &&
        parsed.pathname.length > 1
      ) {
        identities.add(databaseIdentity(parsed));
      }
    } catch {
      // Product RAG owns validation of its own URL; this command only compares valid identities.
    }
  }

  const productDatabase = normalizeText(env.POSTGRES_DB);
  if (productDatabase !== undefined) {
    const host = canonicalDatabaseHost(normalizeText(env.POSTGRES_HOST) ?? 'localhost');
    const port = canonicalDatabasePort(normalizeText(env.POSTGRES_PORT) ?? '5432');
    identities.add(`${host}:${port}/${productDatabase}`);
  }
  return identities;
}

function databaseIdentity(url: URL): string {
  const database = decodeURIComponent(url.pathname.slice(1));
  return `${canonicalDatabaseHost(url.hostname)}:${canonicalDatabasePort(url.port || '5432')}/${database}`;
}

function canonicalDatabaseHost(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return isLocalDatabaseHost(normalized) ? 'local' : normalized;
}

function canonicalDatabasePort(port: string): string {
  const numericPort = Number(port);
  return Number.isInteger(numericPort) && numericPort > 0 && numericPort <= 65_535
    ? String(numericPort)
    : port;
}
