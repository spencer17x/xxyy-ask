import {
  createQualityTracerFromEnv,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
  type RagEnv,
} from '@xxyy/rag-core';

import {
  TelegramBotConfigurationError,
  createTelegramBot,
  loadTelegramBotConfig,
  runTelegramBot,
  type TelegramBotEnv,
} from './bot.js';
import { createTelegramChatRuntime } from './runtime.js';
import { createTelegramApiClient } from './telegram-api.js';

type TelegramEnv = RagEnv & TelegramBotEnv & Partial<Record<'INIT_CWD', string>>;

const logger = {
  error(message: string, error?: unknown) {
    process.stderr.write(`${message}${error === undefined ? '' : ` ${formatError(error)}`}\n`);
  },
  info(message: string) {
    process.stdout.write(`${message}\n`);
  },
};

async function main(env: TelegramEnv = process.env): Promise<void> {
  const workspaceCwd = resolveWorkspaceCwd(process.cwd(), env);
  const workspaceEnv = loadWorkspaceEnv({ cwd: workspaceCwd, env });
  const config = loadRagConfig(workspaceEnv);
  const botConfig = loadTelegramBotConfig(workspaceEnv);
  const runtime = createTelegramChatRuntime(
    config,
    createQualityTracerFromEnv({ ...workspaceEnv }),
  );
  const api = createTelegramApiClient({ botToken: botConfig.botToken });
  const bot = createTelegramBot({
    api,
    chatService: runtime.service,
    config: botConfig,
    logger,
  });
  const abortController = new AbortController();

  const stop = (): void => {
    abortController.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    logger.info('Telegram bot polling started.');
    await runTelegramBot(bot, {
      abortSignal: abortController.signal,
      errorRetryMs: botConfig.pollErrorRetryMs,
      logger,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await runtime.close();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof TelegramBotConfigurationError) {
    logger.error(error.message);
  } else {
    logger.error('Telegram bot failed.', error);
  }
  process.exitCode = 1;
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
