import type {
  TelegramApi,
  TelegramGetUpdatesInput,
  TelegramSendMessageInput,
  TelegramSendMessageDraftInput,
  TelegramSendPhotoInput,
  TelegramUpdate,
} from './bot.js';

export interface CreateTelegramApiClientOptions {
  apiBaseUrl?: string;
  botToken: string;
  fetch?: TelegramFetch;
}

type TelegramFetch = (
  input: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: 'POST';
  },
) => Promise<{
  json(): Promise<unknown>;
}>;

export class TelegramApiError extends Error {
  description?: string;
  method: string;

  constructor(method: string, description: string) {
    super(`Telegram Bot API ${method} failed: ${description}`);
    this.name = 'TelegramApiError';
    this.description = description;
    this.method = method;
  }
}

interface TelegramApiResponse {
  description?: string;
  ok: boolean;
  result?: unknown;
}

export function createTelegramApiClient(options: CreateTelegramApiClientOptions): TelegramApi {
  const apiBaseUrl = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/u, '');
  const fetchImpl = options.fetch ?? fetch;

  return {
    getUpdates(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'getUpdates', {
        allowed_updates: ['message'],
        limit: input.limit,
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        timeout: input.timeout,
      }).then((result) => (Array.isArray(result) ? (result as TelegramUpdate[]) : []));
    },

    sendMessage(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'sendMessage', {
        chat_id: input.chatId,
        text: input.text,
      }).then(() => undefined);
    },

    sendMessageDraft(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'sendMessageDraft', {
        chat_id: input.chatId,
        draft_id: input.draftId,
        text: input.text,
      }).then(() => undefined);
    },

    sendPhoto(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'sendPhoto', {
        ...(input.caption === undefined ? {} : { caption: input.caption }),
        chat_id: input.chatId,
        photo: input.photo,
      }).then(() => undefined);
    },
  } satisfies TelegramApi;
}

async function callTelegramMethod(
  fetchImpl: TelegramFetch,
  apiBaseUrl: string,
  botToken: string,
  method: 'getUpdates' | 'sendMessage' | 'sendMessageDraft' | 'sendPhoto',
  payload:
    | Record<string, unknown>
    | Record<keyof TelegramGetUpdatesInput, unknown>
    | Record<keyof TelegramSendMessageInput, unknown>
    | Record<keyof TelegramSendMessageDraftInput, unknown>
    | Record<keyof TelegramSendPhotoInput, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(`${apiBaseUrl}/bot${botToken}/${method}`, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  const body = readTelegramApiResponse(await response.json());
  if (!body.ok) {
    throw new TelegramApiError(method, body.description ?? 'Unknown Telegram API error.');
  }
  return body.result;
}

function readTelegramApiResponse(value: unknown): TelegramApiResponse {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, description: 'Invalid Telegram API response.' };
  }
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ok: record.ok === true,
    result: record.result,
  };
}
