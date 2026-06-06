import { describe, expect, it } from 'vitest';

import { createApiSmokeChecks, runApiSmoke } from './api-smoke.mjs';

describe('createApiSmokeChecks', () => {
  it('checks public health endpoints by default', () => {
    expect(createApiSmokeChecks([], {})).toEqual([
      {
        body: undefined,
        headers: {},
        kind: 'health',
        label: 'health',
        method: 'GET',
        url: 'http://localhost:3000/health',
      },
      {
        body: undefined,
        headers: {},
        kind: 'deepHealth',
        label: 'deep health',
        method: 'GET',
        url: 'http://localhost:3000/health/deep',
      },
    ]);
  });

  it('supports protected ops summary and chat smoke checks', () => {
    expect(
      createApiSmokeChecks(
        [
          '--base-url',
          'https://ask.example.com',
          '--ops-token',
          'ops-token',
          '--chat',
          '--question',
          'XXYY Pro 有哪些权益？',
        ],
        {},
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'health',
        url: 'https://ask.example.com/health',
      }),
      expect.objectContaining({
        kind: 'deepHealth',
        url: 'https://ask.example.com/health/deep',
      }),
      expect.objectContaining({
        headers: { Authorization: 'Bearer ops-token' },
        kind: 'opsSummary',
        url: 'https://ask.example.com/api/ops/summary',
      }),
      expect.objectContaining({
        body: JSON.stringify({ channel: 'cli', message: 'XXYY Pro 有哪些权益？' }),
        headers: { 'Content-Type': 'application/json' },
        kind: 'chat',
        method: 'POST',
        url: 'https://ask.example.com/api/chat',
      }),
    ]);
  });

  it('reads base URL and ops token from environment', () => {
    expect(
      createApiSmokeChecks([], {
        API_BASE_URL: 'https://ask.example.com/',
        API_OPS_TOKEN: 'env-token',
      }),
    ).toContainEqual(
      expect.objectContaining({
        headers: { Authorization: 'Bearer env-token' },
        kind: 'opsSummary',
        url: 'https://ask.example.com/api/ops/summary',
      }),
    );
  });
});

describe('runApiSmoke', () => {
  it('runs checks and validates chat responses when requested', async () => {
    const calls = [];
    const exitCode = await runApiSmoke({
      args: ['--chat'],
      env: {},
      fetch: (url, request) => {
        calls.push({ request, url });
        if (url.endsWith('/api/chat')) {
          return Promise.resolve(
            jsonResponse({
              answer: 'XXYY Pro 提供更多权益。',
              citations: [{ title: 'XXYY Pro 权益' }],
              intent: 'product_qa',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: () => {},
    });

    expect(exitCode).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/health',
      'http://localhost:3000/health/deep',
      'http://localhost:3000/api/chat',
    ]);
  });

  it('fails on the first unavailable endpoint', async () => {
    const labels = [];
    const exitCode = await runApiSmoke({
      args: [],
      env: {},
      fetch: (url) =>
        Promise.resolve(
          url.endsWith('/health') ? jsonResponse({ status: 'ok' }) : jsonResponse({}, 503),
        ),
      log: (message) => {
        if (message.startsWith('==> ')) {
          labels.push(message.replace('==> ', ''));
        }
      },
    });

    expect(exitCode).toBe(1);
    expect(labels).toEqual(['health', 'deep health']);
  });
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}
