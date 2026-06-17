import { describe, expect, it } from 'vitest';

import { fetchTelegramSupportMessages } from './telegram-support-connector.js';

describe('fetchTelegramSupportMessages', () => {
  it('fetches only authorized Telegram chats and maps updates into raw support messages', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      requestedUrls.push(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                message: {
                  chat: { id: 1001 },
                  date: 1781665200,
                  from: { id: 42, is_bot: false },
                  message_id: 10,
                  text: 'Telegram 通知怎么设置？',
                },
                update_id: 20,
              },
              {
                message: {
                  chat: { id: 9999 },
                  date: 1781665201,
                  from: { id: 42, is_bot: false },
                  message_id: 11,
                  text: '这个未授权群不应该入库',
                },
                update_id: 21,
              },
              {
                message: {
                  chat: { id: 1001 },
                  date: 1781665202,
                  from: { id: 7, is_bot: false },
                  message_id: 12,
                  reply_to_message: { message_id: 10 },
                  text: '在钱包监控里创建通知 Bot，填写群 ID 后保存即可。',
                },
                update_id: 22,
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
      );
    };

    const result = await fetchTelegramSupportMessages({
      allowedChatIds: ['1001'],
      botToken: 'test-token',
      fetch: fetchImpl,
      now: () => '2026-06-17T03:00:00.000Z',
      offset: 19,
      supportUserIds: ['7'],
    });

    expect(requestedUrls[0]).toContain('https://api.telegram.org/bottest-token/getUpdates');
    expect(requestedUrls[0]).toContain('offset=19');
    expect(result.nextOffset).toBe(23);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.chatIdHash).not.toContain('1001');
    expect(result.messages[0]).toMatchObject({
      ingestedAt: '2026-06-17T03:00:00.000Z',
      messageId: '10',
      senderRole: 'user',
      sentAt: '2026-06-17T03:00:00.000Z',
      source: 'telegram',
      text: 'Telegram 通知怎么设置？',
    });
    expect(result.messages[1]).toMatchObject({
      chatIdHash: result.messages[0]?.chatIdHash,
      messageId: '12',
      replyToMessageId: '10',
      senderRole: 'support',
      text: '在钱包监控里创建通知 Bot，填写群 ID 后保存即可。',
    });
    expect(result.messages[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects unconfigured authorization and Telegram API failures', async () => {
    await expect(
      fetchTelegramSupportMessages({
        allowedChatIds: [],
        botToken: 'test-token',
      }),
    ).rejects.toThrow('At least one authorized Telegram chat id is required.');

    await expect(
      fetchTelegramSupportMessages({
        allowedChatIds: ['1001'],
        botToken: 'test-token',
        fetch: () =>
          Promise.resolve(
            new Response(JSON.stringify({ description: 'Unauthorized', ok: false }), {
              status: 401,
            }),
          ),
      }),
    ).rejects.toThrow('Telegram getUpdates failed with status 401: Unauthorized');
  });
});
