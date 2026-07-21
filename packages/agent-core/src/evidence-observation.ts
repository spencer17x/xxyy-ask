export interface SearchEvidenceAttempt {
  chunkIds: readonly string[];
  citationKeys: readonly string[];
  evidenceTexts: readonly string[];
  query: string;
}

export type EvidenceObservationStopReason = 'max_steps' | 'no_new_evidence' | 'sufficient';

export interface EvidenceObservation {
  complexity: 'multi_part' | 'single_part';
  coveredFacets: string[];
  distinctCitationCount: number;
  distinctEvidenceCount: number;
  latestNewEvidenceCount: number;
  missingFacets: string[];
  requiredFacets: string[];
  shouldContinue: boolean;
  stopReason?: EvidenceObservationStopReason;
  sufficient: boolean;
  suggestedQuery?: string;
}

const MULTI_PART_SIGNAL = /比较|对比|区别|分别|同时|以及|与|\bcompare\b|\bversus\b|\bvs\.?\b/iu;
const MULTI_CATEGORY_SIGNAL =
  /(?:权益|功能|设置|上限|限制|管理|套餐|版本).+和.+(?:权益|功能|设置|上限|限制|管理|套餐|版本)/u;
const FACET_SEPARATOR = /\s*(?:以及|并且|还有|和|与|及|、|\/|\bversus\b|\bvs\.?\b)\s*/iu;
const GENERIC_FACET_TERMS = new Set([
  'compare',
  'versus',
  'vs',
  'xxyy',
  '什么',
  '区别',
  '哪些',
  '如何',
  '怎么',
  '是否',
  '比较',
  '对比',
  '分别',
  '可以',
  '同时',
  '以及',
]);

export function observeProductEvidence(
  question: string,
  attempts: readonly SearchEvidenceAttempt[],
  maxSteps: number,
): EvidenceObservation {
  const requiredFacets = extractEvidenceFacets(question);
  const multiPart = requiresMultiPartEvidence(question);
  const allEvidenceTexts = attempts.flatMap((attempt) => attempt.evidenceTexts);
  const coveredFacets = requiredFacets.filter((facet) =>
    allEvidenceTexts.some((text) => facetMatchesEvidence(facet, text)),
  );
  const missingFacets = requiredFacets.filter((facet) => !coveredFacets.includes(facet));
  const citationKeys = new Set(attempts.flatMap((attempt) => attempt.citationKeys));
  const evidenceKeys = distinctEvidenceKeys(attempts);
  const latestNewEvidenceCount = countLatestNewEvidence(attempts);
  const sufficient = determineSufficiency({
    coveredFacetCount: coveredFacets.length,
    distinctCitationCount: citationKeys.size,
    multiPart,
    requiredFacetCount: requiredFacets.length,
  });

  let stopReason: EvidenceObservationStopReason | undefined;
  if (sufficient) {
    stopReason = 'sufficient';
  } else if (attempts.length >= Math.max(0, maxSteps)) {
    stopReason = 'max_steps';
  } else if (attempts.length >= 2 && latestNewEvidenceCount === 0) {
    stopReason = 'no_new_evidence';
  }

  const suggestedQuery =
    sufficient || stopReason !== undefined
      ? undefined
      : createSuggestedQuery(question, missingFacets[0]);

  return {
    complexity: multiPart ? 'multi_part' : 'single_part',
    coveredFacets,
    distinctCitationCount: citationKeys.size,
    distinctEvidenceCount: evidenceKeys.size,
    latestNewEvidenceCount,
    missingFacets,
    requiredFacets,
    shouldContinue: !sufficient && stopReason === undefined,
    ...(stopReason === undefined ? {} : { stopReason }),
    sufficient,
    ...(suggestedQuery === undefined ? {} : { suggestedQuery }),
  };
}

export function extractEvidenceFacets(question: string): string[] {
  if (!requiresMultiPartEvidence(question)) {
    return [];
  }

  const normalized = question
    .normalize('NFKC')
    .replace(/^[\s，,。.!！?？]*(?:请|帮我|麻烦)?\s*(?:比较|对比|分别说明|说明一下)?\s*/u, '')
    .replace(/[？?！!。.]\s*$/u, '')
    .trim();
  const facets = normalized
    .split(FACET_SEPARATOR)
    .map(cleanFacet)
    .filter((facet) => facet.length >= 2 && facet.length <= 80);

  return [...new Set(facets)].slice(0, 4);
}

export function requiresMultiPartEvidence(question: string): boolean {
  const normalized = question.normalize('NFKC');
  return MULTI_PART_SIGNAL.test(normalized) || MULTI_CATEGORY_SIGNAL.test(normalized);
}

export function queryTargetsMissingFacet(query: string, missingFacets: readonly string[]): boolean {
  if (missingFacets.length === 0) {
    return true;
  }

  return missingFacets.some((facet) => facetMatchesEvidence(facet, query));
}

