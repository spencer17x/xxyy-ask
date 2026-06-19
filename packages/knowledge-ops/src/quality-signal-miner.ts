import { createHash } from 'node:crypto';

import { redactSupportText } from './redaction.js';
import type {
  GeneratedEvalCase,
  KnowledgeCandidate,
  KnowledgeCandidateSourceRef,
  KnowledgeCandidateType,
  KnowledgeRiskFlag,
  KnowledgeRiskLevel,
  RedactedEntitySummary,
  RedactionReport,
} from './types.js';

export type AnswerQualitySignalReason =
  | 'boundary_investment_advice'
  | 'boundary_private_data'
  | 'low_confidence'
  | 'missing_citations'
  | 'session_unavailable'
  | 'tool_failure'
  | 'tx_analysis_failure'
  | 'unknown_intent';

export interface AnswerQualitySignal {
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
  'missing_citations',
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
  if (signal.reason === 'boundary_private_data' || signal.reason === 'boundary_investment_advice') {
    return createBoundaryCandidate(signal, now);
  }

  if (PRODUCT_GAP_REASONS.has(signal.reason)) {
    return createProductGapCandidate(signal, now);
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
    id: createCandidateId(signal),
    proposedAnswer: answerText,
    question: questionText,
    redactionReport,
    riskLevel: redactionReport.riskLevel,
    sourceRefs: [createSourceRef(signal)],
    status: 'needs_review',
    targetCategory: candidateType === 'boundary_example' ? 'policy_boundary' : 'product_faq',
    type: candidateType,
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
    id: createCandidateId(signal),
    proposedAnswer,
    question: questionText,
    redactionReport,
    riskLevel: redactionReport.riskLevel,
    sourceRefs: [createSourceRef(signal)],
    status: 'needs_review',
    targetCategory: 'policy_boundary',
    type: 'boundary_example',
    updatedAt: now,
  };
}

function boundaryAnswerFor(reason: AnswerQualitySignalReason): string {
  if (reason === 'boundary_investment_advice') {
    return 'XXYY 客服 Agent 可以说明产品功能和风险提示，但不能提供买入、卖出、价格预测或投资收益建议。请自行评估风险。';
  }

  return 'XXYY 客服 Agent 不能查询账户、订单、钱包余额或私有交易记录。请在已登录的 XXYY 产品页面或你的钱包/交易所内自行核对。';
}

function selectProductCandidateType(riskLevel: KnowledgeRiskLevel): KnowledgeCandidateType {
  return riskLevel === 'high' ? 'boundary_example' : 'faq';
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

function createSourceRef(signal: AnswerQualitySignal): KnowledgeCandidateSourceRef {
  return {
    chatIdHash: signal.sessionIdPresent ? 'session_present' : 'session_absent',
    messageId: createQualitySignalMessageId(signal),
    source: 'answer_quality_signal',
  };
}

function createCandidateId(signal: AnswerQualitySignal): string {
  return `kc_quality_${qualitySignalHash(signal)}`;
}

function createQualitySignalMessageId(signal: AnswerQualitySignal): string {
  return `aqs_${qualitySignalHash(signal)}`;
}

function qualitySignalHash(signal: AnswerQualitySignal): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        answer: signal.answer,
        channel: signal.channel,
        citationCount: signal.citationCount,
        confidence: signal.confidence,
        errorCode: signal.errorCode,
        intent: signal.intent,
        question: signal.redactedQuestion,
        reason: signal.reason,
        sessionIdPresent: signal.sessionIdPresent,
        userIdPresent: signal.userIdPresent,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}
