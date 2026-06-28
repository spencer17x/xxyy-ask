import type { ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
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
    type?: 'channel' | 'group' | 'private' | 'supergroup';
  };
  from?: {
    id: number;
  };
  message_id: number;
  text?: string;
}

export interface TelegramApi {
  getUpdates(input: TelegramGetUpdatesInput): Promise<TelegramUpdate[]>;
  sendChatAction?(input: TelegramSendChatActionInput): Promise<void>;
  sendMessage(input: TelegramSendMessageInput): Promise<void>;
  sendMessageDraft?(input: TelegramSendMessageDraftInput): Promise<void>;
  sendPhoto(input: TelegramSendPhotoInput): Promise<void>;
}

export interface TelegramGetUpdatesInput {
  limit: number;
  offset?: number;
  timeout: number;
}

export interface TelegramSendMessageInput {
  chatId: number;
  parseMode?: 'HTML';
  replyToMessageId?: number;
  text: string;
}

export interface TelegramSendChatActionInput {
  action: 'typing';
  chatId: number;
}

export interface TelegramSendMessageDraftInput {
  chatId: number;
  draftId: number;
  text: string;
}

export interface TelegramSendPhotoInput {
  caption?: string;
  chatId: number;
  photo: string;
  replyToMessageId?: number;
}

export interface TelegramBot {
  handleUpdate(update: TelegramUpdate): Promise<void>;
  pollOnce(): Promise<void>;
}

export interface CreateTelegramBotOptions {
  api: TelegramApi;
  chatService: TelegramChatService;
  config: TelegramBotConfig;
  logger?: TelegramBotLogger;
}

type TelegramChatService = Pick<ChatService, 'ask'> & Partial<Pick<ChatService, 'stream'>>;

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
const TELEGRAM_DRAFT_UPDATE_MIN_CHARS = 80;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_TYPING_REFRESH_MS = 4000;
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
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: UNAUTHORIZED_TEXT,
      });
      return;
    }

    const text = message.text?.trim();
    if (text === undefined || text.length === 0) {
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: UNSUPPORTED_MESSAGE_TEXT,
      });
      return;
    }

    if (isHelpCommand(text)) {
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: HELP_TEXT,
      });
      return;
    }

    const request = createTelegramChatRequest(message, text);
    await withTelegramTyping(options.api, chatId, async () => {
      if (canStreamToDraft(message, options)) {
        const streamed = await trySendStreamingChatResponse({
          api: options.api,
          chatId,
          config: options.config,
          draftId: createTelegramDraftId(update.update_id),
          replyToMessageId: message.message_id,
          request,
          stream: options.chatService.stream,
        });
        if (streamed) {
          return;
        }
      }

      const response = await options.chatService.ask(request);

      await sendChatResponse(options.api, chatId, response, options.config, message.message_id);
    });
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

function createTelegramChatRequest(message: TelegramMessage, text: string): ChatRequest {
  return {
    channel: 'telegram',
    message: text,
    sessionId: `telegram:${message.chat.id}`,
    ...(message.from?.id === undefined ? {} : { userId: `telegram:${message.from.id}` }),
  };
}

function canStreamToDraft(message: TelegramMessage, options: CreateTelegramBotOptions): boolean {
  return (
    options.chatService.stream !== undefined &&
    options.api.sendMessageDraft !== undefined &&
    (message.chat.type === undefined || message.chat.type === 'private')
  );
}

