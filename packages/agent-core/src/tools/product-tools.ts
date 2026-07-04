import { z } from 'zod';

import type {
  ChatResponse,
  ChatStreamEvent,
  Citation,
  Classification,
  RagIndex,
} from '@xxyy/shared';
import {
  classifyQuestion,
  createBoundaryAnswer,
  createLocalRetriever,
  loadRagConfig,
  type AnswerProvider,
  type RagConfig,
  type RetrievedChunk,
  type Retriever,
} from '@xxyy/rag-core';

import type { ToolDefinition } from '../tool-registry.js';

export const PRODUCT_TOOL_NAMES = ['search_product_docs', 'answer_product_question'] as const;

export type ProductToolName = (typeof PRODUCT_TOOL_NAMES)[number];

export interface CreateProductToolsOptions {
  answerProvider?: AnswerProvider;
  config?: Partial<RagConfig>;
  index?: RagIndex;
  retriever?: Retriever;
}

const productToolPolicy = {
  requiresOpsAuth: false,
};

const MAX_TOP_K = 20;
const DEFAULT_TOP_K = 6;
const MAX_CITATIONS = 3;
const MAX_EXCERPT_LENGTH = 220;

const nonEmptyStringSchema = z.string().trim().min(1);
const productChannelSchema = z.enum(['cli', 'web', 'telegram', 'agent']);

const citationSchema = z.object({
  excerpt: z.string(),
  file: z.string(),
  sourceUrl: z.string().optional(),
  title: z.string(),
});

const retrievedChunkSchema = z.object({
  documentId: z.string(),
  id: z.string(),
  lexicalScore: z.number(),
  metadata: z
    .object({
      file: z.string(),
      headingPath: z.array(z.string()),
      module: z.string(),
      order: z.number().optional(),
      retrievedAt: z.string().optional(),
      sourceType: z.enum(['official_docs', 'x_updates']),
      sourceUrl: z.string().optional(),
      title: z.string(),
    })
    .passthrough(),
  rank: z.number(),
  score: z.number(),
  sourceBoost: z.number(),
  text: z.string(),
  vectorScore: z.number(),
});

export const searchProductDocsInputSchema = z.object({
  query: nonEmptyStringSchema,
  topK: z.number().int().positive().optional(),
});

export const searchProductDocsOutputSchema = z.object({
  chunks: z.array(retrievedChunkSchema),
  citations: z.array(citationSchema),
  confidence: z.number(),
});

export const answerProductQuestionInputSchema = z.object({
  channel: productChannelSchema.optional(),
  question: nonEmptyStringSchema,
});

export const answerProductQuestionOutputSchema = z.object({
  answer: z.string(),
  attachments: z.array(z.unknown()).optional(),
  citations: z.array(citationSchema),
  confidence: z.number(),
  intent: z.enum([
    'product_qa',
    'how_to',
    'realtime_account_query',
    'investment_advice',
    'unknown',
  ]),
});

type SearchProductDocsToolDefinition = ToolDefinition<
  'search_product_docs',
  typeof searchProductDocsInputSchema,
  typeof searchProductDocsOutputSchema
>;

type AnswerProductQuestionToolDefinition = ToolDefinition<
  'answer_product_question',
  typeof answerProductQuestionInputSchema,
  typeof answerProductQuestionOutputSchema
>;

export function createProductTools(
  options: CreateProductToolsOptions,
): ToolDefinition<ProductToolName>[] {
  const config = {
    ...loadRagConfig(),
    ...options.config,
  };
  const retriever = createConfiguredRetriever(options);

  const searchProductDocsTool: SearchProductDocsToolDefinition = {
    name: 'search_product_docs',
    description: 'Search XXYY product documentation and return matching chunks with citations.',
    inputSchema: searchProductDocsInputSchema,
    outputSchema: searchProductDocsOutputSchema,
    policy: productToolPolicy,
    async execute(input) {
      const chunks = await retriever.retrieve(input.query, {
        topK: normalizeTopK(input.topK ?? config.topK),
      });
      return toSearchProductDocsOutput(chunks);
    },
  };

  const answerProductQuestionTool: AnswerProductQuestionToolDefinition = {
    name: 'answer_product_question',
    description: 'Answer an XXYY product support question using retrieved product documentation.',
    inputSchema: answerProductQuestionInputSchema,
    outputSchema: answerProductQuestionOutputSchema,
    policy: productToolPolicy,
    async execute(input) {
      const classification = classificationForPlannerSelectedProductQuestion(input.question);
      if (!shouldRetrieveForPlannerSelectedProductQuestion(classification)) {
        return createBoundaryAnswer(classification);
      }
      if (options.answerProvider === undefined) {
        throw new Error('answer_product_question requires an answerProvider.');
      }

      const retrievedChunks = await retriever.retrieve(input.question, {
        topK: normalizeTopK(config.topK),
      });
      return options.answerProvider.answer({
        classification,
        question: input.question,
        retrievedChunks,
      });
    },
    async *stream(input) {
      const classification = classificationForPlannerSelectedProductQuestion(input.question);
      if (!shouldRetrieveForPlannerSelectedProductQuestion(classification)) {
        yield* streamChatResponse(createBoundaryAnswer(classification));
        return;
      }
      if (options.answerProvider === undefined) {
        throw new Error('answer_product_question requires an answerProvider.');
      }

      const retrievedChunks = await retriever.retrieve(input.question, {
        topK: normalizeTopK(config.topK),
      });
      const answerInput = {
        classification,
        question: input.question,
        retrievedChunks,
      };
      if (options.answerProvider.stream !== undefined) {
        yield* options.answerProvider.stream(answerInput);
        return;
      }

      yield* streamChatResponse(await options.answerProvider.answer(answerInput));
    },
  };

  return [searchProductDocsTool, answerProductQuestionTool];
}

