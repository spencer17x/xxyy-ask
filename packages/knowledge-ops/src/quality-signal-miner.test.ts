import { describe, expect, it } from 'vitest';

import { mineAnswerQualitySignals } from './quality-signal-miner.js';

const now = '2026-06-19T08:00:00.000Z';

describe('mineAnswerQualitySignals', () => {
  it('creates a needs-review FAQ candidate from a low-confidence product answer', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer: 'XXYY Pro 可以在会员页面升级，升级后会提升监控上限。',
          channel: 'web',
          citationCount: 0,
          confidence: 0.32,
          intent: 'product_qa',
          reason: 'low_confidence',
          redactedQuestion: 'XXYY Pro 怎么升级？我的邮箱是 me@example.com',
          sessionIdPresent: true,
          userIdPresent: true,
        },
      ],
    });

    expect(result).toMatchObject({
      candidatesCreated: 1,
      signalsRead: 1,
      signalsSkipped: 0,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.32,
      createdAt: now,
      proposedAnswer: 'XXYY Pro 可以在会员页面升级，升级后会提升监控上限。',
      question: 'XXYY Pro 怎么升级？我的邮箱是 [REDACTED_EMAIL]',
      riskLevel: 'medium',
      status: 'needs_review',
      targetCategory: 'product_faq',
      type: 'faq',
      updatedAt: now,
    });
    const candidate = result.candidates[0];
    expect(candidate).toBeDefined();
    if (candidate === undefined) {
      throw new Error('Expected a quality-signal candidate to be created.');
    }
    const sourceRef = candidate.sourceRefs[0];
    expect(sourceRef).toBeDefined();
    if (sourceRef === undefined) {
      throw new Error('Expected a quality-signal source ref.');
    }
    expect(sourceRef.messageId).toMatch(/^aqs_[a-f0-9]{16}$/u);
    expect(candidate.sourceRefs).toEqual([
      {
        chatIdHash: 'session_present',
        messageId: sourceRef.messageId,
        source: 'answer_quality_signal',
      },
    ]);
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer: 'XXYY Pro 可以在会员页面升级，升级后会提升监控上限。',
        question: 'XXYY Pro 怎么升级？我的邮箱是 [REDACTED_EMAIL]',
      },
    ]);
  });

  it('creates one eval candidate from a conservative product fallback signal', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer:
            '当前知识库没有足够资料确认这个问题。为了避免误导，我不会编造产品细节；请补充更具体的功能、权益或配置步骤，或稍后在知识库更新后再问。',
          channel: 'web',
          citationCount: 0,
          confidence: 0.2,
          intent: 'product_qa',
          reason: 'low_confidence_missing_citations',
          redactedQuestion: 'XXYY Pro 价格是多少？',
          sessionIdPresent: true,
          userIdPresent: false,
        },
      ],
    });

    expect(result).toMatchObject({
      candidatesCreated: 1,
      signalsRead: 1,
      signalsSkipped: 0,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.2,
      proposedAnswer:
        '当前知识库没有足够资料确认这个问题。为了避免误导，我不会编造产品细节；请补充更具体的功能、权益或配置步骤，或稍后在知识库更新后再问。',
      question: 'XXYY Pro 价格是多少？',
      status: 'needs_review',
      targetCategory: 'eval_case',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer:
          '当前知识库没有足够资料确认这个问题。为了避免误导，我不会编造产品细节；请补充更具体的功能、权益或配置步骤，或稍后在知识库更新后再问。',
        expectedIntent: 'product_qa',
        minCitations: 0,
        question: 'XXYY Pro 价格是多少？',
        requireExpectedAnswerText: false,
      },
    ]);
  });

  it('creates a high-risk boundary candidate from a private-data boundary signal', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          channel: 'telegram',
          confidence: 0.8,
          intent: 'realtime_account_query',
          reason: 'boundary_private_data',
          redactedQuestion: '帮我查一下钱包余额 0x1111111111111111111111111111111111111111',
          sessionIdPresent: false,
          userIdPresent: false,
        },
      ],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.8,
      proposedAnswer:
        'XXYY 客服 Agent 不能查询账户、订单、钱包余额或私有交易记录。请在已登录的 XXYY 产品页面或你的钱包/交易所内自行核对。',
      question: '帮我查一下钱包余额 [REDACTED_EVM_ADDRESS]',
      riskLevel: 'high',
      status: 'needs_review',
      targetCategory: 'policy_boundary',
      type: 'boundary_example',
    });
    expect(result.candidates[0]?.redactionReport.riskFlags).toEqual(
      expect.arrayContaining(['private_account_query']),
    );
  });

  it('creates a needs-review eval candidate from an unknown-intent clarification signal', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer:
            '我还不确定你想咨询 XXYY 的哪个功能。请补充具体功能、配置步骤、Pro 权益，或发送单笔交易哈希。',
          channel: 'web',
          confidence: 0.45,
          intent: 'unknown',
          reason: 'unknown_intent',
          redactedQuestion: '帮我看看这个，我的邮箱是 me@example.com',
          sessionIdPresent: true,
          userIdPresent: false,
        },
      ],
    });

    expect(result).toMatchObject({
      candidatesCreated: 1,
      signalsRead: 1,
      signalsSkipped: 0,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.45,
      createdAt: now,
      proposedAnswer:
        '我还不确定你想咨询 XXYY 的哪个功能。请补充具体功能、配置步骤、Pro 权益，或发送单笔交易哈希。',
      question: '帮我看看这个，我的邮箱是 [REDACTED_EMAIL]',
      riskLevel: 'medium',
      status: 'needs_review',
      targetCategory: 'policy_boundary',
      type: 'eval_case',
      updatedAt: now,
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer:
          '我还不确定你想咨询 XXYY 的哪个功能。请补充具体功能、配置步骤、Pro 权益，或发送单笔交易哈希。',
        expectedIntent: 'unknown',
        minCitations: 0,
        question: '帮我看看这个，我的邮箱是 [REDACTED_EMAIL]',
        requireExpectedAnswerText: false,
      },
    ]);
  });

  it('creates a needs-review eval candidate from a missing-session clarification signal', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer:
            '我缺少这次会话的上一轮上下文，不能确定“这笔”指哪一笔交易。请发送单笔完整交易哈希或对应主网浏览器链接，我会自动继续分析。',
          channel: 'web',
          confidence: 0.45,
          intent: 'tx_sandwich_detection',
          reason: 'session_unavailable',
          redactedQuestion: '这笔呢？',
          sessionIdPresent: true,
          userIdPresent: false,
        },
      ],
    });

    expect(result).toMatchObject({
      candidatesCreated: 1,
      signalsRead: 1,
      signalsSkipped: 0,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.45,
      proposedAnswer:
        '我缺少这次会话的上一轮上下文，不能确定“这笔”指哪一笔交易。请发送单笔完整交易哈希或对应主网浏览器链接，我会自动继续分析。',
      question: '这笔呢？',
      status: 'needs_review',
      targetCategory: 'policy_boundary',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer:
          '我缺少这次会话的上一轮上下文，不能确定“这笔”指哪一笔交易。请发送单笔完整交易哈希或对应主网浏览器链接，我会自动继续分析。',
        expectedIntent: 'tx_sandwich_detection',
        minCitations: 0,
        question: '这笔呢？',
        requireExpectedAnswerText: false,
      },
    ]);
  });

  it('creates a needs-review eval candidate from an ambiguous follow-up clarification signal', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer: '你想分析哪一笔交易？请发送单笔完整交易哈希或对应主网浏览器链接。',
          channel: 'web',
          confidence: 0.55,
          intent: 'tx_sandwich_detection',
          reason: 'ambiguous_followup',
          redactedQuestion: '这笔呢？',
          sessionIdPresent: true,
          userIdPresent: false,
        },
      ],
    });

    expect(result).toMatchObject({
      candidatesCreated: 1,
      signalsRead: 1,
      signalsSkipped: 0,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.55,
      proposedAnswer: '你想分析哪一笔交易？请发送单笔完整交易哈希或对应主网浏览器链接。',
      question: '这笔呢？',
      status: 'needs_review',
      targetCategory: 'policy_boundary',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer: '你想分析哪一笔交易？请发送单笔完整交易哈希或对应主网浏览器链接。',
        expectedIntent: 'tx_sandwich_detection',
        minCitations: 0,
        question: '这笔呢？',
        requireExpectedAnswerText: false,
      },
    ]);
  });

  it('creates a needs-review eval candidate from a transaction analysis failure signal', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer:
            '交易哈希夹子检测功能暂未启用。当前不会编造链上分析结论；接入正式链上数据源后才能判断是否被夹并生成截图。',
          channel: 'web',
          confidence: 0.35,
          intent: 'tx_sandwich_detection',
          reason: 'tx_analysis_failure',
          redactedQuestion: '[evm_tx_hash]',
          sessionIdPresent: true,
          userIdPresent: false,
        },
      ],
    });

    expect(result).toMatchObject({
      candidatesCreated: 1,
      signalsRead: 1,
      signalsSkipped: 0,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.35,
      proposedAnswer:
        '交易哈希夹子检测功能暂未启用。当前不会编造链上分析结论；接入正式链上数据源后才能判断是否被夹并生成截图。',
      question: '[evm_tx_hash]',
      status: 'needs_review',
      targetCategory: 'eval_case',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer:
          '交易哈希夹子检测功能暂未启用。当前不会编造链上分析结论；接入正式链上数据源后才能判断是否被夹并生成截图。',
        expectedIntent: 'tx_sandwich_detection',
        minCitations: 0,
        question: '[evm_tx_hash]',
        requireExpectedAnswerText: false,
      },
    ]);
  });

  it('creates a needs-review eval candidate from a transaction tool failure signal', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer:
            '交易分析数据源暂时不可用，无法确认这笔交易是否被夹。当前不会编造链上分析结论，请稍后重试。',
          channel: 'web',
          errorCode: 'TxToolFailure',
          intent: 'tx_sandwich_detection',
          reason: 'tool_failure',
          redactedQuestion: '[evm_tx_hash]',
          sessionIdPresent: false,
          userIdPresent: false,
        },
      ],
    });

    expect(result).toMatchObject({
      candidatesCreated: 1,
      signalsRead: 1,
      signalsSkipped: 0,
    });
    expect(result.candidates[0]).toMatchObject({
      proposedAnswer:
        '交易分析数据源暂时不可用，无法确认这笔交易是否被夹。当前不会编造链上分析结论，请稍后重试。',
      question: '[evm_tx_hash]',
      targetCategory: 'eval_case',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer:
          '交易分析数据源暂时不可用，无法确认这笔交易是否被夹。当前不会编造链上分析结论，请稍后重试。',
        expectedIntent: 'tx_sandwich_detection',
        minCitations: 0,
        question: '[evm_tx_hash]',
        requireExpectedAnswerText: false,
      },
    ]);
  });

  it('skips quality signals that do not yet contain publishable knowledge', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          channel: 'web',
          errorCode: 'TxAnalysisProviderUnavailableError',
          intent: 'tx_sandwich_detection',
          reason: 'tx_analysis_failure',
          redactedQuestion: '0x2222222222222222222222222222222222222222222222222222222222222222',
          sessionIdPresent: true,
          userIdPresent: false,
        },
        {
          answer:
            '当前产品知识库暂时不可用，无法基于 XXYY 文档确认这个问题。为了避免误导，我不会编造产品细节；请稍后重试。',
          channel: 'web',
          errorCode: 'ProductToolFailure',
          intent: 'product_qa',
          reason: 'tool_failure',
          redactedQuestion: 'XXYY Pro 有哪些权益？',
          sessionIdPresent: true,
          userIdPresent: false,
        },
        {
          channel: 'web',
          confidence: 0.2,
          intent: 'unknown',
          reason: 'unknown_intent',
          redactedQuestion: '   ',
          sessionIdPresent: false,
          userIdPresent: false,
        },
      ],
    });

    expect(result).toEqual({
      candidates: [],
      candidatesCreated: 0,
      signalsRead: 3,
      signalsSkipped: 3,
    });
  });
});
