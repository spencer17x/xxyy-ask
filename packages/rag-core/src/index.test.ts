import { describe, expect, it } from 'vitest';

import {
  classifyQuestion,
  createChatService,
  createGroundedAnswer,
  evaluateCases,
  loadRagConfig,
  retrieve,
  workspacePackageName,
} from './index.js';

describe('rag-core public exports', () => {
  it('exports the deterministic RAG core API', () => {
    expect(workspacePackageName).toBe('@xxyy/rag-core');
    expect(loadRagConfig).toBeTypeOf('function');
    expect(classifyQuestion).toBeTypeOf('function');
    expect(retrieve).toBeTypeOf('function');
    expect(createGroundedAnswer).toBeTypeOf('function');
    expect(createChatService).toBeTypeOf('function');
    expect(evaluateCases).toBeTypeOf('function');
  });
});
