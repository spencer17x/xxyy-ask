export const supportedChannels = ['cli', 'web', 'telegram'] as const;

export const workspacePackageName = '@xxyy/shared';

export type ChatChannel = (typeof supportedChannels)[number];

export const supportedIntents = [
  'product_qa',
  'how_to',
  'realtime_account_query',
  'mev_or_chain_forensics',
  'investment_advice',
  'unknown',
] as const;

export type Intent = (typeof supportedIntents)[number];

export type SourceType = 'official_docs' | 'x_updates';

export interface ChatRequest {
  message: string;
  channel: ChatChannel;
  sessionId?: string;
  userId?: string;
}

export interface Citation {
  title: string;
  file: string;
  excerpt: string;
  sourceUrl?: string;
}

export interface ChatResponse {
  answer: string;
  intent: Intent;
  citations: Citation[];
  confidence: number;
}

export interface SourceDocument {
  id: string;
  title: string;
  module: string;
  sourceType: SourceType;
  file: string;
  content: string;
  sourceUrl?: string;
  order?: number;
  retrievedAt?: string;
}

export interface ChunkMetadata {
  title: string;
  module: string;
  sourceType: SourceType;
  file: string;
  headingPath: string[];
  sourceUrl?: string;
  order?: number;
  retrievedAt?: string;
}

export interface RagChunk {
  id: string;
  documentId: string;
  text: string;
  metadata: ChunkMetadata;
}

export interface IndexEntry extends RagChunk {
  tokens: string[];
  embedding: number[];
}

export interface RagIndex {
  version: 1;
  builtAt: string;
  entries: IndexEntry[];
}

export interface Classification {
  intent: Intent;
  confidence: number;
  reason: string;
}
