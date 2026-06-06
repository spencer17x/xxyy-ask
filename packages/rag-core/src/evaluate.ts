import type { ChatRequest, Intent } from '@xxyy/shared';

import type { ChatService } from './chat-service.js';

export interface EvaluationCase {
  name: string;
  request: ChatRequest;
  expectedIntent: Intent;
  minCitations?: number;
  requiredAnswerIncludes?: string[];
  forbiddenAnswerIncludes?: string[];
  requiredCitationTitles?: string[];
  requiredSourceUrls?: string[];
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

export async function evaluateCases(
  cases: EvaluationCase[],
  service: ChatService,
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
      citationTitles: response.citations.map((citation) => citation.title),
      minCitations,
      sourceUrls: response.citations.flatMap((citation) =>
        citation.sourceUrl === undefined ? [] : [citation.sourceUrl],
      ),
      testCase,
    });

    results.push({
      name: testCase.name,
      passed: failureReasons.length === 0,
      expectedIntent: testCase.expectedIntent,
      actualIntent: response.intent,
      minCitations,
      citationCount,
      failureReasons,
    });
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

  return failures;
}
