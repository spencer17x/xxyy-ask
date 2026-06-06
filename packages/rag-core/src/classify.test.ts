import { describe, expect, it } from 'vitest';

import { classifyQuestion } from './classify.js';

describe('classifyQuestion', () => {
  it.each([
    ['XXYY Pro 有哪些权益和功能更新？', 'product_qa'],
    ['XXYY 有 APP 吗？', 'product_qa'],
    ['钱包备注上限提升到 1 万条在哪条推特里？', 'product_qa'],
    ['钱包监控上限历史更新记录在哪里？', 'product_qa'],
    ['如何设置 Telegram 钱包监控？', 'how_to'],
    ['怎么操作订单查询？', 'how_to'],
    ['如何在 XXYY 买入代币？', 'how_to'],
    ['XXYY 的 Swap 交易怎么操作买入和卖出？', 'how_to'],
    ['如何设置挂单买入？', 'how_to'],
    ['帮我查一下钱包余额和账户交易记录', 'realtime_account_query'],
    ['这个 tx hash 是不是被夹了，有 MEV sandwich 吗？', 'mev_or_chain_forensics'],
    ['现在可以买 SOL 吗，推荐一个能保证盈利的 token', 'investment_advice'],
    ['嗯？', 'unknown'],
  ] as const)('classifies "%s" as %s', (question, expectedIntent) => {
    const classification = classifyQuestion(question);

    expect(classification.intent).toBe(expectedIntent);
    expect(classification.confidence).toBeGreaterThan(0);
    expect(classification.reason.length).toBeGreaterThan(0);
  });

  it('prefers realtime account lookup over generic product wording for user-specific data', () => {
    expect(classifyQuestion('帮我查 XXYY 钱包余额').intent).toBe('realtime_account_query');
  });

  it('prefers MEV forensics over generic transaction lookup when sandwich wording is present', () => {
    expect(classifyQuestion('我的交易是不是被夹子夹了？').intent).toBe('mev_or_chain_forensics');
  });

  it.each([
    'Can XXYY guarantee profit for SOL?',
    'What investment recommendation does XXYY make for BTC?',
    'Can XXYY help me make profit from SOL?',
    'Which token should I buy to make profit in XXYY?',
    '如何在 XXYY 买入能保证盈利的 token？',
    '如何买入 SOL，可以保证盈利吗？',
  ])('classifies English profit/recommendation requests as investment advice: %s', (question) => {
    expect(classifyQuestion(question).intent).toBe('investment_advice');
  });

  it('does not classify account hacking requests as how-to product support', () => {
    expect(classifyQuestion('How to hack XXYY account?').intent).toBe('unknown');
  });
});
