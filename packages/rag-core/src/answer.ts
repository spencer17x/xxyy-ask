import type { ChatAttachment, ChatResponse, Citation, Classification, Intent } from '@xxyy/shared';
import { tokenize } from '@xxyy/knowledge';

import type { RetrievedChunk } from './retrieve.js';

const GROUNDED_INTENTS = new Set<Intent>(['product_qa', 'how_to']);
const MAX_CITATIONS = 3;
const MAX_EXCERPT_LENGTH = 220;
const VIDEO_LINK_PATTERN = /\[([^\]]+)\]\((\/assets\/[^)\s]+\.mp4)\)/giu;
const FUTURE_SUPPORT_PATTERN =
  /计划|即将|预计|未来|下季度|稍后|soon|coming|roadmap|will\s+support|plans?\s+to\s+support/iu;

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

  const groundingChunks = selectGroundingChunks(question, retrievedChunks);
  if (groundingChunks.length === 0) {
    return createInsufficientKnowledgeAnswer(question, classification.intent);
  }

  const citations = createCitationsFromChunks(groundingChunks);
  const excerpts = citations.map((citation) => citation.excerpt);
  const supportConclusion = createSupportConclusion(question, groundingChunks);
  const answerPrefix =
    classification.intent === 'how_to' ? '根据知识库，可以按这些信息操作：' : '根据知识库，';

  return withOptionalAttachments(
    {
      answer: supportConclusion ?? `${answerPrefix}${excerpts.join(' ')}`,
      intent: classification.intent,
      citations,
      confidence: calculateGroundedConfidence(
        classification.confidence,
        groundingChunks[0]?.score ?? 0,
      ),
    },
    createAttachmentsFromChunks(groundingChunks),
  );
}

export function selectGroundingChunks(
  question: string,
  retrievedChunks: RetrievedChunk[],
): RetrievedChunk[] {
  const highRankedChunks = retrievedChunks.slice(0, MAX_CITATIONS);

  if (isDirectSourceQuestion(question)) {
    const directXPostChunk = selectBestDirectXPostChunk(
      question,
      highRankedChunks.filter(isDirectXPostChunk),
    );
    if (directXPostChunk !== undefined) {
      return [directXPostChunk];
    }
  }

  const topicalChunks = selectTopicalGroundingChunks(question, highRankedChunks);
  if (topicalChunks.length > 0) {
    return topicalChunks;
  }
  if (requiresStrongTopicalEvidence(question)) {
    return [];
  }

  const supportEntityTokens = supportEntityEvidenceTokens(question);
  if (supportEntityTokens.length > 0) {
    return highRankedChunks.filter((chunk) =>
      containsAllEvidenceTokens(toEvidenceText(chunk), supportEntityTokens),
    );
  }

  const standardAnswerChunk = highRankedChunks.find((chunk) => /标准客服回答：/u.test(chunk.text));
  if (standardAnswerChunk !== undefined && !requiresMultipleGroundingSources(question)) {
    return [standardAnswerChunk];
  }

  return highRankedChunks;
}

export function createInsufficientKnowledgeAnswer(question: string, intent: Intent): ChatResponse {
  return {
    answer: insufficientKnowledgeText(question),
    citations: [],
    confidence: 0.25,
    intent,
  };
}

