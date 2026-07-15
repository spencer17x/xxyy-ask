import { classifyQuestion } from '@xxyy/rag-core';
import type { CreateKnowledgeCandidateInput } from '@xxyy/rag-core';

export interface ExtractTelegramCandidateOptions {
  adminUserIds: ReadonlySet<string>;
}

export interface ExtractTelegramCandidateResult {
  candidates: CreateKnowledgeCandidateInput[];
  adminReplyCount: number;
  messageCount: number;
  skippedBoundaryCount: number;
  skippedMissingReplyCount: number;
}

interface TelegramExport {
  id?: number | string;
  messages: TelegramExportMessage[];
}

interface TelegramExportMessage {
  date?: string;
  date_unixtime?: string;
  from_id?: string;
  id: number | string;
  reply_to_message_id?: number | string;
  text?: unknown;
  type?: string;
}

export function extractTelegramKnowledgeCandidates(
  rawExport: unknown,
  options: ExtractTelegramCandidateOptions,
): ExtractTelegramCandidateResult {
  const telegramExport = readTelegramExport(rawExport);
  const messages = telegramExport.messages.filter(isOrdinaryMessage);
  const messagesById = new Map(messages.map((message) => [String(message.id), message]));
  const adminUserIds = new Set([...options.adminUserIds].map(normalizeTelegramUserId));
  const candidates: CreateKnowledgeCandidateInput[] = [];
  let adminReplyCount = 0;
  let skippedBoundaryCount = 0;
  let skippedMissingReplyCount = 0;

  for (const answerMessage of messages) {
    const submittedBy = normalizeTelegramUserId(answerMessage.from_id ?? '');
    if (submittedBy.length === 0 || !adminUserIds.has(submittedBy)) {
      continue;
    }

    adminReplyCount += 1;
    const replyId = answerMessage.reply_to_message_id;
    const questionMessage = replyId === undefined ? undefined : messagesById.get(String(replyId));
    if (
      questionMessage === undefined ||
      adminUserIds.has(normalizeTelegramUserId(questionMessage.from_id ?? ''))
    ) {
      skippedMissingReplyCount += 1;
      continue;
    }

    const question = flattenTelegramText(questionMessage.text).trim();
    const canonicalAnswer = flattenTelegramText(answerMessage.text).trim();
    if (question.length === 0 || canonicalAnswer.length === 0) {
      skippedMissingReplyCount += 1;
      continue;
    }

    const classification = classifyQuestion(question);
    if (classification.intent !== 'product_qa' && classification.intent !== 'how_to') {
      skippedBoundaryCount += 1;
      continue;
    }

    const effectiveAt = readMessageTimestamp(answerMessage);
    const sourceUrl = firstHttpsUrl(canonicalAnswer);
    candidates.push({
      canonicalAnswer,
      question,
      sourceChannel: 'telegram_export',
      ...(effectiveAt === undefined ? {} : { effectiveAt }),
      evidence: `Telegram export reply ${String(answerMessage.id)} to message ${String(questionMessage.id)}.`,
      sourceAnswerMessageId: String(answerMessage.id),
      ...(telegramExport.id === undefined ? {} : { sourceChatId: String(telegramExport.id) }),
      sourceQuestionMessageId: String(questionMessage.id),
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      submittedBy,
    });
  }

  return {
    adminReplyCount,
    candidates,
    messageCount: messages.length,
    skippedBoundaryCount,
    skippedMissingReplyCount,
  };
}

function readTelegramExport(value: unknown): TelegramExport {
  if (!isObject(value) || !Array.isArray(value.messages)) {
    throw new Error('Telegram export must be a JSON object with a messages array.');
  }

  const messages: TelegramExportMessage[] = [];
  value.messages.forEach((message, index) => {
    if (!isObject(message) || !isMessageId(message.id)) {
      throw new Error(`Invalid Telegram export message at index ${index}.`);
    }
    messages.push({
      id: message.id,
      ...(typeof message.date === 'string' ? { date: message.date } : {}),
      ...(typeof message.date_unixtime === 'string'
        ? { date_unixtime: message.date_unixtime }
        : {}),
      ...(typeof message.from_id === 'string' ? { from_id: message.from_id } : {}),
      ...(isMessageId(message.reply_to_message_id)
        ? { reply_to_message_id: message.reply_to_message_id }
        : {}),
      ...('text' in message ? { text: message.text } : {}),
      ...(typeof message.type === 'string' ? { type: message.type } : {}),
    });
  });

  return {
    messages,
    ...(isMessageId(value.id) ? { id: value.id } : {}),
  };
}

function isOrdinaryMessage(message: TelegramExportMessage): boolean {
  return message.type === undefined || message.type === 'message';
}

function flattenTelegramText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (isObject(part) && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

function normalizeTelegramUserId(value: string): string {
  return value.trim().replace(/^user(?=\d+$)/u, '');
}

function readMessageTimestamp(message: TelegramExportMessage): string | undefined {
  if (message.date_unixtime !== undefined && /^\d+$/u.test(message.date_unixtime)) {
    const timestamp = Number(message.date_unixtime) * 1000;
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }
  if (
    message.date !== undefined &&
    /(?:Z|[+-]\d{2}:?\d{2})$/u.test(message.date) &&
    Number.isFinite(Date.parse(message.date))
  ) {
    return new Date(message.date).toISOString();
  }
  return undefined;
}

function firstHttpsUrl(text: string): string | undefined {
  const match = /https:\/\/[^\s<>()]+/u.exec(text);
  return match?.[0]?.replace(/[.,，。；;!?！？]+$/u, '');
}

function isMessageId(value: unknown): value is number | string {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && value.trim().length > 0)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
