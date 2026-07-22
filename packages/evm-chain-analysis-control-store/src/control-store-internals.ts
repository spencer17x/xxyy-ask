import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';

import {
  ChainAnalysisControlStoreError,
  chainAnalysisControlAuditEventSchema,
  createChainAnalysisControlAuditEvent,
  governanceAuthorizationRevocationSchema,
  governanceAuthorizationSchema,
  type ChainAnalysisControlAuditEvent,
  type ChainAnalysisControlAuditEventKind,
  type ChainAnalysisControlAuditStream,
  type ChainAnalysisGovernanceRole,
  type GovernanceAuthorization,
} from './contracts.js';
import {
  acquireControlLock,
  parseSafeInteger,
  queryControlDatabase,
  type PgControlClientLike,
} from './postgres.js';

interface PayloadRow {
  payload: unknown;
}

interface AuthorizationRow extends PayloadRow {
  revocation_payload: unknown;
}

interface AuditHeadRow {
  last_event_fingerprint: string | null;
  last_sequence: number | string;
}

export async function assertGovernanceAuthorization(
  client: PgControlClientLike,
  input: {
    at: string;
    principalIdHash: string;
    role: ChainAnalysisGovernanceRole;
  },
): Promise<GovernanceAuthorization> {
  await acquireControlLock(client, `authorization-role:${input.principalIdHash}:${input.role}`);
  const response = await queryControlDatabase<AuthorizationRow>(
    client,
    `
      /* control:authorization-read */
      select grant_record.payload, revocation_record.payload as revocation_payload
      from evm_chain_control_authorizations grant_record
      left join evm_chain_control_authorization_revocations revocation_record
        on revocation_record.authorization_id = grant_record.authorization_id
      where
        grant_record.principal_id_hash = $1
        and $2 = any(grant_record.roles)
        and grant_record.granted_at <= $3::timestamptz
        and (grant_record.valid_until is null or grant_record.valid_until > $3::timestamptz)
      order by grant_record.granted_at desc, grant_record.authorization_id
    `,
    [input.principalIdHash, input.role, input.at],
  );
  let wasRevoked = false;
  for (const row of response.rows) {
    const authorization = governanceAuthorizationSchema.parse(row.payload);
    if (row.revocation_payload === null) {
      return authorization;
    }
    const revocation = governanceAuthorizationRevocationSchema.parse(row.revocation_payload);
    if (Date.parse(revocation.revokedAt) > Date.parse(input.at)) {
      return authorization;
    }
    wasRevoked = true;
  }
  if (wasRevoked) {
    throw new ChainAnalysisControlStoreError(
      'authorization_revoked',
      `The ${input.role} authorization was revoked at the requested operation time.`,
    );
  }
  throw new ChainAnalysisControlStoreError(
    'authorization_missing',
    `Principal is not authorized for role ${input.role}.`,
  );
}

export async function appendControlAuditEvent(
  client: PgControlClientLike,
  input: {
    actorIdHash: string;
    entityFingerprint: string;
    entityId: string;
    entityType: string;
    eventAt: string;
    eventKind: ChainAnalysisControlAuditEventKind;
    payload?: unknown;
    payloadFingerprint?: string;
    stream: ChainAnalysisControlAuditStream;
  },
): Promise<ChainAnalysisControlAuditEvent> {
  const response = await queryControlDatabase<AuditHeadRow>(
    client,
    `
      /* control:audit-head-lock */
      select last_sequence, last_event_fingerprint
      from evm_chain_control_audit_heads
      where stream = $1
      for update
    `,
    [input.stream],
  );
  const head = response.rows[0];
  if (head === undefined) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      `Audit stream ${input.stream} has not been initialized.`,
    );
  }
  const sequence = parseSafeInteger(head.last_sequence, 'audit sequence') + 1;
  const event = createChainAnalysisControlAuditEvent({
    actorIdHash: input.actorIdHash,
    entityFingerprint: input.entityFingerprint,
    entityId: input.entityId,
    entityType: input.entityType,
    eventAt: input.eventAt,
    eventKind: input.eventKind,
    payloadFingerprint:
      input.payloadFingerprint ?? sha256Fingerprint(input.payload ?? input.entityFingerprint),
    ...(head.last_event_fingerprint === null
      ? {}
      : { previousEventFingerprint: head.last_event_fingerprint }),
    sequence,
    stream: input.stream,
  });
  await queryControlDatabase(
    client,
    `
      /* control:audit-insert */
      insert into evm_chain_control_audit_events (
        event_id,
        event_fingerprint,
        stream,
        sequence,
        previous_event_fingerprint,
        event_at,
        payload
      ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
    `,
    [
      event.eventId,
      event.eventFingerprint,
      event.stream,
      event.sequence,
      event.previousEventFingerprint ?? null,
      event.eventAt,
      JSON.stringify(event),
    ],
  );
  const updated = await queryControlDatabase<{ stream: string }>(
    client,
    `
      /* control:audit-head-update */
      update evm_chain_control_audit_heads
      set last_sequence = $2, last_event_fingerprint = $3
      where stream = $1 and last_sequence = $2 - 1
      returning stream
    `,
    [event.stream, event.sequence, event.eventFingerprint],
  );
  if (updated.rows.length !== 1) {
    throw new ChainAnalysisControlStoreError(
      'invalid_audit_chain',
      `Audit stream ${event.stream} changed while appending sequence ${event.sequence}.`,
    );
  }
  return event;
}

export async function readControlAuditEvents(
  client: PgControlClientLike,
  stream: ChainAnalysisControlAuditStream,
): Promise<ChainAnalysisControlAuditEvent[]> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:audit-read */
      select payload
      from evm_chain_control_audit_events
      where stream = $1
      order by sequence
    `,
    [stream],
  );
  return response.rows.map((row) => chainAnalysisControlAuditEventSchema.parse(row.payload));
}

export function assertActor(expected: string, actual: string, label: string): void {
  if (expected !== actual) {
    throw new ChainAnalysisControlStoreError(
      'invalid_actor',
      `${label} must match the content-addressed artifact actor.`,
    );
  }
}

export function assertSameFingerprint(expected: string, actual: string, label: string): void {
  if (expected !== actual) {
    throw new ChainAnalysisControlStoreError(
      'immutable_conflict',
      `${label} already exists with different immutable content.`,
    );
  }
}
