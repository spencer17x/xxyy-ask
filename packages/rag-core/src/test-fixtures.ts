import { createLocalHashEmbedding, tokenize } from '@xxyy/knowledge';
import type { IndexEntry, RagIndex, SourceType } from '@xxyy/shared';

interface FixtureEntryInput {
  id: string;
  title: string;
  text: string;
  sourceType: SourceType;
  file?: string;
  module?: string;
  sourceUrl?: string;
  headingPath?: string[];
}

export function createFixtureIndex(entries: FixtureEntryInput[]): RagIndex {
  return {
    version: 1,
    builtAt: '1970-01-01T00:00:00.000Z',
    entries: entries.map(createFixtureEntry),
  };
}

function createFixtureEntry(input: FixtureEntryInput): IndexEntry {
  const file = input.file ?? `/fixtures/${input.id}.md`;
  const headingPath = input.headingPath ?? [input.title];
  const searchableText = [input.title, 'XXYY', ...headingPath, input.text].join('\n');

  const base: IndexEntry = {
    id: input.id,
    documentId: input.id.replace(/:chunk:\d+$/u, ''),
    text: input.text,
    metadata: {
      title: input.title,
      module: input.module ?? 'XXYY',
      sourceType: input.sourceType,
      file,
      headingPath,
    },
    tokens: tokenize(searchableText),
    embedding: createLocalHashEmbedding(searchableText),
  };

  if (input.sourceUrl !== undefined) {
    return {
      ...base,
      metadata: {
        ...base.metadata,
        sourceUrl: input.sourceUrl,
      },
    };
  }

  return base;
}
