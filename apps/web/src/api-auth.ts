export function createApiHeaders(token?: string): Record<string, string> {
  const normalized = token?.trim();
  return {
    'Content-Type': 'application/json',
    ...(normalized === undefined || normalized.length === 0
      ? {}
      : { Authorization: `Bearer ${normalized}` }),
  };
}