function classificationForPlannerSelectedProductQuestion(question: string): Classification {
  const classification = classifyQuestion(question);
  if (classification.intent === 'product_qa' || classification.intent === 'how_to') {
    return classification;
  }

  if (!canPlannerSafelyOverrideProductClassification(classification)) {
    return classification;
  }

  return {
    confidence: 0.7,
    intent: 'product_qa',
    reason: 'planner selected product answer tool',
  };
}

function shouldRetrieveForPlannerSelectedProductQuestion(classification: Classification): boolean {
  return classification.intent === 'product_qa' || classification.intent === 'how_to';
}

function canPlannerSafelyOverrideProductClassification(classification: Classification): boolean {
  return (
    classification.intent === 'unknown' &&
    classification.reason === 'no deterministic product support intent matched'
  );
}

function createConfiguredRetriever(options: CreateProductToolsOptions): Retriever {
  if (options.retriever !== undefined) {
    return options.retriever;
  }

  if (options.index !== undefined) {
    return createLocalRetriever(options.index);
  }

  throw new Error('createProductTools requires either index or retriever.');
}

function toSearchProductDocsOutput(
  chunks: RetrievedChunk[],
): z.input<typeof searchProductDocsOutputSchema> {
  return {
    chunks: chunks.map(toOutputChunk),
    citations: chunks.slice(0, MAX_CITATIONS).map(toCitation),
    confidence: chunks[0]?.score ?? 0,
  };
}

function toOutputChunk(chunk: RetrievedChunk): z.input<typeof retrievedChunkSchema> {
  return {
    documentId: chunk.documentId,
    id: chunk.id,
    lexicalScore: chunk.lexicalScore,
    metadata: {
      ...chunk.metadata,
    },
    rank: chunk.rank,
    score: chunk.score,
    sourceBoost: chunk.sourceBoost,
    text: chunk.text,
    vectorScore: chunk.vectorScore,
  };
}

function toCitation(chunk: RetrievedChunk): Citation {
  return {
    excerpt: createExcerpt(chunk.text),
    file: normalizeCitationFile(chunk.metadata.file),
    ...(chunk.metadata.sourceUrl === undefined ? {} : { sourceUrl: chunk.metadata.sourceUrl }),
    title: chunk.metadata.title,
  };
}

function normalizeTopK(topK: number): number {
  if (!Number.isInteger(topK) || topK <= 0) {
    return DEFAULT_TOP_K;
  }

  return Math.min(topK, MAX_TOP_K);
}

function normalizeCitationFile(file: string): string {
  const normalized = file.replaceAll('\\', '/');
  const docsIndex = normalized.indexOf('/docs/');
  if (docsIndex >= 0) {
    return normalized.slice(docsIndex + 1);
  }

  return normalized.replace(/^\/+/u, '');
}

function createExcerpt(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  if (compact.length <= MAX_EXCERPT_LENGTH) {
    return compact;
  }

  return `${compact.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

function streamChatResponse(response: ChatResponse): AsyncIterable<ChatStreamEvent> {
  return toAsyncIterable([
    ...(response.answer.length > 0
      ? [{ type: 'answer_delta' as const, delta: response.answer }]
      : []),
    {
      type: 'metadata',
      ...(response.attachments === undefined ? {} : { attachments: response.attachments }),
      citations: response.citations,
      confidence: response.confidence,
      intent: response.intent,
      ...(response.tokenUsage === undefined ? {} : { tokenUsage: response.tokenUsage }),
    },
  ]);
}

async function* toAsyncIterable<T>(items: Iterable<T>): AsyncIterable<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

export type AnswerProductQuestionToolOutput = ChatResponse;
