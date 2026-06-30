import { Annotation } from '@langchain/langgraph';

import type { AgentRoute, ChatRequest, ChatResponse } from '@xxyy/shared';

export const AGENT_MAX_STEPS_DEFAULT = 4;

export const ALLOWED_AGENT_TOOL_NAMES = ['answer_product_question'] as const;

export type AllowedAgentToolName = (typeof ALLOWED_AGENT_TOOL_NAMES)[number];

export type AgentMessage = {
  role: 'assistant' | 'system' | 'tool' | 'user';
  content: string;
};

export type PlannerRoute = 'boundary' | 'clarify' | 'product_answer' | 'unsupported';

export type FinalPlannerRoute = 'boundary' | 'clarify' | 'unsupported';

export type AgentPlan =
  | {
      kind: 'tool';
      reason: string;
      route: PlannerRoute;
      toolName: AllowedAgentToolName;
      input: unknown;
    }
  | {
      kind: 'final';
      reason: string;
      route: FinalPlannerRoute;
      response: ChatResponse;
    };

export type AgentToolCallRecord = {
  input: unknown;
  step: number;
  toolName: string;
};

export type AgentToolResultRecord = {
  output: unknown;
  step: number;
  toolName: string;
};

export type AgentEvidence = {
  kind: 'chat_response';
  response: ChatResponse;
  toolName: string;
};

export type AgentPolicyDecision =
  | {
      action: 'continue';
    }
  | {
      action: 'final';
      response: ChatResponse;
    };

export type AgentState = {
  currentStep: number;
  errors: string[];
  evidence: AgentEvidence[];
  finalResponse?: ChatResponse;
  maxSteps: number;
  messages: AgentMessage[];
  plan?: AgentPlan;
  policyDecision?: AgentPolicyDecision;
  request: ChatRequest;
  route?: AgentRoute;
  toolCalls: AgentToolCallRecord[];
  toolResults: AgentToolResultRecord[];
};

export const AgentStateAnnotation = Annotation.Root({
  currentStep: Annotation<number>({
    default: () => 0,
    reducer: (_left, right) => right,
  }),
  errors: Annotation<string[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  evidence: Annotation<AgentEvidence[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  finalResponse: Annotation<ChatResponse | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  maxSteps: Annotation<number>({
    default: () => AGENT_MAX_STEPS_DEFAULT,
    reducer: (_left, right) => right,
  }),
  messages: Annotation<AgentMessage[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  plan: Annotation<AgentPlan | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  policyDecision: Annotation<AgentPolicyDecision | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  request: Annotation<ChatRequest>({
    reducer: (_left, right) => right,
  }),
  route: Annotation<AgentRoute | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  toolCalls: Annotation<AgentToolCallRecord[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  toolResults: Annotation<AgentToolResultRecord[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
});

export function createInitialAgentState(
  request: ChatRequest,
  options: { maxSteps?: number } = {},
): AgentState {
  return {
    currentStep: 0,
    errors: [],
    evidence: [],
    maxSteps: options.maxSteps ?? AGENT_MAX_STEPS_DEFAULT,
    messages: [{ role: 'user', content: request.message }],
    request,
    toolCalls: [],
    toolResults: [],
  };
}

export function isAllowedAgentToolName(name: string): name is AllowedAgentToolName {
  return ALLOWED_AGENT_TOOL_NAMES.includes(name as AllowedAgentToolName);
}

export function normalizeAgentRoute(route: PlannerRoute): AgentRoute {
  if (route === 'unsupported') {
    return 'clarify';
  }
  return route;
}
