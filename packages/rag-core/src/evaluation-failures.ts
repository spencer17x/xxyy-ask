import type { EvaluationReport } from './evaluate.js';
import { redactSensitiveSupportText } from './redaction.js';

export function formatEvaluationFailureJsonl(report: EvaluationReport): string {
  return report.results
    .filter((result) => !result.passed)
    .map((result) =>
      JSON.stringify({
        _review: {
          failureReasons: result.failureReasons.map(safe),
          observedAnswer: safe(result.response.answer),
          ...(result.actualAgentRoute === undefined
            ? {}
            : { observedAgentRoute: result.actualAgentRoute }),
          observedCitations: result.response.citations.map((citation) => ({
            excerpt: safe(citation.excerpt),
            file: safe(citation.file),
            ...(citation.sourceUrl === undefined ? {} : { sourceUrl: safe(citation.sourceUrl) }),
            title: safe(citation.title),
          })),
          retrievedChunkIds: result.retrievedChunkIds.map(safe),
          reviewRequired: true,
          source: 'rag_evaluate',
          toolNames: result.toolNames.map(safe),
        },
        boundaryExpected: !['agent_capabilities', 'product_qa', 'how_to'].includes(
          result.expectedIntent,
        ),
        ...(result.expectedAgentRoute === undefined
          ? {}
          : { expectedAgentRoute: result.expectedAgentRoute }),
        expectedIntent: result.expectedIntent,
        name: safe(result.name),
        question: safe(result.question),
        referenceFacts: result.referenceFacts.map(safe),
        relevantChunkIds: result.relevantChunkIds.map(safe),
      }),
    )
    .join('\n');
}

function safe(value: string): string {
  return redactSensitiveSupportText(value);
}
