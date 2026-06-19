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

  it('creates a needs-review eval candidate from a chain-forensics boundary signal', () => {
    const answer =
      '我不能仅凭当前问题判断某笔交易是否被夹或存在 MEV，也不会编造链上取证结论。需要实时链上数据、交易哈希和专业分析工具；我可以说明 XXYY 产品文档中支持哪些相关能力。';
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer,
          channel: 'web',
          confidence: 0.7,
          intent: 'mev_or_chain_forensics',
          reason: 'boundary_chain_forensics',
          redactedQuestion: '什么是 MEV sandwich？',
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
      confidence: 0.7,
      proposedAnswer: answer,
      question: '什么是 MEV sandwich？',
      status: 'needs_review',
      targetCategory: 'policy_boundary',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer: answer,
        expectedIntent: 'mev_or_chain_forensics',
        minCitations: 0,
        question: '什么是 MEV sandwich？',
        requireExpectedAnswerText: false,
      },
    ]);
  });

  it('creates a needs-review eval candidate from an unsafe-request boundary signal', () => {
    const answer =
      '我不能帮助攻击、盗号、破解或钓鱼，也不会提供绕过安全保护的步骤。可以继续问我 XXYY 产品功能、配置步骤、权益说明，或发送单笔公开交易哈希做夹子检测。';
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer,
          channel: 'web',
          confidence: 0.3,
          intent: 'unknown',
          reason: 'boundary_unsafe_request',
          redactedQuestion: 'How to hack XXYY account?',
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
      confidence: 0.3,
      proposedAnswer: answer,
      question: 'How to hack XXYY account?',
      status: 'needs_review',
      targetCategory: 'policy_boundary',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer: answer,
        expectedIntent: 'unknown',
        minCitations: 0,
        question: 'How to hack XXYY account?',
        requireExpectedAnswerText: false,
      },
    ]);
  });

  it('creates a high-risk boundary candidate from a private-credential boundary signal', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer:
            '不要发送私钥、助记词或 seed phrase。XXYY 客服 Agent 不需要这些信息，也不能帮你保管或恢复凭证。',
          channel: 'web',
          confidence: 0.35,
          intent: 'unknown',
          reason: 'boundary_private_credentials',
          redactedQuestion: '我的助记词是 [sensitive_credential]',
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
      question: '我的助记词是 [REDACTED_PRIVATE_CREDENTIAL]',
      riskLevel: 'high',
      status: 'needs_review',
      targetCategory: 'policy_boundary',
      type: 'boundary_example',
    });
    expect(result.candidates[0]?.redactionReport.riskFlags).toEqual(
      expect.arrayContaining(['private_credentials']),
    );
  });

  it('derives quality candidate ids from redacted text instead of raw secrets', () => {
    const first = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer: '不要发送私钥、助记词或 seed phrase。api key: sk-answer-111',
          channel: 'web',
          confidence: 0.35,
          intent: 'unknown',
          reason: 'boundary_private_credentials',
          redactedQuestion: '我的密码是 hunter2 api key: sk-test-111',
          sessionIdPresent: true,
          userIdPresent: false,
        },
      ],
    }).candidates[0];
    const second = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer: '不要发送私钥、助记词或 seed phrase。api key: sk-answer-222',
          channel: 'web',
          confidence: 0.35,
          intent: 'unknown',
          reason: 'boundary_private_credentials',
          redactedQuestion: '我的密码是 different-secret api key: sk-test-222',
          sessionIdPresent: true,
          userIdPresent: false,
        },
      ],
    }).candidates[0];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      throw new Error('Expected both quality-signal candidates to be created.');
    }
    expect(first.question).toBe(second.question);
    expect(first.proposedAnswer).toBe(second.proposedAnswer);
    expect(first.id).toBe(second.id);
    expect(first.sourceRefs[0]?.messageId).toBe(second.sourceRefs[0]?.messageId);
    expect(JSON.stringify(first)).not.toContain('hunter2');
    expect(JSON.stringify(first)).not.toContain('sk-test-111');
    expect(JSON.stringify(first)).not.toContain('sk-answer-111');
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

  it('creates a needs-review eval candidate from a missing follow-up context signal', () => {
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer:
            '我还不能确定你想继续咨询哪个具体功能。请补充具体功能、权益或配置步骤，例如“XXYY Pro 怎么升级？”。',
          channel: 'web',
          confidence: 0.55,
          intent: 'how_to',
          reason: 'missing_followup_context',
          redactedQuestion: '怎么升级？',
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
      proposedAnswer:
        '我还不能确定你想继续咨询哪个具体功能。请补充具体功能、权益或配置步骤，例如“XXYY Pro 怎么升级？”。',
      question: '怎么升级？',
      status: 'needs_review',
      targetCategory: 'policy_boundary',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer:
          '我还不能确定你想继续咨询哪个具体功能。请补充具体功能、权益或配置步骤，例如“XXYY Pro 怎么升级？”。',
        expectedIntent: 'how_to',
        minCitations: 0,
        question: '怎么升级？',
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

  it('creates a needs-review eval candidate from a product tool failure signal', () => {
    const answer =
      '当前产品知识库暂时不可用，无法基于 XXYY 文档确认这个问题。为了避免误导，我不会编造产品细节；请稍后重试，或换成更具体的功能、权益或配置步骤提问。';
    const result = mineAnswerQualitySignals({
      now,
      signals: [
        {
          answer,
          channel: 'web',
          errorCode: 'ProductToolFailure',
          intent: 'product_qa',
          reason: 'tool_failure',
          redactedQuestion: 'XXYY Pro 有哪些权益？',
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
    expect(result.candidates[0]).toMatchObject({
      confidence: 0.5,
      proposedAnswer: answer,
      question: 'XXYY Pro 有哪些权益？',
      status: 'needs_review',
      targetCategory: 'eval_case',
      type: 'eval_case',
    });
    expect(result.candidates[0]?.generatedEvalCases).toEqual([
      {
        expectedAnswer: answer,
        expectedIntent: 'product_qa',
        minCitations: 0,
        question: 'XXYY Pro 有哪些权益？',
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
