import {
  createSharedProviderCircuitState,
  materializeGrantedProviderBudgetLease,
  providerBudgetLeaseSchema,
  providerBudgetPolicySchema,
  providerBudgetReservationRequestSchema,
  providerBudgetSettlementSchema,
  settleProviderBudgetLease,
  sharedCircuitTransitionRequestSchema,
  sharedProviderCircuitStateSchema,
  transitionSharedProviderCircuitState,
  type ChainDataAdapterKind,
  type ProviderBudgetCoordinator,
  type ProviderBudgetLease,
  type ProviderBudgetPolicy,
  type ProviderBudgetReservationRequest,
  type ProviderBudgetSettlement,
  type ProviderBudgetSettlementInput,
  type SharedCircuitStateCoordinator,
  type SharedCircuitTransitionRequest,
  type SharedProviderCircuitState,
} from '@xxyy/evm-chain-analysis-readiness';

import {
  ChainAnalysisControlStoreError,
  verifyChainAnalysisControlAuditEvents,
  type ChainAnalysisControlAuditEvent,
} from './contracts.js';
import {
  appendControlAuditEvent,
  assertGovernanceAuthorization,
  readControlAuditEvents,
} from './control-store-internals.js';
import { migrateEvmChainAnalysisControlStore } from './migrations.js';
import {
  acquireControlLock,
  parseSafeInteger,
  queryControlDatabase,
  withControlTransaction,
  type PgControlClientLike,
} from './postgres.js';

type BudgetUsage = ProviderBudgetLease['reserved'];

interface PayloadRow {
  payload: unknown;
}

interface ActivePolicyRow extends PayloadRow {
  generation: number | string;
}

interface BudgetWindowRow {
  budget_id: string;
  policy_fingerprint: string;
  reserved_cost_units: number | string;
  reserved_requests: number | string;
  reserved_response_bytes: number | string;
  reserved_rpc_calls: number | string;
  used_cost_units: number | string;
  used_requests: number | string;
  used_response_bytes: number | string;
  used_rpc_calls: number | string;
  window_ends_at: string;
  window_started_at: string;
}

interface BudgetLeaseRow extends PayloadRow {
  window_started_at: string;
}

interface CountRow {
  active_count: number | string;
}

interface CircuitHeadRow extends PayloadRow {
  generation: number | string;
  state_fingerprint: string;
}

export interface PgEvmChainAnalysisProviderControlStore
  extends ProviderBudgetCoordinator, SharedCircuitStateCoordinator {
  initializeCircuit(input: {
    actorIdHash: string;
    state: unknown;
  }): Promise<SharedProviderCircuitState>;
  installBudgetPolicy(input: {
    actorIdHash: string;
    expectedPolicyFingerprint?: string;
    installedAt: string;
    policy: unknown;
  }): Promise<ProviderBudgetPolicy>;
  migrate(): Promise<void>;
  readAudit(): Promise<ChainAnalysisControlAuditEvent[]>;
  reconcileExpiredLeases(input: {
    asOf: string;
    limit?: number;
    workerIdHash: string;
  }): Promise<ProviderBudgetSettlement[]>;
}

