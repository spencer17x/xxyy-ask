export interface ModelHealthCheck {
  status: 'error' | 'ok';
  dimension?: number;
  message?: string;
  model?: string;
}

export type ModelHealthResult =
  | {
      durationMs: number;
      embedding: ModelHealthCheck;
      kind: 'report';
      llm: ModelHealthCheck;
      ok: boolean;
    }
  | {
      durationMs: number;
      kind: 'error';
      message: string;
      ok: false;
    };

export async function checkModelHealth(
  fetchImpl: typeof fetch,
  now: () => number = defaultNow,
): Promise<ModelHealthResult> {
  const startedAt = now();
  try {
    const response = await fetchImpl('/health/deep', {
      headers: { Accept: 'application/json' },
      method: 'GET',
    });
    const payload = (await response.json().catch(() => undefined)) as unknown;
    const durationMs = elapsedMs(startedAt, now);
    if (!isHealthPayload(payload)) {
      return {
        durationMs,
        kind: 'error',
        message: readErrorMessage(payload, response.status),
        ok: false,
      };
    }

    return {
      durationMs,
      embedding: payload.checks.embedding,
      kind: 'report',
      llm: payload.checks.llm,
      ok:
        response.ok &&
        payload.checks.embedding.status === 'ok' &&
        payload.checks.llm.status === 'ok',
    };
  } catch (error) {
    return {
      durationMs: elapsedMs(startedAt, now),
      kind: 'error',
      message: error instanceof Error ? error.message : '模型测试请求失败',
      ok: false,
    };
  }
}

function isHealthPayload(
  value: unknown,
): value is { checks: { embedding: ModelHealthCheck; llm: ModelHealthCheck } } {
  if (!isRecord(value) || !isRecord(value.checks)) {
    return false;
  }
  return isModelCheck(value.checks.embedding) && isModelCheck(value.checks.llm);
}

function isModelCheck(value: unknown): value is ModelHealthCheck {
  return isRecord(value) && (value.status === 'ok' || value.status === 'error');
}

function readErrorMessage(payload: unknown, status: number): string {
  if (isRecord(payload) && typeof payload.message === 'string') {
    return payload.message;
  }
  return `模型测试请求失败 (${status})`;
}

function elapsedMs(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
