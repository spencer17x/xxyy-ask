import { z } from 'zod';

import {
  InvalidKnowledgeCandidateStateError,
  InvalidKnowledgePublicationJobStateError,
  KnowledgePublicationJobNotFoundError,
  UnverifiedTelegramKnowledgeAuthorError,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from '@xxyy/rag-core';
import type {
  ImportTelegramKnowledgeResult,
  KnowledgeGovernanceService,
  KnowledgePublicationJobStatus,
  PgKnowledgePublicationJobStore,
} from '@xxyy/rag-core';

import type { ApiRequestLike, ApiResponseLike } from './index.js';
import {
  hasKnowledgeAdminPermission,
  type KnowledgeAdminAuthenticator,
  type KnowledgeAdminPermission,
  type KnowledgeAdminPrincipal,
} from './knowledge-admin-auth.js';

export interface KnowledgeAdminServices {
  governance: KnowledgeGovernanceService;
  publicationJobs: PgKnowledgePublicationJobStore;
  importTelegram(input: {
    rawExport: unknown;
    useAgent: boolean;
  }): Promise<ImportTelegramKnowledgeResult>;
}

export interface HandleKnowledgeAdminApiOptions {
  authenticator: KnowledgeAdminAuthenticator;
  getServices: () => Promise<KnowledgeAdminServices>;
  maxBodyBytes: number;
  request: ApiRequestLike;
  requestUrl: URL;
  response: ApiResponseLike;
}

const candidateStatusSchema = z.enum(['approved', 'pending', 'published', 'rejected']);
const publicationStatusSchema = z.enum(['failed', 'queued', 'running', 'succeeded']);

const reviseCandidateSchema = z
  .object({
    canonicalAnswer: z.string().trim().min(1).max(20_000).optional(),
    evidence: z.string().trim().min(1).max(20_000).optional(),
    proposedModule: z.string().trim().min(1).max(120).optional(),
    proposedTitle: z.string().trim().min(1).max(160).optional(),
    question: z.string().trim().min(1).max(2_000).optional(),
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one revision field is required.');

const approveCandidateSchema = z
  .object({
    effectiveAt: z.iso.datetime({ offset: true }),
    note: z.string().trim().max(2_000).optional(),
    sourceUrl: z.url().startsWith('https://').optional(),
    supersedes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(500)
          .regex(/^[A-Za-z0-9_.:/-]+$/u),
      )
      .max(100)
      .optional(),
  })
  .strict();

const rejectCandidateSchema = z
  .object({
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

const trustAuthorSchema = z
  .object({
    chatId: z.string().trim().min(1).max(160),
    role: z.enum(['administrator', 'knowledge_editor', 'owner']),
    userId: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9_:@.-]+$/u),
    validFrom: z.iso.datetime({ offset: true }),
    validTo: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.validTo === undefined || Date.parse(value.validTo) > Date.parse(value.validFrom),
    { message: 'validTo must be later than validFrom.', path: ['validTo'] },
  );

const importTelegramSchema = z
  .object({
    rawExport: z.unknown().refine((value) => value !== undefined, 'rawExport is required.'),
    useAgent: z.boolean().default(false),
  })
  .strict();

export function isKnowledgeAdminApiPath(pathname: string): boolean {
  return pathname === '/admin/api' || pathname.startsWith('/admin/api/');
}

export async function handleKnowledgeAdminApi(
  options: HandleKnowledgeAdminApiOptions,
): Promise<void> {
  setAdminSecurityHeaders(options.response);
  if (!options.authenticator.configured) {
    sendJson(options.response, 503, {
      error: 'knowledge_admin_not_configured',
      message: 'Knowledge administration is disabled until administrator tokens are configured.',
    });
    return;
  }

  const principal = options.authenticator.authenticate(
    headerValue(options.request.headers.authorization),
  );
  if (principal === undefined) {
    options.response.setHeader('WWW-Authenticate', 'Bearer realm="xxyy-knowledge-admin"');
    sendJson(options.response, 401, {
      error: 'unauthorized',
      message: 'A valid knowledge administrator token is required.',
    });
    return;
  }

  try {
    await routeKnowledgeAdminRequest(options, principal);
  } catch (error) {
    sendKnowledgeAdminError(options.response, error);
  }
}

async function routeKnowledgeAdminRequest(
  options: HandleKnowledgeAdminApiOptions,
  principal: KnowledgeAdminPrincipal,
): Promise<void> {
  const segments = parseAdminPathSegments(options.requestUrl.pathname);
  const method = options.request.method ?? 'GET';

  if (method === 'GET' && segments.length === 1 && segments[0] === 'me') {
    sendJson(options.response, 200, {
      principal,
      permissions: knowledgeAdminPermissions(principal),
    });
    return;
  }

  const services = await options.getServices();

  if (segments[0] === 'candidates') {
    await routeCandidateRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'publications') {
    await routePublicationRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'trusted-authors') {
    await routeTrustedAuthorRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'imports' && segments[1] === 'telegram' && segments.length === 2) {
    requirePermission(principal, 'import:telegram');
    requireMethod(method, 'POST');
    const payload = importTelegramSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const result = await services.importTelegram(payload);
    sendJson(options.response, 201, result);
    return;
  }

  sendNotFound(options.response);
}

async function routeCandidateRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  requirePermission(principal, 'candidate:read');
  if (segments.length === 0) {
    requireMethod(method, 'GET');
    const statusValue = options.requestUrl.searchParams.get('status') ?? undefined;
    const status = statusValue === undefined ? undefined : candidateStatusSchema.parse(statusValue);
    const candidates = await services.governance.listCandidates({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
      ...(status === undefined ? {} : { status }),
    });
    sendJson(options.response, 200, { candidates });
    return;
  }

  const candidateId = requiredPathSegment(segments[0], 'candidate id');
  if (segments.length === 1 && method === 'GET') {
    const detail = await services.governance.getCandidateDetail(candidateId);
    if (detail === undefined) {
      sendNotFound(options.response, 'Knowledge candidate was not found.');
      return;
    }
    const publications = await services.publicationJobs.list({ candidateId, limit: 20 });
    sendJson(options.response, 200, { ...detail, publications });
    return;
  }

  if (segments.length === 1 && method === 'PATCH') {
    requirePermission(principal, 'candidate:review');
    const payload = reviseCandidateSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const candidate = await services.governance.revise({
      editedBy: adminActor(principal),
      id: candidateId,
      ...(payload.canonicalAnswer === undefined
        ? {}
        : { canonicalAnswer: payload.canonicalAnswer }),
      ...(payload.evidence === undefined ? {} : { evidence: payload.evidence }),
      ...(payload.proposedModule === undefined ? {} : { proposedModule: payload.proposedModule }),
      ...(payload.proposedTitle === undefined ? {} : { proposedTitle: payload.proposedTitle }),
      ...(payload.question === undefined ? {} : { question: payload.question }),
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    });
    sendJson(options.response, 200, { candidate });
    return;
  }

  if (segments.length === 2 && segments[1] === 'approve') {
    requirePermission(principal, 'candidate:review');
    requireMethod(method, 'POST');
    const payload = approveCandidateSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const candidate = await services.governance.approve({
      effectiveAt: payload.effectiveAt,
      id: candidateId,
      reviewedBy: adminActor(principal),
      ...(payload.note === undefined ? {} : { note: payload.note }),
      ...(payload.sourceUrl === undefined ? {} : { sourceUrl: payload.sourceUrl }),
      ...(payload.supersedes === undefined ? {} : { supersedes: payload.supersedes }),
    });
    sendJson(options.response, 200, { candidate });
    return;
  }

  if (segments.length === 2 && segments[1] === 'reject') {
    requirePermission(principal, 'candidate:review');
    requireMethod(method, 'POST');
    const payload = rejectCandidateSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const candidate = await services.governance.reject({
      id: candidateId,
      reviewedBy: adminActor(principal),
      ...(payload.note === undefined ? {} : { note: payload.note }),
    });
    sendJson(options.response, 200, { candidate });
    return;
  }

  if (segments.length === 2 && segments[1] === 'publication') {
    requirePermission(principal, 'publication:request');
    requireMethod(method, 'POST');
    const publication = await services.publicationJobs.request({
      candidateId,
      requestedBy: adminActor(principal),
    });
    sendJson(options.response, 202, { publication });
    return;
  }

  sendNotFound(options.response);
}

async function routePublicationRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  requirePermission(principal, 'candidate:read');
  if (segments.length === 0) {
    requireMethod(method, 'GET');
    const statusValue = options.requestUrl.searchParams.get('status') ?? undefined;
    const status: KnowledgePublicationJobStatus | undefined =
      statusValue === undefined ? undefined : publicationStatusSchema.parse(statusValue);
    const publications = await services.publicationJobs.list({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
      ...(status === undefined ? {} : { status }),
    });
    sendJson(options.response, 200, { publications });
    return;
  }

  if (segments.length === 2 && segments[1] === 'retry') {
    requirePermission(principal, 'publication:request');
    requireMethod(method, 'POST');
    const publication = await services.publicationJobs.retry({
      id: requiredPathSegment(segments[0], 'publication job id'),
      requestedBy: adminActor(principal),
    });
    sendJson(options.response, 202, { publication });
    return;
  }

  sendNotFound(options.response);
}

async function routeTrustedAuthorRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  if (segments.length !== 0) {
    sendNotFound(options.response);
    return;
  }
  requirePermission(principal, 'candidate:read');
  if (method === 'GET') {
    const chatId = options.requestUrl.searchParams.get('chatId')?.trim();
    const activeAt = options.requestUrl.searchParams.get('activeAt')?.trim();
    const authors = await services.governance.listTrustedAuthors({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
      ...(chatId === undefined || chatId.length === 0 ? {} : { chatId }),
      ...(activeAt === undefined || activeAt.length === 0 ? {} : { activeAt }),
    });
    sendJson(options.response, 200, { authors });
    return;
  }
  requirePermission(principal, 'trusted_author:manage');
  requireMethod(method, 'POST');
  const payload = trustAuthorSchema.parse(
    await readJsonBody(options.request, options.maxBodyBytes),
  );
  const author = await services.governance.trustAuthor({
    chatId: payload.chatId,
    role: payload.role,
    userId: payload.userId,
    validFrom: payload.validFrom,
    verificationSource: 'manual',
    verifiedBy: adminActor(principal),
    ...(payload.validTo === undefined ? {} : { validTo: payload.validTo }),
  });
  sendJson(options.response, 201, { author });
}