export function createPgEvmChainAnalysisProviderControlStore(options: {
  client: PgControlClientLike;
  coordinatorInstanceIdHash: string;
  now?: () => string;
}): PgEvmChainAnalysisProviderControlStore {
  const { client } = options;
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async compareAndSet(
      input: SharedCircuitTransitionRequest,
    ): Promise<SharedProviderCircuitState> {
      const request = sharedCircuitTransitionRequestSchema.parse(input);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: request.next.updatedAt,
          principalIdHash: options.coordinatorInstanceIdHash,
          role: 'provider_operator',
        });
        const identity = circuitIdentity(request.next);
        await acquireControlLock(transaction, `circuit:${identity}`);
        const response = await queryControlDatabase<CircuitHeadRow>(
          transaction,
          `
            /* control:circuit-head-lock */
            select head.generation, head.state_fingerprint, state.payload
            from evm_chain_control_circuit_heads head
            join evm_chain_control_circuit_states state
              on state.state_fingerprint = head.state_fingerprint
            where head.adapter = $1 and head.chain_id = $2 and head.provider_id = $3
            for update of head
          `,
          [request.next.adapter, request.next.chainId, request.next.providerId],
        );
        const row = response.rows[0];
        if (row === undefined) {
          throw new ChainAnalysisControlStoreError(
            'circuit_not_found',
            `Shared circuit ${identity} was not initialized.`,
          );
        }
        const current = sharedProviderCircuitStateSchema.parse(row.payload);
        const currentGeneration = parseSafeInteger(row.generation, 'circuit generation');
        const requestedNext = createSharedProviderCircuitState(request.next);
        if (
          currentGeneration === request.expectedGeneration + 1 &&
          current.stateFingerprint === requestedNext.stateFingerprint
        ) {
          return current;
        }
        if (
          currentGeneration !== request.expectedGeneration ||
          current.stateFingerprint !== request.expectedStateFingerprint
        ) {
          throw new ChainAnalysisControlStoreError(
            'stale_generation',
            `Shared circuit ${identity} changed before compare-and-set.`,
          );
        }
        const next = transitionSharedProviderCircuitState(current, request.next);
        await queryControlDatabase(
          transaction,
          `
            /* control:circuit-state-insert */
            insert into evm_chain_control_circuit_states (
              state_fingerprint, adapter, chain_id, provider_id, generation, payload
            ) values ($1, $2, $3, $4, $5, $6::jsonb)
          `,
          [
            next.stateFingerprint,
            next.adapter,
            next.chainId,
            next.providerId,
            next.generation,
            JSON.stringify(next),
          ],
        );
        const updated = await queryControlDatabase<{ state_fingerprint: string }>(
          transaction,
          `
            /* control:circuit-head-cas */
            update evm_chain_control_circuit_heads
            set generation = $4, state_fingerprint = $5
            where
              adapter = $1
              and chain_id = $2
              and provider_id = $3
              and generation = $6
              and state_fingerprint = $7
            returning state_fingerprint
          `,
          [
            next.adapter,
            next.chainId,
            next.providerId,
            next.generation,
            next.stateFingerprint,
            request.expectedGeneration,
            request.expectedStateFingerprint,
          ],
        );
        if (updated.rows.length !== 1) {
          throw new ChainAnalysisControlStoreError(
            'stale_generation',
            `Shared circuit ${identity} lost its generation fence.`,
          );
        }
        await appendControlAuditEvent(transaction, {
          actorIdHash: options.coordinatorInstanceIdHash,
          entityFingerprint: next.stateFingerprint,
          entityId: identity,
          entityType: 'shared_provider_circuit',
          eventAt: next.updatedAt,
          eventKind: 'circuit_transition',
          payload: {
            from: current.stateFingerprint,
            generation: next.generation,
            reason: next.lastTransitionReason,
            state: next.state,
          },
          stream: 'provider_control',
        });
        return next;
      });
    },

    async initializeCircuit(input): Promise<SharedProviderCircuitState> {
      const state = sharedProviderCircuitStateSchema.parse(input.state);
      if (state.generation !== 0) {
        throw new ChainAnalysisControlStoreError(
          'invalid_state',
          'A shared circuit must initialize at generation zero.',
        );
      }
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: state.updatedAt,
          principalIdHash: input.actorIdHash,
          role: 'provider_operator',
        });
        const identity = circuitIdentity(state);
        await acquireControlLock(transaction, `circuit:${identity}`);
        const existing = await readCircuit(transaction, state);
        if (existing !== undefined) {
          if (existing.stateFingerprint !== state.stateFingerprint) {
            throw new ChainAnalysisControlStoreError(
              'already_exists',
              `Shared circuit ${identity} is already initialized.`,
            );
          }
          return existing;
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:circuit-state-insert */
            insert into evm_chain_control_circuit_states (
              state_fingerprint, adapter, chain_id, provider_id, generation, payload
            ) values ($1, $2, $3, $4, $5, $6::jsonb)
          `,
          [
            state.stateFingerprint,
            state.adapter,
            state.chainId,
            state.providerId,
            state.generation,
            JSON.stringify(state),
          ],
        );
        await queryControlDatabase(
          transaction,
          `
            /* control:circuit-head-insert */
            insert into evm_chain_control_circuit_heads (
              adapter, chain_id, provider_id, generation, state_fingerprint
            ) values ($1, $2, $3, $4, $5)
          `,
          [
            state.adapter,
            state.chainId,
            state.providerId,
            state.generation,
            state.stateFingerprint,
          ],
        );
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: state.stateFingerprint,
          entityId: identity,
          entityType: 'shared_provider_circuit',
          eventAt: state.updatedAt,
          eventKind: 'circuit_initialized',
          payload: { generation: state.generation, state: state.state },
          stream: 'provider_control',
        });
        return state;
      });
    },

    async installBudgetPolicy(input): Promise<ProviderBudgetPolicy> {
      const policy = providerBudgetPolicySchema.parse(input.policy);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.installedAt,
          principalIdHash: input.actorIdHash,
          role: 'provider_operator',
        });
        await acquireControlLock(transaction, `budget-policy:${policy.budgetId}`);
        const active = await readActivePolicy(transaction, policy.budgetId, true);
        if (active?.policy.policyFingerprint === policy.policyFingerprint) {
          return active.policy;
        }
        if (active !== undefined && input.expectedPolicyFingerprint === undefined) {
          throw new ChainAnalysisControlStoreError(
            'budget_policy_conflict',
            `Replacing budget policy ${policy.budgetId} requires its expected fingerprint.`,
          );
        }
        if (
          input.expectedPolicyFingerprint !== undefined &&
          active?.policy.policyFingerprint !== input.expectedPolicyFingerprint
        ) {
          throw new ChainAnalysisControlStoreError(
            'budget_policy_conflict',
            `Budget policy ${policy.budgetId} changed before installation.`,
          );
        }
        await queryControlDatabase(
          transaction,
          `
            /* control:budget-policy-insert */
            insert into evm_chain_control_budget_policies (
              policy_fingerprint, budget_id, payload
            ) values ($1, $2, $3::jsonb)
            on conflict (policy_fingerprint) do nothing
          `,
          [policy.policyFingerprint, policy.budgetId, JSON.stringify(policy)],
        );
        if (active === undefined) {
          await queryControlDatabase(
            transaction,
            `
              /* control:active-budget-policy-insert */
              insert into evm_chain_control_active_budget_policies (
                budget_id, policy_fingerprint, generation, installed_at
              ) values ($1, $2, 0, $3::timestamptz)
            `,
            [policy.budgetId, policy.policyFingerprint, input.installedAt],
          );
        } else {
          const updated = await queryControlDatabase<{ budget_id: string }>(
            transaction,
            `
              /* control:active-budget-policy-cas */
              update evm_chain_control_active_budget_policies
              set
                policy_fingerprint = $2,
                generation = generation + 1,
                installed_at = $3::timestamptz
              where budget_id = $1 and generation = $4 and policy_fingerprint = $5
              returning budget_id
            `,
            [
              policy.budgetId,
              policy.policyFingerprint,
              input.installedAt,
              active.generation,
              active.policy.policyFingerprint,
            ],
          );
          if (updated.rows.length !== 1) {
            throw new ChainAnalysisControlStoreError(
              'budget_policy_conflict',
              `Budget policy ${policy.budgetId} lost its generation fence.`,
            );
          }
        }
        await appendControlAuditEvent(transaction, {
          actorIdHash: input.actorIdHash,
          entityFingerprint: policy.policyFingerprint,
          entityId: policy.budgetId,
          entityType: 'provider_budget_policy',
          eventAt: input.installedAt,
          eventKind: 'budget_policy_installed',
          payload: {
            previousPolicyFingerprint: active?.policy.policyFingerprint ?? null,
          },
          stream: 'provider_control',
        });
        return policy;
      });
    },

    async migrate(): Promise<void> {
      await migrateEvmChainAnalysisControlStore(client);
    },

    async read(input: {
      adapter: ChainDataAdapterKind;
      chainId: string;
      providerId: string;
    }): Promise<SharedProviderCircuitState | undefined> {
      return readCircuit(client, input);
    },

    async readAudit(): Promise<ChainAnalysisControlAuditEvent[]> {
      return verifyChainAnalysisControlAuditEvents(
        await readControlAuditEvents(client, 'provider_control'),
      );
    },

    async reconcileExpiredLeases(input): Promise<ProviderBudgetSettlement[]> {
      const limit = normalizeReconcileLimit(input.limit);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: input.asOf,
          principalIdHash: input.workerIdHash,
          role: 'provider_operator',
        });
        const response = await queryControlDatabase<BudgetLeaseRow>(
          transaction,
          `
            /* control:expired-leases-lock */
            select lease.payload, lease.window_started_at::text as window_started_at
            from evm_chain_control_budget_leases lease
            left join evm_chain_control_budget_settlements settlement
              on settlement.lease_id = lease.lease_id
            where settlement.lease_id is null and lease.expires_at <= $1::timestamptz
            order by lease.expires_at, lease.lease_id
            for update of lease skip locked
            limit $2
          `,
          [input.asOf, limit],
        );
        const settlements: ProviderBudgetSettlement[] = [];
        for (const row of response.rows) {
          const lease = providerBudgetLeaseSchema.parse(row.payload);
          const settlement = settleProviderBudgetLease(lease, {
            leaseId: lease.leaseId,
            outcome: 'cancelled',
            settledAt: input.asOf,
            usage: zeroUsage(),
          });
          await persistSettlement(
            transaction,
            lease,
            row.window_started_at,
            settlement,
            input.workerIdHash,
          );
          settlements.push(settlement);
        }
        return settlements;
      });
    },

    async reserve(input: ProviderBudgetReservationRequest): Promise<ProviderBudgetLease> {
      const request = providerBudgetReservationRequestSchema.parse(input);
      const issuedAt = normalizeIssuedAt(now(), request.requestedAt);
      return withControlTransaction(client, async (transaction) => {
        await assertGovernanceAuthorization(transaction, {
          at: issuedAt,
          principalIdHash: request.instanceIdHash,
          role: 'provider_operator',
        });
        await acquireControlLock(transaction, `budget:${request.budgetId}`);
        await acquireControlLock(transaction, `budget-request:${request.requestFingerprint}`);
        const existing = await readLeaseByRequest(transaction, request.requestFingerprint);
        if (existing !== undefined) {
          if (
            existing.requestFingerprint !== request.requestFingerprint ||
            existing.policyFingerprint !== request.policyFingerprint
          ) {
            throw new ChainAnalysisControlStoreError(
              'immutable_conflict',
              'Budget request already produced a different lease.',
            );
          }
          return existing;
        }
        const active = await readActivePolicy(transaction, request.budgetId, true);
        if (active === undefined) {
          throw new ChainAnalysisControlStoreError(
            'budget_policy_missing',
            `Budget policy ${request.budgetId} is not installed.`,
          );
        }
        const policy = active.policy;
        if (policy.policyFingerprint !== request.policyFingerprint) {
          throw new ChainAnalysisControlStoreError(
            'budget_policy_conflict',
            `Budget request does not reference the active policy for ${request.budgetId}.`,
          );
        }
        if (Date.parse(issuedAt) - Date.parse(request.requestedAt) > policy.windowSeconds * 1_000) {
          throw new ChainAnalysisControlStoreError(
            'invalid_state',
            'Budget reservation request is older than the active accounting window.',
          );
        }
        const window = await findOrCreateBudgetWindow(transaction, policy, issuedAt);
        const activeCountResponse = await queryControlDatabase<CountRow>(
          transaction,
          `
            /* control:active-lease-count */
            select count(*) as active_count
            from evm_chain_control_budget_leases lease
            left join evm_chain_control_budget_settlements settlement
              on settlement.lease_id = lease.lease_id
            where
              lease.budget_id = $1
              and lease.policy_fingerprint = $2
              and lease.expires_at > $3::timestamptz
              and settlement.lease_id is null
          `,
          [policy.budgetId, policy.policyFingerprint, issuedAt],
        );
        const activeCount = parseSafeInteger(
          activeCountResponse.rows[0]?.active_count ?? 0,
          'active lease count',
        );
        if (activeCount >= policy.maxConcurrentLeases) {
          throw new ChainAnalysisControlStoreError(
            'budget_concurrency_exhausted',
            `Budget ${policy.budgetId} has no global lease concurrency available.`,
          );
        }
        assertWindowCapacity(window, request.reserve, policy);
        const lease = materializeGrantedProviderBudgetLease(policy, request, issuedAt);
        await queryControlDatabase(
          transaction,
          `
            /* control:budget-lease-insert */
            insert into evm_chain_control_budget_leases (
              lease_id,
              lease_fingerprint,
              request_fingerprint,
              budget_id,
              policy_fingerprint,
              window_started_at,
              issued_at,
              expires_at,
              payload
            ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::jsonb)
          `,
          [
            lease.leaseId,
            lease.leaseFingerprint,
            lease.requestFingerprint,
            lease.budgetId,
            lease.policyFingerprint,
            window.window_started_at,
            lease.issuedAt,
            lease.expiresAt,
            JSON.stringify(lease),
          ],
        );
        const updated = await updateBudgetWindow(transaction, window, request.reserve, zeroUsage());
        if (!updated) {
          throw new ChainAnalysisControlStoreError(
            'budget_exhausted',
            `Budget ${policy.budgetId} lost its atomic reservation fence.`,
          );
        }
        await appendControlAuditEvent(transaction, {
          actorIdHash: request.instanceIdHash,
          entityFingerprint: lease.leaseFingerprint,
          entityId: lease.leaseId,
          entityType: 'provider_budget_lease',
          eventAt: lease.issuedAt,
          eventKind: 'budget_reserved',
          payload: {
            policyFingerprint: lease.policyFingerprint,
            requestFingerprint: lease.requestFingerprint,
            reserved: lease.reserved,
          },
          stream: 'provider_control',
        });
        return lease;
      });
    },

    async settle(input: ProviderBudgetSettlementInput): Promise<ProviderBudgetSettlement> {
      return withControlTransaction(client, async (transaction) => {
        await acquireControlLock(transaction, `budget-lease:${input.leaseId}`);
        const leaseRow = await readLeaseRow(transaction, input.leaseId, true);
        if (leaseRow === undefined) {
          throw new ChainAnalysisControlStoreError(
            'lease_not_found',
            `Budget lease ${input.leaseId} was not found.`,
          );
        }
        const lease = providerBudgetLeaseSchema.parse(leaseRow.payload);
        await assertGovernanceAuthorization(transaction, {
          at: input.settledAt,
          principalIdHash: lease.instanceIdHash,
          role: 'provider_operator',
        });
        const settlement = settleProviderBudgetLease(lease, input);
        const existing = await readSettlement(transaction, lease.leaseId);
        if (existing !== undefined) {
          if (existing.settlementFingerprint !== settlement.settlementFingerprint) {
            throw new ChainAnalysisControlStoreError(
              'lease_already_settled',
              `Budget lease ${lease.leaseId} already has a different settlement.`,
            );
          }
          return existing;
        }
        await persistSettlement(
          transaction,
          lease,
          leaseRow.window_started_at,
          settlement,
          lease.instanceIdHash,
        );
        return settlement;
      });
    },
  };
}

async function readActivePolicy(
  client: PgControlClientLike,
  budgetId: string,
  forUpdate: boolean,
): Promise<{ generation: number; policy: ProviderBudgetPolicy } | undefined> {
  const response = await queryControlDatabase<ActivePolicyRow>(
    client,
    `
      /* control:active-budget-policy-read */
      select active.generation, policy.payload
      from evm_chain_control_active_budget_policies active
      join evm_chain_control_budget_policies policy
        on policy.policy_fingerprint = active.policy_fingerprint
      where active.budget_id = $1
      ${forUpdate ? 'for update of active' : ''}
    `,
    [budgetId],
  );
  const row = response.rows[0];
  return row === undefined
    ? undefined
    : {
        generation: parseSafeInteger(row.generation, 'budget policy generation'),
        policy: providerBudgetPolicySchema.parse(row.payload),
      };
}

async function findOrCreateBudgetWindow(
  client: PgControlClientLike,
  policy: ProviderBudgetPolicy,
  issuedAt: string,
): Promise<BudgetWindowRow> {
  const response = await queryControlDatabase<BudgetWindowRow>(
    client,
    `
      /* control:budget-window-read */
      select
        budget_id,
        policy_fingerprint,
        window_started_at::text as window_started_at,
        window_ends_at::text as window_ends_at,
        reserved_cost_units,
        reserved_requests,
        reserved_response_bytes,
        reserved_rpc_calls,
        used_cost_units,
        used_requests,
        used_response_bytes,
        used_rpc_calls
      from evm_chain_control_budget_windows
      where
        budget_id = $1
        and policy_fingerprint = $2
        and window_started_at <= $3::timestamptz
        and window_ends_at > $3::timestamptz
      order by window_started_at desc
      limit 1
      for update
    `,
    [policy.budgetId, policy.policyFingerprint, issuedAt],
  );
  const existing = response.rows[0];
  if (existing !== undefined) {
    return existing;
  }
  const windowEndsAt = new Date(Date.parse(issuedAt) + policy.windowSeconds * 1_000).toISOString();
  const inserted = await queryControlDatabase<BudgetWindowRow>(
    client,
    `
      /* control:budget-window-insert */
      insert into evm_chain_control_budget_windows (
        budget_id, policy_fingerprint, window_started_at, window_ends_at
      ) values ($1, $2, $3::timestamptz, $4::timestamptz)
      returning
        budget_id,
        policy_fingerprint,
        window_started_at::text as window_started_at,
        window_ends_at::text as window_ends_at,
        reserved_cost_units,
        reserved_requests,
        reserved_response_bytes,
        reserved_rpc_calls,
        used_cost_units,
        used_requests,
        used_response_bytes,
        used_rpc_calls
    `,
    [policy.budgetId, policy.policyFingerprint, issuedAt, windowEndsAt],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      `Could not initialize budget window ${policy.budgetId}.`,
    );
  }
  return row;
}

async function updateBudgetWindow(
  client: PgControlClientLike,
  window: BudgetWindowRow,
  reservedDelta: BudgetUsage,
  usedDelta: BudgetUsage,
): Promise<boolean> {
  const response = await queryControlDatabase<{ budget_id: string }>(
    client,
    `
      /* control:budget-window-update */
      update evm_chain_control_budget_windows
      set
        reserved_cost_units = reserved_cost_units + $4,
        reserved_requests = reserved_requests + $5,
        reserved_response_bytes = reserved_response_bytes + $6,
        reserved_rpc_calls = reserved_rpc_calls + $7,
        used_cost_units = used_cost_units + $8,
        used_requests = used_requests + $9,
        used_response_bytes = used_response_bytes + $10,
        used_rpc_calls = used_rpc_calls + $11
      where
        budget_id = $1
        and policy_fingerprint = $2
        and window_started_at = $3::timestamptz
        and reserved_cost_units + $4 >= 0
        and reserved_requests + $5 >= 0
        and reserved_response_bytes + $6 >= 0
        and reserved_rpc_calls + $7 >= 0
      returning budget_id
    `,
    [
      window.budget_id,
      window.policy_fingerprint,
      window.window_started_at,
      reservedDelta.costUnits,
      reservedDelta.requests,
      reservedDelta.responseBytes,
      reservedDelta.rpcCalls,
      usedDelta.costUnits,
      usedDelta.requests,
      usedDelta.responseBytes,
      usedDelta.rpcCalls,
    ],
  );
  return response.rows.length === 1;
}

async function persistSettlement(
  client: PgControlClientLike,
  lease: ProviderBudgetLease,
  windowStartedAt: string,
  settlement: ProviderBudgetSettlement,
  actorIdHash: string,
): Promise<void> {
  const windowResponse = await queryControlDatabase<BudgetWindowRow>(
    client,
    `
      /* control:budget-window-lock */
      select
        budget_id,
        policy_fingerprint,
        window_started_at::text as window_started_at,
        window_ends_at::text as window_ends_at,
        reserved_cost_units,
        reserved_requests,
        reserved_response_bytes,
        reserved_rpc_calls,
        used_cost_units,
        used_requests,
        used_response_bytes,
        used_rpc_calls
      from evm_chain_control_budget_windows
      where budget_id = $1 and policy_fingerprint = $2 and window_started_at = $3::timestamptz
      for update
    `,
    [lease.budgetId, lease.policyFingerprint, windowStartedAt],
  );
  const window = windowResponse.rows[0];
  if (window === undefined) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      `Budget lease ${lease.leaseId} lost its accounting window.`,
    );
  }
  await queryControlDatabase(
    client,
    `
      /* control:budget-settlement-insert */
      insert into evm_chain_control_budget_settlements (
        lease_id, settlement_fingerprint, settled_at, payload
      ) values ($1, $2, $3::timestamptz, $4::jsonb)
    `,
    [
      lease.leaseId,
      settlement.settlementFingerprint,
      settlement.settledAt,
      JSON.stringify(settlement),
    ],
  );
  const reconciled = await updateBudgetWindow(
    client,
    window,
    negateUsage(lease.reserved),
    settlement.usage,
  );
  if (!reconciled) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      `Budget lease ${lease.leaseId} could not reconcile reserved usage.`,
    );
  }
  await appendControlAuditEvent(client, {
    actorIdHash,
    entityFingerprint: settlement.settlementFingerprint,
    entityId: lease.leaseId,
    entityType: 'provider_budget_settlement',
    eventAt: settlement.settledAt,
    eventKind: 'budget_settled',
    payload: {
      leaseFingerprint: lease.leaseFingerprint,
      outcome: settlement.outcome,
      usage: settlement.usage,
    },
    stream: 'provider_control',
  });
}

async function readLeaseByRequest(
  client: PgControlClientLike,
  requestFingerprint: string,
): Promise<ProviderBudgetLease | undefined> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:budget-lease-by-request */
      select payload from evm_chain_control_budget_leases where request_fingerprint = $1
    `,
    [requestFingerprint],
  );
  const payload = response.rows[0]?.payload;
  return payload === undefined ? undefined : providerBudgetLeaseSchema.parse(payload);
}

