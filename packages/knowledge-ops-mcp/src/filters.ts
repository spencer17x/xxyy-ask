import type { ListKnowledgeCandidatesInput } from '@xxyy/agent-core';
import type { ListKnowledgeCandidatesFilter } from '@xxyy/knowledge-ops';

export function toListCandidatesFilter(
  input: ListKnowledgeCandidatesInput,
): ListKnowledgeCandidatesFilter {
  return {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.type === undefined ? {} : { type: input.type }),
  };
}
