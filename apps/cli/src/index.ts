import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  EmbeddingConfigurationError,
  createOpenAiEmbeddingProvider,
  loadProductDocuments,
  prepareKnowledgeChunks,
  type PreparedKnowledgeChunk,
} from '@xxyy/knowledge';
import {
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
  createChatService,
  createLazyRetriever,
  createPgPool,
  createPgVectorStore,
  evaluateCases,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
} from '@xxyy/rag-core';
import type { ChatResponse, ChatRequest } from '@xxyy/shared';
import type {
  ChatService,
  EmbeddedKnowledgeChunk,
  EvaluationCase,
  EvaluationReport,
  RagEnv,
} from '@xxyy/rag-core';

export { resolveWorkspaceCwd } from '@xxyy/rag-core';

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

interface DefaultCliIoOptions {
  cwd?: string;
  env?: CliEnv;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
}

interface CliChatRuntime {
  service: ChatService;
  close(): Promise<void>;
}

const HELP_TEXT = [
  'Usage:',
  '  pnpm rag:ingest',
  '  pnpm rag:ask -- "question"',
  '  pnpm rag:evaluate',
].join('\n');

const EMBEDDING_BATCH_SIZE = 64;

export const BUILT_IN_EVALUATION_CASES: EvaluationCase[] = [
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
    name: 'wallet note x source',
    request: { channel: 'cli', message: '钱包备注支持最多 1 万条是哪条推文？' },
    expectedIntent: 'product_qa',
    minCitations: 1,
  },
  {
    name: 'wallet monitoring limit updates',
    request: { channel: 'cli', message: '钱包监控上限历史更新记录有哪些？' },
    expectedIntent: 'product_qa',
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
    return appendAttachments([...lines, 'Citations: none'], response).join('\n');
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

  return appendAttachments(lines, response).join('\n');
}

function appendAttachments(lines: string[], response: ChatResponse): string[] {
  if (response.attachments === undefined || response.attachments.length === 0) {
    return lines;
  }

  lines.push('', 'Attachments:');
  response.attachments.forEach((attachment, index) => {
    lines.push(`[${index + 1}] ${attachment.title}`);
    lines.push(`    ${attachment.url}`);
  });
  return lines;
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

export function createDefaultCliIo(options: DefaultCliIoOptions = {}): CliIo {
  const cwd = options.cwd ?? process.cwd();
  const shellEnv = options.env ?? process.env;
  const workspaceCwd = resolveWorkspaceCwd(cwd, shellEnv);

  return {
    cwd,
    env: loadWorkspaceEnv({ cwd: workspaceCwd, env: shellEnv }),
    stderr: options.stderr ?? process.stderr,
    stdout: options.stdout ?? process.stdout,
  };
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  io: CliIo = createDefaultCliIo(),
): Promise<number> {
  const parsed = parseCliArgs(args);
  const workspaceCwd = resolveWorkspaceCwd(io.cwd, io.env);

  if (parsed.command === 'help') {
    writeLine(io.stderr, [parsed.error, HELP_TEXT].filter(Boolean).join('\n\n'));
    return parsed.error === undefined ? 0 : 1;
  }

  if (parsed.command === 'ingest') {
    try {
      const summary = await ingest({ ...io, cwd: workspaceCwd });
      writeLine(io.stdout, formatIngestSummary(summary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  const config = loadRagConfig(io.env);

  try {
    const runtime = createCliChatRuntime(config);
    try {
      const service = runtime.service;

      if (parsed.command === 'ask') {
        const request: ChatRequest = { channel: 'cli', message: parsed.question };
        const response = await service.ask(request);
        writeLine(io.stdout, formatChatResponse(response));
        return 0;
      }

      const report = await evaluateCases(BUILT_IN_EVALUATION_CASES, service);
      writeLine(io.stdout, formatEvaluationReport(report));
      return report.passed === report.total ? 0 : 1;
    } finally {
      await runtime.close();
    }
  } catch (error) {
    if (writeConfigurationError(io, error)) {
      return 1;
    }
    throw error;
  }
}

async function ingest(io: CliIo): Promise<IngestSummary> {
  const config = loadRagConfig(io.env);
  const documents = await loadProductDocuments({ cwd: io.cwd });
  const chunks = prepareKnowledgeChunks(documents);
  const pool = createPgPool(config.databaseUrl);

  try {
    const embeddingProvider = createOpenAiEmbeddingProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiEmbeddingModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    const store = createPgVectorStore({ client: pool, embeddingProvider });
    await store.migrate();
    const embeddedChunks = await embedPreparedChunks(chunks, embeddingProvider);
    await store.replaceChunks(embeddedChunks);
  } finally {
    await pool.end();
  }

  return {
    documentCount: documents.length,
    chunkCount: chunks.length,
    indexPath: 'pgvector',
  };
}

async function embedPreparedChunks(
  chunks: PreparedKnowledgeChunk[],
  embeddingProvider: { embedTexts(texts: string[]): Promise<number[][]> },
): Promise<EmbeddedKnowledgeChunk[]> {
  const embeddedChunks: EmbeddedKnowledgeChunk[] = [];

  for (let index = 0; index < chunks.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(index, index + EMBEDDING_BATCH_SIZE);
    const embeddings = await embeddingProvider.embedTexts(
      batch.map((chunk) => chunk.searchableText),
    );
    batch.forEach((chunk, batchIndex) => {
      const embedding = embeddings[batchIndex];
      if (embedding === undefined) {
        throw new Error(`Missing embedding for chunk ${chunk.id}.`);
      }
      embeddedChunks.push({ ...chunk, embedding });
    });
  }

  return embeddedChunks;
}

function createCliChatRuntime(config: ReturnType<typeof loadRagConfig>): CliChatRuntime {
  let pool: ReturnType<typeof createPgPool> | undefined;
  const retriever = createLazyRetriever(async () => {
    const nextPool = createPgPool(config.databaseUrl);

    try {
      const embeddingProvider = createOpenAiEmbeddingProvider({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        maxRetries: config.openAiMaxRetries,
        model: config.openAiEmbeddingModel,
        requestTimeoutMs: config.openAiRequestTimeoutMs,
      });
      pool = nextPool;
      return createPgVectorStore({ client: nextPool, embeddingProvider });
    } catch (error) {
      await nextPool.end();
      throw error;
    }
  });

  return {
    service: createChatService({ config, retriever }),
    close: async () => {
      const currentPool = pool;
      pool = undefined;
      await currentPool?.end();
    },
  };
}

function writeLine(stream: Pick<NodeJS.WriteStream, 'write'>, message: string): void {
  stream.write(`${message}\n`);
}

function writeConfigurationError(io: CliIo, error: unknown): boolean {
  if (error instanceof EmbeddingConfigurationError) {
    writeLine(io.stderr, error.message);
    return true;
  }

  if (error instanceof VectorStoreConfigurationError) {
    writeLine(io.stderr, error.message);
    return true;
  }

  if (error instanceof VectorStoreUnavailableError) {
    writeLine(io.stderr, error.message);
    return true;
  }

  return false;
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
