import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { KnowledgeCandidateInvalidPublishStatusError } from './knowledge-candidate-store.js';
import type { KnowledgeCandidate, KnowledgeCandidateSourceRef } from './types.js';

export const DEFAULT_REVIEWED_SUPPORT_KNOWLEDGE_TARGET = 'pages/65-reviewed-support-knowledge.md';

export interface PublishKnowledgeCandidateInput {
  candidate: KnowledgeCandidate;
  now?: string;
  productFeaturesDir: string;
  targetFile?: string;
}

export interface PublishKnowledgeCandidateResult {
  candidate: KnowledgeCandidate;
  publishedAt: string;
  publishedTarget: string;
  publishRunId: string;
}

export class KnowledgePublishTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgePublishTargetError';
  }
}

export class KnowledgeCandidateInvalidPublishTypeError extends Error {
  constructor(candidateId: string) {
    super(
      `Knowledge candidate ${candidateId} is an eval-only candidate and cannot be published into product knowledge.`,
    );
    this.name = 'KnowledgeCandidateInvalidPublishTypeError';
  }
}

export async function publishKnowledgeCandidate(
  input: PublishKnowledgeCandidateInput,
): Promise<PublishKnowledgeCandidateResult> {
  const { candidate } = input;
  if (candidate.status !== 'approved') {
    throw new KnowledgeCandidateInvalidPublishStatusError(candidate.id, candidate.status);
  }
  if (isEvalOnlyCandidate(candidate)) {
    throw new KnowledgeCandidateInvalidPublishTypeError(candidate.id);
  }

  const publishedAt = input.now ?? new Date().toISOString();
  const targetFile = normalizeTargetFile(input.targetFile);
  const publishedTarget = `${targetFile}#${candidate.id}`;
  const publishRunId = createPublishRunId({
    candidateId: candidate.id,
    publishedAt,
    publishedTarget,
  });

  await appendPublishedCandidate({
    candidate,
    productFeaturesDir: input.productFeaturesDir,
    publishedAt,
    publishRunId,
    targetFile,
  });

  return {
    candidate: {
      ...candidate,
      publishedTarget,
      status: 'published',
      updatedAt: publishedAt,
    },
    publishedAt,
    publishedTarget,
    publishRunId,
  };
}

async function appendPublishedCandidate(input: {
  candidate: KnowledgeCandidate;
  productFeaturesDir: string;
  publishedAt: string;
  publishRunId: string;
  targetFile: string;
}): Promise<void> {
  const filePath = path.join(input.productFeaturesDir, input.targetFile);
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readTextFileIfExists(filePath);
  const marker = createCandidateMarker(input.candidate.id);
  if (existing.includes(marker)) {
    return;
  }

  const entry = formatCandidateEntry(input);
  if (existing.length === 0) {
    await writeFile(filePath, `${formatReviewedSupportHeader(input.publishedAt)}${entry}`, 'utf8');
    return;
  }

  await appendFile(filePath, `${existing.endsWith('\n') ? '' : '\n'}${entry}`, 'utf8');
}

async function readTextFileIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return '';
    }
    throw error;
  }
}

function formatReviewedSupportHeader(publishedAt: string): string {
  return [
    '---',
    'title: "Reviewed Support Knowledge"',
    'section: "客服审核知识"',
    'category: "知识运营"',
    `retrieved_at: "${publishedAt}"`,
    '---',
    '',
    '# Reviewed Support Knowledge',
    '',
    '以下内容来自人工审核通过的客服候选知识。每条记录保留 candidate id、发布批次和脱敏来源引用，用于审计、回滚和评测追踪。',
    '',
  ].join('\n');
}

function formatCandidateEntry(input: {
  candidate: KnowledgeCandidate;
  publishedAt: string;
  publishRunId: string;
}): string {
  const { candidate } = input;
  const lines = [
    `${createCandidateMarker(candidate.id)}`,
    `## ${candidate.question}`,
    '',
    `- Candidate ID: \`${candidate.id}\``,
    `- Published at: ${input.publishedAt}`,
    `- Publish run: \`${input.publishRunId}\``,
    `- Type: ${candidate.type}`,
    `- Target category: ${candidate.targetCategory}`,
    `- Risk level: ${candidate.riskLevel}`,
    `- Reviewer: \`${candidate.reviewer ?? 'unknown'}\``,
    `- Source refs: ${formatSourceRefs(candidate.sourceRefs)}`,
    '',
    '### Answer',
    '',
    candidate.proposedAnswer,
  ];

  if (candidate.generatedEvalCases.length > 0) {
    lines.push('', '### Generated Eval Cases', '');
    for (const evalCase of candidate.generatedEvalCases) {
      lines.push(`- Q: ${evalCase.question}`, `- Expected: ${evalCase.expectedAnswer}`);
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function createCandidateMarker(candidateId: string): string {
  return `<!-- xxyy-knowledge-candidate:${candidateId} -->`;
}

function isEvalOnlyCandidate(candidate: KnowledgeCandidate): boolean {
  return candidate.type === 'eval_case' && candidate.targetCategory === 'eval_case';
}

function formatSourceRefs(sourceRefs: KnowledgeCandidateSourceRef[]): string {
  if (sourceRefs.length === 0) {
    return 'none';
  }

  return sourceRefs
    .map((ref) =>
      [
        ref.source,
        ref.chatIdHash,
        ref.messageId,
        ...(ref.threadId === undefined ? [] : [ref.threadId]),
      ].join(':'),
    )
    .map((value) => `\`${value}\``)
    .join(', ');
}

function normalizeTargetFile(targetFile: string | undefined): string {
  const normalized = (targetFile ?? DEFAULT_REVIEWED_SUPPORT_KNOWLEDGE_TARGET)
    .trim()
    .replace(/\\/gu, '/');
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.includes('..')) {
    throw new KnowledgePublishTargetError('Publish target must be a relative Markdown file.');
  }
  if (!normalized.startsWith('pages/')) {
    throw new KnowledgePublishTargetError(
      'Publish target must be under docs/product-features/pages so product ingest can load it.',
    );
  }
  if (!normalized.endsWith('.md')) {
    throw new KnowledgePublishTargetError('Publish target must be a Markdown file.');
  }

  return normalized;
}

function createPublishRunId(input: {
  candidateId: string;
  publishedAt: string;
  publishedTarget: string;
}): string {
  const timestamp = input.publishedAt
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '')
    .replace(/\+.*$/u, 'Z');
  const hash = createHash('sha256')
    .update(`${input.candidateId}\0${input.publishedAt}\0${input.publishedTarget}`)
    .digest('hex')
    .slice(0, 8);

  return `publish_${timestamp}_${hash}`;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
