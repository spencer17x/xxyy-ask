export const evmDataAdapterConfigurationErrorCodes = [
  'chain_not_configured',
  'endpoint_not_allowed',
  'invalid_configuration',
  'invalid_limits',
  'provider_not_configured',
] as const;

export const evmRpcRequestErrorCodes = [
  'http_error',
  'invalid_json',
  'invalid_jsonrpc',
  'request_aborted',
  'request_timeout',
  'response_too_large',
  'transport_error',
] as const;

export type EvmDataAdapterConfigurationErrorCode =
  (typeof evmDataAdapterConfigurationErrorCodes)[number];
export type EvmRpcRequestErrorCode = (typeof evmRpcRequestErrorCodes)[number];

export class EvmDataAdapterConfigurationError extends Error {
  constructor(
    public readonly code: EvmDataAdapterConfigurationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EvmDataAdapterConfigurationError';
  }
}

export class EvmRpcRequestError extends Error {
  constructor(
    public readonly code: EvmRpcRequestErrorCode,
    public readonly providerId: string,
    public readonly retryable: boolean,
    public readonly attempts: number,
    options: {
      httpStatus?: number | undefined;
      maxResponseBytes?: number | undefined;
    } = {},
  ) {
    super(requestErrorMessage(code, providerId, attempts, options));
    this.name = 'EvmRpcRequestError';
    this.httpStatus = options.httpStatus;
    this.maxResponseBytes = options.maxResponseBytes;
  }

  public readonly httpStatus: number | undefined;
  public readonly maxResponseBytes: number | undefined;
}

function requestErrorMessage(
  code: EvmRpcRequestErrorCode,
  providerId: string,
  attempts: number,
  options: { httpStatus?: number | undefined; maxResponseBytes?: number | undefined },
): string {
  if (code === 'http_error') {
    return `EVM RPC provider ${providerId} returned HTTP ${options.httpStatus ?? 'error'} after ${attempts} attempt(s).`;
  }
  if (code === 'response_too_large') {
    return `EVM RPC provider ${providerId} exceeded the ${options.maxResponseBytes ?? 'configured'} byte response limit.`;
  }
  return `EVM RPC provider ${providerId} failed with ${code} after ${attempts} attempt(s).`;
}
