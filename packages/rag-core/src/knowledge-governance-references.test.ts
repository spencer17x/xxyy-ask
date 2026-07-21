import { describe, expect, it } from 'vitest';

import { createPgKnowledgeGovernanceReferenceStore } from './knowledge-governance-references.js';

describe('createPgKnowledgeGovernanceReferenceStore', () => {
  it('loads conflict chunks in requested order without exposing embeddings', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPgKnowledgeGovernanceReferenceStore({
      client: {
        query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
          queries.push({ sql, values });
          return Promise.resolve({
            rows: [
              {
                content: '规则正文',
                document_id: 'official_docs:feature',
                effective_at: '2026-07-01T00:00:00.000Z',
                heading_path: ['功能', '限制'],
                id: 'chunk-1',
                module: '功能',
                source_type: 'official_docs',
                source_url: 'https://docs.xxyy.io/feature',
                status: 'current',
                title: '功能限制',
              },
            ] as T[],
          });
        },
      },
    });

    const references = await store.getByIds(['chunk-1', 'chunk-1', '  ']);

    expect(references[0]).toMatchObject({
      content: '规则正文',
      effectiveAt: '2026-07-01T00:00:00.000Z',
      id: 'chunk-1',
      sourceType: 'official_docs',
    });
    expect(queries[0]?.values).toEqual([['chunk-1']]);
    expect(queries[0]?.sql).not.toContain('embedding');
    expect(queries[0]?.sql).toContain('array_position');
  });
});