export function shouldUseDeterministicSupportAnswer(question: string): boolean {
  return isSupportQuestion(normalizeForEvidenceMatch(question));
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

function isDirectSourceQuestion(question: string): boolean {
  return /哪条推文|哪条推特|哪篇推文|哪篇推特|具体推文|具体推特|tweet|x\s*post/iu.test(
    question.normalize('NFKC'),
  );
}

function requiresMultipleGroundingSources(question: string): boolean {
  return (
    /比较|对比|区别|分别|同时|以及|与|\bcompare\b|\bversus\b|\bvs\b/iu.test(question) ||
    /(?:权益|功能|设置|上限|限制|管理).+和.+(?:权益|功能|设置|上限|限制|管理)/u.test(question)
  );
}

function isDirectXPostChunk(chunk: RetrievedChunk): boolean {
  return (
    chunk.metadata.sourceType === 'x_updates' &&
    /^X Post \d+/u.test(chunk.metadata.title) &&
    /^https:\/\/x\.com\//u.test(chunk.metadata.sourceUrl ?? '')
  );
}

function selectBestDirectXPostChunk(
  question: string,
  chunks: RetrievedChunk[],
): RetrievedChunk | undefined {
  let bestChunk: RetrievedChunk | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  const queryTokens = meaningfulSourceQuestionTokens(question);

  for (const chunk of chunks) {
    const evidence = toEvidenceText(chunk);
    let score = 0;
    for (const token of queryTokens) {
      if (evidence.includes(token)) {
        score += token.length > 2 ? token.length : 1;
      }
    }

    if (score > bestScore) {
      bestChunk = chunk;
      bestScore = score;
    }
  }

  return bestChunk;
}

function meaningfulSourceQuestionTokens(question: string): string[] {
  const stopTokens = new Set([
    'tweet',
    'post',
    'x',
    '哪条',
    '哪篇',
    '具体',
    '推文',
    '推特',
    '来源',
  ]);
  return tokenize(question).filter((token) => token.length > 1 && !stopTokens.has(token));
}

function selectTopicalGroundingChunks(
  question: string,
  chunks: RetrievedChunk[],
): RetrievedChunk[] {
  const normalizedQuestion = normalizeForEvidenceMatch(question);

  if (isTradeSettingPresetText(normalizedQuestion)) {
    return chunks
      .filter((chunk) => isTradeSettingPresetEvidence(toEvidenceText(chunk)))
      .slice(0, 2);
  }

  if (isBaseB20SupportText(normalizedQuestion)) {
    return chunks.filter((chunk) => isBaseB20SupportEvidence(toEvidenceText(chunk))).slice(0, 2);
  }

  if (isCopyTradingSupportText(normalizedQuestion)) {
    return chunks
      .filter((chunk) => isCopyTradingSupportEvidence(toEvidenceText(chunk)))
      .slice(0, 2);
  }

  return [];
}

function requiresStrongTopicalEvidence(question: string): boolean {
  const normalizedQuestion = normalizeForEvidenceMatch(question);
  return (
    isTradeSettingPresetText(normalizedQuestion) ||
    isBaseB20SupportText(normalizedQuestion) ||
    isCopyTradingSupportText(normalizedQuestion)
  );
}

function supportEntityEvidenceTokens(question: string): string[] {
  const normalizedQuestion = normalizeForEvidenceMatch(question);
  if (!isSupportQuestion(normalizedQuestion)) {
    return [];
  }

  return Array.from(new Set(tokenize(normalizedQuestion))).filter(isSupportEntityToken);
}

function isSupportQuestion(normalizedQuestion: string): boolean {
  return /是否支持|当前支持|现在支持|支持.*(?:吗|么|不)|(?:does|do|can|is|are).*\bsupport\b|\bsupport(?:s|ed)?\b/u.test(
    normalizedQuestion,
  );
}

function isSupportEntityToken(token: string): boolean {
  return (
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(token) &&
    token.length > 1 &&
    !supportEntityStopTokens.has(token)
  );
}

const supportEntityStopTokens = new Set([
  'are',
  'can',
  'current',
  'currently',
  'do',
  'does',
  'i',
  'is',
  'me',
  'my',
  'now',
  'please',
  'pro',
  'support',
  'supported',
  'supports',
  'the',
  'this',
  'xxyy',
  'you',
]);

function containsAllEvidenceTokens(text: string, tokens: string[]): boolean {
  const evidenceTokens = new Set(tokenize(normalizeForEvidenceMatch(text)));
  return tokens.every((token) => evidenceTokens.has(token));
}

function createSupportConclusion(
  question: string,
  groundingChunks: RetrievedChunk[],
): string | undefined {
  return createSupportConclusionFromEvidence(
    question,
    groundingChunks.map((chunk) => chunk.text),
  );
}

export function createSupportConclusionFromEvidence(
  question: string,
  evidenceTexts: string[],
): string | undefined {
  const normalizedQuestion = normalizeForEvidenceMatch(question);
  if (!isSupportQuestion(normalizedQuestion)) {
    return undefined;
  }

  const sentence = selectSupportEvidenceSentence(question, evidenceTexts);
  if (sentence === undefined) {
    return undefined;
  }

  if (isNegativeSupportSentence(sentence) || /^(?:支持|已支持|全面支持)/u.test(sentence)) {
    return ensureSentenceEnding(sentence);
  }

  return `支持。${ensureSentenceEnding(sentence)}`;
}

function selectSupportEvidenceSentence(
  question: string,
  evidenceTexts: string[],
): string | undefined {
  const keywords = supportEvidenceKeywords(question);
  if (keywords.length === 0) {
    return undefined;
  }

  for (const text of evidenceTexts) {
    for (const sentence of splitEvidenceSentences(text)) {
      const normalizedSentence = normalizeForEvidenceMatch(sentence);
      if (
        containsAllEvidenceTokens(normalizedSentence, keywords) &&
        isCurrentSupportSentence(normalizedSentence)
      ) {
        return cleanEvidenceSentence(sentence);
      }
    }
  }

  return undefined;
}

function supportEvidenceKeywords(question: string): string[] {
  const normalizedQuestion = normalizeForEvidenceMatch(question);
  const keywords = supportEntityEvidenceTokens(question);

  if (isCopyTradingSupportText(normalizedQuestion)) {
    keywords.push('跟单');
  }
  if (isBaseB20SupportText(normalizedQuestion)) {
    keywords.push('b20');
  }

  return Array.from(new Set(keywords));
}

function isCurrentSupportSentence(sentence: string): boolean {
  return (
    !FUTURE_SUPPORT_PATTERN.test(sentence) &&
    /支持|上线|可用|暂时没有|不支持|未支持|尚未支持|\bsupport(?:s|ed)?\b|\bavailable\b|\blaunched\b/iu.test(
      sentence,
    )
  );
}

function splitEvidenceSentences(text: string): string[] {
  return text
    .replace(/\s+-\s+/gu, '\n')
    .split(/(?<=[。！？!?])\s+|\n+/u)
    .map(cleanEvidenceSentence)
    .filter((sentence) => sentence.length > 0);
}

function cleanEvidenceSentence(sentence: string): string {
  return sentence
    .replace(/\[[^\]]+\]\(([^)\s]+)\)/gu, '$1')
    .replace(/https?:\/\/\S+/giu, '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/^[\s\-*•|]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isNegativeSupportSentence(sentence: string): boolean {
  return /暂时没有|不支持|未支持|尚未支持|没有明确/u.test(sentence);
}

