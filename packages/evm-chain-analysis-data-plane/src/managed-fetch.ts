import { sha256Fingerprint } from '@xxyy/evm-chain-analysis-harness';
import {
  createProductionAuditEvent,
  createProviderBudgetReservation,
  type ChainDataAdapterKind,
  type ProductionAuditEvent,
  type ProviderBudgetCoordinator,
  type ProviderBudgetSettlement,
  type ProviderBudgetSettlementInput,
  type SharedCircuitStateCoordinator,
  type SharedProviderCircuitState,
} from '@xxyy/evm-chain-analysis-readiness';

import type { ProviderResponseCache } from './cache.js';
import {
  adapterTransportConfigurationSchema,
  productionProviderBindingSchema,
  type AdapterTransportConfiguration,
} from './contracts.js';
import { ProductionDataPlaneError } from './errors.js';
import type { ResolvedProductionProvider } from './secret-resolver.js';

type Usage = ProductionAuditEvent['usage'];
const MAX_MANAGED_REQUEST_BODY_CHARACTERS = 4 * 1024 * 1024;
const MAX_REQUEST_JSON_DEPTH = 64;
const MAX_REQUEST_JSON_NODES = 100_000;
const MAX_RESPONSE_CHUNKS = 65_536;

export const productionDataPlaneAlertCodes = [
  'audit_sink_unavailable',
  'budget_control_unavailable',
  'budget_rejected',
  'cache_unavailable',
  'circuit_backend_unavailable',
  'circuit_open',
  'provider_failure',
] as const;

export type ProductionDataPlaneAlertCode = (typeof productionDataPlaneAlertCodes)[number];

export interface ProductionDataPlaneMetric {
  adapter: ChainDataAdapterKind;
  cacheHit: boolean;
  chainId: string;
  durationMs: number;
  observedAt: string;
  providerId: string;
  requestFingerprint: string;
  resultCode: string;
  usage: Usage;
}

export interface ProductionDataPlaneAlert {
  adapter: ChainDataAdapterKind;
  alertCode: ProductionDataPlaneAlertCode;
  chainId: string;
  correlationHash: string;
  observedAt: string;
  providerId: string;
  severity: 'critical' | 'warning';
}

export interface ProviderRequestAuditSink {
  completeProviderRequest(input: {
    actorIdHash: string;
    event: unknown;
    settlement: ProviderBudgetSettlementInput;
  }): Promise<{
    event: ProductionAuditEvent;
    settlement: ProviderBudgetSettlement;
  }>;
  recordProviderRequest(input: {
    actorIdHash: string;
    event: unknown;
  }): Promise<ProductionAuditEvent>;
}

export interface ProductionProviderControls
  extends ProviderBudgetCoordinator, ProviderRequestAuditSink, SharedCircuitStateCoordinator {}

export interface CreateManagedProviderFetchOptions {
  adapter: ChainDataAdapterKind;
  alertSink?: ((alert: ProductionDataPlaneAlert) => void | Promise<void>) | undefined;
  allowInsecureLocalhost?: boolean | undefined;
  cache?: ProviderResponseCache | undefined;
  chainId: string;
  controls: ProductionProviderControls;
  fetchImpl?: typeof fetch | undefined;
  instanceIdHash: string;
  manifestFingerprint: string;
  metricSink?: ((metric: ProductionDataPlaneMetric) => void | Promise<void>) | undefined;
  now?: (() => string) | undefined;
  nowMs?: (() => number) | undefined;
  providers: readonly ResolvedProductionProvider[];
  transport: AdapterTransportConfiguration;
}

interface CircuitPermit {
  probe: boolean;
}

interface RequestMetadata {
  cacheable: boolean;
  cacheKey: string;
  correlationHash: string;
  providerRequestFingerprint: string;
  rpcCalls: number;
}

