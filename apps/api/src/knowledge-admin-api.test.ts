import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type {
  KnowledgeCandidate,
  KnowledgeGovernanceService,
  KnowledgePublicationJob,
  PgKnowledgePublicationJobStore,
} from '@xxyy/rag-core';

import {
  createKnowledgeAdminAuthenticator,
  hashKnowledgeAdminToken,
} from './knowledge-admin-auth.js';
import { handleKnowledgeAdminApi, type KnowledgeAdminServices } from './knowledge-admin-api.js';
import type { ApiRequestLike, ApiResponseLike } from './index.js';

const TOKEN = 'admin-test-token-with-at-least-24-characters';

describe('handleKnowledgeAdminApi', () => {
  it('fails closed before loading database services when admin authentication is disabled', async () => {
    const getServices = vi.fn<() => Promise<KnowledgeAdminServices>>();
    const response = await callAdmin({
      authenticator: createKnowledgeAdminAuthenticator(undefined),
      getServices,
      method: 'GET',
      url: '/admin/api/candidates',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json).toMatchObject({ error: 'knowledge_admin_not_configured' });
    expect(getServices).not.toHaveBeenCalled();
  });

  it('rejects missing credentials without touching knowledge services', async () => {
    const getServices = vi.fn<() => Promise<KnowledgeAdminServices>>();
    const response = await callAdmin({
      authenticator: authenticator('admin'),
      getServices,
      method: 'GET',
      url: '/admin/api/candidates',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['WWW-Authenticate']).toContain('Bearer');
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(getServices).not.toHaveBeenCalled();
  });

  it('allows viewers to inspect candidates but not mutate them', async () => {
    const listCandidates = vi
      .fn<KnowledgeGovernanceService['listCandidates']>()
      .mockResolvedValue([candidate()]);
    const services = knowledgeAdminServices({ governance: governance({ listCandidates }) });
    const readResponse = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () => Promise.resolve(services),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/candidates?status=pending&limit=20',
    });
    const writeResponse = await callAdmin({
      authenticator: authenticator('viewer'),
      body: { canonicalAnswer: '修改后的答案' },
      getServices: () => Promise.resolve(services),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1',
    });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json).toMatchObject({ candidates: [{ id: 'knowledge_candidate_1' }] });
    expect(listCandidates).toHaveBeenCalledWith({ limit: 20, status: 'pending' });
    expect(writeResponse.statusCode).toBe(403);
  });

  it('uses the authenticated reviewer identity instead of accepting an actor from the body', async () => {
    const revise = vi.fn<KnowledgeGovernanceService['revise']>().mockResolvedValue(candidate());
    const response = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: {
        canonicalAnswer: '修改后的答案',
        editedBy: 'forged:actor',
      },
      getServices: () =>
        Promise.resolve(knowledgeAdminServices({ governance: governance({ revise }) })),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1',
    });

    expect(response.statusCode).toBe(400);
    expect(revise).not.toHaveBeenCalled();

    const accepted = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: { canonicalAnswer: '修改后的答案', reason: '补充限制' },
      getServices: () =>
        Promise.resolve(knowledgeAdminServices({ governance: governance({ revise }) })),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1',
    });
    expect(accepted.statusCode).toBe(200);
    expect(revise).toHaveBeenCalledWith({
      canonicalAnswer: '修改后的答案',
      editedBy: 'admin:alice',
      id: 'knowledge_candidate_1',
      reason: '补充限制',
    });
  });

  it('requires an explicit effective time when a reviewer approves a candidate', async () => {
    const approve = vi.fn<KnowledgeGovernanceService['approve']>().mockResolvedValue(
      candidate({
        effectiveAt: '2026-07-21T00:00:00.000Z',
        status: 'approved',
      }),
    );
    const services = knowledgeAdminServices({ governance: governance({ approve }) });

    const missingEffectiveTime = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: {},
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1/approve',
    });
    const accepted = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: { effectiveAt: '2026-07-21T00:00:00.000Z' },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1/approve',
    });

    expect(missingEffectiveTime.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(200);
    expect(approve).toHaveBeenCalledWith({
      effectiveAt: '2026-07-21T00:00:00.000Z',
      id: 'knowledge_candidate_1',
      reviewedBy: 'admin:alice',
    });
  });

  it('separates reviewer and publisher permissions for publication requests and retries', async () => {
    const request = vi
      .fn<PgKnowledgePublicationJobStore['request']>()
      .mockResolvedValue(publication());
    const retry = vi
      .fn<PgKnowledgePublicationJobStore['retry']>()
      .mockResolvedValue(publication({ status: 'queued' }));
    const services = knowledgeAdminServices({
      publicationJobs: publicationStore({ request, retry }),
    });

    const forbidden = await callAdmin({
      authenticator: authenticator('reviewer'),
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1/publication',
    });
    const queued = await callAdmin({
      authenticator: authenticator('publisher'),
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1/publication',
    });
    const retried = await callAdmin({
      authenticator: authenticator('publisher'),
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/publications/knowledge_publication_1/retry',
    });

    expect(forbidden.statusCode).toBe(403);
    expect(queued.statusCode).toBe(202);
    expect(retried.statusCode).toBe(202);
    expect(request).toHaveBeenCalledWith({
      candidateId: 'knowledge_candidate_1',
      requestedBy: 'admin:alice',
    });
    expect(retry).toHaveBeenCalledWith({
      id: 'knowledge_publication_1',
      requestedBy: 'admin:alice',
    });
  });

  it('reserves trusted-author management for administrators and stamps the verifier', async () => {
    const trustAuthor = vi
      .fn<KnowledgeGovernanceService['trustAuthor']>()
      .mockResolvedValue(trustedAuthor());
    const services = knowledgeAdminServices({ governance: governance({ trustAuthor }) });
    const payload = {
      chatId: '-100123',
      role: 'administrator',
      userId: '456',
      validFrom: '2026-07-01T00:00:00.000Z',
    };

    const publisherResponse = await callAdmin({
      authenticator: authenticator('publisher'),
      body: payload,
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/trusted-authors',
    });
    const adminResponse = await callAdmin({
      authenticator: authenticator('admin'),
      body: payload,
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/trusted-authors',
    });
    const forgedSourceResponse = await callAdmin({
      authenticator: authenticator('admin'),
      body: { ...payload, verificationSource: 'telegram_api' },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/trusted-authors',
    });

    expect(publisherResponse.statusCode).toBe(403);
    expect(adminResponse.statusCode).toBe(201);
    expect(forgedSourceResponse.statusCode).toBe(400);
    expect(trustAuthor).toHaveBeenCalledWith({
      ...payload,
      verificationSource: 'manual',
      verifiedBy: 'admin:alice',
    });
  });

  it('limits Telegram imports and never accepts an explicit administrator override', async () => {
    const importTelegram = vi.fn<KnowledgeAdminServices['importTelegram']>().mockResolvedValue({
      adminReplyCount: 1,
      agentCandidateCount: 0,
      agentRunStats: {
        attemptedThreadCount: 0,
        eligibleThreadCount: 0,
        failedThreadCount: 0,
        failureCounts: {
          invalid_output: 0,
          provider_error: 0,
          timeout: 0,
          unknown: 0,
        },
        modelAvailable: false,
        skippedBudgetThreadCount: 0,
        skippedByModeThreadCount: 0,
        skippedUnavailableThreadCount: 0,
        succeededThreadCount: 0,
      },
      candidateCount: 1,
      created: [],
      curationMode: 'auto',
      deterministicCandidateCount: 1,
      duplicateCount: 0,
      messageCount: 2,
      rejectedAgentProposalCount: 0,
      runId: 'run-1',
      skippedBoundaryCount: 0,
      skippedMissingReplyCount: 0,
      threadCount: 1,
      unverifiedAuthorMessageCount: 0,
      verifiedAuthorMessageCount: 1,
    });
    const services = knowledgeAdminServices({ importTelegram });

    const forged = await callAdmin({
      authenticator: authenticator('admin'),
      body: { adminUserIds: ['attacker'], rawExport: {}, useAgent: false },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/imports/telegram',
    });
    const tooLarge = await callAdmin({
      authenticator: authenticator('admin'),
      body: { rawExport: { text: 'x'.repeat(200) } },
      getServices: () => Promise.resolve(services),
      maxBodyBytes: 32,
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/imports/telegram',
    });

    expect(forged.statusCode).toBe(400);
    expect(tooLarge.statusCode).toBe(413);
    expect(importTelegram).not.toHaveBeenCalled();
  });

  it('defaults Telegram imports to auto curation and maps the legacy agent flag', async () => {
    const importTelegram = vi
      .fn<KnowledgeAdminServices['importTelegram']>()
      .mockRejectedValue(new Error('stop after input capture'));
    const services = knowledgeAdminServices({ importTelegram });

    await callAdmin({
      authenticator: authenticator('admin'),
      body: { rawExport: { messages: [] } },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/imports/telegram',
    });
    await callAdmin({
      authenticator: authenticator('admin'),
      body: { rawExport: { messages: [] }, useAgent: true },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/imports/telegram',
    });

    expect(importTelegram).toHaveBeenNthCalledWith(1, {
      curationMode: 'auto',
      rawExport: { messages: [] },
    });
    expect(importTelegram).toHaveBeenNthCalledWith(2, {
      curationMode: 'required',
      rawExport: { messages: [] },
    });
  });

  it('reports knowledge database connectivity failures as unavailable', async () => {
    const listCandidates = vi
      .fn<KnowledgeGovernanceService['listCandidates']>()
      .mockRejectedValue(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }));

    const response = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () =>
        Promise.resolve(knowledgeAdminServices({ governance: governance({ listCandidates }) })),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/candidates',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json).toMatchObject({ error: 'knowledge_store_unavailable' });
  });
});

