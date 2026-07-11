import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCustomerAgentChatService } from '@xxyy/agent-core';
import {
  EmbeddingConfigurationError,
  createLocalHashEmbedding,
  createOpenAiEmbeddingProvider,
  loadProductDocuments,
  prepareKnowledgeChunks,
  type PreparedKnowledgeChunk,
} from '@xxyy/knowledge';
import {
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
  AnswerJudgeConfigurationError,
  aggregateRetrievalResults,
  createLazyRetriever,
  createLocalRetriever,
  createOpenAiAnswerQualityJudge,
  createOpenAiAnswerProvider,
  createPgFeedbackStore,
  createPgPool,
  createPgVectorStore,
  createQualityTracerFromEnv,
  createChatService,
  createGroundedAnswer,
  createMetadataReranker,
  createRerankingRetriever,
  evaluateRetrievalRanking,
  evaluateCases,
  formatEvaluationFailureJsonl,
  formatRetrievedChunksDebug,
  LlmConfigurationError,
  QualityTracingConfigurationError,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
} from '@xxyy/rag-core';
import type {
  AnswerProvider,
  AnswerQualityJudge,
  ChatService,
  EmbeddedKnowledgeChunk,
  EvaluationCase,
  EvaluationReport,
  EvaluationResult,
  FeedbackRecord,
  KnowledgeStats,
  RagEnv,
  QualityTracer,
  Retriever,
} from '@xxyy/rag-core';
import type { ChatRequest, ChatResponse, RagIndex } from '@xxyy/shared';

export { resolveWorkspaceCwd } from '@xxyy/rag-core';

type CliEnv = RagEnv &
  Partial<
    Record<
      | 'APP_REVISION'
      | 'EVAL_JUDGE_MODEL'
      | 'INIT_CWD'
      | 'LANGSMITH_API_KEY'
      | 'LANGSMITH_ENDPOINT'
      | 'LANGSMITH_PROJECT'
      | 'LANGSMITH_TRACING'
      | 'QUALITY_TRACE_SAMPLE_RATE',
      string
    >
  >;

type CliCommand =
  | { command: 'ask'; debugRetrieve: boolean; question: string }
  | {
      command: 'evaluate';
      failuresOut?: string;
      judge: boolean;
      providerBacked: boolean;
    }
  | { command: 'feedback:backlog' }
  | { command: 'ingest'; rebuildEmbeddingSchema: boolean }
  | { command: 'migrate' }
  | { command: 'stats' }
  | { command: 'sync:x' }
  | { command: 'help'; error?: string };

interface IngestSummary {
  documentCount: number;
  chunkCount: number;
  indexPath: string;
  runId?: string;
}

interface SyncXUpdatesSummary {
  changedChunkCount: number;
  chunkCount: number;
  documentCount: number;
  indexPath: string;
  skippedChunkCount: number;
  runId?: string;
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
  retriever: Retriever;
  close(): Promise<void>;
}

const HELP_TEXT = [
  'Usage:',
  '  pnpm rag:ingest [--rebuild-embedding-schema]',
  '  pnpm rag:sync:x',
  '  pnpm rag:migrate',
  '  pnpm rag:stats',
  '  pnpm rag:evaluate [--provider] [--judge] [--failures-out .rag/failures.jsonl]',
  '  pnpm rag:feedback:backlog',
  '  pnpm rag:ask -- "question"',
  '  pnpm rag:ask -- --debug-retrieve "question"',
].join('\n');

const EMBEDDING_BATCH_SIZE = 64;

export function parseCliArgs(args: readonly string[]): CliCommand {
  const [command, ...rawRest] = args;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (
    command === 'evaluate' ||
    command === 'feedback:backlog' ||
    command === 'migrate' ||
    command === 'stats' ||
    command === 'sync:x'
  ) {
    if (command === 'evaluate') {
      return parseEvaluateArgs(rawRest);
    }
    return { command };
  }

  if (command === 'ingest') {
    return parseIngestArgs(rawRest);
  }

  if (command === 'ask') {
    return parseAskArgs(rawRest);
  }

  return { command: 'help', error: `Unknown command: ${command}` };
}

