export const productionDataPlaneErrorCodes = [
  'audit_unavailable',
  'budget_unavailable',
  'circuit_open',
  'circuit_unavailable',
  'invalid_configuration',
  'provider_response_too_large',
  'secret_unavailable',
  'transport_unavailable',
] as const;

export type ProductionDataPlaneErrorCode = (typeof productionDataPlaneErrorCodes)[number];

export class ProductionDataPlaneError extends Error {
  readonly code: ProductionDataPlaneErrorCode;

  constructor(code: ProductionDataPlaneErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProductionDataPlaneError';
    this.code = code;
  }
}
