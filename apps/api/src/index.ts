import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadKnowledgeIndex } from '@xxyy/knowledge';
import { createChatService, LlmConfigurationError, loadRagConfig } from '@xxyy/rag-core';
import type { ChatRequest, ChatChannel } from '@xxyy/shared';
import { supportedChannels } from '@xxyy/shared';
import type { ChatService, RagEnv } from '@xxyy/rag-core';
import { renderChatPage } from '@xxyy/web';

type ApiEnv = RagEnv & Partial<Record<'INIT_CWD', string>>;

export interface ApiRequestLike {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}

export interface ApiResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

export type ApiRequestHandler = (
  request: ApiRequestLike,
  response: ApiResponseLike,
) => Promise<void>;

export interface CreateRequestHandlerOptions {
  cwd?: string;
  env?: ApiEnv;
  getChatService?: () => Promise<ChatService>;
  renderHtml?: () => string;
}

interface ChatPayload {
  message: string;
  channel?: ChatChannel;
  sessionId?: string;
  userId?: string;
}

export class MissingIndexError extends Error {
  constructor(public readonly indexPath: string) {
    super(`Knowledge index not found at ${indexPath}. Run pnpm rag:ingest first.`);
  }
}

export function createRequestHandler(options: CreateRequestHandlerOptions = {}): ApiRequestHandler {
  const env = options.env ?? process.env;
  const cwd = resolveWorkspaceCwd(options.cwd ?? process.cwd(), env);
  const config = loadRagConfig(env);
  const displayIndexPath = config.indexPath;
  const absoluteIndexPath = path.resolve(cwd, config.indexPath);
  const renderHtml = options.renderHtml ?? renderChatPage;
  const getChatService =
    options.getChatService ??
    createCachedChatServiceLoader(absoluteIndexPath, displayIndexPath, config);

  return async function handleRequest(request, response): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');

    try {
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/') {
        sendHtml(response, 200, renderHtml());
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/chat') {
        const payload = parseChatPayload(await readJsonBody(request));
        const service = await getChatService();
        const chatRequest = toChatRequest(payload);
        const chatResponse = await service.ask(chatRequest);
        sendJson(response, 200, chatResponse);
        return;
      }

      sendJson(response, 404, { error: 'not_found', message: 'Route not found.' });
    } catch (error) {
      if (error instanceof MissingIndexError) {
        sendJson(response, 503, {
          error: 'knowledge_index_missing',
          message: error.message,
        });
        return;
      }

      if (error instanceof BadRequestError) {
        sendJson(response, 400, { error: 'bad_request', message: error.message });
        return;
      }

      if (error instanceof LlmConfigurationError) {
        sendJson(response, 503, {
          error: 'llm_configuration_missing',
          message: error.message,
        });
        return;
      }

      sendJson(response, 500, {
        error: 'internal_error',
        message: 'Unable to process request.',
      });
    }
  };
}

export function resolveWorkspaceCwd(cwd: string, env: ApiEnv): string {
  const initCwd = env.INIT_CWD;
  if (initCwd !== undefined && hasWorkspaceEvidence(initCwd)) {
    return path.resolve(initCwd);
  }

  if (hasWorkspaceEvidence(cwd)) {
    return path.resolve(cwd);
  }

  return findWorkspaceRoot(cwd) ?? path.resolve(cwd);
}

export function startServer(
  options: CreateRequestHandlerOptions = {},
): ReturnType<typeof createServer> {
  const port = Number(process.env.PORT ?? 3000);
  const handler = createRequestHandler(options);
  const server = createServer((request, response) => {
    void handler(request as ApiRequestLike, response);
  });

  server.listen(port, () => {
    process.stdout.write(`XXYY RAG API listening on http://localhost:${port}\n`);
  });

  return server;
}

function createCachedChatServiceLoader(
  absoluteIndexPath: string,
  displayIndexPath: string,
  config: ReturnType<typeof loadRagConfig>,
): () => Promise<ChatService> {
  let cachedService: ChatService | undefined;

  return async () => {
    if (cachedService !== undefined) {
      return cachedService;
    }

    try {
      const index = await loadKnowledgeIndex(absoluteIndexPath);
      cachedService = createChatService({ config, index });
      return cachedService;
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new MissingIndexError(displayIndexPath);
      }
      throw error;
    }
  };
}

async function readJsonBody(request: ApiRequestLike): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }

  if (body.trim().length === 0) {
    throw new BadRequestError('Request body must be JSON.');
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (_error) {
    throw new BadRequestError('Request body must be valid JSON.');
  }
}

function parseChatPayload(value: unknown): ChatPayload {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message !== 'string' || record.message.trim().length === 0) {
    throw new BadRequestError('message must be a non-empty string.');
  }

  const channel = parseOptionalChannel(record.channel);

  return withOptionalFields(
    {
      message: record.message.trim(),
      ...(channel === undefined ? {} : { channel }),
    },
    record,
  );
}

function withOptionalFields(
  payload: { message: string; channel?: ChatChannel },
  record: Record<string, unknown>,
): ChatPayload {
  const sessionId = parseOptionalString(record.sessionId, 'sessionId');
  const userId = parseOptionalString(record.userId, 'userId');

  return {
    ...payload,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(userId === undefined ? {} : { userId }),
  };
}

function parseOptionalChannel(value: unknown): ChatChannel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !supportedChannels.includes(value as ChatChannel)) {
    throw new BadRequestError('channel must be one of: cli, web, telegram.');
  }

  return value as ChatChannel;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new BadRequestError(`${fieldName} must be a string.`);
  }

  return value;
}

function toChatRequest(payload: ChatPayload): ChatRequest {
  return {
    channel: payload.channel ?? 'web',
    message: payload.message,
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    ...(payload.userId === undefined ? {} : { userId: payload.userId }),
  };
}

function sendJson(response: ApiResponseLike, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendHtml(response: ApiResponseLike, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function hasWorkspaceEvidence(candidatePath: string): boolean {
  return (
    existsSync(path.join(candidatePath, 'pnpm-workspace.yaml')) ||
    existsSync(path.join(candidatePath, 'docs', 'product-features')) ||
    existsSync(path.join(candidatePath, '.rag', 'index.json'))
  );
}

function findWorkspaceRoot(startPath: string): string | undefined {
  let currentPath = path.resolve(startPath);

  while (true) {
    if (hasWorkspaceEvidence(currentPath)) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

class BadRequestError extends Error {}

function isDirectRun(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  startServer();
}
