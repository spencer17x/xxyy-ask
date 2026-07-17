import { z } from 'zod';

import type { ChatResponse } from '@xxyy/shared';

import type { ToolDefinition } from '../tool-registry.js';

export const AGENT_TOOL_NAMES = ['describe_agent_capabilities'] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

const agentCapabilitiesInputSchema = z.object({}).strict();

const agentCapabilitiesOutputSchema = z.object({
  agentRoute: z.literal('agent_answer'),
  answer: z.string(),
  citations: z.array(z.never()),
  confidence: z.number(),
  intent: z.literal('agent_capabilities'),
});

const capabilityFacts = [
  '回答 XXYY 产品功能、Pro 权益和官方更新相关问题',
  '提供产品配置与操作步骤，例如交易设置、钱包监控和 Telegram 配置',
  '基于产品文档、官方 X 更新和管理员审核知识回答，并提供来源引用',
  '区分当前规则与历史更新，默认采用最新有效规则，也可以说明历史变更',
  '知识不足时明确说明或请求补充信息，不编造实时数据',
] as const;

const boundaryFacts = [
  '查询账户、订单、余额或私有交易记录',
  '代用户执行账户或交易操作',
  '分析交易哈希、链上取证或 MEV',
  '提供投资建议、喊单或收益承诺',
] as const;

export function createAgentTools(): ToolDefinition<AgentToolName>[] {
  return [
    {
      name: 'describe_agent_capabilities',
      description:
        'Describe the current customer-support Agent itself: its responsibilities, available actions, knowledge sources, operating scope, and limitations. Use it for broad or hypothetical assessments of the assistant support role; no product module or concrete support case is required. Do not use it when the grammatical subject is the XXYY product or one of its modules.',
      inputSchema: agentCapabilitiesInputSchema,
      outputSchema: agentCapabilitiesOutputSchema,
      execute() {
        return createAgentCapabilitiesResponse();
      },
    },
  ];
}

function createAgentCapabilitiesResponse(): ChatResponse {
  return {
    agentRoute: 'agent_answer',
    answer: [
      '我是 XXYY 产品客服 Agent。目前我可以：',
      '',
      ...capabilityFacts.map((fact, index) => `${index + 1}. ${fact}。`),
      '',
      `我不能${boundaryFacts.join('、')}。`,
    ].join('\n'),
    citations: [],
    confidence: 0.98,
    intent: 'agent_capabilities',
  };
}
