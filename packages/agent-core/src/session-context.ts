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

export interface SessionContextStore {
  appendTurn(sessionId: string, turn: SessionTurn): Promise<void>;
  getRecentTurns(sessionId: string, limit?: number): Promise<SessionTurn[]>;
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
      return Promise.resolve();
    },

    getRecentTurns(sessionId, limit) {
      const turns = turnsBySession.get(sessionId) ?? [];
      return Promise.resolve(turns.slice(-(limit ?? maxTurnsPerSession)));
    },
  };
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
