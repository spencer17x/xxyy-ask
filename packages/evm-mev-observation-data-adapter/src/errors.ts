export const evmMevObservationConfigurationErrorCodes = [
  'chain_not_configured',
  'endpoint_not_allowed',
  'invalid_configuration',
  'invalid_limits',
  'pool_not_configured',
  'provider_not_configured',
] as const;

export const evmMevObservationRequestErrorCodes = [
  'circuit_open',
  'http_error',
  'invalid_json',
  'invalid_jsonrpc',
  'local_concurrency_limit',
  'local_rate_limit',
  'request_aborted',
  'request_timeout',
  'response_too_large',
  'transport_error',
] as const;

export type EvmMevObservationConfigurationErrorCode =
  (typeof evmMevObservationConfigurationErrorCodes)[number];
export type EvmMevObservationRequestErrorCode = (typeof evmMevObservationRequestErrorCodes)[number];

export class EvmMevObservationConfigurationError extends Error {
  constructor(
    public readonly code: EvmMevObservationConfigurationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EvmMevObservationConfigurationError';
  }
}

export class EvmMevObservationRequestError extends Error {
  constructor(
    public readonly code: EvmMevObservationRequestErrorCode,
    public readonly providerId: string,
    public readonly retryable: boolean,
    public readonly attempts: number,
    options: {
      httpStatus?: number | undefined;
      maxResponseBytes?: number | undefined;
    } = {},
  ) {
    super(requestErrorMessage(code, providerId, attempts, options));
    this.name = 'EvmMevObservationRequestError';
    this.httpStatus = options.httpStatus;
    this.maxResponseBytes = options.maxResponseBytes;
  }

  public readonly httpStatus: number | undefined;
  public readonly maxResponseBytes: number | undefined;
}

function requestErrorMessage(
  code: EvmMevObservationRequestErrorCode,
  providerId: string,
  attempts: number,
  options: { httpStatus?: number | undefined; maxResponseBytes?: number | undefined },
): string {
  if (code === 'http_error') {
    return `MEV observation provider ${providerId} returned HTTP ${options.httpStatus ?? 'error'} after ${attempts} attempt(s).`;
  }
  if (code === 'response_too_large') {
    return `MEV observation provider ${providerId} exceeded the ${options.maxResponseBytes ?? 'configured'} byte response limit.`;
  }
  return `MEV observation provider ${providerId} failed with ${code} after ${attempts} attempt(s).`;
}