export function createManagedProviderFetch(
  rawOptions: CreateManagedProviderFetchOptions,
): typeof fetch {
  const now = monotonicIsoClock(rawOptions.now ?? (() => new Date().toISOString()));
  const nowMs = rawOptions.nowMs ?? Date.now;
  const options = {
    ...rawOptions,
    now,
    nowMs,
    transport: adapterTransportConfigurationSchema.parse(rawOptions.transport),
  };
  if (!isFingerprint(options.instanceIdHash) || !isFingerprint(options.manifestFingerprint)) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider transport requires runtime and manifest fingerprints.',
    );
  }
  const approvedProviders = options.providers.map((provider) =>
    validateResolvedProvider(
      provider,
      options.adapter,
      options.chainId,
      options.allowInsecureLocalhost ?? false,
    ),
  );
  const providers = new Map(approvedProviders.map((provider) => [provider.endpoint, provider]));
  if (providers.size !== options.providers.length || providers.size === 0) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider transport requires unique resolved endpoints.',
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (input, init) => {
    const endpoint = normalizeEndpoint(requestUrl(input), options.allowInsecureLocalhost ?? false);
    const provider = providers.get(endpoint);
    if (provider === undefined) {
      throw new ProductionDataPlaneError(
        'invalid_configuration',
        'Provider request did not match an approved resolved endpoint.',
      );
    }
    assertApprovedHttpRequest(init, provider);
    const metadata = requestMetadata(
      init?.body,
      options.adapter,
      options.chainId,
      options.manifestFingerprint,
      provider.binding.descriptor.configurationFingerprint,
      provider.binding.descriptor.providerId,
      options.instanceIdHash,
    );
    const startedAtMs = safeNowMs(nowMs);
    const permit = await acquireCircuitPermit({
      adapter: options.adapter,
      alertSink: options.alertSink,
      chainId: options.chainId,
      controls: options.controls,
      correlationHash: metadata.correlationHash,
      now,
      providerId: provider.binding.descriptor.providerId,
      transport: options.transport,
    });

    const cached = permit.probe
      ? undefined
      : await readCacheSafely(
          options.cache,
          metadata.cacheable ? metadata.cacheKey : undefined,
          startedAtMs,
          () =>
            emitAlert(options.alertSink, {
              adapter: options.adapter,
              alertCode: 'cache_unavailable',
              chainId: options.chainId,
              correlationHash: metadata.correlationHash,
              observedAt: now(),
              providerId: provider.binding.descriptor.providerId,
              severity: 'warning',
            }),
        );
    if (cached !== undefined) {
      const usage = zeroUsage();
      const event = createProductionAuditEvent({
        adapter: options.adapter,
        chainId: options.chainId,
        correlationHash: metadata.correlationHash,
        durationMs: 0,
        eventAt: now(),
        eventKind: 'provider_request',
        instanceIdHash: options.instanceIdHash,
        manifestFingerprint: options.manifestFingerprint,
        providerId: provider.binding.descriptor.providerId,
        providerConfigurationFingerprint: provider.binding.descriptor.configurationFingerprint,
        requestFingerprint: metadata.providerRequestFingerprint,
        resultCode: 'cache_hit',
        usage,
      });
      await persistAuditOrFail(options, event, metadata.correlationHash);
      emitMetric(options.metricSink, {
        adapter: options.adapter,
        cacheHit: true,
        chainId: options.chainId,
        durationMs: 0,
        observedAt: event.eventAt,
        providerId: provider.binding.descriptor.providerId,
        requestFingerprint: metadata.providerRequestFingerprint,
        resultCode: 'cache_hit',
        usage,
      });
      return responseFromCache(cached);
    }

    const requestedAt = now();
    let lease;
    try {
      lease = await options.controls.reserve(
        createProviderBudgetReservation({
          budgetId: provider.binding.budgetPolicy.budgetId,
          instanceIdHash: options.instanceIdHash,
          policyFingerprint: provider.binding.budgetPolicy.policyFingerprint,
          requestedAt,
          reserve: {
            costUnits: provider.binding.costUnitsPerRequest,
            requests: 1,
            responseBytes: options.transport.maxResponseBytes,
            rpcCalls: metadata.rpcCalls,
          },
        }),
      );
    } catch (cause) {
      const alertCode = isControlBackendError(cause)
        ? 'budget_control_unavailable'
        : 'budget_rejected';
      emitAlert(options.alertSink, {
        adapter: options.adapter,
        alertCode,
        chainId: options.chainId,
        correlationHash: metadata.correlationHash,
        observedAt: now(),
        providerId: provider.binding.descriptor.providerId,
        severity: alertCode === 'budget_control_unavailable' ? 'critical' : 'warning',
      });
      await releaseDeferredProbe({
        adapter: options.adapter,
        alertSink: options.alertSink,
        chainId: options.chainId,
        controls: options.controls,
        correlationHash: metadata.correlationHash,
        now,
        permit,
        providerId: provider.binding.descriptor.providerId,
        transport: options.transport,
      });
      throw new ProductionDataPlaneError(
        'budget_unavailable',
        'Provider request was rejected by the shared budget control.',
        { cause },
      );
    }

    let response: Response;
    let boundedBody: Awaited<ReturnType<typeof readBoundedResponseBody>>;
    try {
      response = await fetchImpl(input, init);
      boundedBody = await readBoundedResponseBody(response, options.transport.maxResponseBytes);
    } catch (cause) {
      await completeProviderRequest({
        circuitOutcome: 'failure',
        eventResultCode: 'transport_error',
        leaseId: lease.leaseId,
        metadata,
        options,
        outcome: 'failed',
        permit,
        provider,
        startedAtMs,
        usage: {
          costUnits: provider.binding.costUnitsPerRequest,
          requests: 1,
          responseBytes: options.transport.maxResponseBytes,
          rpcCalls: metadata.rpcCalls,
        },
      });
      throw new ProductionDataPlaneError(
        'transport_unavailable',
        'Approved provider transport failed.',
        { cause },
      );
    }
    if (boundedBody.exceeded) {
      await completeProviderRequest({
        circuitOutcome: 'failure',
        eventResultCode: 'response_too_large',
        leaseId: lease.leaseId,
        metadata,
        options,
        outcome: 'failed',
        permit,
        provider,
        startedAtMs,
        usage: {
          costUnits: provider.binding.costUnitsPerRequest,
          requests: 1,
          responseBytes: options.transport.maxResponseBytes,
          rpcCalls: metadata.rpcCalls,
        },
      });
      throw new ProductionDataPlaneError(
        'provider_response_too_large',
        'Provider response exceeded the approved transport limit.',
      );
    }
    const bytes = boundedBody.bytes;

    const resultCode = response.ok ? 'success' : `http_${response.status}`;
    const circuitOutcome = response.ok ? 'success' : 'failure';
    const usage = {
      costUnits: provider.binding.costUnitsPerRequest,
      requests: 1,
      responseBytes: bytes.byteLength,
      rpcCalls: metadata.rpcCalls,
    };
    await completeProviderRequest({
      circuitOutcome,
      eventResultCode: resultCode,
      leaseId: lease.leaseId,
      metadata,
      options,
      outcome: response.ok ? 'success' : 'failed',
      permit,
      provider,
      startedAtMs,
      usage,
    });
    if (response.ok && metadata.cacheable && options.transport.cacheTtlMs > 0) {
      await writeCacheSafely(
        options.cache,
        metadata.cacheKey,
        {
          body: bytes,
          ...(response.headers.get('content-type') === null
            ? {}
            : { contentType: response.headers.get('content-type') ?? undefined }),
          status: response.status,
        },
        safeNowMs(nowMs) + options.transport.cacheTtlMs,
        () =>
          emitAlert(options.alertSink, {
            adapter: options.adapter,
            alertCode: 'cache_unavailable',
            chainId: options.chainId,
            correlationHash: metadata.correlationHash,
            observedAt: now(),
            providerId: provider.binding.descriptor.providerId,
            severity: 'warning',
          }),
      );
    }
    return new Response(copyArrayBuffer(bytes), {
      headers: responseHeaders(response),
      status: response.status,
      statusText: response.statusText,
    });
  };
}

