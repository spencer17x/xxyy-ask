import { z } from 'zod';

import {
  capabilityChannels,
  capabilityDataScopeSchema,
  capabilityIdSchema,
  capabilityPrincipals,
  capabilityRiskLevels,
  capabilitySideEffects,
  capabilitySources,
  capabilityVersionSchema,
  type CapabilityInvocationContext,
  type CapabilityManifest,
  type CapabilityRiskLevel,
} from './capability-contract.js';

function uniqueValues<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

export const capabilityGrantSchema = z
  .object({
    capabilityId: capabilityIdSchema,
    channels: z.array(z.enum(capabilityChannels)).min(1).refine(uniqueValues),
    dataScopes: z.array(capabilityDataScopeSchema).min(1).refine(uniqueValues),
    maxRisk: z.enum(capabilityRiskLevels),
    principals: z.array(z.enum(capabilityPrincipals)).min(1).refine(uniqueValues),
    sideEffects: z.array(z.enum(capabilitySideEffects)).min(1).refine(uniqueValues),
    source: z.enum(capabilitySources),
    version: capabilityVersionSchema,
  })
  .strict();

type ParsedCapabilityGrant = z.output<typeof capabilityGrantSchema>;

export type CapabilityGrant = Readonly<
  Omit<ParsedCapabilityGrant, 'channels' | 'dataScopes' | 'principals' | 'sideEffects'> & {
    channels: readonly ParsedCapabilityGrant['channels'][number][];
    dataScopes: readonly string[];
    principals: readonly ParsedCapabilityGrant['principals'][number][];
    sideEffects: readonly ParsedCapabilityGrant['sideEffects'][number][];
  }
>;

export type CapabilityPolicyDenialReason =
  | 'confirmation_required'
  | 'idempotency_key_required'
  | 'no_matching_grant';

export type CapabilityPolicyDecision =
  | { allowed: true; reason: 'explicit_grant' }
  | { allowed: false; reason: CapabilityPolicyDenialReason };

export interface CapabilityPolicy {
  evaluate(
    manifest: CapabilityManifest,
    context: CapabilityInvocationContext,
  ): CapabilityPolicyDecision;
}

const riskRank: Record<CapabilityRiskLevel, number> = {
  critical: 3,
  high: 2,
  low: 0,
  moderate: 1,
};

export function createDenyByDefaultCapabilityPolicy(
  grants: readonly CapabilityGrant[] = [],
): CapabilityPolicy {
  const parsedGrants = grants.map((grant) => freezeGrant(capabilityGrantSchema.parse(grant)));

  return {
    evaluate(manifest, context) {
      const hasMatchingGrant = parsedGrants.some((grant) => grantMatches(grant, manifest, context));
      if (!hasMatchingGrant) {
        return { allowed: false, reason: 'no_matching_grant' };
      }
      if (manifest.requiresConfirmation && context.userConfirmed !== true) {
        return { allowed: false, reason: 'confirmation_required' };
      }
      if (
        manifest.idempotency === 'required' &&
        (context.idempotencyKey === undefined || context.idempotencyKey.length === 0)
      ) {
        return { allowed: false, reason: 'idempotency_key_required' };
      }
      return { allowed: true, reason: 'explicit_grant' };
    },
  };
}

function freezeGrant(grant: ParsedCapabilityGrant): CapabilityGrant {
  return Object.freeze({
    ...grant,
    channels: Object.freeze([...grant.channels]),
    dataScopes: Object.freeze([...grant.dataScopes]),
    principals: Object.freeze([...grant.principals]),
    sideEffects: Object.freeze([...grant.sideEffects]),
  });
}

function grantMatches(
  grant: CapabilityGrant,
  manifest: CapabilityManifest,
  context: CapabilityInvocationContext,
): boolean {
  return (
    grant.capabilityId === manifest.id &&
    grant.version === manifest.version &&
    grant.source === manifest.source &&
    grant.channels.includes(context.channel) &&
    grant.principals.includes(context.principal) &&
    riskRank[manifest.risk] <= riskRank[grant.maxRisk] &&
    grant.sideEffects.includes(manifest.sideEffect) &&
    manifest.dataScopes.every((scope) => grant.dataScopes.includes(scope))
  );
}
