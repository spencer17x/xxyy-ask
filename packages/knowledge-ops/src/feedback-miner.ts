import { createHash } from 'node:crypto';

import { redactSupportText } from './redaction.js';
import type {
  GeneratedEvalCase,
  GeneratedEvalIntent,
  KnowledgeCandidate,
  KnowledgeCandidateSourceRef,
  KnowledgeRiskFlag,
  KnowledgeRiskLevel,
  RedactedEntitySummary,
  RedactionReport,
} from './types.js';

export type AnswerFeedbackRating = 'negative' | 'positive';

export interface AnswerFeedback {
  answer: string;
  channel: string;
  citationCount: number;
  comment?: string;
  intent: string;
  question: string;
  rating: AnswerFeedbackRating;
  sessionIdPresent: boolean;
}

export interface MineAnswerFeedbackInput {
  feedback: AnswerFeedback[];
  now?: string;
}

export interface MineAnswerFeedbackOutput {
  candidates: KnowledgeCandidate[];
  candidatesCreated: number;
  feedbackRead: number;
  feedbackSkipped: number;
}

const SUPPORTED_GENERATED_EVAL_INTENTS = new Set<GeneratedEvalIntent>([
  'product_qa',
  'how_to',
  'tx_sandwich_detection',
  'realtime_account_query',
  'mev_or_chain_forensics',
  'investment_advice',
  'unknown',
]);

export function mineAnswerFeedback(input: MineAnswerFeedbackInput): MineAnswerFeedbackOutput {
  const now = input.now ?? new Date().toISOString();
  const candidates = input.feedback.flatMap((feedback): KnowledgeCandidate[] => {
    const candidate = createCandidateFromFeedback(feedback, now);
    return candidate === undefined ? [] : [candidate];
  });

  return {
    candidates,
    candidatesCreated: candidates.length,
    feedbackRead: input.feedback.length,
    feedbackSkipped: input.feedback.length - candidates.length,
  };
}

function createCandidateFromFeedback(
  feedback: AnswerFeedback,
  now: string,
): KnowledgeCandidate | undefined {
  if (feedback.rating !== 'negative') {
    return undefined;
  }

  const question = redactSupportText(feedback.question);
  const answer = redactSupportText(feedback.answer);
  const comment =
    feedback.comment === undefined || feedback.comment.trim().length === 0
      ? undefined
      : redactSupportText(feedback.comment);
  const questionText = question.text.trim();
  const answerText = answer.text.trim();

  if (questionText.length === 0 || answerText.length === 0) {
    return undefined;
  }

  const redactionReport = mergeRedactionReports([
    question.report,
    answer.report,
    ...(comment === undefined ? [] : [comment.report]),
  ]);
  const feedbackIdentity = createFeedbackIdentity(feedback, {
    answerText,
    commentText: comment?.text.trim(),
    questionText,
  });

  if (isBoundaryFeedback(feedback, redactionReport)) {
    return createBoundaryCandidate(feedbackIdentity, {
      answerText,
      now,
      questionText,
      redactionReport: ensureBoundaryRisk(redactionReport, feedback.intent),
    });
  }

  const reviewHint = createFeedbackReviewHint(comment?.text.trim());
  const proposedAnswer = createFeedbackProposedAnswer({
    answerText,
    reviewHint,
  });
  const generatedEvalCases: GeneratedEvalCase[] = [
    {
      expectedAnswer: reviewHint,
      expectedIntent: toSupportedIntent(feedback.intent),
      minCitations: minCitationsForFeedbackIntent(feedback.intent),
      question: questionText,
      requireExpectedAnswerText: false,
    },
  ];

  return {
    confidence: 0.55,
    createdAt: now,
    existingKnowledgeMatches: [],
    generatedEvalCases,
    id: createCandidateId(feedbackIdentity),
    proposedAnswer,
    question: questionText,
    redactionReport,
    riskLevel: redactionReport.riskLevel,
    sourceRefs: [createSourceRef(feedbackIdentity)],
    status: 'needs_review',
    targetCategory: 'eval_case',
    type: 'eval_case',
    updatedAt: now,
  };
}

