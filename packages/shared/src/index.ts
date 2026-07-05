import { z } from 'zod';

export const supportedChannels = ['cli', 'web', 'telegram'] as const;

export const workspacePackageName = '@xxyy/shared';

export type ChatChannel = (typeof supportedChannels)[number];

export const supportedIntents = [
  'product_qa',
  'how_to',
  'realtime_account_query',
  'investment_advice',
  'unknown',
] as const;

export type Intent = (typeof supportedIntents)[number];

export const supportedAgentRoutes = ['boundary', 'clarify', 'product_answer'] as const;

export type AgentRoute = (typeof supportedAgentRoutes)[number];

export type SourceType = 'official_docs' | 'x_updates';
export type KnowledgeStatus = 'current' | 'historical' | 'deprecated';

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

export type ChatAttachment =
  | {
      kind: 'video';
      title: string;
      url: string;
      mediaType: 'video/mp4';
    }
  | {
      kind: 'image';
      title: string;
      url: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
    };

export interface ChatResponse {
  answer: string;
  intent: Intent;
  citations: Citation[];
  confidence: number;
  agentRoute?: AgentRoute;
  attachments?: ChatAttachment[];
  tokenUsage?: ChatTokenUsage;
}

export interface ChatTokenUsage {
  completionTokens?: number;
  promptTokens?: number;
  totalTokens: number;
}

export const citationSchema = z.object({
  excerpt: z.string(),
  file: z.string(),
  sourceUrl: z.string().optional(),
  title: z.string(),
});

export const chatAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('video'),
    mediaType: z.literal('video/mp4'),
    title: z.string(),
    url: z.string(),
  }),
  z.object({
    kind: z.literal('image'),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
    title: z.string(),
    url: z.string(),
  }),
]);

export const chatTokenUsageSchema = z.object({
  completionTokens: z.number().int().nonnegative().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
});

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('answer_delta'),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('metadata'),
    agentRoute: z.enum(supportedAgentRoutes).optional(),
    attachments: z.array(chatAttachmentSchema).optional(),
    citations: z.array(citationSchema),
    confidence: z.number(),
    intent: z.enum(supportedIntents),
    tokenUsage: chatTokenUsageSchema.optional(),
  }),
]);

export type ChatStreamEvent =
  | {
      type: 'answer_delta';
      delta: string;
    }
  | {
      type: 'metadata';
      intent: Intent;
      citations: Citation[];
      confidence: number;
      agentRoute?: AgentRoute;
      attachments?: ChatAttachment[];
      tokenUsage?: ChatTokenUsage;
    };

export interface SourceDocument {
  id: string;
  title: string;
  module: string;
  sourceType: SourceType;
  file: string;
  content: string;
  effectiveAt?: string;
  sourceUrl?: string;
  order?: number;
  retrievedAt?: string;
  status?: KnowledgeStatus;
  supersedes?: string[];
}

export interface ChunkMetadata {
  title: string;
  module: string;
  sourceType: SourceType;
  file: string;
  headingPath: string[];
  sourceUrl?: string;
  order?: number;
  effectiveAt?: string;
  retrievedAt?: string;
  status?: KnowledgeStatus;
  supersedes?: string[];
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