function parseEvaluateArgs(rawArgs: readonly string[]): CliCommand {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  let failuresOut: string | undefined;
  let judge = false;
  let providerBacked = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--provider') {
      providerBacked = true;
      continue;
    }
    if (arg === '--judge') {
      judge = true;
      continue;
    }
    if (arg === '--failures-out') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { command: 'help', error: 'Missing path for --failures-out.' };
      }
      if (!isSafeEvaluationOutputPath(value)) {
        return { command: 'help', error: '--failures-out must be a file under .rag/.' };
      }
      failuresOut = value;
      index += 1;
      continue;
    }
    return { command: 'help', error: `Unknown rag:evaluate option: ${arg}` };
  }

  if (judge && !providerBacked) {
    return { command: 'help', error: '--judge requires --provider.' };
  }

  return {
    command: 'evaluate',
    ...(failuresOut === undefined ? {} : { failuresOut }),
    judge,
    providerBacked,
  };
}

function isSafeEvaluationOutputPath(value: string): boolean {
  if (path.isAbsolute(value)) {
    return false;
  }
  const normalized = path.normalize(value);
  return normalized.startsWith(`.rag${path.sep}`) && path.basename(normalized).length > 0;
}

function parseIngestArgs(rawArgs: readonly string[]): CliCommand {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  if (args.length === 0) {
    return { command: 'ingest', rebuildEmbeddingSchema: false };
  }
  if (args.length === 1 && args[0] === '--rebuild-embedding-schema') {
    return { command: 'ingest', rebuildEmbeddingSchema: true };
  }

  return { command: 'help', error: `Unknown rag:ingest option: ${args.join(' ')}` };
}

function parseAskArgs(rawArgs: readonly string[]): CliCommand {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const debugRetrieve = args.includes('--debug-retrieve');
  const question = args
    .filter((arg) => arg !== '--debug-retrieve')
    .join(' ')
    .trim();
  if (question.length === 0) {
    return { command: 'help', error: 'Missing question for rag:ask.' };
  }

  return {
    command: 'ask',
    debugRetrieve,
    question,
  };
}

export function formatIngestSummary(summary: IngestSummary): string {
  const lines = [
    `Indexed ${summary.documentCount} documents into ${summary.chunkCount} chunks.`,
    `Saved index: ${summary.indexPath}`,
  ];

  if (summary.runId !== undefined) {
    lines.push(`Run ID: ${summary.runId}`);
  }

  return lines.join('\n');
}

export function formatSyncXUpdatesSummary(summary: SyncXUpdatesSummary): string {
  const lines = [
    `Synced ${summary.changedChunkCount} changed X chunks (${summary.skippedChunkCount} skipped).`,
    `Scanned ${summary.documentCount} X documents into ${summary.chunkCount} chunks.`,
    `Saved index: ${summary.indexPath}`,
  ];

  if (summary.runId !== undefined) {
    lines.push(`Run ID: ${summary.runId}`);
  }

  return lines.join('\n');
}

