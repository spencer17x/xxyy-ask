import { describe, expect, it, vi } from 'vitest';

import { runAgentSmoke } from './agent-smoke.mjs';

describe('runAgentSmoke', () => {
  it('checks health and first-slice agent routes', async () => {
    const calls = [];
    const fetch = vi.fn(async (url, init = {}) => {
      calls.push({ body: init.body, method: init.method ?? 'GET', url });

      if (url === 'https://ask.example.test/health') {
        return jsonResponse({ ok: true });
      }

      if (url !== 'https://ask.example.test/api/chat') {
        throw new Error(`unexpected URL: ${url}`);
      }

      const body = JSON.parse(init.body);
      if (body.message === 'product question') {
        return jsonResponse({ agentRoute: 'product_answer', answer: 'product answer' });
      }
      if (body.message === 'boundary question') {
        return jsonResponse({ agentRoute: 'boundary', answer: 'boundary answer' });
      }
      if (body.message === 'tx-hash-1') {
        return jsonResponse({ agentRoute: 'transaction_analysis', answer: 'tx answer' });
      }

      throw new Error(`unexpected message: ${body.message}`);
    });
    const output = [];

    const exitCode = await runAgentSmoke({
      env: {
        API_SMOKE_BASE_URL: 'https://ask.example.test',
        API_SMOKE_BOUNDARY_QUESTION: 'boundary question',
        API_SMOKE_PRODUCT_QUESTION: 'product question',
        API_SMOKE_TX_HASH: 'tx-hash-1',
      },
      fetch,
      log: (message) => output.push(message),
    });

    expect(exitCode).toBe(0);
    expect(output).toEqual(['agent smoke passed']);
    expect(calls).toEqual([
      { body: undefined, method: 'GET', url: 'https://ask.example.test/health' },
      {
        body: JSON.stringify({ channel: 'web', message: 'product question' }),
        method: 'POST',
        url: 'https://ask.example.test/api/chat',
      },
      {
        body: JSON.stringify({ channel: 'web', message: 'boundary question' }),
        method: 'POST',
        url: 'https://ask.example.test/api/chat',
      },
      {
        body: JSON.stringify({ channel: 'web', message: 'tx-hash-1' }),
        method: 'POST',
        url: 'https://ask.example.test/api/chat',
      },
    ]);
  });
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}
