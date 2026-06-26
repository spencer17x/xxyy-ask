import type { ChatResponse } from '@xxyy/shared';
import type { ChatService } from '@xxyy/rag-core';

export interface TelegramBotConfig {
  allowedChatIds?: Set<number>;
  botToken: string;
  pollErrorRetryMs: number;
  pollTimeoutSeconds: number;
  publicBaseUrl?: string;
  supportUserIds?: Set<number>;
  updatesLimit: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  chat: {
    id: number;
  };
  from?: {
    id: number;
  };
  message_id: number;
  text?: string;
}

export interface TelegramApi {
  getUpdates(input: TelegramGetUpdatesInput): Promise<TelegramUpdate[]>;
  sendMessage(input: TelegramSendMessageInput): Promise<void>;
  sendPhoto(input: TelegramSendPhotoInput): Promise<void>;
}

export interface TelegramGetUpdatesInput {
  limit: number;
  offset?: number;
  timeout: number;
}

export interface TelegramSendMessageInput {
  chatId: number;
  text: string;
}

export interface TelegramSendPhotoInput {
  caption?: string;
  chatId: number;
  photo: string;
}

export interface TelegramBot {
  handleUpdate(update: TelegramUpdate): Promise<void>;
  pollOnce(): Promise<void>;
}

export interface CreateTelegramBotOptions {
  api: TelegramApi;
  chatService: Pick<ChatService, 'ask'>;
  config: TelegramBotConfig;
  logger?: TelegramBotLogger;
}

export interface TelegramBotLogger {
  error(message: string, error?: unknown): void;
  info(message: string): void;
}

export type TelegramBotEnv = Record<string, string | undefined> &
  Partial<
    Record<
      | 'TELEGRAM_ALLOWED_CHAT_IDS'
      | 'TELEGRAM_BOT_TOKEN'
      | 'TELEGRAM_POLL_ERROR_RETRY_MS'
      | 'TELEGRAM_POLL_TIMEOUT_SECONDS'
      | 'TELEGRAM_PUBLIC_BASE_URL'
      | 'TELEGRAM_SUPPORT_USER_IDS'
      | 'TELEGRAM_UPDATES_LIMIT',
      string
    >
  >;

export class TelegramBotConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramBotConfigurationError';
  }
}

const DEFAULT_UPDATES_LIMIT = 100;
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_POLL_ERROR_RETRY_MS = 3000;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const HELP_TEXT = [
  '我是 XXYY 客服 Bot，可以回答产品使用问题，也可以检查公开交易链接是否被夹。',
  '',
  '直接发送问题或 Solscan / EVM explorer 交易链接即可。',
].join('\n');
const UNAUTHORIZED_TEXT = '当前 Telegram chat 未授权使用这个 XXYY 客服 Bot。';
const UNSUPPORTED_MESSAGE_TEXT = '目前只支持文本消息，请直接发送问题或交易链接。';

export function loadTelegramBotConfig(env: TelegramBotEnv): TelegramBotConfig {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (botToken === undefined || botToken.length === 0) {
    throw new TelegramBotConfigurationError('TELEGRAM_BOT_TOKEN is required.');
  }

  const publicBaseUrl = normalizeOptionalString(env.TELEGRAM_PUBLIC_BASE_URL);

  const allowedChatIds = parseIntegerSet(env.TELEGRAM_ALLOWED_CHAT_IDS);
  const supportUserIds = parseIntegerSet(env.TELEGRAM_SUPPORT_USER_IDS);

  return {
    ...(allowedChatIds === undefined ? {} : { allowedChatIds }),
    botToken,
    pollErrorRetryMs: parsePositiveInteger(
      env.TELEGRAM_POLL_ERROR_RETRY_MS,
      DEFAULT_POLL_ERROR_RETRY_MS,
    ),
    pollTimeoutSeconds: parsePositiveInteger(
      env.TELEGRAM_POLL_TIMEOUT_SECONDS,
      DEFAULT_POLL_TIMEOUT_SECONDS,
    ),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    ...(supportUserIds === undefined ? {} : { supportUserIds }),
    updatesLimit: parsePositiveInteger(env.TELEGRAM_UPDATES_LIMIT, DEFAULT_UPDATES_LIMIT),
  };
}

