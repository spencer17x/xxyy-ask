import { z } from 'zod';

export const EVM_CHAIN_ANALYSIS_READINESS_VERSION = '0.1.0' as const;
export const MAX_REVIEWED_REPLAY_REVIEWS = 8;
export const MAX_REVIEWED_REPLAY_PROMOTIONS = 500;
export const MAX_READINESS_PROVIDERS = 128;

export const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/u, 'Expected a stable lower-case identifier.');

export const fingerprintSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, 'Expected a SHA-256 fingerprint.');

export const candidateIdSchema = z
  .string()
  .regex(/^reviewed_[0-9a-f]{64}$/u, 'Expected a content-addressed reviewed candidate id.');

export const reviewIdSchema = z
  .string()
  .regex(/^review_[0-9a-f]{64}$/u, 'Expected a content-addressed review id.');

export const tombstoneIdSchema = z
  .string()
  .regex(/^tombstone_[0-9a-f]{64}$/u, 'Expected a content-addressed tombstone id.');

export const ppmSchema = z.number().int().min(0).max(1_000_000);

export function uniqueValues<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

export function datetimeMs(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('Expected a valid ISO date-time.');
  }
  return milliseconds;
}

export function compareIsoDate(left: string, right: string): number {
  return datetimeMs(left) - datetimeMs(right);
}
