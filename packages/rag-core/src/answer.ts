import type { ChatAttachment, ChatResponse, Citation, Classification, Intent } from '@xxyy/shared';

import type { RetrievedChunk } from './retrieve.js';

const GROUNDED_INTENTS = new Set<Intent>(['product_qa', 'how_to']);
const MAX_CITATIONS = 3;
const MAX_EXCERPT_LENGTH = 220;
const VIDEO_LINK_PATTERN = /\[([^\]]+)\]\((\/assets\/[^)\s]+\.mp4)\)/giu;

export function createGroundedAnswer(
  question: string,
  classification: Classification,
  retrievedChunks: RetrievedChunk[],
): ChatResponse {
  if (!GROUNDED_INTENTS.has(classification.intent)) {
    return createBoundaryAnswer(classification);
  }

  if (retrievedChunks.length === 0) {
    return {
      answer: `暂时没有找到与「${question}」直接相关的知识库内容。为了避免误导，我不能基于缺失资料补充产品细节；可以换一种问法，或提供更具体的功能名称。`,
      intent: classification.intent,
      citations: [],
      confidence: 0.25,
    };
  }

  const citations = createCitationsFromChunks(retrievedChunks);
  const excerpts = citations.map((citation) => citation.excerpt);
  const answerPrefix =
    classification.intent === 'how_to' ? '根据知识库，可以按这些信息操作：' : '根据知识库，';

  return withOptionalAttachments(
    {
      answer: `${answerPrefix}${excerpts.join(' ')}`,
      intent: classification.intent,
      citations,
      confidence: calculateGroundedConfidence(
        classification.confidence,
        retrievedChunks[0]?.score ?? 0,
      ),
    },
    createAttachmentsFromChunks(retrievedChunks),
  );
}

function withOptionalAttachments(
  response: ChatResponse,
  attachments: ChatAttachment[],
): ChatResponse {
  if (attachments.length === 0) {
    return response;
  }

  return {
    ...response,
    attachments,
  };
}

export function createAttachmentsFromChunks(retrievedChunks: RetrievedChunk[]): ChatAttachment[] {
  const byUrl = new Map<string, ChatAttachment>();

  for (const chunk of retrievedChunks) {
    for (const attachment of extractVideoAttachments(chunk.text)) {
      if (!byUrl.has(attachment.url)) {
        byUrl.set(attachment.url, attachment);
      }
    }
  }

  return Array.from(byUrl.values());
}

function extractVideoAttachments(text: string): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];

  for (const match of text.matchAll(VIDEO_LINK_PATTERN)) {
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (title === undefined || title.length === 0 || url === undefined || url.length === 0) {
      continue;
    }
    attachments.push({
      kind: 'video',
      mediaType: 'video/mp4',
      title,
      url,
    });
  }

  return attachments;
}

export function createBoundaryAnswer(classification: Classification): ChatResponse {
  return {
    answer: boundaryText(classification.intent),
    intent: classification.intent,
    citations: [],
    confidence: Math.min(classification.confidence, 0.7),
  };
}

function boundaryText(intent: Intent): string {
  switch (intent) {
    case 'realtime_account_query':
      return '我不能直接查询你的钱包余额、订单、账户或交易记录，也不会编造实时数据。请在已授权的 XXYY 产品界面查看；如果你想了解产品里如何找到这些入口，可以继续问我操作步骤。';
    case 'mev_or_chain_forensics':
      return '我不能仅凭当前问题判断某笔交易是否被夹或存在 MEV，也不会编造链上取证结论。需要实时链上数据、交易哈希和专业分析工具；我可以说明 XXYY 产品文档中支持哪些相关能力。';
    case 'investment_advice':
      return '我不能提供买卖建议、喊单或收益承诺。可以帮你理解 XXYY 产品功能、风险提示或如何使用产品信息，但最终投资判断需要你自行评估风险。';
    case 'unknown':
      return '我还不确定你想咨询的具体问题。你可以补充是想了解 XXYY 产品功能、设置步骤，还是账户/交易相关入口。';
    case 'product_qa':
    case 'how_to':
      return '暂时没有找到可引用的知识库内容。';
  }
}

export function createCitationsFromChunks(retrievedChunks: RetrievedChunk[]): Citation[] {
  return retrievedChunks.slice(0, MAX_CITATIONS).map(createCitation);
}

function createCitation(chunk: RetrievedChunk): Citation {
  const citation: Citation = {
    title: chunk.metadata.title,
    file: normalizeCitationFile(chunk.metadata.file),
    excerpt: createExcerpt(chunk.text),
  };

  if (chunk.metadata.sourceUrl !== undefined) {
    return {
      ...citation,
      sourceUrl: chunk.metadata.sourceUrl,
    };
  }

  return citation;
}

function normalizeCitationFile(file: string): string {
  const normalized = file.replaceAll('\\', '/');
  const docsIndex = normalized.indexOf('/docs/');
  if (docsIndex >= 0) {
    return normalized.slice(docsIndex + 1);
  }

  return normalized.replace(/^\/+/u, '');
}

function createExcerpt(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  if (compact.length <= MAX_EXCERPT_LENGTH) {
    return compact;
  }

  return `${compact.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

function calculateGroundedConfidence(classificationConfidence: number, topScore: number): number {
  const scoreConfidence = Math.min(0.25, topScore / 10);
  return Number(
    Math.min(0.95, Math.max(0.55, classificationConfidence * 0.75 + scoreConfidence)).toFixed(2),
  );
}