function ensureSentenceEnding(sentence: string): string {
  return /[。！？!?]$/u.test(sentence) ? sentence : `${sentence}。`;
}

function toEvidenceText(chunk: RetrievedChunk): string {
  return normalizeForEvidenceMatch(
    [chunk.metadata.title, chunk.metadata.module, ...chunk.metadata.headingPath, chunk.text].join(
      ' ',
    ),
  );
}

function normalizeForEvidenceMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function isTradeSettingPresetText(normalizedText: string): boolean {
  return /p\s*1\s*[/｜|]?\s*p\s*2\s*[/｜|]?\s*p\s*3|p1\/p2\/p3/u.test(normalizedText);
}

function isTradeSettingPresetEvidence(normalizedEvidence: string): boolean {
  return (
    isTradeSettingPresetText(normalizedEvidence) &&
    /交易设置|多档位|档位/u.test(normalizedEvidence) &&
    /gas|滑点|买卖|挂单/u.test(normalizedEvidence)
  );
}

function isBaseB20SupportText(normalizedText: string): boolean {
  return /\bb20\b/u.test(normalizedText);
}

function isBaseB20SupportEvidence(normalizedEvidence: string): boolean {
  return (
    isBaseB20SupportText(normalizedEvidence) &&
    /全面支持|支持.*交易|代币交易|专属标识/u.test(normalizedEvidence)
  );
}

function isCopyTradingSupportText(normalizedText: string): boolean {
  return /跟单|copy\s*trading|copy\s*trade|copytrade/u.test(normalizedText);
}

function isCopyTradingSupportEvidence(normalizedEvidence: string): boolean {
  return (
    isCopyTradingSupportText(normalizedEvidence) &&
    /功能上线|支持\s*(?:\d+|[一二三四五六七八九十]+)\s*大?公链|利润|胜率|跟单金额|卖出比例|gas|滑点|过滤条件|自定义/u.test(
      normalizedEvidence,
    )
  );
}

