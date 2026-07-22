export const evmExecutionDataAdapterConfigurationErrorCodes = [
  'chain_not_configured',
  'endpoint_not_allowed',
  'invalid_configuration',
  'invalid_limits',
  'provider_not_configured',
] as const;

export const evmExecutionRpcRequestErrorCodes = [
  'http_error',
  'invalid_json',
  'invalid_jsonrpc',
  'request_aborted',
  'request_timeout',
  'response_too_large',
  'transport_error',
] as const;

export const evmTraceNormalizationErrorCodes = [
  'trace_bytes_limit_exceeded',
  'trace_depth_limit_exceeded',
  'trace_invalid',
  'trace_node_limit_exceeded',
] as const;

export type EvmExecutionDataAdapterConfigurationErrorCode =
  (typeof evmExecutionDataAdapterConfigurationErrorCodes)[number];
export type EvmExecutionRpcRequestErrorCode = (typeof evmExecutionRpcRequestErrorCodes)[number];
export type EvmTraceNormalizationErrorCode = (typeof evmTraceNormalizationErrorCodes)[number];

export class EvmExecutionDataAdapterConfigurationError extends Error {
  constructor(
    public readonly code: EvmExecutionDataAdapterConfigurationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'EvmExecutionDataAdapterConfigurationError';
  }
}

export class EvmExecutionRpcRequestError extends Error {
  constructor(
    public readonly code: EvmExecutionRpcRequestErrorCode,
    public readonly providerId: string,
    public readonly retryable: boolean,
    public readonly attempts: number,
    options: {
      httpStatus?: number | undefined;
      maxResponseBytes?: number | undefined;
    } = {},
  ) {
    super(requestErrorMessage(code, providerId, attempts, options));
    this.name = 'EvmExecutionRpcRequestError';
    this.httpStatus = options.httpStatus;
    this.maxResponseBytes = options.maxResponseBytes;
  }

  public readonly httpStatus: number | undefined;
  public readonly maxResponseBytes: number | undefined;
}

export class EvmTraceNormalizationError extends Error {
  constructor(public readonly code: EvmTraceNormalizationErrorCode) {
    super(`EVM call trace normalization failed with ${code}.`);
    this.name = 'EvmTraceNormalizationError';
  }
}

function requestErrorMessage(
  code: EvmExecutionRpcRequestErrorCode,
  providerId: string,
  attempts: number,
  options: { httpStatus?: number | undefined; maxResponseBytes?: number | undefined },
): string {
  if (code === 'http_error') {
    return `EVM execution RPC provider ${providerId} returned HTTP ${options.httpStatus ?? 'error'} after ${attempts} attempt(s).`;
  }
  if (code === 'response_too_large') {
    return `EVM execution RPC provider ${providerId} exceeded the ${options.maxResponseBytes ?? 'configured'} byte response limit.`;
  }
  return `EVM execution RPC provider ${providerId} failed with ${code} after ${attempts} attempt(s).`;
}
