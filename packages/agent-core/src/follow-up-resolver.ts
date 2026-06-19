import type { TxAnalysisChain } from '@xxyy/shared';
import { hasAmbiguousTransactionReferences, parseTransactionReference } from '@xxyy/rag-core';

import type { SessionTurn } from './session-context.js';

export type FollowUpResolution = 'needs_clarification' | 'resolved_followup' | 'unchanged';
export type FollowUpDependency = 'product_topic' | 'transaction_reference';
export type FollowUpClarificationReason = 'ambiguous_reference' | 'missing_context';

export interface ResolveFollowUpInput {
  message: string;
  recentTurns: SessionTurn[];
}

interface RecentTransactionReference {
  chain?: TxAnalysisChain;
  txHash: string;
}

export type ResolveFollowUpOutput =
  | {
      contextSummary?: string;
      resolution: Exclude<FollowUpResolution, 'needs_clarification'>;
      resolvedMessage: string;
    }
  | {
      clarificationQuestion: string;
      clarificationReason: FollowUpClarificationReason;
      dependency: FollowUpDependency;
      resolution: 'needs_clarification';
    };

export function resolveFollowUp(input: ResolveFollowUpInput): ResolveFollowUpOutput {
  const message = input.message.trim();
  if (message.length === 0) {
    return { resolution: 'unchanged', resolvedMessage: input.message };
  }

  if (parseTransactionReference(message) !== undefined) {
    return { resolution: 'unchanged', resolvedMessage: input.message };
  }

  const dependency = detectFollowUpDependency(message);

  if (dependency === 'transaction_reference') {
    const transactionReferences = uniqueRecentTransactionReferences(input.recentTurns);
    if (transactionReferences.length === 1) {
      const transactionReference = transactionReferences[0];
      if (transactionReference === undefined) {
        return { resolution: 'unchanged', resolvedMessage: input.message };
      }
      return {
        contextSummary: 'resolved transaction follow-up from one recent transaction',
        resolution: 'resolved_followup',
        resolvedMessage: `${formatRecentTransactionReference(transactionReference)} ${message}`,
      };
    }
    if (transactionReferences.length > 1) {
      return {
        clarificationQuestion: '你想分析哪一笔交易？请发送单笔完整交易哈希或对应主网浏览器链接。',
        clarificationReason: 'ambiguous_reference',
        dependency,
        resolution: 'needs_clarification',
      };
    }
    return {
      clarificationQuestion:
        '我还不能确定“这笔”指哪一笔交易。请发送单笔完整交易哈希或对应主网浏览器链接。',
      clarificationReason: 'missing_context',
      dependency,
      resolution: 'needs_clarification',
    };
  }

  if (dependency === 'product_topic') {
    if (isMembershipPlanComparisonFollowUp(message)) {
      const membershipPlanFollowUp = resolveMembershipPlanFollowUp(message, input.recentTurns);
      if (membershipPlanFollowUp !== undefined) {
        return membershipPlanFollowUp;
      }
      return {
        clarificationQuestion:
          '我还不能确定你想继续咨询哪个具体功能。请补充具体功能、权益或配置步骤，例如“XXYY Pro 怎么升级？”。',
        clarificationReason: 'missing_context',
        dependency,
        resolution: 'needs_clarification',
      };
    }

    const topic = inferRecentProductTopic(input.recentTurns);
    if (topic !== undefined) {
      return {
        contextSummary: 'resolved product follow-up from previous product turn',
        resolution: 'resolved_followup',
        resolvedMessage: `${topic} ${message}`,
      };
    }
    const preference = inferRecentProductPreference(input.recentTurns);
    if (preference !== undefined) {
      return {
        contextSummary: 'resolved product follow-up from recent product preference',
        resolution: 'resolved_followup',
        resolvedMessage: `${preference} ${message}`,
      };
    }
    return {
      clarificationQuestion:
        '我还不能确定你想继续咨询哪个具体功能。请补充具体功能、权益或配置步骤，例如“XXYY Pro 怎么升级？”。',
      clarificationReason: 'missing_context',
      dependency,
      resolution: 'needs_clarification',
    };
  }

  return { resolution: 'unchanged', resolvedMessage: input.message };
}

