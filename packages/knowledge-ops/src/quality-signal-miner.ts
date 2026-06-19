import { createHash } from 'node:crypto';

import { redactSupportText } from './redaction.js';
import type {
  GeneratedEvalCase,
  GeneratedEvalIntent,
  KnowledgeCandidate,
  KnowledgeCandidateSourceRef,
  KnowledgeCandidateType,
  KnowledgeRiskFlag,
  KnowledgeRiskLevel,
  RedactedEntitySummary,
  RedactionReport,
} from './types.js';

export type AnswerQualitySignalReason =
  | 'boundary_chain_forensics'
  | 'ambiguous_transaction_reference'
  | 'ambiguous_followup'
  | 'boundary_business_action'
  | 'boundary_investment_advice'
  | 'boundary_private_data'
  | 'boundary_private_credentials'
  | 'boundary_unsafe_request'
  | 'handoff_wording'
  | 'low_confidence'
  | 'low_confidence_missing_citations'
  | 'missing_citations'
  | 'missing_followup_context'
  | 'session_unavailable'
  | 'tool_failure'
  | 'tx_analysis_failure'
  | 'unknown_intent';

export interface AnswerQualitySignal {
  agentRoute?: string;
  answer?: string;
  channel: string;
  citationCount?: number;
  confidence?: number;
  errorCode?: string;
  intent: string;
  reason: AnswerQualitySignalReason;
  redactedQuestion: string;
  sessionIdPresent: boolean;
  userIdPresent: boolean;
}

export interface MineAnswerQualitySignalsInput {
  now?: string;
  signals: AnswerQualitySignal[];
}

export interface MineAnswerQualitySignalsOutput {
  candidates: KnowledgeCandidate[];
  candidatesCreated: number;
  signalsRead: number;
  signalsSkipped: number;
}

const PRODUCT_GAP_REASONS = new Set<AnswerQualitySignalReason>([
  'low_confidence',
  'low_confidence_missing_citations',
  'missing_citations',
]);
const SUPPORTED_GENERATED_EVAL_INTENTS = new Set<GeneratedEvalIntent>([
  'product_qa',
  'how_to',
  'tx_sandwich_detection',
  'realtime_account_query',
  'mev_or_chain_forensics',
  'investment_advice',
  'unknown',
]);

export function mineAnswerQualitySignals(
  input: MineAnswerQualitySignalsInput,
): MineAnswerQualitySignalsOutput {
  const now = input.now ?? new Date().toISOString();
  const candidates = input.signals.flatMap((signal): KnowledgeCandidate[] => {
    const candidate = createCandidateFromSignal(signal, now);
    return candidate === undefined ? [] : [candidate];
  });

  return {
    candidates,
    candidatesCreated: candidates.length,
    signalsRead: input.signals.length,
    signalsSkipped: input.signals.length - candidates.length,
  };
}

function createCandidateFromSignal(
  signal: AnswerQualitySignal,
  now: string,
): KnowledgeCandidate | undefined {
  if (
    signal.reason === 'boundary_private_data' ||
    signal.reason === 'boundary_investment_advice' ||
    signal.reason === 'boundary_private_credentials'
  ) {
    return createBoundaryCandidate(signal, now);
  }

  if (PRODUCT_GAP_REASONS.has(signal.reason)) {
    return createProductGapCandidate(signal, now);
  }
  if (isProductToolFailureSignal(signal)) {
    return createProductToolFailureCandidate(signal, now);
  }
  if (
    signal.reason === 'ambiguous_followup' ||
    signal.reason === 'ambiguous_transaction_reference' ||
    signal.reason === 'boundary_business_action' ||
    signal.reason === 'boundary_chain_forensics' ||
    signal.reason === 'boundary_unsafe_request' ||
    signal.reason === 'handoff_wording' ||
    signal.reason === 'missing_followup_context' ||
    signal.reason === 'unknown_intent' ||
    signal.reason === 'session_unavailable'
  ) {
    return createUnknownIntentCandidate(signal, now);
  }
  if (isTransactionFailureSignal(signal)) {
    return createTransactionFailureCandidate(signal, now);
  }

  return undefined;
}

