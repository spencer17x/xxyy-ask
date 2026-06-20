import { z } from 'zod';

import type { ChatRequest } from '@xxyy/shared';

import { ALLOWED_AGENT_TOOL_NAMES, type AgentPlan, type PlannerRoute } from './langgraph-state.js';

export interface PlannerToolDescriptor {
  name: string;
  description: string;
}

export interface PlannerModelInput {
  request: ChatRequest;
  stateSummary: string;
  tools: PlannerToolDescriptor[];
}

export interface PlannerModel {
  plan(input: PlannerModelInput): Promise<AgentPlan>;
}

export interface OpenAiCompatiblePlannerModelOptions {
  apiKey: string | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  model: string | undefined;
  requestTimeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

const plannerRoutes = [
  'boundary',
  'clarify',
  'product_answer',
  'transaction_analysis',
  'unsupported',
] as const satisfies readonly PlannerRoute[];

const plannerRouteSchema = z.enum(plannerRoutes);
const allowedToolNameSchema = z.enum(ALLOWED_AGENT_TOOL_NAMES);

const citationSchema = z.object({
  title: z.string(),
  file: z.string(),
  excerpt: z.string(),
  sourceUrl: z.string().optional(),
});

const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('video'),
    title: z.string(),
    url: z.string(),
    mediaType: z.literal('video/mp4'),
  }),
  z.object({
    kind: z.literal('image'),
    title: z.string(),
    url: z.string(),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  }),
]);

const chatResponseSchema = z.object({
  agentRoute: z
    .enum(['boundary', 'clarify', 'preference_capture', 'product_answer', 'transaction_analysis'])
    .optional(),
  answer: z.string(),
  attachments: z.array(attachmentSchema).optional(),
  citations: z.array(citationSchema).default([]),
  confidence: z.number(),
  intent: z.enum([
    'product_qa',
    'how_to',
    'tx_sandwich_detection',
    'realtime_account_query',
    'mev_or_chain_forensics',
    'investment_advice',
    'unknown',
  ]),
  tokenUsage: z
    .object({
      completionTokens: z.number().optional(),
      promptTokens: z.number().optional(),
      totalTokens: z.number(),
    })
    .optional(),
});

const plannerToolPlanSchema = z.object({
  input: z.unknown(),
  kind: z.literal('tool'),
  reason: z.string().trim().min(1),
  route: plannerRouteSchema,
  toolName: allowedToolNameSchema,
});

const plannerFinalPlanSchema = z.object({
  kind: z.literal('final'),
  reason: z.string().trim().min(1),
  response: chatResponseSchema,
  route: plannerRouteSchema,
});

const plannerPlanSchema = z.discriminatedUnion('kind', [
  plannerToolPlanSchema,
  plannerFinalPlanSchema,
]);

export class PlannerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerConfigurationError';
  }
}

export class PlannerModelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerModelParseError';
  }
}

export class PlannerModelRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerModelRequestError';
  }
}

export function createScriptedPlannerModel(plans: AgentPlan[]): PlannerModel {
  const remaining = [...plans];
  return {
    plan() {
      const next = remaining.shift();
      if (next === undefined) {
        return Promise.reject(
          new PlannerModelParseError('Scripted planner did not have another plan.'),
        );
      }
      return Promise.resolve(next);
    },
  };
}

export function createOpenAiCompatiblePlannerModel(
  options: OpenAiCompatiblePlannerModelOptions,
): PlannerModel {
  if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
    throw new PlannerConfigurationError('OPENAI_API_KEY is required for agent planning.');
  }
  if (options.model === undefined || options.model.trim().length === 0) {
    throw new PlannerConfigurationError('OPENAI_MODEL is required for agent planning.');
  }

  const apiKey = options.apiKey;
  const model = options.model;
  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    async plan(input) {
      const response = await fetchWithTimeout(fetchImpl, endpoint, {
        apiKey,
        body: createPlannerRequestBody(model, input),
        requestTimeoutMs,
      });
      const payload = await parseChatCompletionResponse(response);
      const content = payload.choices?.[0]?.message?.content;
      if (content === undefined) {
        throw new PlannerModelParseError('Planner response did not include message content.');
      }
      return parsePlannerContent(content);
    },
  };
}

function createPlannerRequestBody(
  model: string,
  input: PlannerModelInput,
): Record<string, unknown> {
  return {
    messages: [
      {
        role: 'system',
        content: [
          'You are the XXYY customer support agent planner.',
          'Return only a JSON object matching one of these shapes:',
          '{"kind":"tool","route":"product_answer|transaction_analysis|boundary|clarify|unsupported","toolName":"answer_product_question|analyze_transaction|boundary_reply|clarify_request","input":{},"reason":"..."}',
          '{"kind":"final","route":"boundary|clarify|unsupported","response":{"answer":"...","intent":"unknown","citations":[],"confidence":0.3},"reason":"..."}',
          'Never request account, order, wallet, balance, private transaction, or investment-advice tools.',
          'Use product tools for XXYY product questions.',
          'Use transaction analysis only for a single concrete transaction hash or supported explorer link.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          request: input.request,
          stateSummary: input.stateSummary,
          tools: input.tools,
        }),
      },
    ],
    model,
    response_format: { type: 'json_object' },
    temperature: 0,
  };
}

async function parseChatCompletionResponse(response: Response): Promise<ChatCompletionResponse> {
  try {
    return (await response.json()) as ChatCompletionResponse;
  } catch (error) {
    throw new PlannerModelParseError(`Planner response was not valid JSON: ${String(error)}`);
  }
}

function parsePlannerContent(content: string): AgentPlan {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonFence(content));
  } catch (error) {
    throw new PlannerModelParseError(`Planner returned invalid JSON: ${String(error)}`);
  }

  const parsed = plannerPlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new PlannerModelParseError(parsed.error.message);
  }

  return parsed.data as AgentPlan;
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?/iu, '')
    .replace(/```$/u, '')
    .trim();
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  endpoint: string,
  options: {
    apiKey: string;
    body: Record<string, unknown>;
    requestTimeoutMs: number;
  },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      body: JSON.stringify(options.body),
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PlannerModelRequestError(`Planner request failed with status ${response.status}.`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
