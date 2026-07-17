import type { AgentRoute, ChatRequest, ChatResponse, Intent } from '@xxyy/shared';

import type { ChatService } from './chat-service.js';
import type { AnswerQualityScores } from './answer-quality-judge.js';
import type {
  RetrievalEvaluationResult,
  RetrievalEvaluationSummary,
} from './retrieval-evaluate.js';

interface AnswerQualityEvaluationSummary {
  averageCompleteness: number;
  averageCorrectness: number;
  averageGroundedness: number;
  averageRelevance: number;
  averageSafeRefusal: number;
  judgedCaseCount: number;
}

export interface EvaluationCase {
  name: string;
  request: ChatRequest;
  expectedIntent: Intent;
  expectedAgentRoute?: AgentRoute;
  expectedToolNames?: string[];
  forbiddenChunkIds?: string[];
  minCitations?: number;
  referenceFacts?: string[];
  relevantChunkIds?: string[];
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
  actualAgentRoute?: AgentRoute;
  name: string;
  passed: boolean;
  expectedAgentRoute?: AgentRoute;
  expectedIntent: Intent;
  expectedToolNames: string[];
  forbiddenChunkIds: string[];
  actualIntent: Intent;
  minCitations: number;
  question: string;
  citationCount: number;
  failureReasons: string[];
  judgeScores?: AnswerQualityScores;
  referenceFacts: string[];
  relevantChunkIds: string[];
  response: ChatResponse;
  retrievedChunkIds: string[];
  retrievalEvaluation?: RetrievalEvaluationResult;
  toolNames: string[];
}

export interface EvaluationReport {
  judgeSummary?: AnswerQualityEvaluationSummary;
  total: number;
  passed: number;
  retrievalSummary?: RetrievalEvaluationSummary;
  results: EvaluationResult[];
}

export interface EvaluateCasesOptions {
  observe?(
    testCase: EvaluationCase,
    response: ChatResponse,
  ): EvaluationObservation | Promise<EvaluationObservation>;
  onResult?(result: EvaluationResult, index: number, total: number): void;
}

interface EvaluationObservation {
  retrievedChunkIds?: string[];
  toolNames?: string[];
}

export async function evaluateCases(
  cases: EvaluationCase[],
  service: ChatService,
  options: EvaluateCasesOptions = {},
): Promise<EvaluationReport> {
  const results: EvaluationResult[] = [];

  for (const testCase of cases) {
    const response = await service.ask(testCase.request);
    const observation = (await options.observe?.(testCase, response)) ?? {};
    const retrievedChunkIds = [...(observation.retrievedChunkIds ?? [])];
    const toolNames = [...(observation.toolNames ?? [])];
    const minCitations = testCase.minCitations ?? 0;
    const citationCount = response.citations.length;
    const failureReasons = collectFailureReasons({
      actualIntent: response.intent,
      answer: response.answer,
      citationCount,
      citationExcerpts: response.citations.map((citation) => citation.excerpt),
      citationFiles: response.citations.map((citation) => citation.file),
      citationTitles: response.citations.map((citation) => citation.title),
      actualAgentRoute: response.agentRoute,
      minCitations,
      sourceUrls: response.citations.flatMap((citation) =>
        citation.sourceUrl === undefined ? [] : [citation.sourceUrl],
      ),
      testCase,
      toolNames,
    });

    const result: EvaluationResult = {
      ...(response.agentRoute === undefined ? {} : { actualAgentRoute: response.agentRoute }),
      name: testCase.name,
      passed: failureReasons.length === 0,
      ...(testCase.expectedAgentRoute === undefined
        ? {}
        : { expectedAgentRoute: testCase.expectedAgentRoute }),
      expectedIntent: testCase.expectedIntent,
      expectedToolNames: [...(testCase.expectedToolNames ?? [])],
      forbiddenChunkIds: [...(testCase.forbiddenChunkIds ?? [])],
      actualIntent: response.intent,
      minCitations,
      question: testCase.request.message,
      citationCount,
      failureReasons,
      referenceFacts: [...(testCase.referenceFacts ?? [])],
      relevantChunkIds: [...(testCase.relevantChunkIds ?? [])],
      response,
      retrievedChunkIds,
      toolNames,
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
  actualAgentRoute: AgentRoute | undefined;
  actualIntent: Intent;
  answer: string;
  citationCount: number;
  citationExcerpts: string[];
  citationFiles: string[];
  citationTitles: string[];
  minCitations: number;
  sourceUrls: string[];
  testCase: EvaluationCase;
  toolNames: string[];
}): string[] {
  const failures: string[] = [];

  if (input.actualIntent !== input.testCase.expectedIntent) {
    failures.push(`intent ${input.actualIntent} != ${input.testCase.expectedIntent}`);
  }

  if (
    input.testCase.expectedAgentRoute !== undefined &&
    input.actualAgentRoute !== input.testCase.expectedAgentRoute
  ) {
    failures.push(
      `agent route ${input.actualAgentRoute ?? 'undefined'} != ${input.testCase.expectedAgentRoute}`,
    );
  }

  if (
    input.testCase.expectedToolNames !== undefined &&
    !sameOrderedValues(input.toolNames, input.testCase.expectedToolNames)
  ) {
    failures.push(
      `tool trajectory ${formatTrajectory(input.toolNames)} != ${formatTrajectory(input.testCase.expectedToolNames)}`,
    );
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

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function formatTrajectory(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join(',');
}

function normalizeGroundingText(text: string): string {
  return text.replace(/\s+/gu, '');
}
