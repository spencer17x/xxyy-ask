import type { Intent, TxAnalysisChain } from '@xxyy/shared';

export type SessionTurnRole = 'assistant' | 'user';

export interface SessionTurnMetadata {
  chain?: TxAnalysisChain;
  citationCount?: number;
  confidence?: number;
  intent?: Intent;
  txHash?: string;
}

export interface SessionTurn {
  content: string;
  createdAt: string;
  metadata?: SessionTurnMetadata;
  role: SessionTurnRole;
}

export interface SessionContextSummary {
  productPreference?: string;
  productTopic?: string;
  updatedAt: string;
}

export interface SessionContextStore {
  appendTurn(sessionId: string, turn: SessionTurn): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
  getRecentTurns(sessionId: string, limit?: number): Promise<SessionTurn[]>;
  getSessionSummary(sessionId: string): Promise<SessionContextSummary | null>;
}

export interface InMemorySessionContextStoreOptions {
  maxTurnsPerSession?: number;
  now?: () => Date;
}

const DEFAULT_MAX_TURNS_PER_SESSION = 12;

export function createInMemorySessionContextStore(
  options: InMemorySessionContextStoreOptions = {},
): SessionContextStore {
  const maxTurnsPerSession = options.maxTurnsPerSession ?? DEFAULT_MAX_TURNS_PER_SESSION;
  const now = options.now ?? (() => new Date());
  const summariesBySession = new Map<string, SessionContextSummary>();
  const turnsBySession = new Map<string, SessionTurn[]>();

  return {
    appendTurn(sessionId, turn) {
      const existingTurns = turnsBySession.get(sessionId) ?? [];
      const storedTurn = {
        ...turn,
        content: sanitizeSessionText(turn.content),
        createdAt: turn.createdAt || now().toISOString(),
      };
      const nextTurns = [...existingTurns, storedTurn].slice(-maxTurnsPerSession);
      turnsBySession.set(sessionId, nextTurns);
      const summaryPatch = summarizeSessionTurn(storedTurn);
      if (summaryPatch !== undefined) {
        summariesBySession.set(sessionId, {
          ...(summariesBySession.get(sessionId) ?? {}),
          ...summaryPatch,
          updatedAt: storedTurn.createdAt,
        });
      }
      return Promise.resolve();
    },

    clearSession(sessionId) {
      summariesBySession.delete(sessionId);
      turnsBySession.delete(sessionId);
      return Promise.resolve();
    },

    getRecentTurns(sessionId, limit) {
      const turns = turnsBySession.get(sessionId) ?? [];
      return Promise.resolve(turns.slice(-(limit ?? maxTurnsPerSession)));
    },

    getSessionSummary(sessionId) {
      return Promise.resolve(summariesBySession.get(sessionId) ?? null);
    },
  };
}

export function summarizeSessionTurn(
  turn: SessionTurn,
): Omit<SessionContextSummary, 'updatedAt'> | undefined {
  if (turn.metadata?.intent === 'tx_sandwich_detection') {
    return undefined;
  }

  const summary: Omit<SessionContextSummary, 'updatedAt'> = {};
  const productPreference = inferProductPreferenceFromText(turn.content);
  if (productPreference !== undefined) {
    summary.productPreference = productPreference;
  }

  const productTopic = inferProductTopicFromTurn(turn);
  if (productTopic !== undefined) {
    summary.productTopic = productTopic;
  }

  return Object.keys(summary).length === 0 ? undefined : summary;
}

export function sanitizeSessionText(text: string): string {
  return redactSensitiveCredentials(text)
    .replace(/\b0x[a-fA-F0-9]{64}\b/gu, '[evm_tx_hash]')
    .replace(/\b0x[a-fA-F0-9]{40}\b/gu, '[evm_address]')
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/gu, '[solana_signature]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, '[phone]')
    .trim();
}

function redactSensitiveCredentials(text: string): string {
  return text
    .replace(
      /((?:私钥|助记词|恢复词|密钥)\s*(?:是|为|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:private\s+key|seed\s+phrase|mnemonic|secret\s+recovery\s+phrase)\s*(?:is|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:我的)?(?:密码|登录密码)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:api\s*key|access\s*token|auth\s*token|访问令牌)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
      '$1[sensitive_credential]',
    )
    .replace(/(\bbearer\s+)[^\s,，。；;]+/giu, '$1[sensitive_credential]')
    .replace(/(\bsecret\s+key\s*(?:is|:|=)\s*)[^\s,，。；;]+/giu, '$1[sensitive_credential]')
    .replace(/(\b(?:my\s+)?password\s*(?:is|:|=)\s*)[^\s,，。；;]+/giu, '$1[sensitive_credential]');
}

function inferProductPreferenceFromText(content: string): string | undefined {
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

function inferProductTopicFromTurn(turn: SessionTurn): string | undefined {
  if (
    turn.role !== 'assistant' ||
    (turn.metadata?.intent !== 'product_qa' && turn.metadata?.intent !== 'how_to') ||
    turn.metadata.citationCount === undefined ||
    turn.metadata.citationCount <= 0
  ) {
    return undefined;
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
  return undefined;
}
