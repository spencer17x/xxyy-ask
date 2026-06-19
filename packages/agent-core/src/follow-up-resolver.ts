import { parseTransactionReference } from '@xxyy/rag-core';

import type { SessionTurn } from './session-context.js';

export type FollowUpResolution = 'needs_clarification' | 'resolved_followup' | 'unchanged';

export interface ResolveFollowUpInput {
  message: string;
  recentTurns: SessionTurn[];
}

export type ResolveFollowUpOutput =
  | {
      contextSummary?: string;
      resolution: Exclude<FollowUpResolution, 'needs_clarification'>;
      resolvedMessage: string;
    }
  | {
      clarificationQuestion: string;
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

  if (isTransactionFollowUp(message)) {
    const transactionHashes = uniqueRecentTransactionHashes(input.recentTurns);
    if (transactionHashes.length === 1) {
      return {
        contextSummary: 'resolved transaction follow-up from one recent transaction',
        resolution: 'resolved_followup',
        resolvedMessage: `${transactionHashes[0]} ${message}`,
      };
    }
    if (transactionHashes.length > 1) {
      return {
        clarificationQuestion: '你想分析哪一笔交易？请发送单笔完整交易哈希或对应主网浏览器链接。',
        resolution: 'needs_clarification',
      };
    }
  }

  if (isShortProductFollowUp(message)) {
    const topic = inferRecentProductTopic(input.recentTurns);
    if (topic !== undefined) {
      return {
        contextSummary: 'resolved product follow-up from previous product turn',
        resolution: 'resolved_followup',
        resolvedMessage: `${topic} ${message}`,
      };
    }
  }

  return { resolution: 'unchanged', resolvedMessage: input.message };
}

function uniqueRecentTransactionHashes(turns: SessionTurn[]): string[] {
  const hashes: string[] = [];
  for (const turn of turns) {
    const txHash = turn.metadata?.txHash;
    if (txHash !== undefined && !hashes.some((hash) => hash.toLowerCase() === txHash.toLowerCase())) {
      hashes.push(txHash);
    }
  }
  return hashes;
}

function isTransactionFollowUp(message: string): boolean {
  return /^(这笔|那笔|刚才那笔|上一笔)|被夹|夹子|sandwich|transaction|tx/iu.test(message);
}

function isShortProductFollowUp(message: string): boolean {
  const normalized = message.normalize('NFKC').trim();
  if (normalized.length > 24) {
    return false;
  }
  return /^(那|这个|刚才|上一条)?(怎么|如何|有哪些|可以|支持|升级|配置|设置)/u.test(normalized);
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
