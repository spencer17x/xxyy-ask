import { describe, expect, it, vi } from 'vitest';

import { checkModelHealth } from './model-health.js';

const healthyPayload = {
  checks: {
    config: { status: 'ok' },
    embedding: { dimension: 1536, model: 'text-embedding-3-small', status: 'ok' },
    llm: { model: 'grok-4.5', status: 'ok' },
    vectorStore: { status: 'ok' },
  },
  status: 'ok',
};

describe('checkModelHealth', () => {
  it('checks LLM and embedding without authorization', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(healthyPayload)),
    ) as unknown as typeof fetch;

    await expect(checkModelHealth(fetchImpl, sequenceNow(10, 34))).resolves.toEqual({
      durationMs: 24,
      embedding: healthyPayload.checks.embedding,
      kind: 'report',
      llm: healthyPayload.checks.llm,
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith('/health/deep', {
      headers: { Accept: 'application/json' },
      method: 'GET',
    });
  });

  it('preserves model details from a degraded response', async () => {
    const payload = {
      ...healthyPayload,
      checks: {
        ...healthyPayload.checks,
        llm: { message: 'LLM unavailable', model: 'grok-4.5', status: 'error' },
      },
      status: 'degraded',
    };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(payload, { status: 503 })),
    ) as unknown as typeof fetch;

    await expect(checkModelHealth(fetchImpl, sequenceNow(0, 9))).resolves.toMatchObject({
      durationMs: 9,
      kind: 'report',
      llm: payload.checks.llm,
      ok: false,
    });
  });

  it('returns a readable error for malformed responses', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ status: 'ok' })),
    ) as unknown as typeof fetch;

    await expect(checkModelHealth(fetchImpl, sequenceNow(2, 5))).resolves.toEqual({
      durationMs: 3,
      kind: 'error',
      message: '模型测试请求失败 (200)',
      ok: false,
    });
  });
});

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
    ...init,
  });
}

function sequenceNow(...values: number[]): () => number {
  return () => values.shift() ?? 0;
}