async function trySendStreamingChatResponse(options: {
  api: Pick<TelegramApi, 'sendMessage' | 'sendMessageDraft' | 'sendPhoto'>;
  chatId: number;
  config: Pick<TelegramBotConfig, 'publicBaseUrl'>;
  draftId: number;
  replyToMessageId?: number;
  request: ChatRequest;
  stream: ChatService['stream'] | undefined;
}): Promise<boolean> {
  if (options.stream === undefined || options.api.sendMessageDraft === undefined) {
    return false;
  }

  let answer = '';
  let draftFailed = false;
  let lastDraftLength = 0;
  let metadata: Extract<ChatStreamEvent, { type: 'metadata' }> | undefined;

  try {
    for await (const event of options.stream(options.request)) {
      if (event.type === 'answer_delta') {
        answer += event.delta;
        if (!draftFailed && shouldSendTelegramDraft(answer, lastDraftLength)) {
          try {
            await options.api.sendMessageDraft({
              chatId: options.chatId,
              draftId: options.draftId,
              text: answer,
            });
            lastDraftLength = answer.length;
          } catch {
            draftFailed = true;
          }
        }
        continue;
      }

      metadata = event;
    }
  } catch {
    return false;
  }

  if (metadata === undefined) {
    return false;
  }

  await sendChatResponse(
    options.api,
    options.chatId,
    {
      answer,
      citations: metadata.citations,
      confidence: metadata.confidence,
      intent: metadata.intent,
      ...(metadata.agentRoute === undefined ? {} : { agentRoute: metadata.agentRoute }),
      ...(metadata.attachments === undefined ? {} : { attachments: metadata.attachments }),
      ...(metadata.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
    },
    options.config,
    options.replyToMessageId,
  );
  return true;
}

async function withTelegramTyping<T>(
  api: Pick<TelegramApi, 'sendChatAction'>,
  chatId: number,
  task: () => Promise<T>,
): Promise<T> {
  if (api.sendChatAction === undefined) {
    return task();
  }

  await sendTypingAction(api, chatId);
  const timer = setInterval(() => {
    void sendTypingAction(api, chatId);
  }, TELEGRAM_TYPING_REFRESH_MS);
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

async function sendTypingAction(
  api: Pick<TelegramApi, 'sendChatAction'>,
  chatId: number,
): Promise<void> {
  try {
    await api.sendChatAction?.({ action: 'typing', chatId });
  } catch {
    // Typing indicators are best-effort; never fail the support response because of them.
  }
}

function shouldSendTelegramDraft(answer: string, lastDraftLength: number): boolean {
  return (
    answer.length > 0 &&
    (lastDraftLength === 0 || answer.length - lastDraftLength >= TELEGRAM_DRAFT_UPDATE_MIN_CHARS)
  );
}

function createTelegramDraftId(updateId: number): number {
  return Math.max(1, updateId);
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
  replyToMessageId?: number,
): Promise<void> {
  const attachmentLines = attachmentFallbackLines(response.attachments, config.publicBaseUrl);
  const message = formatTelegramChatResponse(response, attachmentLines);
  for (const chunk of splitTelegramMessage(message, TELEGRAM_MESSAGE_LIMIT)) {
    await api.sendMessage({
      chatId,
      parseMode: 'HTML',
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      text: chunk,
    });
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
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    });
  }
}

function formatTelegramChatResponse(response: ChatResponse, attachmentLines: string[]): string {
  const lines = [
    markdownToTelegramHtml(response.answer),
    ...attachmentLines.map(escapeHtml),
    ...telegramCitationLines(response.citations),
  ];
  return lines.join('\n').trim();
}

function telegramCitationLines(citations: ChatResponse['citations']): string[] {
  if (citations.length === 0) {
    return [];
  }

  return [
    '',
    '<b>来源</b>',
    ...citations.flatMap((citation, index) => [
      `${index + 1}. ${telegramCitationTitle(citation)}`,
      `<code>${escapeHtml(citation.file)}</code>`,
      escapeHtml(citation.excerpt),
    ]),
  ];
}

function telegramCitationTitle(citation: ChatResponse['citations'][number]): string {
  const title = escapeHtml(citation.title);
  if (citation.sourceUrl === undefined) {
    return `<b>${title}</b>`;
  }
  return `<a href="${escapeHtmlAttribute(citation.sourceUrl)}">${title}</a>`;
}

function markdownToTelegramHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*\n][^*]*?)\*\*/gu, '<b>$1</b>')
    .replace(/`([^`\n]+?)`/gu, '<code>$1</code>');
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/gu, '&quot;');
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