function createProductGapCandidate(
  signal: AnswerQualitySignal,
  now: string,
): KnowledgeCandidate | undefined {
  const question = redactSupportText(signal.redactedQuestion);
  const answer = redactSupportText(signal.answer ?? '');
  const questionText = question.text.trim();
  const answerText = answer.text.trim();

  if (questionText.length === 0 || answerText.length === 0) {
    return undefined;
  }

  const redactionReport = mergeRedactionReports([question.report, answer.report]);
  const signalIdentity = createQualitySignalIdentity(signal, { answerText, questionText });
  if (isProductKnowledgeInsufficientAnswer(answerText)) {
    return {
      confidence: normalizeConfidence(signal.confidence),
      createdAt: now,
      existingKnowledgeMatches: [],
      generatedEvalCases: [
        createGeneratedEvalCase({
          answerText,
          expectedIntent: toSupportedIntent(signal.intent),
          minCitations: 0,
          questionText,
          requireExpectedAnswerText: false,
        }),
      ],
      id: createCandidateId(signalIdentity),
      proposedAnswer: answerText,
      question: questionText,
      redactionReport,
      riskLevel: redactionReport.riskLevel,
      sourceRefs: [createSourceRef(signalIdentity)],
      status: 'needs_review',
      targetCategory: 'eval_case',
      type: 'eval_case',
      updatedAt: now,
    };
  }

  const generatedEvalCases: GeneratedEvalCase[] = [
    {
      expectedAnswer: answerText,
      question: questionText,
    },
  ];
  const candidateType = selectProductCandidateType(redactionReport.riskLevel);

  return {
    confidence: normalizeConfidence(signal.confidence),
    createdAt: now,
    existingKnowledgeMatches: [],
    generatedEvalCases,
    id: createCandidateId(signalIdentity),
    proposedAnswer: answerText,
    question: questionText,
    redactionReport,
    riskLevel: redactionReport.riskLevel,
    sourceRefs: [createSourceRef(signalIdentity)],
    status: 'needs_review',
    targetCategory: candidateType === 'boundary_example' ? 'policy_boundary' : 'product_faq',
    type: candidateType,
    updatedAt: now,
  };
}

function createProductToolFailureCandidate(
  signal: AnswerQualitySignal,
  now: string,
): KnowledgeCandidate | undefined {
  const question = redactSupportText(signal.redactedQuestion);
  const answer = redactSupportText(signal.answer ?? '');
  const questionText = question.text.trim();
  const answerText = answer.text.trim();

  if (questionText.length === 0 || answerText.length === 0) {
    return undefined;
  }

  const redactionReport = mergeRedactionReports([question.report, answer.report]);
  const signalIdentity = createQualitySignalIdentity(signal, { answerText, questionText });

  return {
    confidence: normalizeConfidence(signal.confidence),
    createdAt: now,
    existingKnowledgeMatches: [],
    generatedEvalCases: [
      createGeneratedEvalCase({
        answerText,
        expectedIntent: toSupportedIntent(signal.intent),
        minCitations: 0,
        questionText,
        requireExpectedAnswerText: false,
      }),
    ],
    id: createCandidateId(signalIdentity),
    proposedAnswer: answerText,
    question: questionText,
    redactionReport,
    riskLevel: redactionReport.riskLevel,
    sourceRefs: [createSourceRef(signalIdentity)],
    status: 'needs_review',
    targetCategory: 'eval_case',
    type: 'eval_case',
    updatedAt: now,
  };
}

function createBoundaryCandidate(
  signal: AnswerQualitySignal,
  now: string,
): KnowledgeCandidate | undefined {
  const question = redactSupportText(signal.redactedQuestion);
  const questionText = question.text.trim();

  if (questionText.length === 0) {
    return undefined;
  }

  const redactionReport = ensureBoundaryRisk(question.report, signal.reason);
  const proposedAnswer = boundaryAnswerFor(signal.reason);
  const signalIdentity = createQualitySignalIdentity(signal, {
    answerText: proposedAnswer,
    questionText,
  });

  return {
    confidence: normalizeConfidence(signal.confidence),
    createdAt: now,
    existingKnowledgeMatches: [],
    generatedEvalCases: [
      {
        expectedAnswer: proposedAnswer,
        question: questionText,
      },
    ],
    id: createCandidateId(signalIdentity),
    proposedAnswer,
    question: questionText,
    redactionReport,
    riskLevel: redactionReport.riskLevel,
    sourceRefs: [createSourceRef(signalIdentity)],
    status: 'needs_review',
    targetCategory: 'policy_boundary',
    type: 'boundary_example',
    updatedAt: now,
  };
}