async function completeProviderRequest(input: {
  circuitOutcome: 'failure' | 'success';
  eventResultCode: string;
  leaseId: string;
  metadata: RequestMetadata;
  options: CreateManagedProviderFetchOptions;
  outcome: 'failed' | 'success';
  permit: CircuitPermit;
  provider: ResolvedProductionProvider;
  startedAtMs: number;
  usage: Usage;
}): Promise<void> {
  const settledAt = input.options.now?.() ?? new Date().toISOString();
  const endedAtMs = safeNowMs(input.options.nowMs ?? Date.now);
  const event = createProductionAuditEvent({
    adapter: input.options.adapter,
    budgetLeaseId: input.leaseId,
    chainId: input.options.chainId,
    correlationHash: input.metadata.correlationHash,
    durationMs: boundedDuration(input.startedAtMs, endedAtMs),
    eventAt: settledAt,
    eventKind: 'provider_request',
    instanceIdHash: input.options.instanceIdHash,
    manifestFingerprint: input.options.manifestFingerprint,
    providerId: input.provider.binding.descriptor.providerId,
    providerConfigurationFingerprint: input.provider.binding.descriptor.configurationFingerprint,
    requestFingerprint: input.metadata.providerRequestFingerprint,
    resultCode: input.eventResultCode,
    usage: input.usage,
  });
  await completeAuditOrFail(
    input.options,
    event,
    {
      leaseId: input.leaseId,
      outcome: input.outcome,
      settledAt,
      usage: input.usage,
    },
    input.metadata.correlationHash,
  );
  await recordCircuitOutcome({
    adapter: input.options.adapter,
    alertSink: input.options.alertSink,
    chainId: input.options.chainId,
    controls: input.options.controls,
    correlationHash: input.metadata.correlationHash,
    now: input.options.now ?? (() => new Date().toISOString()),
    outcome: input.circuitOutcome,
    permit: input.permit,
    providerId: input.provider.binding.descriptor.providerId,
    transport: input.options.transport,
  });
  if (input.circuitOutcome === 'failure') {
    emitAlert(input.options.alertSink, {
      adapter: input.options.adapter,
      alertCode: 'provider_failure',
      chainId: input.options.chainId,
      correlationHash: input.metadata.correlationHash,
      observedAt: event.eventAt,
      providerId: input.provider.binding.descriptor.providerId,
      severity: 'warning',
    });
  }
  emitMetric(input.options.metricSink, {
    adapter: input.options.adapter,
    cacheHit: false,
    chainId: input.options.chainId,
    durationMs: event.durationMs,
    observedAt: event.eventAt,
    providerId: input.provider.binding.descriptor.providerId,
    requestFingerprint: input.metadata.providerRequestFingerprint,
    resultCode: input.eventResultCode,
    usage: input.usage,
  });
}

