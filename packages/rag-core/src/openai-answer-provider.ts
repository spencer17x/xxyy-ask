import type { ChatResponse } from '@xxyy/shared';

import { createBoundaryAnswer, createCitationsFromChunks } from './answer.js';
import type { AnswerProvider, AnswerProviderInput } from './answer-provider.js';

export interface OpenAiAnswerProviderOptions {
  apiKey: string | undefined;
  model: string | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const GROUNDED_INTENTS = new Set(['product_qa', 'how_to']);
const MAX_CONTEXT_CHARS = 4000;

export class LlmConfigurationError extends Error {}

export function createOpenAiAnswerProvider(options: OpenAiAnswerProviderOptions): AnswerProvider {
  if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
    throw new LlmConfigurationError('OPENAI_API_KEY is required for LLM answer generation.');
  }
  if (options.model === undefined || options.model.trim().length === 0) {
    throw new LlmConfigurationError('OPENAI_MODEL is required for LLM answer generation.');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey;
  const model = options.model;
  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`;

  return {
    async answer(input: AnswerProviderInput): Promise<ChatResponse> {
      if (!GROUNDED_INTENTS.has(input.classification.intent)) {
        return createBoundaryAnswer(input.classification);
      }

      if (input.retrievedChunks.length === 0) {
        return {
          answer: `当前知识库没有找到与「${input.question}」直接相关的资料。为了避免误导，我不能编造产品细节。`,
          citations: [],
          confidence: 0.25,
          intent: input.classification.intent,
        };
      }

      const citations = createCitationsFromChunks(input.retrievedChunks);
      const response = await fetchImpl(endpoint, {
        body: JSON.stringify({
          messages: [
            {
              content: systemPrompt(),
              role: 'system',
            },
            {
              content: userPrompt(input, citations.length),
              role: 'user',
            },
          ],
          model,
          temperature: 0.2,
        }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`LLM request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const answer = payload.choices?.[0]?.message?.content?.trim();
      if (answer === undefined || answer.length === 0) {
        throw new Error('LLM response did not include an answer.');
      }

      return {
        answer,
        citations,
        confidence: calculateLlmConfidence(input.classification.confidence),
        intent: input.classification.intent,
      };
    },
  };
}

function systemPrompt(): string {
  return [
    '你是 XXYY 产品客服智能问答助手。',
    '只能基于提供的知识库片段回答，不要编造产品能力、实时账户数据、链上结论或投资建议。',
    '如果资料不足，直接说明当前知识库没有明确说明。',
    '回答使用简洁中文。操作类问题优先给步骤。',
    '不要在正文中伪造来源编号；来源由系统单独返回。',
  ].join('\n');
}

function userPrompt(input: AnswerProviderInput, citationCount: number): string {
  return [
    `用户问题：${input.question}`,
    `分类：${input.classification.intent}`,
    `可用来源数量：${citationCount}`,
    '',
    '知识库片段：',
    createContext(input),
  ].join('\n');
}

function createContext(input: AnswerProviderInput): string {
  const chunks = input.retrievedChunks.map((chunk, index) =>
    [
      `[${index + 1}] ${chunk.metadata.title}`,
      `文件：${chunk.metadata.file}`,
      chunk.metadata.sourceUrl === undefined ? undefined : `URL：${chunk.metadata.sourceUrl}`,
      `内容：${chunk.text}`,
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  );

  return truncateContext(chunks.join('\n\n'));
}

function truncateContext(context: string): string {
  if (context.length <= MAX_CONTEXT_CHARS) {
    return context;
  }

  return `${context.slice(0, MAX_CONTEXT_CHARS)}\n[内容已截断]`;
}

function calculateLlmConfidence(classificationConfidence: number): number {
  return Number(Math.min(0.92, Math.max(0.55, classificationConfidence)).toFixed(2));
}