export function detectFollowUpDependency(message: string): FollowUpDependency | undefined {
  const normalized = message.trim();
  if (
    normalized.length === 0 ||
    parseTransactionReference(normalized) !== undefined ||
    hasAmbiguousTransactionReferences(normalized)
  ) {
    return undefined;
  }

  if (isTransactionFollowUp(normalized)) {
    return 'transaction_reference';
  }

  if (isShortProductFollowUp(normalized)) {
    return 'product_topic';
  }

  return undefined;
}

function uniqueRecentTransactionReferences(turns: SessionTurn[]): RecentTransactionReference[] {
  const referencesByHash = new Map<string, RecentTransactionReference[]>();
  for (const turn of turns) {
    const txHash = turn.metadata?.txHash;
    if (txHash === undefined) {
      continue;
    }

    const chain = turn.metadata?.chain;
    const hashKey = normalizeTransactionHashKey(txHash);
    const existingReferences = referencesByHash.get(hashKey) ?? [];
    const reference = {
      ...(chain === undefined ? {} : { chain }),
      txHash,
    };

    if (!existingReferences.some((existing) => transactionReferenceEquals(existing, reference))) {
      referencesByHash.set(hashKey, [...existingReferences, reference]);
    }
  }

  return Array.from(referencesByHash.values()).flatMap((references) => {
    const knownReferences = references.filter(
      (reference) => reference.chain !== undefined && reference.chain !== 'unknown',
    );
    return knownReferences.length > 0 ? knownReferences : references.slice(0, 1);
  });
}

function normalizeTransactionHashKey(txHash: string): string {
  return txHash.startsWith('0x') ? txHash.toLowerCase() : txHash;
}

function transactionReferenceEquals(
  left: RecentTransactionReference,
  right: RecentTransactionReference,
): boolean {
  return (
    normalizeTransactionHashKey(left.txHash) === normalizeTransactionHashKey(right.txHash) &&
    (left.chain ?? 'unknown') === (right.chain ?? 'unknown')
  );
}

function formatRecentTransactionReference(reference: RecentTransactionReference): string {
  if (reference.chain === undefined || reference.chain === 'unknown') {
    return reference.txHash;
  }

  return `${reference.chain} ${reference.txHash}`;
}

function isTransactionFollowUp(message: string): boolean {
  if (/^(这笔|那笔|刚才那笔|上一笔)/u.test(message)) {
    return true;
  }

  if (isDefinitionQuestion(message)) {
    return false;
  }
  return /^(这笔|那笔|刚才那笔|上一笔)|被夹|夹子|sandwich|transaction|tx/iu.test(message);
}

