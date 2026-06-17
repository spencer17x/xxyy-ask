import { createHash } from 'node:crypto';

import type { RawSupportMessage, SupportMessageSenderRole } from './types.js';

export interface FetchTelegramSupportMessagesOptions {
  allowedChatIds: readonly string[];
  botToken: string;
  fetch?: typeof fetch;
  limit?: number;
  now?: () => string;
  offset?: number;
  supportUserIds?: readonly string[];
}

export interface FetchTelegramSupportMessagesResult {
  messages: RawSupportMessage[];
  nextOffset?: number;
}

interface TelegramGetUpdatesResponse {
  description?: string;
  ok: boolean;
  result?: TelegramUpdate[];
}

interface TelegramUpdate {
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  edited_message?: TelegramMessage;
  message?: TelegramMessage;
  update_id: number;
}

interface TelegramMessage {
  caption?: string;
  chat: {
    id: number | string;
  };
  date: number;
  from?: {
    id?: number | string;
    is_bot?: boolean;
  };
  message_id: number;
  reply_to_message?: {
    message_id?: number;
  };
  text?: string;
}

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export async function fetchTelegramSupportMessages(
  options: FetchTelegramSupportMessagesOptions,
): Promise<FetchTelegramSupportMessagesResult> {
  const allowedChatIds = new Set(options.allowedChatIds.map(normalizeTelegramId));
  if (allowedChatIds.size === 0) {
    throw new Error('At least one authorized Telegram chat id is required.');
  }

  const fetchImpl = options.fetch ?? fetch;
  const url = createGetUpdatesUrl(options);
  const response = await fetchImpl(url);
  const payload = (await response.json()) as TelegramGetUpdatesResponse;
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      `Telegram getUpdates failed with status ${response.status}: ${
        payload.description?.trim() || response.statusText || 'unknown error'
      }`,
    );
  }

  const supportUserIds = new Set((options.supportUserIds ?? []).map(normalizeTelegramId));
  const now = options.now?.() ?? new Date().toISOString();
  const updates = payload.result ?? [];
  const messages = updates.flatMap((update) =>
    mapTelegramUpdate(update, {
      allowedChatIds,
      now,
      supportUserIds,
    }),
  );
  const maxUpdateId = updates.reduce<number | undefined>(
    (current, update) =>
      current === undefined || update.update_id > current ? update.update_id : current,
    undefined,
  );

  return {
    messages,
    ...(maxUpdateId === undefined ? {} : { nextOffset: maxUpdateId + 1 }),
  };
}

function createGetUpdatesUrl(options: FetchTelegramSupportMessagesOptions): string {
  const url = new URL(`${TELEGRAM_API_BASE_URL}/bot${options.botToken}/getUpdates`);
  if (options.offset !== undefined) {
    url.searchParams.set('offset', String(options.offset));
  }
  url.searchParams.set('limit', String(normalizeLimit(options.limit)));
  url.searchParams.set(
    'allowed_updates',
    JSON.stringify(['message', 'edited_message', 'channel_post', 'edited_channel_post']),
  );
  return url.toString();
}

function mapTelegramUpdate(
  update: TelegramUpdate,
  context: {
    allowedChatIds: Set<string>;
    now: string;
    supportUserIds: Set<string>;
  },
): RawSupportMessage[] {
  const message =
    update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  if (message === undefined) {
    return [];
  }

  const chatId = normalizeTelegramId(message.chat.id);
  if (!context.allowedChatIds.has(chatId)) {
    return [];
  }

  const text = (message.text ?? message.caption ?? '').trim();
  if (text.length === 0) {
    return [];
  }

  const rawMessage: RawSupportMessage = {
    source: 'telegram',
    chatIdHash: hashTelegramChatId(chatId),
    contentHash: hashTelegramMessageContent({ chatId, message, text }),
    ingestedAt: context.now,
    messageId: String(message.message_id),
    ...(message.reply_to_message?.message_id === undefined
      ? {}
      : { replyToMessageId: String(message.reply_to_message.message_id) }),
    senderRole: classifySenderRole(message, context.supportUserIds),
    sentAt: new Date(message.date * 1000).toISOString(),
    text,
  };

  return [rawMessage];
}

function classifySenderRole(
  message: TelegramMessage,
  supportUserIds: Set<string>,
): SupportMessageSenderRole {
  const senderId = message.from?.id;
  if (senderId !== undefined && supportUserIds.has(normalizeTelegramId(senderId))) {
    return 'support';
  }

  if (message.from?.is_bot === true) {
    return 'support';
  }

  return 'user';
}

function hashTelegramChatId(chatId: string): string {
  return createHash('sha256').update(`telegram:${chatId}`).digest('hex');
}

function hashTelegramMessageContent(input: {
  chatId: string;
  message: TelegramMessage;
  text: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        chatId: input.chatId,
        date: input.message.date,
        messageId: input.message.message_id,
        replyToMessageId: input.message.reply_to_message?.message_id,
        text: input.text,
      }),
    )
    .digest('hex');
}

function normalizeTelegramId(value: number | string): string {
  return String(value).trim();
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(limit, MAX_LIMIT);
}
