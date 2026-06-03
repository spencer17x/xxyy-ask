import { Readable } from 'node:stream';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLocalHashEmbedding, tokenize } from '@xxyy/knowledge';
import { describe, expect, it } from 'vitest';

import type { ChatResponse } from '@xxyy/shared';
import { LlmConfigurationError } from '@xxyy/rag-core';

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

  it('returns a useful 503 when LLM configuration is missing', async () => {
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.reject(
              new LlmConfigurationError('OPENAI_API_KEY is required for LLM answer generation.'),
            );
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'llm_configuration_missing',
      message: 'OPENAI_API_KEY is required for LLM answer generation.',
    });
  });

  it('returns a useful 503 when pgvector configuration is missing', async () => {
    const handler = createRequestHandler({
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_MODEL: 'test-model',
        RAG_VECTOR_STORE: 'pgvector',
      },
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'vector_store_configuration_missing',
      message: 'DATABASE_URL is required when RAG_VECTOR_STORE=pgvector.',
    });
  });

  it('returns a useful 503 when embedding configuration is missing', async () => {
    const handler = createRequestHandler({
      env: {
        DATABASE_URL: 'postgres://xxyy:password@localhost:5432/xxyy_ask',
        OPENAI_MODEL: 'test-model',
        RAG_VECTOR_STORE: 'pgvector',
      },
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'embedding_configuration_missing',
      message: 'OPENAI_API_KEY is required for embedding generation.',
    });
  });

  it('uses handler env when loading the default ChatService', async () => {
    const llmRequests: unknown[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: string | Buffer) => {
        body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
      request.on('end', () => {
        llmRequests.push(JSON.parse(body));
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: 'XXYY Pro 支持 Telegram 钱包监控。',
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-env-'));
      const appCwd = path.join(workspaceRoot, 'apps', 'api');
      await mkdir(path.join(workspaceRoot, '.rag'), { recursive: true });
      await mkdir(appCwd, { recursive: true });
      await writeFile(
        path.join(workspaceRoot, '.rag', 'index.json'),
        JSON.stringify(
          {
            version: 1,
            builtAt: '1970-01-01T00:00:00.000Z',
            entries: [
              createIndexEntry({
                id: 'official_docs:pro:chunk:0001',
                text: 'XXYY Pro 支持 Telegram 钱包监控。',
                title: 'XXYY Pro 权益',
              }),
            ],
          },
          null,
          2,
        ),
        'utf8',
      );
      const address = server.address() as AddressInfo;
      const handler = createRequestHandler({
        cwd: appCwd,
        env: {
          INIT_CWD: workspaceRoot,
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          OPENAI_MODEL: 'test-model',
        },
      });

      const response = await callHandler(handler, {
        method: 'POST',
        url: '/api/chat',
        body: { message: 'XXYY Pro 支持什么？' },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        answer: 'XXYY Pro 支持 Telegram 钱包监控。',
        intent: 'product_qa',
      });
      expect(llmRequests).toHaveLength(1);
      expect(llmRequests[0]).toMatchObject({ model: 'test-model' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
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

function createIndexEntry(input: { id: string; text: string; title: string }) {
  const searchableText = [input.title, 'XXYY', input.text].join('\n');
  return {
    id: input.id,
    documentId: input.id.replace(/:chunk:\d+$/u, ''),
    text: input.text,
    metadata: {
      title: input.title,
      module: 'XXYY',
      sourceType: 'official_docs',
      file: '/docs/pro.md',
      headingPath: [input.title],
    },
    tokens: tokenize(searchableText),
    embedding: createLocalHashEmbedding(searchableText),
  };
}