interface CapturedResponse {
  body: string;
  headers: Record<string, string>;
  json: unknown;
  statusCode: number;
}

async function callAdmin(input: {
  authenticator: ReturnType<typeof createKnowledgeAdminAuthenticator>;
  getServices: () => Promise<KnowledgeAdminServices>;
  method: string;
  url: string;
  body?: unknown;
  maxBodyBytes?: number;
  token?: string;
}): Promise<CapturedResponse> {
  const chunks = input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body), 'utf8')];
  const request: ApiRequestLike = {
    headers: input.token === undefined ? {} : { authorization: `Bearer ${input.token}` },
    method: input.method,
    url: input.url,
    [Symbol.asyncIterator]() {
      return Readable.from(chunks)[Symbol.asyncIterator]();
    },
  };
  const captured: CapturedResponse = { body: '', headers: {}, json: undefined, statusCode: 200 };
  const response: ApiResponseLike = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    end(body) {
      if (body !== undefined) {
        captured.body += typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
      }
    },
    setHeader(name, value) {
      captured.headers[name] = value;
    },
    write(body) {
      captured.body += body;
    },
  };
  await handleKnowledgeAdminApi({
    authenticator: input.authenticator,
    getServices: input.getServices,
    maxBodyBytes: input.maxBodyBytes ?? 1024 * 1024,
    request,
    requestUrl: new URL(input.url, 'http://localhost'),
    response,
  });
  captured.json = captured.body.length === 0 ? undefined : (JSON.parse(captured.body) as unknown);
  return captured;
}

