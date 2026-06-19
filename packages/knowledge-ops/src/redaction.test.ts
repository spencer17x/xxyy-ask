import { describe, expect, it } from 'vitest';

import { redactSupportMessage, redactSupportText } from './redaction.js';
import type { RawSupportMessage } from './types.js';

const baseMessage: Omit<RawSupportMessage, 'senderRole' | 'text'> = {
  source: 'telegram',
  chatIdHash: 'chat_hash_1',
  contentHash: 'content_hash_1',
  ingestedAt: '2026-06-17T01:00:00.000Z',
  messageId: '101',
  sentAt: '2026-06-17T00:59:00.000Z',
};

describe('redactSupportText', () => {
  it('redacts user identifiers while keeping a structured redaction report', () => {
    const result = redactSupportText(
      '我的邮箱 alice@example.com，手机 +86 138 0013 8000，钱包 0x1111111111111111111111111111111111111111，链接 https://example.com/order/42',
    );

    expect(result.text).not.toContain('alice@example.com');
    expect(result.text).not.toContain('138 0013 8000');
    expect(result.text).not.toContain('0x1111111111111111111111111111111111111111');
    expect(result.text).not.toContain('https://example.com/order/42');
    expect(result.text).toContain('[REDACTED_EMAIL]');
    expect(result.text).toContain('[REDACTED_PHONE]');
    expect(result.text).toContain('[REDACTED_EVM_ADDRESS]');
    expect(result.text).toContain('[REDACTED_URL]');
    expect(result.report.entities).toEqual([
      { type: 'email', count: 1 },
      { type: 'phone', count: 1 },
      { type: 'evm_address', count: 1 },
      { type: 'url', count: 1 },
    ]);
    expect(result.report.riskLevel).toBe('medium');
  });

  it('flags boundary and investment-advice requests without flagging normal product setup questions', () => {
    const risky = redactSupportText('帮我查一下钱包余额和订单状态，这个币能买吗？');
    const product = redactSupportText('钱包监控怎么设置 Telegram 通知？');

    expect(risky.report.riskFlags).toEqual(
      expect.arrayContaining(['private_account_query', 'investment_advice']),
    );
    expect(risky.report.riskLevel).toBe('high');
    expect(product.report.riskFlags).toEqual([]);
    expect(product.report.riskLevel).toBe('low');
  });

  it('redacts private credentials and marks them high risk', () => {
    const result = redactSupportText(
      '我的助记词是 abandon ability able about above absent absorb abstract absurd abuse access accident',
    );

    expect(result.text).toBe('我的助记词是 [REDACTED_PRIVATE_CREDENTIAL]');
    expect(result.report.entities).toEqual([{ type: 'private_credential', count: 1 }]);
    expect(result.report.riskFlags).toEqual(['private_credentials']);
    expect(result.report.riskLevel).toBe('high');
  });

  it('redacts passwords and API keys as private credentials', () => {
    const result = redactSupportText('我的密码是 hunter2，api key: sk-test-123456');

    expect(result.text).toBe(
      '我的密码是 [REDACTED_PRIVATE_CREDENTIAL]，api key: [REDACTED_PRIVATE_CREDENTIAL]',
    );
    expect(result.report.entities).toEqual([{ type: 'private_credential', count: 2 }]);
    expect(result.report.riskFlags).toEqual(['private_credentials']);
    expect(result.report.riskLevel).toBe('high');
  });

  it('treats existing sensitive credential placeholders as private credentials', () => {
    const result = redactSupportText('我的助记词是 [sensitive_credential]');

    expect(result.text).toBe('我的助记词是 [REDACTED_PRIVATE_CREDENTIAL]');
    expect(result.report.entities).toEqual([{ type: 'private_credential', count: 1 }]);
    expect(result.report.riskFlags).toEqual(['private_credentials']);
    expect(result.report.riskLevel).toBe('high');
  });
});

describe('redactSupportMessage', () => {
  it('preserves source metadata and redacts only message text', () => {
    const redacted = redactSupportMessage({
      ...baseMessage,
      senderRole: 'user',
      text: '我的邮箱是 bob@example.com，如何配置 Telegram 通知？',
    });

    expect(redacted).toMatchObject({
      ...baseMessage,
      senderRole: 'user',
      text: '我的邮箱是 [REDACTED_EMAIL]，如何配置 Telegram 通知？',
    });
    expect(redacted.redactionReport.entities).toEqual([{ type: 'email', count: 1 }]);
  });
});
