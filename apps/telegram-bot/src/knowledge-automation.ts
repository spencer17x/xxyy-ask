import {
  createKnowledgeAutomationController,
  createKnowledgeGovernanceService,
  createOpenAiKnowledgeCuratorModel,
  createPgKnowledgeCandidateStore,
  createPgKnowledgeMatchInspector,
  createPgKnowledgePublicationJobStore,
  createPgPool,
  createPgTrustedAuthorStore,
  fetchTelegramCurrentAdministratorIds,
  UnverifiedTelegramKnowledgeAuthorError,
  type RagConfig,
} from '@xxyy/rag-core';

import type { TelegramKnowledgeAutomation, TelegramMessage } from './bot.js';

export interface TelegramKnowledgeAutomationRuntime {
  automation: TelegramKnowledgeAutomation;
  close(): Promise<void>;
}

const TELEGRAM_ADMIN_CACHE_TTL_MS = 5 * 60 * 1_000;

export function createTelegramKnowledgeAutomationRuntime(options: {
  botToken: string;
  config: RagConfig;
  now?: () => Date;
  telegramApiBaseUrl?: string;
}): TelegramKnowledgeAutomationRuntime {
  const pool = createPgPool(options.config.databaseUrl);
  const candidateStore = createPgKnowledgeCandidateStore({ client: pool });
  const publicationJobStore = createPgKnowledgePublicationJobStore({ client: pool });
  const trustedAuthorStore = createPgTrustedAuthorStore({ client: pool });
  const curatorModel =
    options.config.openAiApiKey === undefined || options.config.openAiModel === undefined
      ? undefined
      : createOpenAiKnowledgeCuratorModel({
          apiKey: options.config.openAiApiKey,
          baseUrl: options.config.openAiBaseUrl,
          model: options.config.openAiModel,
          requestTimeoutMs: options.config.openAiRequestTimeoutMs,
        });
  const governance = createKnowledgeGovernanceService({
    automation: createKnowledgeAutomationController({
      candidateStore,
      publicationJobStore,
    }),
    candidateStore,
    inspector: createPgKnowledgeMatchInspector({ candidateStore, client: pool }),
    trustedAuthorStore,
    ...(curatorModel === undefined ? {} : { curatorModel }),
  });
  const now = options.now ?? (() => new Date());
  const administratorCache = new Map<string, { ids: ReadonlySet<string>; verifiedAt: string }>();

  return {
    automation: {
      async captureReply(message): Promise<boolean> {
        const rawExport = createLiveTelegramKnowledgeExport(message);
        if (rawExport === undefined) {
          return false;
        }
        const chatId = String(message.chat.id);
        const checkedAt = now();
        const cachedAdministrators = administratorCache.get(chatId);
        let currentAdministratorUserIds: ReadonlySet<string> | undefined;
        let currentAdministratorVerifiedAt: string | undefined;
        if (
          cachedAdministrators !== undefined &&
          checkedAt.getTime() - Date.parse(cachedAdministrators.verifiedAt) <=
            TELEGRAM_ADMIN_CACHE_TTL_MS
        ) {
          currentAdministratorUserIds = cachedAdministrators.ids;
          currentAdministratorVerifiedAt = cachedAdministrators.verifiedAt;
        } else {
          try {
            currentAdministratorUserIds = await fetchTelegramCurrentAdministratorIds({
              botToken: options.botToken,
              chatId,
              ...(options.telegramApiBaseUrl === undefined
                ? {}
                : { apiBaseUrl: options.telegramApiBaseUrl }),
            });
            currentAdministratorVerifiedAt = checkedAt.toISOString();
            administratorCache.set(chatId, {
              ids: currentAdministratorUserIds,
              verifiedAt: currentAdministratorVerifiedAt,
            });
          } catch {
            currentAdministratorUserIds = undefined;
            currentAdministratorVerifiedAt = undefined;
          }
        }
        try {
          const result = await governance.importTelegram({
            curationMode: 'auto',
            rawExport,
            runId: `telegram_live_${message.chat.id}_${message.message_id}`,
            sourceChannel: 'telegram',
            ...(currentAdministratorUserIds === undefined
              ? {}
              : {
                  currentAdministratorUserIds,
                  ...(currentAdministratorVerifiedAt === undefined
                    ? {}
                    : { currentAdministratorVerifiedAt }),
                }),
          });
          return result.verifiedAuthorMessageCount > 0;
        } catch (error) {
          if (error instanceof UnverifiedTelegramKnowledgeAuthorError) {
            return false;
          }
          throw error;
        }
      },
    },
    close() {
      return pool.end();
    },
  };
}

export function createLiveTelegramKnowledgeExport(
  message: TelegramMessage,
): Record<string, unknown> | undefined {
  const question = message.reply_to_message;
  if (
    question === undefined ||
    question.text?.trim().length === 0 ||
    message.text?.trim().length === 0 ||
    message.from === undefined ||
    message.from.is_bot === true ||
    message.sender_chat !== undefined
  ) {
    return undefined;
  }
  return {
    id: message.chat.id,
    messages: [
      {
        ...(question.date === undefined ? {} : { date: unixTimestamp(question.date) }),
        ...(question.from === undefined ? {} : { from_id: `user${question.from.id}` }),
        id: question.message_id,
        text: question.text,
      },
      {
        ...(message.date === undefined ? {} : { date: unixTimestamp(message.date) }),
        from_id: `user${message.from.id}`,
        id: message.message_id,
        reply_to_message_id: question.message_id,
        text: message.text,
      },
    ],
  };
}

function unixTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Telegram message date must be a positive Unix timestamp.');
  }
  return new Date(value * 1_000).toISOString();
}