async function releaseDeferredProbe(input: {
  adapter: ChainDataAdapterKind;
  alertSink?: CreateManagedProviderFetchOptions['alertSink'];
  chainId: string;
  controls: SharedCircuitStateCoordinator;
  correlationHash: string;
  now: () => string;
  permit: CircuitPermit;
  providerId: string;
  transport: AdapterTransportConfiguration;
}): Promise<void> {
  if (!input.permit.probe) {
    return;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let state: SharedProviderCircuitState | undefined;
    try {
      state = await input.controls.read({
        adapter: input.adapter,
        chainId: input.chainId,
        providerId: input.providerId,
      });
    } catch (cause) {
      return failCircuitBackend(input, cause);
    }
    if (state === undefined) {
      return failCircuitBackend(input, new Error('Circuit state disappeared.'));
    }
    if (state.state !== 'half_open') {
      return;
    }
    const updatedAt = laterIso(input.now(), state.updatedAt);
    try {
      await input.controls.compareAndSet({
        expectedGeneration: state.generation,
        expectedStateFingerprint: state.stateFingerprint,
        next: {
          adapter: state.adapter,
          chainId: state.chainId,
          consecutiveFailures: state.consecutiveFailures,
          generation: state.generation + 1,
          lastTransitionReason: 'probe_deferred',
          nextProbeAt: new Date(
            Date.parse(updatedAt) + input.transport.circuitOpenMs,
          ).toISOString(),
          openedAt: state.openedAt,
          providerId: state.providerId,
          state: 'open',
          updatedAt,
        },
      });
      return;
    } catch (cause) {
      if (!isStaleGeneration(cause) || attempt === 3) {
        return failCircuitBackend(input, cause);
      }
    }
  }
}

