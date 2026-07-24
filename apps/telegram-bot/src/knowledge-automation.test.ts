import { describe, expect, it } from 'vitest';

import { createLiveTelegramKnowledgeExport } from './knowledge-automation.js';

describe('live Telegram knowledge capture', () => {
  it('converts a direct group reply into the bounded import shape', () => {
    expect(
      createLiveTelegramKnowledgeExport({
        chat: { id: -100123, type: 'supergroup' },
        date: 1_774_490_520,
        from: { id: 123 },
        message_id: 11,
        reply_to_message: {
          chat: { id: -100123, type: 'supergroup' },
          date: 1_774_490_400,
          from: { id: 456 },
          message_id: 10,
          text: 'XXYY 如何设置价格提醒？',
        },
        text: '在提醒设置中开启价格提醒，保存后生效。',
      }),
    ).toEqual({
      id: -100123,
      messages: [
        {
          date: '2026-03-26T02:00:00.000Z',
          from_id: 'user456',
          id: 10,
          text: 'XXYY 如何设置价格提醒？',
        },
        {
          date: '2026-03-26T02:02:00.000Z',
          from_id: 'user123',
          id: 11,
          reply_to_message_id: 10,
          text: '在提醒设置中开启价格提醒，保存后生效。',
        },
      ],
    });
  });

  it('rejects anonymous, bot-authored, and non-reply messages', () => {
    const base = {
      chat: { id: -100123, type: 'supergroup' as const },
      from: { id: 123 },
      message_id: 11,
      text: '回答',
    };

    expect(createLiveTelegramKnowledgeExport(base)).toBeUndefined();
    expect(
      createLiveTelegramKnowledgeExport({
        ...base,
        from: { id: 123, is_bot: true },
        reply_to_message: { chat: base.chat, message_id: 10, text: '问题' },
      }),
    ).toBeUndefined();
    expect(
      createLiveTelegramKnowledgeExport({
        ...base,
        reply_to_message: { chat: base.chat, message_id: 10, text: '问题' },
        sender_chat: { id: -100123 },
      }),
    ).toBeUndefined();
  });
});
