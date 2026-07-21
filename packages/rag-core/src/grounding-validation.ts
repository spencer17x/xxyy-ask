import { tokenize } from '@xxyy/knowledge';

import {
  hasUsableKnowledgeText,
  sanitizeUntrustedKnowledgeText,
} from './knowledge-content-safety.js';
import type { RetrievedChunk } from './retrieve.js';

export interface GroundingClaimResult {
  critical: boolean;
  grounded: boolean;
  matchedChunkIds: string[];
  score: number;
  text: string;
}

export interface AnswerGroundingValidation {
  claims: GroundingClaimResult[];
  coverage: number;
  criticalClaimCount: number;
  grounded: boolean;
  supportedChunkIds: string[];
  unsupportedClaims: string[];
}

interface EvidenceSegment {
  chunkId: string;
  normalized: string;
  numbers: ReadonlySet<string>;
  polarity: ClaimPolarity;
  text: string;
  tokens: ReadonlySet<string>;
}

type ClaimPolarity = 'negative' | 'neutral' | 'positive';

const GROUNDING_STOP_TOKENS = new Set([
  'xxyy',
  '可以',
  '以及',
  '然后',
  '通过',
  '进行',
  '根据',
  '知识',
  '当前',
  '现在',
  '相关',
  '这个',
  '这些',
  'the',
  'and',
  'for',
  'with',
  'can',
  'current',
]);
const NEGATIVE_PATTERN =
  /不支持|不能|无法|不可|不要|不得|切勿|未支持|尚未|暂未|暂不|没有明确|not supported|cannot|can't|must not|do not|unable|unavailable|does not/iu;
const POSITIVE_PATTERN =
  /支持|提供|包括|包含|能够|可以|可在|已上线|已支持|权益|supports?|provides?|includes?|available|can\b/iu;
const META_CLAIM_PATTERN =
  /^(?:根据知识库)?(?:可以按这些信息操作|以下是(?:相关)?信息|操作步骤|结论|回答|说明)[:：]?$|^(?:当前)?知识库(?:没有|未找到|暂无).{0,80}(?:说明|资料|内容|证据)|^(?:资料不足|无法确认|不能确认)/u;

export function validateAnswerGrounding(
  answer: string,
  question: string,
  chunks: RetrievedChunk[],
): AnswerGroundingValidation {
  const evidenceSegments = createEvidenceSegments(chunks);
  const claims = extractAnswerClaims(answer).map((claim) =>
    validateClaim(claim, question, evidenceSegments),
  );
  const criticalClaims = claims.filter((claim) => claim.critical);
  const groundedCriticalClaims = criticalClaims.filter((claim) => claim.grounded);
  const supportedChunkIds = Array.from(
    new Set(groundedCriticalClaims.flatMap((claim) => claim.matchedChunkIds)),
  );
  const coverage =
    criticalClaims.length === 0 ? 1 : groundedCriticalClaims.length / criticalClaims.length;

  return {
    claims,
    coverage: Number(coverage.toFixed(3)),
    criticalClaimCount: criticalClaims.length,
    grounded: criticalClaims.every((claim) => claim.grounded),
    supportedChunkIds,
    unsupportedClaims: criticalClaims.filter((claim) => !claim.grounded).map((claim) => claim.text),
  };
}

function extractAnswerClaims(answer: string): string[] {
  return answer
    .replace(/\[\^?\d+\]/gu, '')
    .split(/\n+|(?<=[。！？；])|(?<=[!?;])\s+|(?<=\.)\s+/u)
    .map((claim) =>
      claim
        .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '')
        .replace(/^(?:根据(?:当前)?知识库|结论)\s*[,，:：]?\s*/u, '')
        .trim(),
    )
    .filter((claim) => claim.length > 0);
}

function validateClaim(
  claim: string,
  question: string,
  evidenceSegments: EvidenceSegment[],
): GroundingClaimResult {
  const critical = isCriticalClaim(claim);
  if (!critical) {
    return {
      critical: false,
      grounded: true,
      matchedChunkIds: [],
      score: 1,
      text: claim,
    };
  }

  const claimTokens = new Set(meaningfulGroundingTokens(`${question} ${claim}`, claim));
  const claimNumbers = new Set(extractNumbers(claim));
  const claimPolarity = detectPolarity(claim);
  let bestScore = 0;
  const matchedChunkIds: string[] = [];

  for (const evidence of evidenceSegments) {
    if (!numbersAreSupported(claimNumbers, evidence.numbers)) {
      continue;
    }
    if (!polarityIsCompatible(claimPolarity, evidence.polarity)) {
      continue;
    }

    const score = calculateEvidenceScore(claim, claimTokens, claimNumbers, evidence);
    bestScore = Math.max(bestScore, score);
    if (score >= groundingThreshold(claimTokens.size, claimNumbers.size)) {
      matchedChunkIds.push(evidence.chunkId);
    }
  }

  return {
    critical: true,
    grounded: matchedChunkIds.length > 0,
    matchedChunkIds: Array.from(new Set(matchedChunkIds)),
    score: Number(bestScore.toFixed(3)),
    text: claim,
  };
}