export function formatMigrationSummary(): string {
  return 'Database migrations applied.';
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

export function formatKnowledgeStats(stats: KnowledgeStats): string {
  const lines = [
    'Knowledge stats:',
    `Documents: ${stats.documentCount}`,
    `Chunks: ${stats.chunkCount}`,
    `Source URLs: ${stats.sourceUrlCount}`,
    `Latest chunk update: ${stats.latestChunkUpdatedAt ?? 'none'}`,
    '',
    'Latest ingest run:',
  ];

  if (stats.latestIngestionRun === undefined) {
    lines.push('none');
  } else {
    lines.push(
      `Run ID: ${stats.latestIngestionRun.runId}`,
      `Source: ${stats.latestIngestionRun.source}`,
      `Created at: ${stats.latestIngestionRun.createdAt}`,
      `Documents: ${stats.latestIngestionRun.documentCount}`,
      `Chunks: ${stats.latestIngestionRun.chunkCount}`,
      `Content hash: ${stats.latestIngestionRun.contentHash}`,
    );
  }

  lines.push('', 'Sources:');
  if (stats.sourceStats.length === 0) {
    lines.push('none');
  } else {
    for (const sourceStat of stats.sourceStats) {
      lines.push(
        `${sourceStat.sourceType}: ${sourceStat.chunkCount} chunks, ${sourceStat.documentCount} documents`,
      );
    }
  }

  return lines.join('\n');
}

export interface FormatEvaluationReportOptions {
  providerBacked?: boolean;
}

type EvaluationReportView = Pick<
  EvaluationReport,
  'judgeSummary' | 'passed' | 'retrievalSummary' | 'total'
> & {
  results: ReadonlyArray<
    Pick<
      EvaluationResult,
      | 'actualIntent'
      | 'citationCount'
      | 'expectedIntent'
      | 'failureReasons'
      | 'minCitations'
      | 'name'
      | 'passed'
    >
  >;
};

export function formatEvaluationReport(
  report: EvaluationReportView,
  options: FormatEvaluationReportOptions = {},
): string {
  const lines = [
    `Evaluation${options.providerBacked === true ? ' (provider-backed)' : ''}: ${report.passed}/${report.total} passed`,
  ];

  if (report.retrievalSummary !== undefined) {
    const summary = report.retrievalSummary;
    lines.push(
      `Retrieval (${summary.annotatedCaseCount} annotated): Recall@K ${formatMetric(summary.averageRecallAtK)}, Precision@K ${formatMetric(summary.averagePrecisionAtK)}, MRR ${formatMetric(summary.meanReciprocalRank)}, nDCG@K ${formatMetric(summary.averageNdcgAtK)}, forbidden hits ${summary.totalForbiddenHits}`,
    );
  }

  if (report.judgeSummary !== undefined) {
    const summary = report.judgeSummary;
    lines.push(
      `Judge (${summary.judgedCaseCount} cases): correctness ${formatMetric(summary.averageCorrectness)}, groundedness ${formatMetric(summary.averageGroundedness)}, completeness ${formatMetric(summary.averageCompleteness)}, relevance ${formatMetric(summary.averageRelevance)}, safe refusal ${formatMetric(summary.averageSafeRefusal)}`,
    );
  }

  for (const result of report.results) {
    const status = `[${result.passed ? 'PASS' : 'FAIL'}] ${result.name}`;
    lines.push(
      options.providerBacked === true
        ? `${status} (expected ${result.expectedIntent}, actual ${result.actualIntent}, citations ${result.citationCount}/${result.minCitations})`
        : status,
    );
    for (const reason of result.failureReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  return lines.join('\n');
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? 'n/a' : value.toFixed(6);
}

export function formatFeedbackEvalBacklog(feedbackRecords: FeedbackRecord[]): string {
  const records = uniqueFeedbackRecords(feedbackRecords).filter(shouldCreateEvalBacklogCandidate);
  if (records.length === 0) {
    return 'No feedback eval backlog candidates.';
  }

  return records.map((record) => JSON.stringify(toFeedbackEvalBacklogRecord(record))).join('\n');
}

function uniqueFeedbackRecords(feedbackRecords: FeedbackRecord[]): FeedbackRecord[] {
  const byKey = new Map<string, FeedbackRecord>();
  for (const record of feedbackRecords) {
    byKey.set(
      [record.createdAt, record.sessionId ?? '', record.question, record.rating].join('\0'),
      record,
    );
  }
  return [...byKey.values()];
}

function shouldCreateEvalBacklogCandidate(record: FeedbackRecord): boolean {
  return record.rating === 'negative' || record.citationCount === 0;
}

function toFeedbackEvalBacklogRecord(record: FeedbackRecord): Record<string, unknown> {
  return {
    _review: {
      channel: record.channel,
      citationCount: record.citationCount,
      ...(record.comment === undefined ? {} : { comment: record.comment }),
      createdAt: record.createdAt,
      observedAnswer: record.answer,
      rating: record.rating,
      reason: record.rating === 'negative' ? 'negative_feedback' : 'no_citation_feedback',
      reviewRequired: true,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      source: 'rag_feedback',
    },
    boundaryExpected: record.intent !== 'product_qa' && record.intent !== 'how_to',
    expectedIntent: record.intent,
    name: createFeedbackEvalCaseName(record),
    question: record.question,
  };
}

function createFeedbackEvalCaseName(record: FeedbackRecord): string {
  const date = record.createdAt.slice(0, 10).replaceAll('-', '') || 'undated';
  const hash = createHash('sha256')
    .update([record.createdAt, record.sessionId ?? '', record.question].join('\n'))
    .digest('hex')
    .slice(0, 8);
  return `feedback-${date}-${hash}`;
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
      const summary = await ingest({ ...io, cwd: workspaceCwd }, parsed.rebuildEmbeddingSchema);
      writeLine(io.stdout, formatIngestSummary(summary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'sync:x') {
    try {
      const summary = await syncXUpdates({ ...io, cwd: workspaceCwd });
      writeLine(io.stdout, formatSyncXUpdatesSummary(summary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'evaluate') {
    try {
      const report = await evaluate({ ...io, cwd: workspaceCwd }, parsed);
      writeLine(
        io.stdout,
        formatEvaluationReport(report, { providerBacked: parsed.providerBacked }),
      );
      return report.passed === report.total ? 0 : 1;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  const config = loadRagConfig(io.env);

  if (parsed.command === 'migrate') {
    try {
      await migrateDatabase(config);
      writeLine(io.stdout, formatMigrationSummary());
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'stats') {
    try {
      const statsSummary = await stats(config);
      writeLine(io.stdout, formatKnowledgeStats(statsSummary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'feedback:backlog') {
    try {
      const backlog = await feedbackBacklog(config);
      writeLine(io.stdout, backlog);
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  try {
    const tracer = createQualityTracerFromEnv({ ...io.env });
    const runtime = createCliChatRuntime(config, tracer);
    try {
      if (parsed.debugRetrieve) {
        const chunks = await runtime.retriever.retrieve(parsed.question, {
          topK: config.topK,
        });
        writeLine(
          io.stdout,
          formatRetrievedChunksDebug(chunks, {
            question: parsed.question,
          }),
        );
        writeLine(io.stdout, '');
      }

      const request: ChatRequest = {
        channel: 'cli',
        message: parsed.question,
      };
      const response = await runtime.service.ask(request);
      writeLine(io.stdout, formatChatResponse(response));
      return 0;
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

async function ingest(io: CliIo, rebuildEmbeddingSchema: boolean): Promise<IngestSummary> {
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
    const store = createPgVectorStore({
      client: pool,
      embeddingDimension: config.embeddingDimension,
      embeddingProvider,
    });
    if (rebuildEmbeddingSchema) {
      await store.migrate({ allowEmbeddingDimensionMismatch: true });
    } else {
      await store.migrate();
    }
    const embeddedChunks = await embedPreparedChunks(chunks, embeddingProvider);
    const ingestionRun = createIngestionRun({
      chunks: embeddedChunks,
      documentCount: documents.length,
    });
    if (rebuildEmbeddingSchema) {
      await store.replaceChunks(embeddedChunks, ingestionRun, {
        rebuildEmbeddingSchema: true,
      });
    } else {
      await store.replaceChunks(embeddedChunks, ingestionRun);
    }
    return {
      documentCount: documents.length,
      chunkCount: chunks.length,
      indexPath: 'pgvector',
      runId: ingestionRun.runId,
    };
  } finally {
    await pool.end();
  }
}

async function syncXUpdates(io: CliIo): Promise<SyncXUpdatesSummary> {
  const config = loadRagConfig(io.env);
  const documents = await loadProductDocuments({ cwd: io.cwd });
  const xDocuments = documents.filter((document) => document.sourceType === 'x_updates');
  const chunks = prepareKnowledgeChunks(xDocuments);
  const pool = createPgPool(config.databaseUrl);

  try {
    const embeddingProvider = createOpenAiEmbeddingProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiEmbeddingModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    const store = createPgVectorStore({
      client: pool,
      embeddingDimension: config.embeddingDimension,
      embeddingProvider,
    });
    await store.migrate();
    const existingHashes = await store.getChunkContentHashes(chunks.map((chunk) => chunk.id));
    const changedChunks = chunks.filter(
      (chunk) => existingHashes.get(chunk.id) !== chunk.contentHash,
    );
    const embeddedChunks = await embedPreparedChunks(changedChunks, embeddingProvider);
    let ingestionRun: ReturnType<typeof createIngestionRun> | undefined;

    if (embeddedChunks.length > 0) {
      ingestionRun = createIngestionRun({
        chunks: embeddedChunks,
        documentCount: xDocuments.length,
        source: 'cli:x_incremental',
      });
      await store.upsertChunks(embeddedChunks);
      await store.recordIngestionRun(ingestionRun);
    }

    return {
      changedChunkCount: changedChunks.length,
      chunkCount: chunks.length,
      documentCount: xDocuments.length,
      indexPath: 'pgvector',
      skippedChunkCount: chunks.length - changedChunks.length,
      ...(ingestionRun === undefined ? {} : { runId: ingestionRun.runId }),
    };
  } finally {
    await pool.end();
  }
}

async function evaluate(
  io: CliIo,
  options: Extract<CliCommand, { command: 'evaluate' }>,
): Promise<EvaluationReport> {
  const config = loadRagConfig(io.env);
  const cases = await loadEvaluationCases(io.cwd);
  const tracer = createQualityTracerFromEnv({ ...io.env });
  let report: EvaluationReport;

  if (options.providerBacked) {
    const runtime = createCliChatRuntime(config, tracer);
    try {
      const evaluationRetriever = createRerankingRetriever(
        runtime.retriever,
        createMetadataReranker(),
        { candidateMultiplier: 4, tracer },
      );
      report = await evaluateCases(cases, runtime.service, {
        observe: createRetrievalObserver(evaluationRetriever, config.topK),
      });
    } finally {
      await runtime.close();
    }
  } else {
    const documents = await loadProductDocuments({ cwd: io.cwd });
    const chunks = prepareKnowledgeChunks(documents);
    const index: RagIndex = {
      builtAt: new Date(0).toISOString(),
      entries: chunks.map((chunk) => ({
        ...chunk,
        embedding: createLocalHashEmbedding(chunk.searchableText),
      })),
      version: 1,
    };
    const evaluationRetriever = createRerankingRetriever(
      createLocalRetriever(index),
      createMetadataReranker(),
      { candidateMultiplier: 4, tracer },
    );
    const service = createChatService({
      answerProvider: {
        answer(input) {
          return Promise.resolve(
            createGroundedAnswer(input.question, input.classification, input.retrievedChunks),
          );
        },
      },
      config,
      index,
      reranker: createMetadataReranker(),
    });

    report = await evaluateCases(cases, service, {
      observe: createRetrievalObserver(evaluationRetriever, config.topK),
    });
  }

  attachRetrievalEvaluation(report, config.topK);
  if (options.judge) {
    await attachJudgeEvaluation(
      report,
      createOpenAiAnswerQualityJudge({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: io.env.EVAL_JUDGE_MODEL,
        requestTimeoutMs: config.openAiRequestTimeoutMs,
      }),
    );
  }
  if (options.failuresOut !== undefined) {
    const outputPath = path.resolve(io.cwd, options.failuresOut);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, formatEvaluationFailureJsonl(report), 'utf8');
  }

  return report;
}

function createRetrievalObserver(retriever: Retriever, topK: number) {
  return async (testCase: EvaluationCase): Promise<{ retrievedChunkIds?: string[] }> => {
    if ((testCase.relevantChunkIds?.length ?? 0) === 0) {
      return {};
    }
    const chunks = await retriever.retrieve(testCase.request.message, { topK });
    return { retrievedChunkIds: chunks.map((chunk) => chunk.id) };
  };
}

function attachRetrievalEvaluation(report: EvaluationReport, topK: number): void {
  const evaluations = report.results.map((result) => {
    const evaluation = evaluateRetrievalRanking({
      forbiddenChunkIds: result.forbiddenChunkIds ?? [],
      relevantChunkIds: result.relevantChunkIds ?? [],
      retrievedChunkIds: result.retrievedChunkIds ?? [],
      topK,
    });
    result.retrievalEvaluation = evaluation;
    return evaluation;
  });
  report.retrievalSummary = aggregateRetrievalResults(evaluations);
}

async function attachJudgeEvaluation(
  report: EvaluationReport,
  judge: AnswerQualityJudge,
): Promise<void> {
  for (const result of report.results) {
    result.judgeScores = await judge.judge({
      actualIntent: result.actualIntent,
      answer: result.response.answer,
      boundaryExpected: !['product_qa', 'how_to'].includes(result.expectedIntent),
      citations: result.response.citations,
      expectedIntent: result.expectedIntent,
      question: result.question,
      referenceFacts: result.referenceFacts ?? [],
    });
  }

  const scores = report.results.flatMap((result) =>
    result.judgeScores === undefined ? [] : [result.judgeScores],
  );
  if (scores.length === 0) {
    return;
  }
  const average = (select: (score: (typeof scores)[number]) => number): number =>
    Math.round(
      (scores.reduce((total, score) => total + select(score), 0) / scores.length) * 1_000_000,
    ) / 1_000_000;
  report.judgeSummary = {
    averageCompleteness: average((score) => score.completeness),
    averageCorrectness: average((score) => score.correctness),
    averageGroundedness: average((score) => score.groundedness),
    averageRelevance: average((score) => score.relevance),
    averageSafeRefusal: average((score) => score.safeRefusal),
    judgedCaseCount: scores.length,
  };
}

interface GoldenQaRecord {
  boundaryExpected?: boolean;
  expectedCitationFiles?: string[];
  expectedCitationTitles?: string[];
  expectedSourceUrls?: string[];
  expectedIntent: EvaluationCase['expectedIntent'];
  expectedAgentRoute?: EvaluationCase['expectedAgentRoute'];
  expectedToolNames?: string[];
  forbiddenChunkIds?: string[];
  forbiddenCitationFiles?: string[];
  forbiddenSourceUrls?: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  name?: string;
  question: string;
  referenceFacts?: string[];
  relevantChunkIds?: string[];
  requireCitationSupport?: boolean;
}

async function loadEvaluationCases(cwd: string): Promise<EvaluationCase[]> {
  const filePath = path.join(cwd, 'docs', 'eval', 'golden-qa.jsonl');
  const content = await readFile(filePath, 'utf8');
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => toEvaluationCase(JSON.parse(line) as GoldenQaRecord, index));
}

function toEvaluationCase(record: GoldenQaRecord, index: number): EvaluationCase {
  return {
    ...(record.expectedAgentRoute === undefined
      ? {}
      : { expectedAgentRoute: record.expectedAgentRoute }),
    expectedIntent: record.expectedIntent,
    ...(record.expectedToolNames === undefined
      ? {}
      : { expectedToolNames: record.expectedToolNames }),
    ...(record.forbiddenChunkIds === undefined
      ? {}
      : { forbiddenChunkIds: record.forbiddenChunkIds }),
    ...(record.mustNotContain === undefined
      ? {}
      : { forbiddenAnswerIncludes: record.mustNotContain }),
    ...(record.boundaryExpected === true ? { minCitations: 0 } : {}),
    name: record.name ?? `golden-${index + 1}`,
    request: {
      channel: 'cli',
      message: record.question,
    },
    ...(record.referenceFacts === undefined ? {} : { referenceFacts: record.referenceFacts }),
    ...(record.relevantChunkIds === undefined ? {} : { relevantChunkIds: record.relevantChunkIds }),
    ...(record.mustContain === undefined ? {} : { requiredAnswerIncludes: record.mustContain }),
    ...(record.expectedCitationFiles === undefined
      ? {}
      : { requiredCitationFiles: record.expectedCitationFiles }),
    ...(record.expectedCitationTitles === undefined
      ? {}
      : { requiredCitationTitles: record.expectedCitationTitles }),
    ...(record.expectedSourceUrls === undefined
      ? {}
      : { requiredSourceUrls: record.expectedSourceUrls }),
    ...(record.forbiddenCitationFiles === undefined
      ? {}
      : { forbiddenCitationFiles: record.forbiddenCitationFiles }),
    ...(record.forbiddenSourceUrls === undefined
      ? {}
      : { forbiddenSourceUrls: record.forbiddenSourceUrls }),
    ...(record.requireCitationSupport === undefined
      ? {}
      : { requireCitationSupport: record.requireCitationSupport }),
  };
}

async function migrateDatabase(config: ReturnType<typeof loadRagConfig>): Promise<void> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgVectorStore({
      client: pool,
      embeddingDimension: config.embeddingDimension,
      embeddingProvider: {
        embedTexts: () => Promise.reject(new Error('rag:migrate does not generate embeddings.')),
      },
    });
    await store.migrate();
  } finally {
    await pool.end();
  }
}

async function stats(config: ReturnType<typeof loadRagConfig>): Promise<KnowledgeStats> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgVectorStore({
      client: pool,
      embeddingDimension: config.embeddingDimension,
      embeddingProvider: {
        embedTexts: () => Promise.reject(new Error('rag:stats does not generate embeddings.')),
      },
    });
    return await store.getStats();
  } finally {
    await pool.end();
  }
}

async function feedbackBacklog(config: ReturnType<typeof loadRagConfig>): Promise<string> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgFeedbackStore({ client: pool });
    const [negativeFeedback, recentFeedback] = await Promise.all([
      store.getFeedbackStats({ limit: 50, rating: 'negative' }),
      store.getFeedbackStats({ limit: 50 }),
    ]);
    return formatFeedbackEvalBacklog([...negativeFeedback.latest, ...recentFeedback.latest]);
  } finally {
    await pool.end();
  }
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

function createCliChatRuntime(
  config: ReturnType<typeof loadRagConfig>,
  tracer: QualityTracer,
): CliChatRuntime {
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
      return createPgVectorStore({
        client: nextPool,
        embeddingDimension: config.embeddingDimension,
        embeddingProvider,
        tracer,
      });
    } catch (error) {
      await nextPool.end();
      throw error;
    }
  });

  return {
    retriever,
    service: createCustomerAgentChatService({
      answerProvider: createLazyAnswerProvider(config, tracer),
      config,
      retriever,
      tracer,
    }),
    close: async () => {
      const currentPool = pool;
      pool = undefined;
      await currentPool?.end();
    },
  };
}

function createLazyAnswerProvider(
  config: ReturnType<typeof loadRagConfig>,
  tracer: QualityTracer,
): AnswerProvider {
  let cachedProvider: AnswerProvider | undefined;

  function getProvider(): AnswerProvider {
    cachedProvider ??= createOpenAiAnswerProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
      tracer,
    });
    return cachedProvider;
  }

  return {
    answer(input) {
      return getProvider().answer(input);
    },
    stream(input) {
      const provider = getProvider();
      if (provider.stream === undefined) {
        throw new Error('Answer provider does not support streaming.');
      }
      return provider.stream(input);
    },
  };
}

function createIngestionRun(input: {
  chunks: EmbeddedKnowledgeChunk[];
  documentCount: number;
  source?: string;
}): {
  chunkCount: number;
  contentHash: string;
  documentCount: number;
  runId: string;
  source: string;
  sourceCounts: Partial<Record<EmbeddedKnowledgeChunk['metadata']['sourceType'], number>>;
} {
  const contentHash = createKnowledgeContentHash(input.chunks);

  return {
    chunkCount: input.chunks.length,
    contentHash,
    documentCount: input.documentCount,
    runId: createIngestionRunId(contentHash),
    source: input.source ?? 'cli',
    sourceCounts: countChunksBySource(input.chunks),
  };
}

function createKnowledgeContentHash(chunks: EmbeddedKnowledgeChunk[]): string {
  const hash = createHash('sha256');
  for (const chunk of [...chunks].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(chunk.id);
    hash.update('\0');
    hash.update(chunk.contentHash);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function createIngestionRunId(contentHash: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
  return `ingest_${timestamp}_${contentHash.slice(0, 8)}`;
}

function countChunksBySource(
  chunks: EmbeddedKnowledgeChunk[],
): Partial<Record<EmbeddedKnowledgeChunk['metadata']['sourceType'], number>> {
  const counts: Partial<Record<EmbeddedKnowledgeChunk['metadata']['sourceType'], number>> = {};

  for (const chunk of chunks) {
    counts[chunk.metadata.sourceType] = (counts[chunk.metadata.sourceType] ?? 0) + 1;
  }

  return counts;
}

function writeLine(stream: Pick<NodeJS.WriteStream, 'write'>, message: string): void {
  stream.write(`${message}\n`);
}

function writeConfigurationError(io: CliIo, error: unknown): boolean {
  if (error instanceof AnswerJudgeConfigurationError) {
    writeLine(io.stderr, error.message);
    return true;
  }

  if (error instanceof QualityTracingConfigurationError) {
    writeLine(io.stderr, error.message);
    return true;
  }
  if (error instanceof LlmConfigurationError) {
    writeLine(io.stderr, error.message);
    return true;
  }

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
  try {
    const exitCode = await runCli();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
