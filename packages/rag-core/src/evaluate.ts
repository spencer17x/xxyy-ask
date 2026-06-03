import type { ChatRequest, Intent } from '@xxyy/shared';

import type { ChatService } from './chat-service.js';

export interface EvaluationCase {
  name: string;
  request: ChatRequest;
  expectedIntent: Intent;
  minCitations?: number;
}

export interface EvaluationResult {
  name: string;
  passed: boolean;
  expectedIntent: Intent;
  actualIntent: Intent;
  minCitations: number;
  citationCount: number;
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
    const passed = response.intent === testCase.expectedIntent && citationCount >= minCitations;

    results.push({
      name: testCase.name,
      passed,
      expectedIntent: testCase.expectedIntent,
      actualIntent: response.intent,
      minCitations,
      citationCount,
    });
  }

  return {
    total: cases.length,
    passed: results.filter((result) => result.passed).length,
    results,
  };
}