function createEvidenceSegments(chunks: RetrievedChunk[]): EvidenceSegment[] {
  return chunks.flatMap((chunk) => {
    const safeText = sanitizeUntrustedKnowledgeText(chunk.text).text;
    if (!hasUsableKnowledgeText(safeText)) {
      return [];
    }
    const title = sanitizeUntrustedKnowledgeText(chunk.metadata.title).text;
    const moduleName = sanitizeUntrustedKnowledgeText(chunk.metadata.module).text;
    const headings = chunk.metadata.headingPath
      .map((heading) => sanitizeUntrustedKnowledgeText(heading).text)
      .join(' ');
    const metadataContext = [title, moduleName, headings].join(' ');
    const contentSegments = splitEvidenceSegments(safeText);
    const datedSegments =
      chunk.metadata.effectiveAt === undefined
        ? contentSegments
        : [...contentSegments, `生效时间 ${chunk.metadata.effectiveAt}`];
    return datedSegments.map((segment) =>
      createEvidenceSegment(chunk.id, metadataContext, segment),
    );
  });
}

function createEvidenceSegment(
  chunkId: string,
  metadataContext: string,
  segment: string,
): EvidenceSegment {
  const text = `${metadataContext} ${segment}`.trim();
  return {
    chunkId,
    normalized: normalizeGroundingText(text),
    numbers: new Set(extractNumbers(text)),
    polarity: detectPolarity(segment),
    text,
    tokens: new Set(meaningfulGroundingTokens(text, text)),
  };
}

function splitEvidenceSegments(text: string): string[] {
  return text
    .split(/\n{2,}|\n(?=\s*[-*•]\s+)|(?<=[。！？；])|(?<=[!?;])\s+|(?<=\.)\s+/u)
    .map((segment) => segment.replace(/\s+/gu, ' ').trim())
    .filter((segment) => segment.length > 0 && segment !== '[已隔离疑似指令注入内容]');
}

function meaningfulGroundingTokens(text: string, claim: string): string[] {
  const claimTokenSet = new Set(tokenize(claim));
  return Array.from(
    new Set(
      tokenize(text).filter(
        (token) =>
          claimTokenSet.has(token) &&
          !GROUNDING_STOP_TOKENS.has(token) &&
          (/^[a-z0-9][a-z0-9_-]*$/u.test(token) || token.length === 2),
      ),
    ),
  );
}

function calculateEvidenceScore(
  claim: string,
  claimTokens: ReadonlySet<string>,
  claimNumbers: ReadonlySet<string>,
  evidence: EvidenceSegment,
): number {
  const normalizedClaim = normalizeGroundingText(claim);
  if (
    normalizedClaim.length >= 4 &&
    (evidence.normalized.includes(normalizedClaim) || normalizedClaim.includes(evidence.normalized))
  ) {
    return 1;
  }

  const matchedTokenCount = [...claimTokens].filter((token) => evidence.tokens.has(token)).length;
  const tokenCoverage = claimTokens.size === 0 ? 0 : matchedTokenCount / claimTokens.size;
  const numberBonus = claimNumbers.size > 0 ? 0.1 : 0;
  return Math.min(1, tokenCoverage + numberBonus);
}

function groundingThreshold(tokenCount: number, numberCount: number): number {
  if (tokenCount <= 1) {
    return numberCount > 0 ? 0.9 : 1;
  }
  return numberCount > 0 ? 0.5 : 0.55;
}

function numbersAreSupported(
  claimNumbers: ReadonlySet<string>,
  evidenceNumbers: ReadonlySet<string>,
): boolean {
  return [...claimNumbers].every((number) => evidenceNumbers.has(number));
}

function polarityIsCompatible(claim: ClaimPolarity, evidence: ClaimPolarity): boolean {
  if (claim === 'positive') {
    return evidence === 'positive';
  }
  if (claim === 'negative') {
    return evidence === 'negative';
  }
  return true;
}

function detectPolarity(text: string): ClaimPolarity {
  if (NEGATIVE_PATTERN.test(text)) {
    return 'negative';
  }
  if (POSITIVE_PATTERN.test(text)) {
    return 'positive';
  }
  return 'neutral';
}

function isCriticalClaim(claim: string): boolean {
  const normalized = claim.replace(/\s+/gu, ' ').trim();
  return normalized.length >= 2 && !META_CLAIM_PATTERN.test(normalized);
}

function extractNumbers(text: string): string[] {
  return (text.normalize('NFKC').match(/\d[\d,]*(?:\.\d+)?%?/gu) ?? []).map((number) =>
    number.replaceAll(',', ''),
  );
}

function normalizeGroundingText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–—]/gu, '-')
    .replace(/[\s*_`#「」『』“”"'，,。！!？?：:；;（）()【】[\]{}<>/\\]+/gu, '');
}