export function isAllowedSearchQueryRewrite(
  originalQuestion: string,
  rewrittenQuery: string,
  missingFacets: readonly string[],
): boolean {
  const query = rewrittenQuery.trim();
  if (query.length === 0 || query.length > 240) {
    return false;
  }
  if (!queryTargetsMissingFacet(query, missingFacets)) {
    return false;
  }
  if (!queryPreservesQuestionScope(originalQuestion, query)) {
    return false;
  }

  const requiredTemporalTerms = originalQuestion.match(/当前|现在|当时|截至|(?:19|20)\d{2}/gu);
  return (
    requiredTemporalTerms === null || requiredTemporalTerms.every((term) => query.includes(term))
  );
}

function determineSufficiency(input: {
  coveredFacetCount: number;
  distinctCitationCount: number;
  multiPart: boolean;
  requiredFacetCount: number;
}): boolean {
  if (input.distinctCitationCount === 0) {
    return false;
  }

  if (!input.multiPart) {
    return true;
  }

  if (input.requiredFacetCount > 1) {
    return input.coveredFacetCount === input.requiredFacetCount;
  }

  return input.distinctCitationCount >= 2;
}

function cleanFacet(value: string): string {
  return value
    .replace(/^(?:请|帮我|麻烦|比较|对比|分别|说明|一下)+\s*/u, '')
    .replace(/(?:分别)?(?:有什么|有何|是什么)?(?:区别|差异|不同)?(?:吗|么|呢)?\s*$/u, '')
    .replace(/^(?:XXYY\s*)?(?=XXYY)/iu, '')
    .trim();
}

function facetMatchesEvidence(facet: string, evidence: string): boolean {
  const normalizedFacet = compactText(facet);
  const normalizedEvidence = compactText(evidence);
  if (normalizedFacet.length === 0 || normalizedEvidence.length === 0) {
    return false;
  }

  const exactFacet = normalizedFacet.replace(/^xxyy/u, '');
  if (exactFacet.length >= 2 && normalizedEvidence.includes(exactFacet)) {
    return true;
  }

  const terms = meaningfulFacetTerms(facet);
  if (terms.length === 0) {
    return false;
  }
  const matched = terms.filter((term) => normalizedEvidence.includes(compactText(term))).length;
  const minimumMatches = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);
  return matched >= minimumMatches;
}

function meaningfulFacetTerms(facet: string): string[] {
  const normalized = facet.normalize('NFKC').toLowerCase();
  const latinTerms = (normalized.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/gu) ?? []).filter(
    (term) => term.length > 1 && !GENERIC_FACET_TERMS.has(term),
  );
  const hanTerms = (normalized.match(/\p{Script=Han}+/gu) ?? []).flatMap((segment) => {
    const characters = Array.from(segment);
    if (characters.length <= 2) {
      return [segment];
    }
    return characters
      .slice(0, -1)
      .map((character, index) => `${character}${characters[index + 1]}`);
  });

  return [...new Set([...latinTerms, ...hanTerms])].filter(
    (term) => term.length > 1 && !GENERIC_FACET_TERMS.has(term),
  );
}

function queryPreservesQuestionScope(question: string, query: string): boolean {
  const normalizedQuery = compactText(query);
  if (normalizedQuery.includes('xxyy')) {
    return true;
  }

  const questionTerms = meaningfulFacetTerms(question).filter((term) => term.length > 1);
  return questionTerms.some((term) => normalizedQuery.includes(compactText(term)));
}

function compactText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function distinctEvidenceKeys(attempts: readonly SearchEvidenceAttempt[]): Set<string> {
  return new Set(
    attempts.flatMap((attempt) =>
      attempt.chunkIds.length > 0
        ? attempt.chunkIds.map((id) => `chunk:${id}`)
        : attempt.citationKeys.map((key) => `citation:${key}`),
    ),
  );
}

function countLatestNewEvidence(attempts: readonly SearchEvidenceAttempt[]): number {
  const latest = attempts.at(-1);
  if (latest === undefined) {
    return 0;
  }

  const previousKeys = distinctEvidenceKeys(attempts.slice(0, -1));
  const latestKeys = distinctEvidenceKeys([latest]);
  return [...latestKeys].filter((key) => !previousKeys.has(key)).length;
}

function createSuggestedQuery(question: string, missingFacet: string | undefined): string {
  const timeScopes = [
    ...new Set(
      question.match(
        /(?:当前|现在|当时|截至[^，,。.!！?？]{0,20}|(?:19|20)\d{2}(?:\s*年|[-/]\d{1,2})?)/gu,
      ) ?? [],
    ),
  ];
  const base =
    missingFacet === undefined ? `${question} 官方文档 具体限制` : `XXYY ${missingFacet}`;
  return [base, ...timeScopes]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join(' ')
    .slice(0, 240)
    .trim();
}