async function completeAuditOrFail(
  options: CreateManagedProviderFetchOptions,
  event: ProductionAuditEvent,
  settlement: ProviderBudgetSettlementInput,
  correlationHash: string,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await options.controls.completeProviderRequest({
        actorIdHash: options.instanceIdHash,
        event,
        settlement,
      });
      return;
    } catch (cause) {
      failure = cause;
    }
  }
  emitAlert(options.alertSink, {
    adapter: options.adapter,
    alertCode: 'audit_sink_unavailable',
    chainId: options.chainId,
    correlationHash,
    observedAt: event.eventAt,
    providerId: event.providerId,
    severity: 'critical',
  });
  throw new ProductionDataPlaneError(
    'audit_unavailable',
    'Provider response was blocked because atomic budget and audit completion failed.',
    { cause: failure },
  );
}

async function persistAuditOrFail(
  options: CreateManagedProviderFetchOptions,
  event: ProductionAuditEvent,
  correlationHash: string,
): Promise<void> {
  try {
    await options.controls.recordProviderRequest({
      actorIdHash: options.instanceIdHash,
      event,
    });
  } catch (cause) {
    emitAlert(options.alertSink, {
      adapter: options.adapter,
      alertCode: 'audit_sink_unavailable',
      chainId: options.chainId,
      correlationHash,
      observedAt: event.eventAt,
      providerId: event.providerId,
      severity: 'critical',
    });
    throw new ProductionDataPlaneError(
      'audit_unavailable',
      'Provider response was blocked because persistent audit failed.',
      { cause },
    );
  }
}

async function acquireCircuitPermit(input: {
  adapter: ChainDataAdapterKind;
  alertSink?: CreateManagedProviderFetchOptions['alertSink'];
  chainId: string;
  controls: SharedCircuitStateCoordinator;
  correlationHash: string;
  now: () => string;
  providerId: string;
  transport: AdapterTransportConfiguration;
}): Promise<CircuitPermit> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let state: SharedProviderCircuitState | undefined;
    try {
      state = await input.controls.read({
        adapter: input.adapter,
        chainId: input.chainId,
        providerId: input.providerId,
      });
    } catch (cause) {
      return failCircuitBackend(input, cause);
    }
    if (state === undefined) {
      return failCircuitBackend(input, new Error('Circuit state is not initialized.'));
    }
    if (state.state === 'closed') {
      return { probe: false };
    }
    const observedAt = laterIso(input.now(), state.updatedAt);
    if (
      state.state === 'half_open' ||
      Date.parse(state.nextProbeAt ?? '') > Date.parse(observedAt)
    ) {
      emitAlert(input.alertSink, {
        adapter: input.adapter,
        alertCode: 'circuit_open',
        chainId: input.chainId,
        correlationHash: input.correlationHash,
        observedAt,
        providerId: input.providerId,
        severity: 'warning',
      });
      throw new ProductionDataPlaneError(
        'circuit_open',
        'Provider request was blocked by the shared circuit.',
      );
    }
    try {
      await input.controls.compareAndSet({
        expectedGeneration: state.generation,
        expectedStateFingerprint: state.stateFingerprint,
        next: {
          adapter: state.adapter,
          chainId: state.chainId,
          consecutiveFailures: state.consecutiveFailures,
          generation: state.generation + 1,
          lastTransitionReason: 'probe_started',
          openedAt: state.openedAt,
          providerId: state.providerId,
          state: 'half_open',
          updatedAt: observedAt,
        },
      });
      return { probe: true };
    } catch (cause) {
      if (!isStaleGeneration(cause) || attempt === 3) {
        return failCircuitBackend(input, cause);
      }
    }
  }
  return failCircuitBackend(input, new Error('Circuit permit retries were exhausted.'));
}

async function recordCircuitOutcome(input: {
  adapter: ChainDataAdapterKind;
  alertSink?: CreateManagedProviderFetchOptions['alertSink'];
  chainId: string;
  controls: SharedCircuitStateCoordinator;
  correlationHash: string;
  now: () => string;
  outcome: 'failure' | 'success';
  permit: CircuitPermit;
  providerId: string;
  transport: AdapterTransportConfiguration;
}): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let state: SharedProviderCircuitState | undefined;
    try {
      state = await input.controls.read({
        adapter: input.adapter,
        chainId: input.chainId,
        providerId: input.providerId,
      });
    } catch (cause) {
      return failCircuitBackend(input, cause);
    }
    if (state === undefined) {
      return failCircuitBackend(input, new Error('Circuit state disappeared.'));
    }
    const next = nextCircuitState(state, input);
    if (next === undefined) {
      return;
    }
    try {
      await input.controls.compareAndSet({
        expectedGeneration: state.generation,
        expectedStateFingerprint: state.stateFingerprint,
        next,
      });
      return;
    } catch (cause) {
      if (!isStaleGeneration(cause) || attempt === 3) {
        return failCircuitBackend(input, cause);
      }
    }
  }
}

