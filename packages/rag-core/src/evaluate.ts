import type { ChatRequest, Intent } from '@xxyy/shared';

import type { ChatService } from './chat-service.js';

export interface EvaluationCase {
  name: string;
  request: ChatRequest;
  expectedIntent: Intent;
  minCitations?: number;
  requiredAnswerIncludes?: string[];
  forbiddenAnswerIncludes?: string[];
  requiredCitationFiles?: string[];
  requiredCitationTitles?: string[];
  requiredSourceUrls?: string[];
  forbiddenCitationFiles?: string[];
  forbiddenSourceUrls?: string[];
  requireCitationSupport?: boolean;
}

export interface EvaluationResult {
  name: string;
  passed: boolean;
  expectedIntent: Intent;
  actualIntent: Intent;
  minCitations: number;
  citationCount: number;
  failureReasons: string[];
}

export interface EvaluationReport {
  total: number;
  passed: number;
  results: EvaluationResult[];
}

export interface EvaluateCasesOptions {
  onResult?(result: EvaluationResult, index: number, total: number): void;
}

export async function evaluateCases(
  cases: EvaluationCase[],
  service: ChatService,
  options: EvaluateCasesOptions = {},
): Promise<EvaluationReport> {
  const results: EvaluationResult[] = [];

  for (const testCase of cases) {
    const response = await service.ask(testCase.request);
    const minCitations = testCase.minCitations ?? 0;
    const citationCount = response.citations.length;
    const failureReasons = collectFailureReasons({
      actualIntent: response.intent,
      answer: response.answer,
      citationCount,
      citationExcerpts: response.citations.map((citation) => citation.excerpt),
      citationFiles: response.citations.map((citation) => citation.file),
      citationTitles: response.citations.map((citation) => citation.title),
      minCitations,
      sourceUrls: response.citations.flatMap((citation) =>
        citation.sourceUrl === undefined ? [] : [citation.sourceUrl],
      ),
      testCase,
    });

    const result = {
      name: testCase.name,
      passed: failureReasons.length === 0,
      expectedIntent: testCase.expectedIntent,
      actualIntent: response.intent,
      minCitations,
      citationCount,
      failureReasons,
    };
    results.push(result);
    options.onResult?.(result, results.length, cases.length);
  }

  return {
    total: cases.length,
    passed: results.filter((result) => result.passed).length,
    results,
  };
}

function collectFailureReasons(input: {
  actualIntent: Intent;
  answer: string;
  citationCount: number;
  citationExcerpts: string[];
  citationFiles: string[];
  citationTitles: string[];
  minCitations: number;
  sourceUrls: string[];
  testCase: EvaluationCase;
}): string[] {
  const failures: string[] = [];

  if (input.actualIntent !== input.testCase.expectedIntent) {
    failures.push(`intent ${input.actualIntent} != ${input.testCase.expectedIntent}`);
  }

  if (input.citationCount < input.minCitations) {
    failures.push(`citations ${input.citationCount}/${input.minCitations}`);
  }

  for (const requiredText of input.testCase.requiredAnswerIncludes ?? []) {
    if (!input.answer.includes(requiredText)) {
      failures.push(`answer missing required text: ${requiredText}`);
    }
  }

  for (const forbiddenText of input.testCase.forbiddenAnswerIncludes ?? []) {
    if (input.answer.includes(forbiddenText)) {
      failures.push(`answer contains forbidden text: ${forbiddenText}`);
    }
  }

  for (const requiredFile of input.testCase.requiredCitationFiles ?? []) {
    if (!input.citationFiles.includes(requiredFile)) {
      failures.push(`missing citation file: ${requiredFile}`);
    }
  }

  for (const requiredTitle of input.testCase.requiredCitationTitles ?? []) {
    if (!input.citationTitles.includes(requiredTitle)) {
      failures.push(`missing citation title: ${requiredTitle}`);
    }
  }

  for (const requiredSourceUrl of input.testCase.requiredSourceUrls ?? []) {
    if (!input.sourceUrls.includes(requiredSourceUrl)) {
      failures.push(`missing source URL: ${requiredSourceUrl}`);
    }
  }

  for (const forbiddenFile of input.testCase.forbiddenCitationFiles ?? []) {
    if (input.citationFiles.includes(forbiddenFile)) {
      failures.push(`forbidden citation file: ${forbiddenFile}`);
    }
  }

  for (const forbiddenSourceUrl of input.testCase.forbiddenSourceUrls ?? []) {
    if (input.sourceUrls.includes(forbiddenSourceUrl)) {
      failures.push(`forbidden source URL: ${forbiddenSourceUrl}`);
    }
  }

  if (input.testCase.requireCitationSupport === true) {
    const normalizedCitationText = normalizeGroundingText(input.citationExcerpts.join('\n'));
    for (const requiredText of input.testCase.requiredAnswerIncludes ?? []) {
      if (
        input.answer.includes(requiredText) &&
        !normalizedCitationText.includes(normalizeGroundingText(requiredText))
      ) {
        failures.push(`answer text is not supported by citations: ${requiredText}`);
      }
    }
  }

  return failures;
}

function normalizeGroundingText(text: string): string {
  return text.replace(/\s+/gu, '');
}
