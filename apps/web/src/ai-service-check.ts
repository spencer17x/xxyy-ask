import { createApiHeaders } from './api-auth.js';

export const AI_SERVICE_TEST_QUESTION = 'XXYY Pro 有哪些权益？';

export type AiServiceCheckResult =
  | {
      confidence: number;
      intent: string;
      ok: true;
      statusText: string;
    }
  | {
      message: string;
      ok: false;
      statusText: string;
    };

interface ChatCheckPayload {
  answer?: unknown;
  confidence?: unknown;
  error?: unknown;
  intent?: unknown;
  message?: unknown;
}

export async function checkAiService(
  fetchImpl: typeof fetch,
  sessionId: string,
  authToken?: string,
): Promise<AiServiceCheckResult> {
  let response: Response;
  try {
    response = await fetchImpl('/api/chat', {
      body: JSON.stringify({
        channel: 'web',
        message: AI_SERVICE_TEST_QUESTION,
        sessionId,
      }),
      headers: createApiHeaders(authToken),
      method: 'POST',
    });
  } catch (error) {
    return unavailable(formatError(error));
  }

  if (!response.ok) {
    return unavailable(await readErrorMessage(response));
  }

  const payload = await readJson(response);
  if (payload === undefined) {
    return unavailable('响应不是有效 JSON');
  }

  if (typeof payload.answer !== 'string' || payload.answer.trim().length === 0) {
    return unavailable('响应缺少可用回答');
  }

  if (typeof payload.intent !== 'string' || payload.intent.trim().length === 0) {
    return unavailable('响应缺少意图信息');
  }

  if (typeof payload.confidence !== 'number' || !Number.isFinite(payload.confidence)) {
    return unavailable('响应缺少置信度');
  }

  const confidence = payload.confidence;
  const intent = payload.intent;
  return {
    confidence,
    intent,
    ok: true,
    statusText: `AI 服务正常 · ${intent} ${confidence.toFixed(2)}`,
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  const payload = await readJson(response);
  const message = payload?.message ?? payload?.error;
  if (typeof message === 'string' && message.trim().length > 0) {
    return compactMessage(message);
  }
  return `请求失败 (${response.status})`;
}

async function readJson(response: Response): Promise<ChatCheckPayload | undefined> {
  try {
    const payload = (await response.json()) as unknown;
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function unavailable(message: string): AiServiceCheckResult {
  const compact = compactMessage(message);
  return {
    message: compact,
    ok: false,
    statusText: `AI 服务不可用：${compact}`,
  };
}

function compactMessage(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return '请求无法送达';
}

function isRecord(value: unknown): value is ChatCheckPayload {
  return typeof value === 'object' && value !== null;
}