function knowledgeAdminPermissions(principal: KnowledgeAdminPrincipal): KnowledgeAdminPermission[] {
  const permissions: KnowledgeAdminPermission[] = [
    'candidate:read',
    'candidate:review',
    'import:telegram',
    'publication:request',
    'trusted_author:manage',
  ];
  return permissions.filter((permission) => hasKnowledgeAdminPermission(principal, permission));
}

function requirePermission(
  principal: KnowledgeAdminPrincipal,
  permission: KnowledgeAdminPermission,
): void {
  if (!hasKnowledgeAdminPermission(principal, permission)) {
    throw new KnowledgeAdminForbiddenError(permission);
  }
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new KnowledgeAdminMethodNotAllowedError(expected);
  }
}

class KnowledgeAdminForbiddenError extends Error {
  constructor(readonly permission: KnowledgeAdminPermission) {
    super(`Administrator role does not grant ${permission}.`);
    this.name = 'KnowledgeAdminForbiddenError';
  }
}

class KnowledgeAdminMethodNotAllowedError extends Error {
  constructor(readonly allowedMethod: string) {
    super(`This route only supports ${allowedMethod}.`);
    this.name = 'KnowledgeAdminMethodNotAllowedError';
  }
}

class KnowledgeAdminBodyTooLargeError extends Error {
  constructor() {
    super('Knowledge administration request body is too large.');
    this.name = 'KnowledgeAdminBodyTooLargeError';
  }
}