export function createTelegramBot(options: CreateTelegramBotOptions): TelegramBot {
  let offset: number | undefined;

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message === undefined) {
      return;
    }

    const chatId = message.chat.id;
    if (!isAllowedMessage(message, options.config)) {
      await options.api.sendMessage({ chatId, text: UNAUTHORIZED_TEXT });
      return;
    }

    const text = message.text?.trim();
    if (text === undefined || text.length === 0) {
      await options.api.sendMessage({ chatId, text: UNSUPPORTED_MESSAGE_TEXT });
      return;
    }

    if (isHelpCommand(text)) {
      await options.api.sendMessage({ chatId, text: HELP_TEXT });
      return;
    }

    const response = await options.chatService.ask({
      channel: 'telegram',
      message: text,
      sessionId: `telegram:${chatId}`,
      ...(message.from?.id === undefined ? {} : { userId: `telegram:${message.from.id}` }),
    });

    await sendChatResponse(options.api, chatId, response, options.config);
  }

  return {
    handleUpdate,

    async pollOnce(): Promise<void> {
      const updates = await options.api.getUpdates({
        limit: options.config.updatesLimit,
        ...(offset === undefined ? {} : { offset }),
        timeout: options.config.pollTimeoutSeconds,
      });

      for (const update of updates) {
        await handleUpdate(update);
        offset = update.update_id + 1;
      }
    },
  };
}

export async function runTelegramBot(
  bot: Pick<TelegramBot, 'pollOnce'>,
  options: {
    abortSignal?: AbortSignal;
    errorRetryMs: number;
    logger?: TelegramBotLogger;
  },
): Promise<void> {
  while (options.abortSignal?.aborted !== true) {
    try {
      await bot.pollOnce();
    } catch (error) {
      options.logger?.error('Telegram polling failed.', error);
      await sleep(options.errorRetryMs, options.abortSignal);
    }
  }
}

export async function sendChatResponse(
  api: Pick<TelegramApi, 'sendMessage' | 'sendPhoto'>,
  chatId: number,
  response: ChatResponse,
  config: Pick<TelegramBotConfig, 'publicBaseUrl'>,
): Promise<void> {
  const attachmentLines = attachmentFallbackLines(response.attachments, config.publicBaseUrl);
  const message = [response.answer, ...attachmentLines].join('\n').trim();
  for (const chunk of splitTelegramMessage(message, TELEGRAM_MESSAGE_LIMIT)) {
    await api.sendMessage({ chatId, text: chunk });
  }

  for (const attachment of response.attachments ?? []) {
    if (attachment.kind !== 'image') {
      continue;
    }
    const photo = resolveTelegramAttachmentUrl(attachment.url, config.publicBaseUrl);
    if (photo === undefined) {
      continue;
    }
    await api.sendPhoto({
      caption: attachment.title,
      chatId,
      photo,
    });
  }
}

export function resolveTelegramAttachmentUrl(
  url: string,
  publicBaseUrl?: string,
): string | undefined {
  if (/^https?:\/\//iu.test(url)) {
    return url;
  }
  if (publicBaseUrl === undefined) {
    return undefined;
  }
  return new URL(url, publicBaseUrl).toString();
}

export function splitTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const newlineIndex = remaining.lastIndexOf('\n', limit);
    const splitIndex = newlineIndex > 0 ? newlineIndex : limit;
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/u, '');
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function isAllowedMessage(message: TelegramMessage, config: TelegramBotConfig): boolean {
  if (config.allowedChatIds === undefined || config.allowedChatIds.size === 0) {
    return true;
  }
  if (config.allowedChatIds.has(message.chat.id)) {
    return true;
  }
  return message.from?.id !== undefined && config.supportUserIds?.has(message.from.id) === true;
}

function isHelpCommand(text: string): boolean {
  const command = text.split(/\s+/u)[0]?.toLowerCase();
  return command === '/start' || command === '/help';
}

function attachmentFallbackLines(
  attachments: ChatResponse['attachments'],
  publicBaseUrl: string | undefined,
): string[] {
  return (attachments ?? []).flatMap((attachment) => {
    const url = resolveTelegramAttachmentUrl(attachment.url, publicBaseUrl);
    return url === undefined ? [`附件：${attachment.title} ${attachment.url}`] : [];
  });
}

function parseIntegerSet(value: string | undefined): Set<number> | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    return undefined;
  }

  const items = normalized
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter(Number.isFinite);
  return new Set(items);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function sleep(ms: number, abortSignal: AbortSignal | undefined): Promise<void> {
  if (abortSignal?.aborted === true) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    abortSignal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
