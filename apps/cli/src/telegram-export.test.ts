import { describe, expect, it } from 'vitest';

import { extractTelegramKnowledgeCandidates } from './telegram-export.js';

describe('extractTelegramKnowledgeCandidates', () => {
  it('extracts administrator replies to product questions from Telegram JSON', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        id: -100123,
        messages: [
          {
            date: '2026-07-15T01:00:00',
            from_id: 'user456',
            id: 10,
            text: 'XXYY 支持 Robinhood 吗？',
            type: 'message',
          },
          {
            date: '2026-07-15T01:02:00',
            date_unixtime: '1784077320',
            from_id: 'user123',
            id: 11,
            reply_to_message_id: 10,
            text: [
              '是的，已经支持。来源：',
              { text: 'https://docs.example.com/robinhood', type: 'link' },
            ],
            type: 'message',
          },
        ],
      },
      { adminUserIds: new Set(['123']) },
    );

    expect(result).toMatchObject({
      adminReplyCount: 1,
      messageCount: 2,
      skippedBoundaryCount: 0,
      skippedMissingReplyCount: 0,
    });
    expect(result.candidates).toEqual([
      {
        canonicalAnswer: '是的，已经支持。来源：https://docs.example.com/robinhood',
        effectiveAt: '2026-07-15T01:02:00.000Z',
        evidence: 'Telegram export reply 11 to message 10.',
        question: 'XXYY 支持 Robinhood 吗？',
        sourceAnswerMessageId: '11',
        sourceChannel: 'telegram_export',
        sourceChatId: '-100123',
        sourceQuestionMessageId: '10',
        sourceUrl: 'https://docs.example.com/robinhood',
        submittedBy: '123',
      },
    ]);
  });

  it('skips account queries and administrator messages without direct user replies', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        messages: [
          { from_id: 'user456', id: 1, text: '帮我查钱包余额', type: 'message' },
          {
            from_id: 'user123',
            id: 2,
            reply_to_message_id: 1,
            text: '余额是 10 SOL',
            type: 'message',
          },
          { from_id: 'user123', id: 3, text: '没有回复关系', type: 'message' },
        ],
      },
      { adminUserIds: new Set(['user123']) },
    );

    expect(result.candidates).toEqual([]);
    expect(result.skippedBoundaryCount).toBe(1);
    expect(result.skippedMissingReplyCount).toBe(1);
  });

  it('rejects malformed exports instead of guessing their structure', () => {
    expect(() =>
      extractTelegramKnowledgeCandidates(
        { messages: [{ text: 'missing id' }] },
        {
          adminUserIds: new Set(['123']),
        },
      ),
    ).toThrow('Invalid Telegram export message at index 0.');
  });
});