function parseAdminPathSegments(pathname: string): string[] {
  const suffix = pathname.slice('/admin/api'.length);
  return suffix
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function requiredPathSegment(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0 || value.length > 500) {
    throw new Error(`${field} is invalid.`);
  }
  return value.trim();
}

function parseLimit(rawValue: string | null): number {
  if (rawValue === null || rawValue.trim().length === 0) {
    return 50;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error('limit must be an integer between 1 and 500.');
  }
  return value;
}

function adminActor(principal: KnowledgeAdminPrincipal): string {
  return `admin:${principal.id}`;
}

async function readJsonBody(request: ApiRequestLike, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const rawChunk of request) {
    const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk) : rawChunk;
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new KnowledgeAdminBodyTooLargeError();
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('Request body must be valid JSON.', { cause: error });
  }
}

function setAdminSecurityHeaders(response: ApiResponseLike): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

function sendKnowledgeAdminError(response: ApiResponseLike, error: unknown): void {
  if (error instanceof z.ZodError) {
    sendJson(response, 400, {
      error: 'invalid_request',
      message: 'Knowledge administration request validation failed.',
      issues: error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
    });
    return;
  }
  if (error instanceof KnowledgeAdminBodyTooLargeError) {
    sendJson(response, 413, { error: 'payload_too_large', message: error.message });
    return;
  }
  if (error instanceof KnowledgeAdminForbiddenError) {
    sendJson(response, 403, { error: 'forbidden', message: error.message });
    return;
  }
  if (error instanceof KnowledgeAdminMethodNotAllowedError) {
    response.setHeader('Allow', error.allowedMethod);
    sendJson(response, 405, { error: 'method_not_allowed', message: error.message });
    return;
  }
  if (
    error instanceof InvalidKnowledgeCandidateStateError ||
    error instanceof InvalidKnowledgePublicationJobStateError
  ) {
    sendJson(response, 409, { error: 'invalid_state', message: error.message });
    return;
  }
  if (error instanceof KnowledgePublicationJobNotFoundError) {
    sendJson(response, 404, { error: 'not_found', message: error.message });
    return;
  }
  if (error instanceof UnverifiedTelegramKnowledgeAuthorError) {
    sendJson(response, 422, { error: 'unverified_knowledge_author', message: error.message });
    return;
  }
  if (
    error instanceof VectorStoreConfigurationError ||
    error instanceof VectorStoreUnavailableError
  ) {
    sendJson(response, 503, {
      error: 'knowledge_store_unavailable',
      message: error.message,
    });
    return;
  }
  if (isKnowledgeStoreUnavailableError(error)) {
    sendJson(response, 503, {
      error: 'knowledge_store_unavailable',
      message: 'Knowledge governance database is unavailable.',
    });
    return;
  }
  if (error instanceof URIError) {
    sendJson(response, 400, { error: 'invalid_path', message: 'Request path is invalid.' });
    return;
  }
  if (error instanceof Error && isSafeAdminInputError(error.message)) {
    sendJson(response, 400, { error: 'invalid_request', message: error.message });
    return;
  }
  sendJson(response, 500, {
    error: 'knowledge_admin_internal_error',
    message: 'Knowledge administration operation failed.',
  });
}

function isSafeAdminInputError(message: string): boolean {
  return /^(?:Request body|limit |candidate id |publication job id |Knowledge Curator Agent|Telegram export|Invalid Telegram export)/u.test(
    message,
  );
}

function isKnowledgeStoreUnavailableError(error: unknown, seen = new Set<unknown>()): boolean {
  if (error === null || typeof error !== 'object' || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (
    code !== undefined &&
    (/^08/u.test(code) ||
      [
        '57P01',
        '57P02',
        '57P03',
        'ECONNREFUSED',
        'ECONNRESET',
        'ENOTFOUND',
        'EPIPE',
        'ETIMEDOUT',
      ].includes(code))
  ) {
    return true;
  }
  return 'cause' in error && isKnowledgeStoreUnavailableError(error.cause, seen);
}

function sendNotFound(response: ApiResponseLike, message = 'Admin route not found.'): void {
  sendJson(response, 404, { error: 'not_found', message });
}

function sendJson(response: ApiResponseLike, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
