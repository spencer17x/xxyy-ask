import type { Classification, Intent } from '@xxyy/shared';

import {
  hasAmbiguousTransactionReferences,
  hasTransactionReferenceCandidate,
  parseTransactionReference,
} from './tx-hash.js';

type IntentRule = {
  intent: Intent;
  confidence: number;
  reason: string;
  patterns: RegExp[];
};

const userSpecificLookupPatterns = [
  /帮我查/u,
  /查一下/u,
  /我的/u,
  /我(的)?(钱包|账户|账号|订单|交易)/u,
  /\bmy\b/u,
  /\bmine\b/u,
  /\blookup\b/u,
];

const unsafeOperationPatterns = [
  /\bhack\b/u,
  /\bexploit\b/u,
  /\bsteal\b/u,
  /\bphish\b/u,
  /盗号|攻击|破解|钓鱼/u,
];

const privateCredentialPatterns = [
  /\b(private\s+key|seed\s+phrase|mnemonic|secret\s+recovery\s+phrase)\b/u,
  /(?:我的)?(?:密码|登录密码)\s*(?:是|为|:|：|=)\s*\S+/u,
  /(?:api\s*key|access\s*token|auth\s*token|访问令牌)\s*(?:是|为|:|：|=)\s*\S+/u,
  /\b(?:my\s+)?(?:password|api\s*key|access\s*token|auth\s*token)\s*(?:is|:|=)\s*\S+/u,
  /私钥|助记词|恢复词|密钥/u,
];

const productOperationPatterns = [
  /如何.*(买入|卖出|交易|挂单|swap|设置)/u,
  /怎么.*(买入|卖出|交易|挂单|swap|设置|操作|登录|导出|导入|生成|升级)/u,
  /(swap|挂单|交易).*怎么操作/u,
  /操作.*(买入|卖出|交易|挂单|swap)/u,
];

const transactionAnalysisPatterns = [
  /\bmev\b|\bsandwich\b|\btx\s*hash\b|\btransaction hash\b|\btransaction\b|\btx\b/u,
  /夹子|被夹|三明治|链上取证|交易哈希|交易|检测|分析|查一下/u,
];

const rules: IntentRule[] = [
  {
    intent: 'investment_advice',
    confidence: 0.9,
    reason: 'asks for trading recommendation or profit promise',
    patterns: [
      /可以买|该买|该卖|推荐.*(币|token)|喊单|保证.*(盈利|赚钱|收益)|收益承诺|profit promise/u,
      /\bguarantee\b.*\b(profit|return|yield|earnings?)\b/u,
      /\b(profit|return|yield|earnings?)\b.*\bguarantee\b/u,
      /\b(make|earn|get)\b.*\b(profit|return|yield|earnings?)\b/u,
      /\b(profit|return|yield|earnings?)\b.*\b(from|with|in)\b/u,
      /\b(investment|trading)\s+recommendation\b/u,
      /\bwhich\b.*\b(token|coin|crypto|sol|eth|btc)\b.*\b(buy|sell)\b/u,
      /\b(should|can)\b.*\b(buy|sell)\b.*\b(token|coin|crypto|sol|eth|btc)\b/u,
      /\b(buy|sell|recommend)\b.*\b(token|coin|crypto|sol|eth|btc)\b/u,
    ],
  },
  {
    intent: 'mev_or_chain_forensics',
    confidence: 0.88,
    reason: 'asks for MEV, sandwich, clipping, or transaction forensics',
    patterns: [
      /\bmev\b|\bsandwich\b|\btx\s*hash\b|\btransaction hash\b/u,
      /夹子|被夹|三明治|链上取证|交易哈希/u,
    ],
  },
  {
    intent: 'how_to',
    confidence: 0.84,
    reason: 'asks for setup or operation instructions',
    patterns: [
      /如何|怎么操作|怎么设置|怎样设置|设置.*(教程|步骤)|操作步骤/u,
      /\bhow to\b|\bhow-to\b|\bsetup\b|\bset up\b/u,
    ],
  },
  {
    intent: 'realtime_account_query',
    confidence: 0.86,
    reason: 'asks for user-specific account, order, wallet, or transaction data',
    patterns: [/(钱包|余额|订单|账户|账号|交易记录|交易查询|transaction|balance|account|order)/u],
  },
  {
    intent: 'product_qa',
    confidence: 0.78,
    reason: 'asks about XXYY product, features, updates, or Pro plan',
    patterns: [
      /\bxxyy\b|\bpro\b|\bproduct\b|\bfeature(s)?\b|\bupdate(s)?\b/u,
      /产品|功能|更新|权益|版本|提醒|监控|telegram/u,
      /钱包备注|监控上限|监控数量|历史更新|更新记录|推特|推文|tweet|x\.com/u,
      /扫链|打满|趋势|收藏|持仓管理|收益统计|快捷交易|自动交易|钱包管理|关注钱包|移动端/u,
    ],
  },
];

