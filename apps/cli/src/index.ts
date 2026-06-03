import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildKnowledgeIndex,
  loadKnowledgeIndex,
  loadProductDocuments,
  saveKnowledgeIndex,
} from '@xxyy/knowledge';
import { createChatService, evaluateCases, loadRagConfig } from '@xxyy/rag-core';
import type { ChatResponse, ChatRequest } from '@xxyy/shared';
import type { EvaluationCase, EvaluationReport, RagEnv } from '@xxyy/rag-core';

type CliEnv = RagEnv & Partial<Record<'INIT_CWD', string>>;

type CliCommand =
  | { command: 'ask'; question: string }
  | { command: 'evaluate' }
  | { command: 'ingest' }
  | { command: 'help'; error?: string };

interface IngestSummary {
  documentCount: number;
  chunkCount: number;
  indexPath: string;
}

interface CliIo {
  cwd: string;
  env: CliEnv;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
}

const HELP_TEXT = [
  'Usage:',
  '  pnpm rag:ingest',
  '  pnpm rag:ask -- "question"',
  '  pnpm rag:evaluate',
].join('\n');

const BUILT_IN_EVALUATION_CASES: EvaluationCase[] = [
  {
    name: 'pro benefits',
    request: { channel: 'cli', message: 'XXYY Pro 有哪些权益？' },
    expectedIntent: 'product_qa',
    minCitations: 1,
  },
  {
    name: 'telegram wallet monitoring setup',
    request: { channel: 'cli', message: '如何设置 Telegram 钱包监控？' },
    expectedIntent: 'how_to',
    minCitations: 1,
  },
  {
    name: 'realtime account boundary',
    request: { channel: 'cli', message: '帮我查一下钱包余额' },
    expectedIntent: 'realtime_account_query',
  },
];

export function parseCliArgs(args: readonly string[]): CliCommand {
  const [command, ...rawRest] = args;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (command === 'ingest' || command === 'evaluate') {
    return { command };
  }

  if (command === 'ask') {
    const rest = rawRest[0] === '--' ? rawRest.slice(1) : rawRest;
    const question = rest.join(' ').trim();
    if (question.length === 0) {
      return { command: 'help', error: 'Missing question for rag:ask.' };
    }
    return { command: 'ask', question };
  }

  return { command: 'help', error: `Unknown command: ${command}` };
}

export function formatIngestSummary(summary: IngestSummary): string {
  return [
    `Indexed ${summary.documentCount} documents into ${summary.chunkCount} chunks.`,
    `Saved index: ${summary.indexPath}`,
  ].join('\n');
}

export function formatChatResponse(response: ChatResponse): string {
  const lines = [
    response.answer,
    '',
    `Intent: ${response.intent} (confidence ${response.confidence.toFixed(2)})`,
    '',
  ];

  if (response.citations.length === 0) {
    return [...lines, 'Citations: none'].join('\n');
  }

  lines.push('Citations:');
  response.citations.forEach((citation, index) => {
    lines.push(`[${index + 1}] ${citation.title}`);
    lines.push(`    ${citation.file}`);
    if (citation.sourceUrl !== undefined) {
      lines.push(`    ${citation.sourceUrl}`);
    }
    lines.push(`    ${citation.excerpt}`);
  });

  return lines.join('\n');
}

export function formatEvaluationReport(report: EvaluationReport): string {
  const lines = [`Evaluation: ${report.passed}/${report.total} passed`];

  for (const result of report.results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    lines.push(
      `${status} ${result.name}: expected ${result.expectedIntent}, got ${result.actualIntent}, citations ${result.citationCount}/${result.minCitations}`,
    );
  }

  return lines.join('\n');
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  io: CliIo = {
    cwd: process.cwd(),
    env: process.env,
    stderr: process.stderr,
    stdout: process.stdout,
  },
): Promise<number> {
  const parsed = parseCliArgs(args);
  const workspaceCwd = resolveWorkspaceCwd(io.cwd, io.env);

  if (parsed.command === 'help') {
    writeLine(io.stderr, [parsed.error, HELP_TEXT].filter(Boolean).join('\n\n'));
    return parsed.error === undefined ? 0 : 1;
  }

  if (parsed.command === 'ingest') {
    const summary = await ingest({ ...io, cwd: workspaceCwd });
    writeLine(io.stdout, formatIngestSummary(summary));
    return 0;
  }

  const config = loadRagConfig(io.env);
  const displayIndexPath = config.indexPath;
  const absoluteIndexPath = path.resolve(workspaceCwd, config.indexPath);

  try {
    const index = await loadKnowledgeIndex(absoluteIndexPath);
    const service = createChatService({ config, index });

    if (parsed.command === 'ask') {
      const request: ChatRequest = { channel: 'cli', message: parsed.question };
      const response = await service.ask(request);
      writeLine(io.stdout, formatChatResponse(response));
      return 0;
    }

    const report = await evaluateCases(BUILT_IN_EVALUATION_CASES, service);
    writeLine(io.stdout, formatEvaluationReport(report));
    return report.passed === report.total ? 0 : 1;
  } catch (error) {
    if (isMissingFileError(error)) {
      writeLine(io.stderr, missingIndexMessage(displayIndexPath));
      return 1;
    }
    throw error;
  }
}

export function resolveWorkspaceCwd(cwd: string, env: CliEnv): string {
  const initCwd = env.INIT_CWD;
  if (initCwd !== undefined && hasWorkspaceEvidence(initCwd)) {
    return path.resolve(initCwd);
  }

  if (hasWorkspaceEvidence(cwd)) {
    return path.resolve(cwd);
  }

  return findWorkspaceRoot(cwd) ?? path.resolve(cwd);
}

async function ingest(io: CliIo): Promise<IngestSummary> {
  const config = loadRagConfig(io.env);
  const documents = await loadProductDocuments({ cwd: io.cwd });
  const index = await buildKnowledgeIndex(documents);
  const absoluteIndexPath = path.resolve(io.cwd, config.indexPath);
  await saveKnowledgeIndex(absoluteIndexPath, index);

  return {
    documentCount: documents.length,
    chunkCount: index.entries.length,
    indexPath: config.indexPath,
  };
}

function missingIndexMessage(indexPath: string): string {
  return `Knowledge index not found at ${indexPath}. Run pnpm rag:ingest first.`;
}

function writeLine(stream: Pick<NodeJS.WriteStream, 'write'>, message: string): void {
  stream.write(`${message}\n`);
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

function isDirectRun(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