function createUnknownIntentCandidate(
  signal: AnswerQualitySignal,
  now: string,
): KnowledgeCandidate | undefined {
  const question = redactSupportText(signal.redactedQuestion);
  const answer = redactSupportText(signal.answer ?? unknownIntentClarificationAnswer());
  const questionText = question.text.trim();
  const answerText = answer.text.trim();

  if (questionText.length === 0 || answerText.length === 0) {
    return undefined;
  }

  const redactionReport = mergeRedactionReports([question.report, answer.report]);
  const signalIdentity = createQualitySignalIdentity(signal, { answerText, questionText });

  return {
    confidence: normalizeConfidence(signal.confidence),
    createdAt: now,
    existingKnowledgeMatches: [],
    generatedEvalCases: [
      createGeneratedEvalCase({
        answerText,
        expectedIntent: toSupportedIntent(signal.intent),
        minCitations: 0,
        questionText,
        requireExpectedAnswerText: false,
      }),
    ],
    id: createCandidateId(signalIdentity),
    proposedAnswer: answerText,
    question: questionText,
    redactionReport,
    riskLevel: redactionReport.riskLevel,
    sourceRefs: [createSourceRef(signalIdentity)],
    status: 'needs_review',
    targetCategory: 'eval_case',
    type: 'eval_case',
    updatedAt: now,
  };
}

function createGeneratedEvalCase(input: {
  answerText: string;
  expectedIntent: GeneratedEvalIntent | undefined;
  minCitations: number | undefined;
  questionText: string;
  requireExpectedAnswerText: boolean | undefined;
}): GeneratedEvalCase {
  return {
    expectedAnswer: input.answerText,
    ...(input.expectedIntent === undefined ? {} : { expectedIntent: input.expectedIntent }),
    ...(input.minCitations === undefined ? {} : { minCitations: input.minCitations }),
    question: input.questionText,
    ...(input.requireExpectedAnswerText === undefined
      ? {}
      : { requireExpectedAnswerText: input.requireExpectedAnswerText }),
  };
}

function createTransactionFailureCandidate(
  signal: AnswerQualitySignal,
  now: string,
): KnowledgeCandidate | undefined {
  const question = redactSupportText(signal.redactedQuestion);
  const answer = redactSupportText(signal.answer ?? '');
  const questionText = question.text.trim();
  const answerText = answer.text.trim();

  if (questionText.length === 0 || answerText.length === 0) {
    return undefined;
  }

  const redactionReport = mergeRedactionReports([question.report, answer.report]);
  const signalIdentity = createQualitySignalIdentity(signal, { answerText, questionText });

  return {
    confidence: normalizeConfidence(signal.confidence),
    createdAt: now,
    existingKnowledgeMatches: [],
    generatedEvalCases: [
      {
        expectedAnswer: answerText,
        expectedIntent: 'tx_sandwich_detection',
        minCitations: 0,
        question: questionText,
        requireExpectedAnswerText: false,
      },
    ],
    id: createCandidateId(signalIdentity),
    proposedAnswer: answerText,
    question: questionText,
    redactionReport,
    riskLevel: redactionReport.riskLevel,
    sourceRefs: [createSourceRef(signalIdentity)],
    status: 'needs_review',
    targetCategory: 'eval_case',
    type: 'eval_case',
    updatedAt: now,
  };
}

interface QualitySignalIdentity {
  agentRoute?: string;
  answer?: string;
  channel: string;
  citationCount?: number;
  confidence?: number;
  errorCode?: string;
  intent: string;
  question: string;
  reason: AnswerQualitySignalReason;
  sessionIdPresent: boolean;
  userIdPresent: boolean;
}

function createQualitySignalIdentity(
  signal: AnswerQualitySignal,
  input: { answerText: string | undefined; questionText: string },
): QualitySignalIdentity {
  const agentRoute = signal.agentRoute?.trim();
  return {
    ...(agentRoute === undefined || agentRoute.length === 0 ? {} : { agentRoute }),
    ...(input.answerText === undefined ? {} : { answer: input.answerText }),
    channel: signal.channel,
    ...(signal.citationCount === undefined ? {} : { citationCount: signal.citationCount }),
    ...(signal.confidence === undefined ? {} : { confidence: signal.confidence }),
    ...(signal.errorCode === undefined ? {} : { errorCode: signal.errorCode }),
    intent: signal.intent,
    question: input.questionText,
    reason: signal.reason,
    sessionIdPresent: signal.sessionIdPresent,
    userIdPresent: signal.userIdPresent,
  };
}

function unknownIntentClarificationAnswer(): string {
  return '我还不确定你想咨询 XXYY 的哪个功能。请补充具体功能、配置步骤、Pro 权益，或发送单笔交易哈希。';
}