function authenticator(role: 'admin' | 'publisher' | 'reviewer' | 'viewer') {
  return createKnowledgeAdminAuthenticator(
    JSON.stringify([
      {
        displayName: 'Alice',
        id: 'alice',
        role,
        tokenHash: hashKnowledgeAdminToken(TOKEN),
      },
    ]),
  );
}

function governance(
  overrides: Partial<KnowledgeGovernanceService> = {},
): KnowledgeGovernanceService {
  return {
    approve: () => Promise.reject(new Error('not used')),
    getCandidate: () => Promise.resolve(undefined),
    getCandidateDetail: () => Promise.resolve(undefined),
    getCandidateHistory: () => Promise.resolve({ auditEvents: [], reviews: [], revisions: [] }),
    importTelegram: () => Promise.reject(new Error('not used')),
    listCandidates: () => Promise.resolve([]),
    listTrustedAuthors: () => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    reject: () => Promise.reject(new Error('not used')),
    revise: () => Promise.reject(new Error('not used')),
    trustAuthor: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function publicationStore(
  overrides: Partial<PgKnowledgePublicationJobStore> = {},
): PgKnowledgePublicationJobStore {
  return {
    claim: () => Promise.reject(new Error('not used')),
    claimNext: () => Promise.resolve(undefined),
    complete: () => Promise.reject(new Error('not used')),
    fail: () => Promise.reject(new Error('not used')),
    get: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    request: () => Promise.reject(new Error('not used')),
    retry: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function knowledgeAdminServices(
  overrides: Partial<KnowledgeAdminServices> = {},
): KnowledgeAdminServices {
  return {
    governance: governance(),
    importTelegram: () => Promise.reject(new Error('not used')),
    publicationJobs: publicationStore(),
    ...overrides,
  };
}

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    canonicalAnswer: '标准答案',
    contentHash: 'hash',
    createdAt: '2026-07-21T00:00:00.000Z',
    currentRevision: 1,
    id: 'knowledge_candidate_1',
    question: '标准问题',
    sourceChannel: 'telegram_export' as const,
    status: 'pending' as const,
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function publication(overrides: Partial<KnowledgePublicationJob> = {}): KnowledgePublicationJob {
  return {
    attemptCount: 0,
    candidateId: 'knowledge_candidate_1',
    createdAt: '2026-07-21T00:00:00.000Z',
    id: 'knowledge_publication_1',
    requestedBy: 'admin:alice',
    status: 'queued',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function trustedAuthor() {
  return {
    chatId: '-100123',
    createdAt: '2026-07-21T00:00:00.000Z',
    id: 'trusted_author_1',
    role: 'administrator' as const,
    updatedAt: '2026-07-21T00:00:00.000Z',
    userId: '456',
    validFrom: '2026-07-01T00:00:00.000Z',
    verificationSource: 'manual' as const,
    verifiedAt: '2026-07-21T00:00:00.000Z',
    verifiedBy: 'admin:alice',
  };
}