function nextCircuitState(
  state: SharedProviderCircuitState,
  input: {
    now: () => string;
    outcome: 'failure' | 'success';
    permit: CircuitPermit;
    transport: AdapterTransportConfiguration;
  },
) {
  const updatedAt = laterIso(input.now(), state.updatedAt);
  if (input.outcome === 'success') {
    if (state.state === 'closed' && state.consecutiveFailures === 0) {
      return undefined;
    }
    if (state.state !== 'closed' && !input.permit.probe) {
      return undefined;
    }
    return {
      adapter: state.adapter,
      chainId: state.chainId,
      consecutiveFailures: 0,
      generation: state.generation + 1,
      lastTransitionReason: input.permit.probe ? 'probe_succeeded' : 'request_succeeded',
      providerId: state.providerId,
      state: 'closed' as const,
      updatedAt,
    };
  }
  if (state.state === 'open' && !input.permit.probe) {
    return undefined;
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  const shouldOpen =
    state.state === 'half_open' ||
    input.permit.probe ||
    consecutiveFailures >= input.transport.circuitFailureThreshold;
  if (!shouldOpen) {
    return {
      adapter: state.adapter,
      chainId: state.chainId,
      consecutiveFailures,
      generation: state.generation + 1,
      lastTransitionReason: 'provider_failure',
      providerId: state.providerId,
      state: 'closed' as const,
      updatedAt,
    };
  }
  const openedAt = state.openedAt ?? updatedAt;
  return {
    adapter: state.adapter,
    chainId: state.chainId,
    consecutiveFailures,
    generation: state.generation + 1,
    lastTransitionReason: state.state === 'half_open' ? 'probe_failed' : 'failure_threshold',
    nextProbeAt: new Date(Date.parse(updatedAt) + input.transport.circuitOpenMs).toISOString(),
    openedAt,
    providerId: state.providerId,
    state: 'open' as const,
    updatedAt,
  };
}

function failCircuitBackend(
  input: {
    adapter: ChainDataAdapterKind;
    alertSink?: CreateManagedProviderFetchOptions['alertSink'];
    chainId: string;
    correlationHash: string;
    now: () => string;
    providerId: string;
  },
  cause: unknown,
): never {
  emitAlert(input.alertSink, {
    adapter: input.adapter,
    alertCode: 'circuit_backend_unavailable',
    chainId: input.chainId,
    correlationHash: input.correlationHash,
    observedAt: input.now(),
    providerId: input.providerId,
    severity: 'critical',
  });
  throw new ProductionDataPlaneError(
    'circuit_unavailable',
    'Provider request was blocked because shared circuit state was unavailable.',
    { cause },
  );
}

function requestMetadata(
  body: RequestInit['body'],
  adapter: ChainDataAdapterKind,
  chainId: string,
  manifestFingerprint: string,
  providerConfigurationFingerprint: string,
  providerId: string,
  instanceIdHash: string,
): RequestMetadata {
  if (typeof body !== 'string') {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider transport only accepts JSON string request bodies.',
    );
  }
  if (body.length > MAX_MANAGED_REQUEST_BODY_CHARACTERS) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider request body exceeds its character limit.',
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch (cause) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider transport requires a valid JSON request body.',
      { cause },
    );
  }
  const rpcCalls = Array.isArray(payload) ? payload.length : 1;
  if (rpcCalls < 1 || rpcCalls > 10_000) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider request has an invalid RPC call count.',
    );
  }
  const cacheable = analyzeJsonPayload(payload);
  const providerRequestFingerprint = sha256Fingerprint({
    adapter,
    chainId,
    manifestFingerprint,
    payload,
    providerConfigurationFingerprint,
    providerId,
  });
  return {
    cacheable,
    cacheKey: sha256Fingerprint({
      adapter,
      chainId,
      providerId,
      request: providerRequestFingerprint,
    }),
    correlationHash: sha256Fingerprint({
      instanceIdHash,
      request: providerRequestFingerprint,
    }),
    providerRequestFingerprint,
    rpcCalls,
  };
}