async function readLeaseRow(
  client: PgControlClientLike,
  leaseId: string,
  forUpdate: boolean,
): Promise<BudgetLeaseRow | undefined> {
  const response = await queryControlDatabase<BudgetLeaseRow>(
    client,
    `
      /* control:budget-lease-read */
      select payload, window_started_at::text as window_started_at
      from evm_chain_control_budget_leases
      where lease_id = $1
      ${forUpdate ? 'for update' : ''}
    `,
    [leaseId],
  );
  return response.rows[0];
}

async function readSettlement(
  client: PgControlClientLike,
  leaseId: string,
): Promise<ProviderBudgetSettlement | undefined> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:budget-settlement-read */
      select payload from evm_chain_control_budget_settlements where lease_id = $1
    `,
    [leaseId],
  );
  const payload = response.rows[0]?.payload;
  return payload === undefined ? undefined : providerBudgetSettlementSchema.parse(payload);
}

async function readCircuit(
  client: PgControlClientLike,
  input: { adapter: ChainDataAdapterKind; chainId: string; providerId: string },
): Promise<SharedProviderCircuitState | undefined> {
  const response = await queryControlDatabase<PayloadRow>(
    client,
    `
      /* control:circuit-read */
      select state.payload
      from evm_chain_control_circuit_heads head
      join evm_chain_control_circuit_states state
        on state.state_fingerprint = head.state_fingerprint
      where head.adapter = $1 and head.chain_id = $2 and head.provider_id = $3
    `,
    [input.adapter, input.chainId, input.providerId],
  );
  const payload = response.rows[0]?.payload;
  return payload === undefined ? undefined : sharedProviderCircuitStateSchema.parse(payload);
}

function assertWindowCapacity(
  row: BudgetWindowRow,
  reserve: BudgetUsage,
  policy: ProviderBudgetPolicy,
): void {
  const reserved = windowUsage(row, 'reserved');
  const used = windowUsage(row, 'used');
  if (
    exceeds(
      safeUsageSum(reserved.costUnits, used.costUnits, reserve.costUnits),
      policy.maxCostUnits,
    ) ||
    exceeds(safeUsageSum(reserved.requests, used.requests, reserve.requests), policy.maxRequests) ||
    exceeds(
      safeUsageSum(reserved.responseBytes, used.responseBytes, reserve.responseBytes),
      policy.maxResponseBytes,
    ) ||
    exceeds(safeUsageSum(reserved.rpcCalls, used.rpcCalls, reserve.rpcCalls), policy.maxRpcCalls)
  ) {
    throw new ChainAnalysisControlStoreError(
      'budget_exhausted',
      `Budget ${policy.budgetId} does not have enough capacity for the reservation.`,
    );
  }
}

function windowUsage(row: BudgetWindowRow, prefix: 'reserved' | 'used'): BudgetUsage {
  return {
    costUnits: parseSafeInteger(row[`${prefix}_cost_units`], `${prefix} cost units`),
    requests: parseSafeInteger(row[`${prefix}_requests`], `${prefix} requests`),
    responseBytes: parseSafeInteger(row[`${prefix}_response_bytes`], `${prefix} response bytes`),
    rpcCalls: parseSafeInteger(row[`${prefix}_rpc_calls`], `${prefix} RPC calls`),
  };
}

function safeUsageSum(...values: number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum)) {
    throw new ChainAnalysisControlStoreError(
      'budget_exhausted',
      'Budget accounting would exceed JavaScript safe integer precision.',
    );
  }
  return sum;
}

function exceeds(value: number, maximum: number): boolean {
  return value > maximum;
}

function zeroUsage(): BudgetUsage {
  return { costUnits: 0, requests: 0, responseBytes: 0, rpcCalls: 0 };
}

function negateUsage(usage: BudgetUsage): BudgetUsage {
  return {
    costUnits: -usage.costUnits,
    requests: -usage.requests,
    responseBytes: -usage.responseBytes,
    rpcCalls: -usage.rpcCalls,
  };
}

function normalizeIssuedAt(value: string, requestedAt: string): string {
  const nowMs = Date.parse(value);
  if (!Number.isFinite(nowMs)) {
    throw new ChainAnalysisControlStoreError('invalid_state', 'Coordinator clock is invalid.');
  }
  if (nowMs < Date.parse(requestedAt)) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'Coordinator cannot issue a lease before the request timestamp.',
    );
  }
  return new Date(nowMs).toISOString();
}

function normalizeReconcileLimit(value: number | undefined): number {
  const normalized = value ?? 100;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 500) {
    throw new ChainAnalysisControlStoreError(
      'invalid_state',
      'Reconcile limit must be an integer between 1 and 500.',
    );
  }
  return normalized;
}

function circuitIdentity(input: {
  adapter: ChainDataAdapterKind;
  chainId: string;
  providerId: string;
}): string {
  return `${input.adapter}:${input.chainId}:${input.providerId}`;
}
