import type { PgClientLike } from './pgvector-store.js';

export interface KnowledgeConflictReference {
  content: string;
  documentId: string;
  headingPath: string[];
  id: string;
  module: string;
  sourceType: 'admin_verified' | 'official_docs' | 'x_updates';
  status: 'current' | 'deprecated' | 'historical';
  title: string;
  effectiveAt?: string;
  sourceUrl?: string;
}

export interface KnowledgeGovernanceReferenceStore {
  getByIds(ids: readonly string[]): Promise<KnowledgeConflictReference[]>;
}

interface KnowledgeConflictReferenceRow {
  content: string;
  document_id: string;
  effective_at: string | null;
  heading_path: string[];
  id: string;
  module: string;
  source_type: KnowledgeConflictReference['sourceType'];
  source_url: string | null;
  status: KnowledgeConflictReference['status'];
  title: string;
}

export function createPgKnowledgeGovernanceReferenceStore(options: {
  client: PgClientLike;
}): KnowledgeGovernanceReferenceStore {
  return {
    async getByIds(rawIds): Promise<KnowledgeConflictReference[]> {
      const ids = normalizeIds(rawIds);
      if (ids.length === 0) {
        return [];
      }
      const response = await options.client.query<KnowledgeConflictReferenceRow>(
        `
        select
          id,
          document_id,
          title,
          module,
          source_type,
          source_url,
          heading_path,
          effective_at::text as effective_at,
          status,
          content
        from knowledge_chunks
        where id = any($1::text[])
        order by array_position($1::text[], id)
        `,
        [ids],
      );
      return response.rows.map((row) => ({
        content: row.content,
        documentId: row.document_id,
        headingPath: row.heading_path,
        id: row.id,
        module: row.module,
        sourceType: row.source_type,
        status: row.status,
        title: row.title,
        ...(row.effective_at === null ? {} : { effectiveAt: row.effective_at }),
        ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
      }));
    },
  };
}

function normalizeIds(rawIds: readonly string[]): string[] {
  return [...new Set(rawIds.map((id) => id.trim()).filter((id) => id.length > 0))].slice(0, 100);
}
