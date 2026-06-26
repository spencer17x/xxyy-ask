import { describe, expect, it, vi } from 'vitest';

import type { ChatResponse } from '@xxyy/shared';

import {
  TelegramBotConfigurationError,
  createTelegramBot,
  loadTelegramBotConfig,
  resolveTelegramAttachmentUrl,
  splitTelegramMessage,
  type TelegramSendMessageInput,
} from './bot.js';

function createResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    answer: 'XXYY Pro 支持更多监控额度。',
    citations: [],
    confidence: 0.8,
    intent: 'product_qa',
    ...overrides,
  };
}

function createSendMessageMock(): ReturnType<
  typeof vi.fn<(input: TelegramSendMessageInput) => Promise<void>>
> {
  return vi.fn(() => Promise.resolve());
}

describe('loadTelegramBotConfig', () => {
  it('requires a bot token', () => {
    expect(() => loadTelegramBotConfig({})).toThrow(TelegramBotConfigurationError);
  });

  it('parses comma-separated allow lists and polling settings', () => {
    const config = loadTelegramBotConfig({
      TELEGRAM_ALLOWED_CHAT_IDS: '123, -456',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_POLL_TIMEOUT_SECONDS: '12',
      TELEGRAM_PUBLIC_BASE_URL: 'https://ask.example.com/base/',
      TELEGRAM_SUPPORT_USER_IDS: '7,8',
      TELEGRAM_UPDATES_LIMIT: '25',
    });

    expect(config.allowedChatIds).toEqual(new Set([123, -456]));
    expect(config.botToken).toBe('bot-token');
    expect(config.pollTimeoutSeconds).toBe(12);
    expect(config.publicBaseUrl).toBe('https://ask.example.com/base/');
    expect(config.supportUserIds).toEqual(new Set([7, 8]));
    expect(config.updatesLimit).toBe(25);
  });
});

describe('createTelegramBot', () => {
  it('passes text messages to chat with telegram channel and replies in the same chat', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        from: { id: 456 },
        message_id: 1,
        text: 'XXYY Pro 有哪些权益？',
      },
      update_id: 10,
    });

    expect(ask).toHaveBeenCalledWith({
      channel: 'telegram',
      message: 'XXYY Pro 有哪些权益？',
      sessionId: 'telegram:123',
      userId: 'telegram:456',
    });
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: 123,
      text: 'XXYY Pro 支持更多监控额度。',
    });
  });

  it('rejects chats outside the allow list without calling chat service', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: loadTelegramBotConfig({
        TELEGRAM_ALLOWED_CHAT_IDS: '999',
        TELEGRAM_BOT_TOKEN: 'bot-token',
      }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        from: { id: 456 },
        message_id: 1,
        text: '查一下交易',
      },
      update_id: 10,
    });

    expect(ask).not.toHaveBeenCalled();
    const payload = sendMessage.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    if (payload === undefined) {
      return;
    }
    expect(payload.chatId).toBe(123);
    expect(payload.text).toContain('未授权');
  });

  it('sends image attachments as Telegram photos when a public URL is available', async () => {
    const ask = vi.fn(() =>
      Promise.resolve(
        createResponse({
          answer: '这笔交易未发现明确被夹。',
          attachments: [
            {
              kind: 'image',
              mediaType: 'image/png',
              title: '交易分析截图',
              url: '/assets/tx-analysis/example.png',
            },
          ],
          intent: 'tx_sandwich_detection',
        }),
      ),
    );
    const sendPhoto = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage: vi.fn(() => Promise.resolve()),
        sendPhoto,
      },
      chatService: { ask },
      config: loadTelegramBotConfig({
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_PUBLIC_BASE_URL: 'https://ask.example.com',
      }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        from: { id: 456 },
        message_id: 1,
        text: '检查这笔交易是否被夹',
      },
      update_id: 10,
    });

    expect(sendPhoto).toHaveBeenCalledWith({
      caption: '交易分析截图',
      chatId: 123,
      photo: 'https://ask.example.com/assets/tx-analysis/example.png',
    });
  });

  it('advances the polling offset after handling updates', async () => {
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([
        {
          message: {
            chat: { id: 123 },
            from: { id: 456 },
            message_id: 1,
            text: '/help',
          },
          update_id: 41,
        },
      ])
      .mockResolvedValueOnce([]);
    const bot = createTelegramBot({
      api: {
        getUpdates,
        sendMessage: vi.fn(() => Promise.resolve()),
        sendPhoto: vi.fn(),
      },
      chatService: { ask: vi.fn(() => Promise.resolve(createResponse())) },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.pollOnce();
    await bot.pollOnce();

    expect(getUpdates).toHaveBeenNthCalledWith(1, {
      limit: 100,
      offset: undefined,
      timeout: 30,
    });
    expect(getUpdates).toHaveBeenNthCalledWith(2, {
      limit: 100,
      offset: 42,
      timeout: 30,
    });
  });
});

describe('message formatting helpers', () => {
  it('resolves relative attachment URLs against the configured public base URL', () => {
    expect(resolveTelegramAttachmentUrl('/assets/a.png', 'https://ask.example.com/base/')).toBe(
      'https://ask.example.com/assets/a.png',
    );
    expect(resolveTelegramAttachmentUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    );
    expect(resolveTelegramAttachmentUrl('/assets/a.png')).toBeUndefined();
  });

  it('splits long Telegram messages without exceeding the requested size', () => {
    expect(splitTelegramMessage('abc\ndefgh', 5)).toEqual(['abc', 'defgh']);
    expect(splitTelegramMessage('abcdef', 3)).toEqual(['abc', 'def']);
  });
});
