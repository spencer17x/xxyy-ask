import { describe, expect, it } from 'vitest';

import { createRunKnowledgeGateCommandArgs } from './commands.js';

describe('knowledge ops MCP command args', () => {
  it('builds single-candidate knowledge gate command arguments', () => {
    expect(
      createRunKnowledgeGateCommandArgs({
        fast: true,
        id: 'kc_telegram_setup',
      }),
    ).toEqual(['rag:gate:knowledge', '--', '--id', 'kc_telegram_setup', '--fast']);
  });

  it('builds approved eval-only batch gate command arguments', () => {
    expect(
      createRunKnowledgeGateCommandArgs({
        approvedEvalOnly: true,
        fast: true,
      }),
    ).toEqual(['rag:gate:knowledge', '--', '--approved-eval', '--fast']);
  });
});
