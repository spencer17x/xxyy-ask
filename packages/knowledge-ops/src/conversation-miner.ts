import { createHash } from 'node:crypto';

import { redactSupportMessage } from './redaction.js';
import type {
  GeneratedEvalCase,
  KnowledgeCandidate,
  KnowledgeCandidateSourceRef,
  KnowledgeCandidateType,
  KnowledgeRiskFlag,
  KnowledgeRiskLevel,
  RawSupportMessage,
  RedactedEntitySummary,
  RedactionReport,
} from './types.js';

export interface MineSupportConversationsInput {
  messages: RawSupportMessage[];
  now?: string;
}

export interface MineSupportConversationsOutput {
  messagesRead: number;
  pairsConsidered: number;
  candidates: KnowledgeCandidate[];
}

interface ConversationPair {
  question: RawSupportMessage;
  answer: RawSupportMessage;
}

export function mineSupportConversations(
  input: MineSupportConversationsInput,
): MineSupportConversationsOutput {
  const now = input.now ?? new Date().toISOString();
  const sortedMessages = [...input.messages].sort(compareMessages);
  const messagesById = new Map(sortedMessages.map((message) => [message.messageId, message]));
  const lastUserByScope = new Map<string, RawSupportMessage>();
  const pairs: ConversationPair[] = [];

  for (const current of sortedMessages) {
    if (current.senderRole === 'user' && current.text.trim().length > 0) {
      lastUserByScope.set(messageScopeKey(current), current);
      continue;
    }

    if (current.senderRole !== 'support' || current.text.trim().length === 0) {
      continue;
    }

    const question = findQuestionForSupportMessage(current, messagesById, lastUserByScope);
    if (question === undefined) {
      continue;
    }

    pairs.push({ question, answer: current });
  }

  return {
    messagesRead: sortedMessages.length,
    pairsConsidered: pairs.length,
    candidates: pairs.map((pair) => createCandidate(pair, now)),
  };
}

function createCandidate(pair: ConversationPair, now: string): KnowledgeCandidate {
  const question = redactSupportMessage(pair.question);
  const answer = redactSupportMessage(pair.answer);
  const redactionReport = mergeRedactionReports([question.redactionReport, answer.redactionReport]);
  const type = selectCandidateType(redactionReport.riskLevel);
  const questionText = question.text.trim();
  const answerText = answer.text.trim();
  const generatedEvalCases: GeneratedEvalCase[] = [
    {
      question: questionText,
      expectedAnswer: answerText,
    },
  ];

  return {
    id: createCandidateId(pair),
    type,
    status: 'needs_review',
    question: questionText,
    proposedAnswer: answerText,
    targetCategory: type === 'boundary_example' ? 'policy_boundary' : 'product_faq',
    sourceRefs: [toSourceRef(pair.question), toSourceRef(pair.answer)],
    redactionReport,
    existingKnowledgeMatches: [],
    confidence: type === 'faq' ? 0.8 : 0.65,
    riskLevel: redactionReport.riskLevel,
    generatedEvalCases,
    createdAt: now,
    updatedAt: now,
  };
}

function findQuestionForSupportMessage(
  supportMessage: RawSupportMessage,
  messagesById: Map<string, RawSupportMessage>,
  lastUserByScope: Map<string, RawSupportMessage>,
): RawSupportMessage | undefined {
  if (supportMessage.replyToMessageId !== undefined) {
    const repliedTo = messagesById.get(supportMessage.replyToMessageId);
    if (repliedTo?.senderRole === 'user' && repliedTo.text.trim().length > 0) {
      return repliedTo;
    }
  }

  return lastUserByScope.get(messageScopeKey(supportMessage));
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
    riskFlags: Array.from(riskFlags),
    riskLevel,
  };
}

function selectCandidateType(riskLevel: KnowledgeRiskLevel): KnowledgeCandidateType {
  return riskLevel === 'high' ? 'boundary_example' : 'faq';
}

function maxRiskLevel(left: KnowledgeRiskLevel, right: KnowledgeRiskLevel): KnowledgeRiskLevel {
  const rank: Record<KnowledgeRiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
  };

  return rank[left] >= rank[right] ? left : right;
}

function createCandidateId(pair: ConversationPair): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        answer: pair.answer.contentHash,
        answerMessageId: pair.answer.messageId,
        chatIdHash: pair.answer.chatIdHash,
        question: pair.question.contentHash,
        questionMessageId: pair.question.messageId,
        source: pair.answer.source,
      }),
    )
    .digest('hex')
    .slice(0, 16);

  return `kc_${hash}`;
}

function toSourceRef(message: RawSupportMessage): KnowledgeCandidateSourceRef {
  const base = {
    source: message.source,
    chatIdHash: message.chatIdHash,
    messageId: message.messageId,
  };

  return message.threadId === undefined ? base : { ...base, threadId: message.threadId };
}

function messageScopeKey(message: RawSupportMessage): string {
  return `${message.source}:${message.chatIdHash}:${message.threadId ?? ''}`;
}

function compareMessages(left: RawSupportMessage, right: RawSupportMessage): number {
  const sentAt = left.sentAt.localeCompare(right.sentAt);
  if (sentAt !== 0) {
    return sentAt;
  }

  return left.messageId.localeCompare(right.messageId);
}
