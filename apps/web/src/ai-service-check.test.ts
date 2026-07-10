import { describe, expect, it, vi } from 'vitest';

import { AI_SERVICE_TEST_QUESTION, checkAiService } from './ai-service-check.js';

describe('checkAiService', () => {
  it('posts a lightweight product question to the normal chat endpoint', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          answer: 'XXYY Pro 包含更多权益。',
          confidence: 0.82,
          intent: 'product_qa',
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await checkAiService(fetchImpl, 'session-test', '  chat-secret  ');

    expect(fetchImpl).toHaveBeenCalledWith('/api/chat', {
      body: JSON.stringify({
        channel: 'web',
        message: AI_SERVICE_TEST_QUESTION,
        sessionId: 'session-test',
      }),
      headers: {
        Authorization: 'Bearer chat-secret',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    expect(result).toEqual({
      confidence: 0.82,
      intent: 'product_qa',
      ok: true,
      statusText: 'AI 服务正常 · product_qa 0.82',
    });
  });

  it('returns a compact API error when the chat endpoint rejects the check', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ message: 'LLM 配置缺失' }, { status: 503 })),
    ) as unknown as typeof fetch;

    await expect(checkAiService(fetchImpl, 'session-test')).resolves.toEqual({
      message: 'LLM 配置缺失',
      ok: false,
      statusText: 'AI 服务不可用：LLM 配置缺失',
    });
  });

  it('treats malformed success payloads as an unavailable service', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ answer: '', confidence: 0.7, intent: 'product_qa' })),
    ) as unknown as typeof fetch;

    await expect(checkAiService(fetchImpl, 'session-test')).resolves.toEqual({
      message: '响应缺少可用回答',
      ok: false,
      statusText: 'AI 服务不可用：响应缺少可用回答',
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
