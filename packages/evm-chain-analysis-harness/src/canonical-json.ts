import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) {
    throw new TypeError('Canonical JSON requires a JSON-serializable root value.');
  }
  return serialized;
}

export function sha256Fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}
