import type {
  KnowledgeRiskFlag,
  KnowledgeRiskLevel,
  RawSupportMessage,
  RedactedEntitySummary,
  RedactedEntityType,
  RedactedSupportMessage,
  RedactionReport,
} from './types.js';

interface RedactionPattern {
  type: RedactedEntityType;
  token: string;
  regex: RegExp;
}

const REDACTION_PATTERNS: RedactionPattern[] = [
  {
    type: 'email',
    token: '[REDACTED_EMAIL]',
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  },
  {
    type: 'phone',
    token: '[REDACTED_PHONE]',
    regex: /(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/gu,
  },
  {
    type: 'evm_address',
    token: '[REDACTED_EVM_ADDRESS]',
    regex: /\b0x[a-fA-F0-9]{40}\b/gu,
  },
  {
    type: 'solana_address',
    token: '[REDACTED_SOLANA_ADDRESS]',
    regex:
      /\b(?=[1-9A-HJ-NP-Za-km-z]{32,44}\b)(?=[1-9A-HJ-NP-Za-km-z]*\d)[1-9A-HJ-NP-Za-km-z]{32,44}\b/gu,
  },
  {
    type: 'url',
    token: '[REDACTED_URL]',
    regex: /https?:\/\/[^\s)）]+/giu,
  },
];

const PRIVATE_CREDENTIAL_PATTERNS = [
  /((?:私钥|助记词|恢复词|密钥)\s*(?:是|为|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
  /((?:private\s+key|seed\s+phrase|mnemonic|secret\s+recovery\s+phrase)\s*(?:is|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
  /((?:我的)?(?:密码|登录密码)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
  /((?:api\s*key|access\s*token|auth\s*token|访问令牌)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
  /(\b(?:my\s+)?password\s*(?:is|:|=)\s*)[^\s,，。；;]+/giu,
];

const PRIVATE_ACCOUNT_PATTERNS = [
  /钱包余额/u,
  /账户余额/u,
  /账号余额/u,
  /订单状态/u,
  /我的.{0,12}(余额|账户|账号|订单)/u,
  /查.{0,8}(余额|账户|账号|订单)/u,
  /\b(balance|account|order)\b/iu,
];

const PRIVATE_TRANSACTION_PATTERNS = [
  /交易记录/u,
  /充值记录/u,
  /提现记录/u,
  /转账记录/u,
  /我的.{0,12}交易/u,
  /\b(private transaction|transaction history)\b/iu,
];

const INVESTMENT_ADVICE_PATTERNS = [
  /能买吗/u,
  /该买吗/u,
  /会涨/u,
  /能涨/u,
  /推荐买/u,
  /买入建议/u,
  /卖出建议/u,
  /投资建议/u,
  /\b(should i buy|investment advice|price prediction)\b/iu,
];

export interface RedactSupportTextResult {
  text: string;
  report: RedactionReport;
}

export function redactSupportText(text: string): RedactSupportTextResult {
  const entityCounts = new Map<RedactedEntityType, number>();
  let redactedText = redactPrivateCredentials(text, entityCounts);

  for (const pattern of REDACTION_PATTERNS) {
    redactedText = redactedText.replace(pattern.regex, () => {
      entityCounts.set(pattern.type, (entityCounts.get(pattern.type) ?? 0) + 1);
      return pattern.token;
    });
  }

  const entities = REDACTION_PATTERNS.flatMap((pattern): RedactedEntitySummary[] => {
    const count = entityCounts.get(pattern.type) ?? 0;
    return count === 0 ? [] : [{ type: pattern.type, count }];
  });
  const privateCredentialCount = entityCounts.get('private_credential') ?? 0;
  if (privateCredentialCount > 0) {
    entities.push({ type: 'private_credential', count: privateCredentialCount });
  }
  const riskFlags = detectRiskFlags(redactedText);
  const riskLevel = calculateRiskLevel(entities, riskFlags);

  return {
    text: redactedText,
    report: {
      entities,
      riskFlags,
      riskLevel,
    },
  };
}

export function redactSupportMessage(message: RawSupportMessage): RedactedSupportMessage {
  const result = redactSupportText(message.text);
  return {
    ...message,
    text: result.text,
    redactionReport: result.report,
  };
}

function detectRiskFlags(text: string): KnowledgeRiskFlag[] {
  const flags: KnowledgeRiskFlag[] = [];

  if (text.includes('[REDACTED_PRIVATE_CREDENTIAL]')) {
    flags.push('private_credentials');
  }

  if (PRIVATE_ACCOUNT_PATTERNS.some((pattern) => pattern.test(text))) {
    flags.push('private_account_query');
  }

  if (PRIVATE_TRANSACTION_PATTERNS.some((pattern) => pattern.test(text))) {
    flags.push('private_transaction_data');
  }

  if (INVESTMENT_ADVICE_PATTERNS.some((pattern) => pattern.test(text))) {
    flags.push('investment_advice');
  }

  return flags;
}

function redactPrivateCredentials(
  text: string,
  entityCounts: Map<RedactedEntityType, number>,
): string {
  let redactedText = text;
  for (const pattern of PRIVATE_CREDENTIAL_PATTERNS) {
    redactedText = redactedText.replace(pattern, (_match, prefix: string) => {
      entityCounts.set('private_credential', (entityCounts.get('private_credential') ?? 0) + 1);
      return `${prefix}[REDACTED_PRIVATE_CREDENTIAL]`;
    });
  }
  return redactedText;
}

function calculateRiskLevel(
  entities: RedactedEntitySummary[],
  riskFlags: KnowledgeRiskFlag[],
): KnowledgeRiskLevel {
  if (riskFlags.length > 0) {
    return 'high';
  }

  if (entities.length > 0) {
    return 'medium';
  }

  return 'low';
}
