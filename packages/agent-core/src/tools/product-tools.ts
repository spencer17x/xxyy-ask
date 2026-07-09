import { z } from 'zod';

import type { ChatResponse, ChatStreamEvent, Classification, RagIndex } from '@xxyy/shared';
import {
  classifyQuestion,
  createAttachmentsFromChunks,
  createBoundaryAnswer,
  createCitationsFromChunks,
  createLocalRetriever,
  createMetadataReranker,
  createRerankingRetriever,
  selectGroundingChunks,
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
const RERANK_CANDIDATE_MULTIPLIER = 4;

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
  question: nonEmptyStringSchema.optional(),
  query: nonEmptyStringSchema,
  topK: z.number().int().positive().optional(),
});

export const searchProductDocsOutputSchema = z.object({
  attachments: z.array(z.unknown()).optional(),
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
      return toSearchProductDocsOutput(input.question ?? input.query, chunks);
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
  let retriever: Retriever;
  if (options.retriever !== undefined) {
    retriever = options.retriever;
  } else if (options.index !== undefined) {
    retriever = createLocalRetriever(options.index);
  } else {
    throw new Error('createProductTools requires either index or retriever.');
  }

  return createRerankingRetriever(retriever, createMetadataReranker(), {
    candidateMultiplier: RERANK_CANDIDATE_MULTIPLIER,
  });
}

function toSearchProductDocsOutput(
  query: string,
  chunks: RetrievedChunk[],
): z.input<typeof searchProductDocsOutputSchema> {
  const citationChunks = selectGroundingChunks(query, chunks);
  const attachments = createAttachmentsFromChunks(citationChunks);
  return {
    ...(attachments.length === 0 ? {} : { attachments }),
    chunks: chunks.map(toOutputChunk),
    citations: createCitationsFromChunks(citationChunks),
    confidence: citationChunks[0]?.score ?? chunks[0]?.score ?? 0,
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

function normalizeTopK(topK: number): number {
  if (!Number.isInteger(topK) || topK <= 0) {
    return DEFAULT_TOP_K;
  }

  return Math.min(topK, MAX_TOP_K);
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
