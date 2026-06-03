import { Readable } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChatResponse } from '@xxyy/shared';

import { MissingIndexError, createRequestHandler, type ApiRequestHandler } from './index.js';

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

async function callHandler(
  handler: ApiRequestHandler,
  input: {
    method: string;
    url: string;
    body?: unknown;
  },
): Promise<CapturedResponse> {
  const chunks = input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body), 'utf8')];
  const request = {
    method: input.method,
    url: input.url,
    headers: {},
    [Symbol.asyncIterator]() {
      return Readable.from(chunks)[Symbol.asyncIterator]();
    },
  };
  const response: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: '',
  };

  await handler(request, {
    get statusCode() {
      return response.statusCode;
    },
    set statusCode(statusCode: number) {
      response.statusCode = statusCode;
    },
    setHeader(name: string, value: string) {
      response.headers[name] = value;
    },
    end(body?: string) {
      response.body = body ?? '';
    },
  });

  return response;
}

describe('createRequestHandler', () => {
  it('returns JSON health status', async () => {
    const handler = createRequestHandler();

    const response = await callHandler(handler, { method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('passes chat requests through ChatService', async () => {
    const chatResponse: ChatResponse = {
      answer: '根据知识库，XXYY Pro 提供更多权益。',
      confidence: 0.8,
      intent: 'product_qa',
      citations: [],
    };
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            expect(request).toEqual({
              channel: 'web',
              message: 'XXYY Pro 有哪些权益？',
              sessionId: 'session-1',
              userId: 'user-1',
            });
            return Promise.resolve(chatResponse);
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 'session-1',
        userId: 'user-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(chatResponse);
  });

  it('returns a useful 503 when the index is missing', async () => {
    const handler = createRequestHandler({
      getChatService: () => Promise.reject(new MissingIndexError('.rag/index.json')),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'knowledge_index_missing',
      message: 'Knowledge index not found at .rag/index.json. Run pnpm rag:ingest first.',
    });
  });

  it('loads the persisted index from INIT_CWD when run through a pnpm filter', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-root-'));
    const appCwd = path.join(workspaceRoot, 'apps', 'api');
    await mkdir(path.join(workspaceRoot, '.rag'), { recursive: true });
    await mkdir(appCwd, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, '.rag', 'index.json'),
      JSON.stringify({ version: 1, builtAt: '1970-01-01T00:00:00.000Z', entries: [] }),
      'utf8',
    );
    const handler = createRequestHandler({
      cwd: appCwd,
      env: { INIT_CWD: workspaceRoot },
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: '嗯？' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      intent: 'unknown',
      citations: [],
    });
  });
});
