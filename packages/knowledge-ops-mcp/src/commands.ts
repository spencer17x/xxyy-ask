import type { RunKnowledgeGateInput } from '@xxyy/agent-core';

export function createRunKnowledgeGateCommandArgs(input: RunKnowledgeGateInput): string[] {
  const fastArgs = input.fast === true ? ['--fast'] : [];

  if (input.approvedEvalOnly === true) {
    return ['rag:gate:knowledge', '--', '--approved-eval', ...fastArgs];
  }

  if (input.id === undefined) {
    throw new Error('run_knowledge_gate requires id unless approvedEvalOnly is true.');
  }

  return ['rag:gate:knowledge', '--', '--id', input.id, ...fastArgs];
}