function assertApprovedHttpRequest(
  init: RequestInit | undefined,
  provider: ResolvedProductionProvider,
): void {
  if (init?.method !== 'POST' || init.redirect !== 'error') {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider transport only accepts non-redirecting POST requests.',
    );
  }
  const headers = new Headers(init.headers);
  const expected = new Map<string, string>([
    ['accept', 'application/json'],
    ['content-type', 'application/json'],
    ...Object.entries(provider.headers),
  ]);
  if (
    [...headers].length !== expected.size ||
    [...expected].some(([name, value]) => headers.get(name) !== value)
  ) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider request headers do not match the approved configuration.',
    );
  }
}

function analyzeJsonPayload(root: unknown): boolean {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: root }];
  let cacheable = true;
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    nodes += 1;
    if (nodes > MAX_REQUEST_JSON_NODES || current.depth > MAX_REQUEST_JSON_DEPTH) {
      throw new ProductionDataPlaneError(
        'invalid_configuration',
        'Managed provider request JSON exceeds its structural limits.',
      );
    }
    if (typeof current.value === 'string') {
      if (
        current.value === 'latest' ||
        current.value === 'pending' ||
        current.value === 'safe' ||
        current.value === 'finalized'
      ) {
        cacheable = false;
      }
      continue;
    }
    const children = Array.isArray(current.value)
      ? current.value
      : current.value !== null && typeof current.value === 'object'
        ? Object.values(current.value as Record<string, unknown>)
        : [];
    for (const value of children) {
      stack.push({ depth: current.depth + 1, value });
    }
  }
  return cacheable;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function normalizeEndpoint(value: string, allowInsecureLocalhost: boolean): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider endpoint is invalid.',
      { cause },
    );
  }
  const isAllowedLocalhost =
    allowInsecureLocalhost && endpoint.protocol === 'http:' && isLoopbackHost(endpoint.hostname);
  if (
    (endpoint.protocol !== 'https:' && !isAllowedLocalhost) ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Managed provider endpoint violates the approved transport boundary.',
    );
  }
  return endpoint.toString();
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType !== null) {
    headers.set('content-type', contentType);
  }
  return headers;
}

function responseFromCache(entry: {
  body: Uint8Array;
  contentType?: string | undefined;
  status: number;
}): Response {
  const headers = new Headers();
  if (entry.contentType !== undefined) {
    headers.set('content-type', entry.contentType);
  }
  return new Response(copyArrayBuffer(entry.body), {
    headers,
    status: entry.status,
  });
}