export function createBoundaryAnswer(classification: Classification): ChatResponse {
  return {
    answer:
      classification.reason === 'business action execution request'
        ? businessActionBoundaryText()
        : classification.reason === 'private credential or seed phrase disclosure'
          ? privateCredentialBoundaryText()
          : classification.reason === 'unsupported transaction or mev analysis request'
            ? unsupportedTransactionAnalysisBoundaryText()
            : classification.reason === 'unsafe or unsupported operation request'
              ? unsafeOperationBoundaryText()
              : boundaryText(classification.intent),
    intent: classification.intent,
    citations: [],
    confidence: Math.min(classification.confidence, 0.7),
  };
}

function boundaryText(intent: Intent): string {
  switch (intent) {
    case 'realtime_account_query':
      return '我不能直接查询你的钱包余额、订单、账户或交易记录，也不会编造实时数据。请在已授权的 XXYY 产品界面查看；如果你想了解产品里如何找到这些入口，可以继续问我操作步骤。';
    case 'investment_advice':
      return '我不能提供买卖建议、喊单或收益承诺。可以帮你理解 XXYY 产品功能、风险提示或如何使用产品信息，但最终投资判断需要你自行评估风险。';
    case 'unknown':
      return '我还不确定你想咨询的具体问题。你可以补充是想了解 XXYY 产品功能、设置步骤，还是账户/交易相关入口。';
    case 'product_qa':
    case 'how_to':
      return '暂时没有找到可引用的知识库内容。';
  }
}

function businessActionBoundaryText(): string {
  return '我不能代你开通、取消、修改、退款、赔偿或执行账户内操作，也不会在客服对话里完成这类处理。可以继续问我开通或升级的操作步骤、权益说明、配置路径，我会基于 XXYY 知识库回答。';
}

function privateCredentialBoundaryText(): string {
  return '不要在客服对话里发送私钥、助记词、密码、API key 或任何敏感凭据。为了你的资产和账户安全，我不会处理这类内容；如果你想了解 XXYY 相关安全设置入口，可以改问产品操作步骤。';
}

function unsafeOperationBoundaryText(): string {
  return '我不能帮助攻击、盗号、钓鱼、破解或利用系统漏洞。可以继续咨询 XXYY 产品功能、配置步骤、权益说明或官方更新相关问题。';
}

function unsupportedTransactionAnalysisBoundaryText(): string {
  return '当前不分析交易哈希、explorer 链接、池子、链上取证或 MEV/夹子问题，也不会编造实时链上结论。可以继续咨询 XXYY 产品功能、配置步骤、权益说明或官方更新。';
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
  const compact = (extractStandardCustomerAnswer(text) ?? text).replace(/\s+/gu, ' ').trim();
  if (compact.length <= MAX_EXCERPT_LENGTH) {
    return compact;
  }

  return `${compact.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

function extractStandardCustomerAnswer(text: string): string | undefined {
  const match = /标准客服回答：(?<answer>.*?)(?:用户问|演示视频：|\n{2,}|$)/su.exec(text);
  const answer = match?.groups?.answer?.trim();
  return answer === undefined || answer.length === 0 ? undefined : answer;
}

function insufficientKnowledgeText(question: string): string {
  const supportEntity = supportEntityDisplayName(question);
  if (supportEntity !== undefined) {
    return `当前知识库没有明确说明 XXYY 支持 ${supportEntity}，不能确认已支持。`;
  }

  return `当前知识库没有找到与「${question}」直接相关的资料，不能确认。`;
}

function supportEntityDisplayName(question: string): string | undefined {
  const normalizedQuestion = question.normalize('NFKC');
  const supportMatch =
    /(?:是否支持|当前支持|现在支持|支持)\s*(?<entity>[#$]?[a-z0-9][a-z0-9._-]*)/iu.exec(
      normalizedQuestion,
    ) ?? /\bsupport(?:s|ed)?\s+(?<entity>[#$]?[a-z0-9][a-z0-9._-]*)/iu.exec(normalizedQuestion);
  const entity = supportMatch?.groups?.entity?.trim();
  if (entity !== undefined && entity.length > 0 && isSupportEntityToken(entity.toLowerCase())) {
    return entity;
  }

  return supportEntityEvidenceTokens(question)[0];
}

function calculateGroundedConfidence(classificationConfidence: number, topScore: number): number {
  const scoreConfidence = Math.min(0.25, topScore / 10);
  return Number(
    Math.min(0.95, Math.max(0.55, classificationConfidence * 0.75 + scoreConfidence)).toFixed(2),
  );
}