interface FeedbackIdentity {
  answer: string;
  channel: string;
  citationCount: number;
  comment?: string;
  intent: string;
  question: string;
  rating: AnswerFeedbackRating;
  sessionIdPresent: boolean;
}

function createFeedbackIdentity(
  feedback: AnswerFeedback,
  input: {
    answerText: string;
    commentText: string | undefined;
    questionText: string;
  },
): FeedbackIdentity {
  return {
    answer: input.answerText,
    channel: feedback.channel,
    citationCount: feedback.citationCount,
    ...(input.commentText === undefined ? {} : { comment: input.commentText }),
    intent: feedback.intent,
    question: input.questionText,
    rating: feedback.rating,
    sessionIdPresent: feedback.sessionIdPresent,
  };
}

function createFeedbackReviewHint(commentText: string | undefined): string {
  if (commentText !== undefined && commentText.length > 0) {
    return `用户负反馈：${commentText}`;
  }

  return '用户负反馈：用户标记该回答未解决问题。';
}

function createFeedbackProposedAnswer(input: { answerText: string; reviewHint: string }): string {
  return `${input.reviewHint}\n原回答：${input.answerText}`;
}

function toSupportedIntent(intent: string): GeneratedEvalIntent {
  return SUPPORTED_GENERATED_EVAL_INTENTS.has(intent as GeneratedEvalIntent)
    ? (intent as GeneratedEvalIntent)
    : 'unknown';
}

function minCitationsForFeedbackIntent(intent: string): number {
  return intent === 'product_qa' || intent === 'how_to' ? 1 : 0;
}

function createBoundaryCandidate(
  feedback: FeedbackIdentity,
  input: {
    answerText: string;
    now: string;
    questionText: string;
    redactionReport: RedactionReport;
  },
): KnowledgeCandidate {
  return {
    confidence: 0.55,
    createdAt: input.now,
    existingKnowledgeMatches: [],
    generatedEvalCases: [
      {
        expectedAnswer: input.answerText,
        question: input.questionText,
      },
    ],
    id: createCandidateId(feedback),
    proposedAnswer: input.answerText,
    question: input.questionText,
    redactionReport: input.redactionReport,
    riskLevel: input.redactionReport.riskLevel,
    sourceRefs: [createSourceRef(feedback)],
    status: 'needs_review',
    targetCategory: 'policy_boundary',
    type: 'boundary_example',
    updatedAt: input.now,
  };
}

function isBoundaryFeedback(feedback: AnswerFeedback, report: RedactionReport): boolean {
  return (
    feedback.intent === 'investment_advice' ||
    feedback.intent === 'realtime_account_query' ||
    report.riskFlags.length > 0
  );
}

function ensureBoundaryRisk(report: RedactionReport, intent: string): RedactionReport {
  const riskFlags = new Set<KnowledgeRiskFlag>(report.riskFlags);

  if (intent === 'investment_advice') {
    riskFlags.add('investment_advice');
  }
  if (intent === 'realtime_account_query') {
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

function createSourceRef(feedback: FeedbackIdentity): KnowledgeCandidateSourceRef {
  return {
    chatIdHash: feedback.sessionIdPresent ? 'session_present' : 'session_absent',
    messageId: createFeedbackMessageId(feedback),
    source: 'answer_feedback',
  };
}

function createCandidateId(feedback: FeedbackIdentity): string {
  return `kc_feedback_${feedbackHash(feedback)}`;
}

function createFeedbackMessageId(feedback: FeedbackIdentity): string {
  return `fb_${feedbackHash(feedback)}`;
}

function feedbackHash(feedback: FeedbackIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        answer: feedback.answer,
        channel: feedback.channel,
        citationCount: feedback.citationCount,
        comment: feedback.comment,
        intent: feedback.intent,
        question: feedback.question,
        rating: feedback.rating,
        sessionIdPresent: feedback.sessionIdPresent,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}