async function readBoundedResponseBody(
  response: Response,
  maxResponseBytes: number,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    (declaredLength.length > 20 || BigInt(declaredLength) > BigInt(maxResponseBytes))
  ) {
    await response.body?.cancel().catch(() => undefined);
    return { bytes: new Uint8Array(), exceeded: true };
  }
  if (response.body === null) {
    return { bytes: new Uint8Array(), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let chunkCount = 0;
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const chunk: unknown = result.value;
    if (!(chunk instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      throw new ProductionDataPlaneError(
        'transport_unavailable',
        'Provider response stream returned an invalid chunk.',
      );
    }
    chunkCount += 1;
    if (chunkCount > MAX_RESPONSE_CHUNKS) {
      await reader.cancel().catch(() => undefined);
      throw new ProductionDataPlaneError(
        'transport_unavailable',
        'Provider response stream exceeded its chunk limit.',
      );
    }
    if (totalBytes + chunk.byteLength > maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      return { bytes: new Uint8Array(), exceeded: true };
    }
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded: false };
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function readCacheSafely(
  cache: ProviderResponseCache | undefined,
  key: string | undefined,
  nowMs: number,
  onFailure: () => void,
) {
  if (cache === undefined || key === undefined) {
    return undefined;
  }
  try {
    return await cache.read(key, nowMs);
  } catch {
    onFailure();
    return undefined;
  }
}

async function writeCacheSafely(
  cache: ProviderResponseCache | undefined,
  key: string,
  entry: { body: Uint8Array; contentType?: string | undefined; status: number },
  expiresAtMs: number,
  onFailure: () => void,
): Promise<void> {
  if (cache === undefined) {
    return;
  }
  try {
    await cache.write(key, entry, expiresAtMs);
  } catch {
    onFailure();
  }
}

function emitMetric(
  sink: CreateManagedProviderFetchOptions['metricSink'],
  metric: ProductionDataPlaneMetric,
): void {
  if (sink === undefined) {
    return;
  }
  try {
    void Promise.resolve(sink(metric)).catch(() => undefined);
  } catch {
    // Metrics are redacted observations and cannot alter the provider result.
  }
}

function emitAlert(
  sink: CreateManagedProviderFetchOptions['alertSink'],
  alert: ProductionDataPlaneAlert,
): void {
  if (sink === undefined) {
    return;
  }
  try {
    void Promise.resolve(sink(alert)).catch(() => undefined);
  } catch {
    // The primary failure remains visible to the caller even when alert delivery also fails.
  }
}

function isStaleGeneration(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'stale_generation'
  );
}

function isControlBackendError(error: unknown): boolean {
  return !(
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    (error.code.startsWith('budget_') ||
      error.code === 'invalid_state' ||
      error.code === 'unauthorized')
  );
}

function safeNowMs(nowMs: () => number): number {
  const value = nowMs();
  if (!Number.isFinite(value)) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Data-plane clock returned a non-finite value.',
    );
  }
  return Math.max(0, Math.trunc(value));
}

function boundedDuration(startedAtMs: number, endedAtMs: number): number {
  return Math.min(86_400_000, Math.max(0, endedAtMs - startedAtMs));
}

function laterIso(candidate: string, previous: string): string {
  const candidateMs = Date.parse(candidate);
  const previousMs = Date.parse(previous);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(previousMs)) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Data-plane clock returned an invalid timestamp.',
    );
  }
  return new Date(Math.max(candidateMs, previousMs + 1)).toISOString();
}

function monotonicIsoClock(clock: () => string): () => string {
  let previousMs = Number.NEGATIVE_INFINITY;
  return () => {
    const candidateMs = Date.parse(clock());
    if (!Number.isFinite(candidateMs)) {
      throw new ProductionDataPlaneError(
        'invalid_configuration',
        'Data-plane clock returned an invalid timestamp.',
      );
    }
    previousMs = Math.max(candidateMs, previousMs + 1);
    return new Date(previousMs).toISOString();
  };
}

function zeroUsage(): Usage {
  return { costUnits: 0, requests: 0, responseBytes: 0, rpcCalls: 0 };
}

function validateResolvedProvider(
  provider: ResolvedProductionProvider,
  adapter: ChainDataAdapterKind,
  chainId: string,
  allowInsecureLocalhost: boolean,
): ResolvedProductionProvider {
  const binding = productionProviderBindingSchema.parse(provider.binding);
  const expectedHeaderNames = binding.credentialHeaders.map((header) => header.name).sort();
  const headerEntries = Object.entries(provider.headers).map(
    ([name, value]) => [name.toLowerCase(), value] as const,
  );
  const actualHeaderNames = headerEntries.map(([name]) => name).sort();
  if (
    provider.adapter !== adapter ||
    binding.descriptor.adapter !== adapter ||
    binding.descriptor.chainId !== chainId ||
    new Set(actualHeaderNames).size !== actualHeaderNames.length ||
    actualHeaderNames.length !== expectedHeaderNames.length ||
    actualHeaderNames.some((name, index) => name !== expectedHeaderNames[index]) ||
    headerEntries.some(
      ([, value]) =>
        value.length === 0 ||
        value.length > 8_192 ||
        value !== value.trim() ||
        /[\r\n]/u.test(value),
    )
  ) {
    throw new ProductionDataPlaneError(
      'invalid_configuration',
      'Resolved provider does not match the managed adapter boundary.',
    );
  }
  return {
    adapter,
    binding,
    endpoint: normalizeEndpoint(provider.endpoint, allowInsecureLocalhost),
    headers: Object.fromEntries(headerEntries),
  };
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === 'localhost'
  );
}

function isFingerprint(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}