function isDefinitionQuestion(message: string): boolean {
  return (
    /^(什么是|什么叫|介绍|解释|how does|what is|what's|explain)/iu.test(message) ||
    /(是什么|是什么意思|什么意思|什么含义)[？?]?$/iu.test(message)
  );
}

function isShortProductFollowUp(message: string): boolean {
  const normalized = message.normalize('NFKC').trim();
  if (isMembershipPlanComparisonFollowUp(normalized)) {
    return true;
  }
  if (normalized.length > 24 || hasExplicitProductTopic(normalized)) {
    return false;
  }
  return (
    /^(那|这个|那个|它|刚才|刚才那个|上一条)?(怎么|如何|有哪些|可以|支持|升级|配置|设置|导出|导入)/u.test(
      normalized,
    ) ||
    /^(那|这个|那个|它|刚才|刚才那个|上一条)?在?(哪里|哪儿|哪|什么地方)(升级|开通|配置|设置|导出|导入|登录)/u.test(
      normalized,
    ) ||
    /^(那|这个|那个|它|刚才|刚才那个|上一条)?(入口|页面|按钮)在?(哪里|哪儿|哪|什么地方)/u.test(
      normalized,
    )
  );
}

function isMembershipPlanComparisonFollowUp(message: string): boolean {
  return /^(那|那么|这个|那个|刚才那个)?\s*(Basic|Pro|永久\s*Pro|永久\s*PRO)\s*(呢|有哪些|有什么)?[？?]?$/iu.test(
    message,
  );
}

function hasExplicitProductTopic(message: string): boolean {
  return /XXYY|Pro|Telegram|TG|钱包监控|自动交易|Raydium自动卖|开盘狙击|移动端|手机|扫链|打满|趋势|收藏|持仓管理|收益统计|快捷交易|钱包管理|关注钱包/u.test(
    message,
  );
}

function resolveMembershipPlanFollowUp(
  message: string,
  turns: SessionTurn[],
): ResolveFollowUpOutput | undefined {
  const plan = extractMembershipPlan(message);
  if (plan === undefined || !hasRecentMembershipBenefitsContext(turns)) {
    return undefined;
  }

  return {
    contextSummary: 'resolved product follow-up from previous product turn',
    resolution: 'resolved_followup',
    resolvedMessage: `${plan} 有哪些权益？`,
  };
}

function extractMembershipPlan(message: string): string | undefined {
  if (/Basic/iu.test(message)) {
    return 'XXYY Basic';
  }
  if (/永久\s*Pro/iu.test(message)) {
    return 'XXYY 永久 Pro';
  }
  if (/Pro/iu.test(message)) {
    return 'XXYY Pro';
  }
  return undefined;
}

function inferRecentProductPreference(turns: SessionTurn[]): string | undefined {
  for (const turn of [...turns].reverse()) {
    if (turn.role !== 'user' || turn.metadata?.intent === 'tx_sandwich_detection') {
      continue;
    }
    const preference = inferProductPreferenceFromText(turn.content);
    if (preference !== undefined) {
      return preference;
    }
  }
  return undefined;
}

export function inferProductPreferenceFromText(content: string): string | undefined {
  if (hasMobileProductPreference(content)) {
    return 'XXYY 移动端登录';
  }
  if (hasTelegramProductPreference(content)) {
    return 'Telegram 钱包监控';
  }
  return undefined;
}

function hasMobileProductPreference(content: string): boolean {
  return /(?:主要|平时|通常|默认|偏好|习惯|用|使用|入口|版本).*(?:移动端|手机端|手机|mobile|app)|(?:移动端|手机端|mobile|app).*(?:用|使用|入口|版本)/iu.test(
    content,
  );
}

function hasTelegramProductPreference(content: string): boolean {
  return /(?:主要|平时|通常|默认|偏好|习惯|用|使用|入口|通知).*(?:Telegram|TG)|(?:Telegram|TG).*(?:用|使用|入口|通知|机器人|bot)/iu.test(
    content,
  );
}

function hasRecentMembershipBenefitsContext(turns: SessionTurn[]): boolean {
  return [...turns].reverse().some((turn) => {
    if (turn.metadata?.intent !== 'product_qa' && turn.metadata?.intent !== 'how_to') {
      return false;
    }
    return /权益|福利|会员|套餐|版本|计划|plan|benefit|membership/iu.test(turn.content);
  });
}

function inferRecentProductTopic(turns: SessionTurn[]): string | undefined {
  for (const turn of [...turns].reverse()) {
    if (turn.metadata?.intent !== 'product_qa' && turn.metadata?.intent !== 'how_to') {
      continue;
    }
    const content = turn.content;
    if (/XXYY\s*Pro|Pro/u.test(content)) {
      return 'XXYY Pro';
    }
    if (/Telegram|TG|钱包监控/u.test(content)) {
      return 'Telegram 钱包监控';
    }
    if (/自动交易|Raydium自动卖|开盘狙击/u.test(content)) {
      return 'XXYY 自动交易';
    }
    if (/移动端|手机|登录/u.test(content)) {
      return 'XXYY 移动端登录';
    }
  }
  return undefined;
}