export function classifyQuestion(question: string): Classification {
  const normalized = question.normalize('NFKC').trim().toLowerCase();
  if (normalized.length < 2) {
    return createClassification('unknown', 0.2, 'question is too short or unclear');
  }

  if (unsafeOperationPatterns.some((pattern) => pattern.test(normalized))) {
    return createClassification('unknown', 0.3, 'unsafe or unsupported operation request');
  }

  if (privateCredentialPatterns.some((pattern) => pattern.test(normalized))) {
    return createClassification('unknown', 0.35, 'private credential or seed phrase disclosure');
  }

  const investmentRule = rules.find((rule) => rule.intent === 'investment_advice');
  if (investmentRule !== undefined && matchesRule(investmentRule, normalized)) {
    return createClassification(
      investmentRule.intent,
      investmentRule.confidence,
      investmentRule.reason,
    );
  }

  const transactionReference = parseTransactionReference(question);
  if (
    transactionReference !== undefined &&
    hasTransactionAnalysisSignal(normalized, transactionReference.txHash)
  ) {
    return createClassification(
      'tx_sandwich_detection',
      0.9,
      'asks to analyze a concrete transaction hash for sandwich or MEV signals',
    );
  }

  if (hasAmbiguousTransactionReferences(question)) {
    return createClassification(
      'tx_sandwich_detection',
      0.86,
      'asks to analyze multiple transaction hashes and needs a single hash clarification',
    );
  }

  if (
    transactionReference === undefined &&
    hasTransactionReferenceCandidate(question) &&
    transactionAnalysisPatterns.some((pattern) => pattern.test(normalized))
  ) {
    return createClassification(
      'tx_sandwich_detection',
      0.84,
      'asks to analyze a transaction reference but the chain hints are unclear',
    );
  }

  const realtimeRule = rules.find((rule) => rule.intent === 'realtime_account_query');
  if (realtimeRule !== undefined && matchesRule(realtimeRule, normalized)) {
    const isUserSpecific = userSpecificLookupPatterns.some((pattern) => pattern.test(normalized));
    if (isUserSpecific) {
      return createClassification(
        realtimeRule.intent,
        realtimeRule.confidence,
        realtimeRule.reason,
      );
    }
  }

  if (productOperationPatterns.some((pattern) => pattern.test(normalized))) {
    return createClassification('how_to', 0.84, 'asks for product operation instructions');
  }

  for (const rule of rules) {
    if (rule.intent === 'investment_advice' || rule.intent === 'realtime_account_query') {
      continue;
    }

    if (matchesRule(rule, normalized)) {
      return createClassification(rule.intent, rule.confidence, rule.reason);
    }
  }

  if (realtimeRule !== undefined && matchesRule(realtimeRule, normalized)) {
    return createClassification(realtimeRule.intent, realtimeRule.confidence, realtimeRule.reason);
  }

  return createClassification('unknown', 0.25, 'no deterministic product support intent matched');
}

function matchesRule(rule: IntentRule, normalizedQuestion: string): boolean {
  return rule.patterns.some((pattern) => pattern.test(normalizedQuestion));
}

function hasTransactionAnalysisSignal(normalizedQuestion: string, txHash: string): boolean {
  if (transactionAnalysisPatterns.some((pattern) => pattern.test(normalizedQuestion))) {
    return true;
  }

  const normalizedHash = txHash.toLowerCase();
  const withoutHash = normalizedQuestion
    .replace(normalizedHash, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

  return withoutHash.length === 0;
}

function createClassification(intent: Intent, confidence: number, reason: string): Classification {
  return {
    intent,
    confidence,
    reason,
  };
}