function boundaryAnswerFor(reason: AnswerQualitySignalReason): string {
  if (reason === 'boundary_investment_advice') {
    return 'XXYY 客服 Agent 可以说明产品功能和风险提示，但不能提供买入、卖出、价格预测或投资收益建议。请自行评估风险。';
  }
  if (reason === 'boundary_private_credentials') {
    return 'XXYY 客服 Agent 不需要私钥、助记词、seed phrase 或恢复词，也不能保管或恢复这些凭证。请不要在客服对话中发送。';
  }

  return 'XXYY 客服 Agent 不能查询账户、订单、钱包余额或私有交易记录。请在已登录的 XXYY 产品页面或你的钱包/交易所内自行核对。';
}

function selectProductCandidateType(riskLevel: KnowledgeRiskLevel): KnowledgeCandidateType {
  return riskLevel === 'high' ? 'boundary_example' : 'faq';
}

function isProductKnowledgeInsufficientAnswer(answerText: string): boolean {
  return /当前知识库没有足够|知识库没有足够资料|知识库没有足够信息/u.test(answerText);
}

function isTransactionFailureSignal(signal: AnswerQualitySignal): boolean {
  return (
    signal.intent === 'tx_sandwich_detection' &&
    (signal.reason === 'tx_analysis_failure' || signal.reason === 'tool_failure')
  );
}

function isProductToolFailureSignal(signal: AnswerQualitySignal): boolean {
  return (
    signal.reason === 'tool_failure' &&
    (signal.intent === 'product_qa' || signal.intent === 'how_to')
  );
}

function toSupportedIntent(intent: string): GeneratedEvalIntent | undefined {
  if (SUPPORTED_GENERATED_EVAL_INTENTS.has(intent as GeneratedEvalIntent)) {
    return intent as GeneratedEvalIntent;
  }

  return undefined;
}

function ensureBoundaryRisk(
  report: RedactionReport,
  reason: AnswerQualitySignalReason,
): RedactionReport {
  const riskFlags = new Set<KnowledgeRiskFlag>(report.riskFlags);

  if (reason === 'boundary_investment_advice') {
    riskFlags.add('investment_advice');
  }
  if (reason === 'boundary_private_data') {
    riskFlags.add('private_account_query');
  }
  if (reason === 'boundary_private_credentials') {
    riskFlags.add('private_credentials');
  }

  return {
    ...report,
    riskFlags: [...riskFlags],
    riskLevel: 'high',
  };
}

function mergeRedactionReports(reports: RedactionReport[]): RedactionReport {
  const entityCounts = new Map<RedactedEntitySummary['type'], number>();
  const riskFlags = new Set<KnowledgeRiskFlag>();
  let riskLevel: KnowledgeRiskLevel = 'low';

  for (const report of reports) {
    for (const entity of report.entities) {
      entityCounts.set(entity.type, (entityCounts.get(entity.type) ?? 0) + entity.count);
    }
    for (const flag of report.riskFlags) {
      riskFlags.add(flag);
    }
    riskLevel = maxRiskLevel(riskLevel, report.riskLevel);
  }

  return {
    entities: Array.from(entityCounts, ([type, count]) => ({ type, count })),
    riskFlags: [...riskFlags],
    riskLevel,
  };
}

function maxRiskLevel(left: KnowledgeRiskLevel, right: KnowledgeRiskLevel): KnowledgeRiskLevel {
  const rank: Record<KnowledgeRiskLevel, number> = {
    high: 2,
    low: 0,
    medium: 1,
  };

  return rank[left] >= rank[right] ? left : right;
}

function normalizeConfidence(confidence: number | undefined): number {
  if (confidence === undefined || !Number.isFinite(confidence)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, confidence));
}

function createSourceRef(signal: QualitySignalIdentity): KnowledgeCandidateSourceRef {
  return {
    chatIdHash: signal.sessionIdPresent ? 'session_present' : 'session_absent',
    messageId: createQualitySignalMessageId(signal),
    ...(signal.agentRoute === undefined ? {} : { qualitySignalAgentRoute: signal.agentRoute }),
    qualitySignalReason: signal.reason,
    source: 'answer_quality_signal',
  };
}

function createCandidateId(signal: QualitySignalIdentity): string {
  return `kc_quality_${qualitySignalHash(signal)}`;
}

function createQualitySignalMessageId(signal: QualitySignalIdentity): string {
  return `aqs_${qualitySignalHash(signal)}`;
}

function qualitySignalHash(signal: QualitySignalIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        agentRoute: signal.agentRoute,
        answer: signal.answer,
        channel: signal.channel,
        citationCount: signal.citationCount,
        confidence: signal.confidence,
        errorCode: signal.errorCode,
        intent: signal.intent,
        question: signal.question,
        reason: signal.reason,
        sessionIdPresent: signal.sessionIdPresent,
        userIdPresent: signal.userIdPresent,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}
