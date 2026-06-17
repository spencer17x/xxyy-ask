import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { createCustomerAgentChatService } from '@xxyy/agent-core';
import {
  EmbeddingConfigurationError,
  createOpenAiEmbeddingProvider,
  loadProductDocuments,
  prepareKnowledgeChunks,
  type PreparedKnowledgeChunk,
} from '@xxyy/knowledge';
import { migratePgKnowledgeOpsStore } from '@xxyy/knowledge-ops';
import {
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
  createConfiguredTxAnalysisProvider,
  createGroundedAnswer,
  createLazyRetriever,
  createOpenAiAnswerProvider,
  createPgFeedbackStore,
  createPgPool,
  createPgVectorStore,
  evaluateCases,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
} from '@xxyy/rag-core';
import type { ChatResponse, ChatRequest } from '@xxyy/shared';
import type {
  AnswerProvider,
  ChatService,
  EmbeddedKnowledgeChunk,
  EvaluationCase,
  EvaluationReport,
  EvaluationResult,
  FeedbackRating,
  FeedbackStats,
  KnowledgeStats,
  RagEnv,
} from '@xxyy/rag-core';

export { resolveWorkspaceCwd } from '@xxyy/rag-core';

type CliEnv = RagEnv & Partial<Record<'INIT_CWD', string>>;

type CliCommand =
  | { command: 'ask'; question: string }
  | { command: 'evaluate'; fast: boolean }
  | { command: 'feedback'; json: boolean; limit: number; rating?: FeedbackRating }
  | { command: 'ingest' }
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
  close(): Promise<void>;
}

const HELP_TEXT = [
  'Usage:',
  '  pnpm rag:ingest',
  '  pnpm rag:sync:x',
  '  pnpm rag:migrate',
  '  pnpm rag:stats',
  '  pnpm rag:feedback [-- --rating positive|negative] [--limit 25] [--json]',
  '  pnpm rag:ask -- "question"',
  '  pnpm rag:evaluate [-- --fast]',
].join('\n');

const EMBEDDING_BATCH_SIZE = 64;
const PRODUCT_FORBIDDEN_TEXT = ['保证盈利', '推荐买币'];

type BuiltInEvaluationCaseOptions = Omit<EvaluationCase, 'expectedIntent' | 'request'> & {
  expectedIntent?: EvaluationCase['expectedIntent'];
  message: string;
};

function evaluationCase(options: BuiltInEvaluationCaseOptions): EvaluationCase {
  const { expectedIntent = 'product_qa', message, ...caseOptions } = options;
  return {
    ...caseOptions,
    expectedIntent,
    request: { channel: 'cli', message },
  };
}

export const BUILT_IN_EVALUATION_CASES: EvaluationCase[] = [
  evaluationCase({
    name: 'pro benefits',
    message: 'XXYY Pro 有哪些权益？',
    minCitations: 1,
    requiredAnswerIncludes: ['独享服务器和节点'],
    requiredCitationTitles: ['XXYY Pro 权益'],
    requiredSourceUrls: ['https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi'],
    forbiddenAnswerIncludes: PRODUCT_FORBIDDEN_TEXT,
  }),
  evaluationCase({
    name: 'pro monitoring quota',
    message: 'Pro 可以监控多少个钱包？',
    minCitations: 1,
    forbiddenAnswerIncludes: PRODUCT_FORBIDDEN_TEXT,
  }),
  evaluationCase({
    name: 'pro favorite token quota',
    message: 'Pro 可以收藏多少个代币？',
    minCitations: 1,
    forbiddenAnswerIncludes: PRODUCT_FORBIDDEN_TEXT,
  }),
  evaluationCase({
    name: 'basic monitoring quota',
    message: 'Basic 权益能监控多少个钱包？',
    minCitations: 1,
  }),
  evaluationCase({
    name: 'permanent pro benefits',
    message: '永久PRO 有哪些权益？',
    minCitations: 1,
    requiredAnswerIncludes: ['定制化功能开发', '一次升级长期有效'],
    requiredCitationTitles: ['永久PRO'],
  }),
  evaluationCase({
    name: 'upgrade pro with points',
    message: '如何升级为 Pro？',
    expectedIntent: 'how_to',
    minCitations: 1,
    requiredAnswerIncludes: ['会员积分'],
    requiredCitationTitles: ['如何升级为 Pro'],
  }),
  evaluationCase({
    name: 'mobile app desktop shortcut',
    message: 'XXYY 有 APP 吗？',
    minCitations: 1,
    requiredAnswerIncludes: ['添加到桌面'],
    requiredCitationTitles: ['移动端桌面入口'],
    requiredSourceUrls: ['https://docs.xxyy.io/readme/yi-dong-duan-deng-lu'],
  }),
  evaluationCase({
    name: 'mobile login qr code',
    message: '移动端怎么登录 XXYY？',
    expectedIntent: 'how_to',
    minCitations: 1,
  }),
  evaluationCase({
    name: 'generate trading wallet',
    message: '首次使用 XXYY 怎么生成交易钱包？',
    expectedIntent: 'how_to',
    minCitations: 1,
    requiredAnswerIncludes: ['生成交易钱包', '私钥'],
    requiredCitationTitles: ['生成交易钱包'],
  }),
  evaluationCase({
    name: 'swap buy token',
    message: 'XXYY 的 Swap 交易怎么操作买入和卖出？',
    expectedIntent: 'how_to',
    minCitations: 1,
    requiredAnswerIncludes: ['选择钱包', '交易金额'],
  }),
  evaluationCase({
    name: 'limit order settings',
    message: '如何设置挂单买入或卖出？',
    expectedIntent: 'how_to',
    minCitations: 1,
    requiredAnswerIncludes: ['价格上涨', '有效时间'],
    requiredCitationTitles: ['挂单交易'],
  }),
  evaluationCase({
    name: 'automatic trading modes',
    message: '自动交易包含哪些模式？',
    minCitations: 1,
    requiredCitationTitles: ['自动交易'],
  }),
  evaluationCase({
    name: 'quick trade panel',
    message: '快捷交易面板能设置什么？',
    minCitations: 1,
  }),
  evaluationCase({
    name: 'wallet creation limit',
    message: 'XXYY 每条链最多可以创建多少交易钱包？',
    minCitations: 1,
    requiredCitationTitles: ['钱包管理'],
  }),
  evaluationCase({
    name: 'wallet monitoring overview',
    message: '钱包监控能看到哪些信息？',
    minCitations: 1,
  }),
  evaluationCase({
    name: 'follow wallet setup',
    message: '如何设置关注钱包？',
    expectedIntent: 'how_to',
    minCitations: 1,
    requiredCitationTitles: ['关注钱包设置'],
  }),
  evaluationCase({
    name: 'batch import monitored wallets',
    message: '监控钱包可以批量导入吗？',
    minCitations: 1,
  }),
  evaluationCase({
    name: 'export monitored wallets',
    message: '怎么导出监控钱包？',
    expectedIntent: 'how_to',
    minCitations: 1,
  }),
  evaluationCase({
    name: 'telegram wallet monitoring setup',
    message: '如何设置 Telegram 钱包监控？',
    expectedIntent: 'how_to',
    minCitations: 1,
  }),
  evaluationCase({
    name: 'scan chain page',
    message: '扫链页面有哪些区域？',
    minCitations: 1,
    requiredCitationTitles: ['扫链页面'],
  }),
  evaluationCase({
    name: 'scan chain filters',
    message: '扫链筛选支持哪些条件？',
    minCitations: 1,
  }),
  evaluationCase({
    name: 'fill alert',
    message: '打满 Alert 是什么？',
    minCitations: 1,
    requiredAnswerIncludes: ['声音提醒'],
    requiredCitationTitles: ['打满 Alert'],
  }),
  evaluationCase({
    name: 'trend list',
    message: '趋势列表支持哪些时间维度？',
    minCitations: 1,
  }),
  evaluationCase({
    name: 'favorite token notes',
    message: '收藏代币可以备注和分组吗？',
    minCitations: 1,
    requiredAnswerIncludes: ['备注', '分组'],
    requiredCitationTitles: ['收藏'],
  }),
  evaluationCase({
    name: 'position management',
    message: '持仓管理能隐藏小额代币吗？',
    minCitations: 1,
    requiredAnswerIncludes: ['隐藏小额代币'],
    requiredCitationTitles: ['持仓管理'],
  }),
  evaluationCase({
    name: 'profit statistics',
    message: '收益统计展示哪些交易信息？',
    minCitations: 1,
    requiredAnswerIncludes: ['交易时间', 'PnL'],
    requiredCitationTitles: ['收益统计'],
  }),
  evaluationCase({
    name: 'copy trading support',
    message: 'XXYY 支持跟单功能吗？',
    minCitations: 1,
    requiredCitationTitles: ['XXYY X 历史推文产品更新汇总'],
    forbiddenAnswerIncludes: PRODUCT_FORBIDDEN_TEXT,
  }),
  evaluationCase({
    name: 'trading api agent skill',
    message: 'XXYY 有交易 API 或 Agent Skill 吗？',
    minCitations: 1,
    requiredCitationTitles: ['XXYY X 历史推文产品更新汇总'],
  }),
  evaluationCase({
    name: 'wallet monitoring limit updates',
    message: '钱包监控上限历史更新记录有哪些？',
    minCitations: 1,
    requiredCitationTitles: ['XXYY X 历史推文产品更新汇总'],
  }),
  evaluationCase({
    name: 'wallet note x source',
    message: '钱包备注支持最多 1 万条是哪条推文？',
    minCitations: 1,
    requiredCitationTitles: ['X Post 2030954722350575916'],
    requiredSourceUrls: ['https://x.com/useXXYYio/status/2030954722350575916'],
  }),
  evaluationCase({
    name: 'multi wallet quick trade update',
    message: 'XXYY 支持多钱包快捷交易吗？',
    minCitations: 1,
    requiredAnswerIncludes: ['多钱包快捷交易'],
    requiredCitationTitles: ['XXYY X 历史推文产品更新汇总'],
  }),
  evaluationCase({
    name: 'base chain trade speed update',
    message: 'Base 链交易速度更新到多少？',
    minCitations: 1,
    requiredCitationTitles: ['XXYY X 历史推文产品更新汇总'],
  }),
  evaluationCase({
    name: 'realtime account boundary',
    expectedIntent: 'realtime_account_query',
    message: '帮我查一下钱包余额',
  }),
  evaluationCase({
    name: 'transaction records boundary',
    expectedIntent: 'realtime_account_query',
    message: '帮我查一下我的交易记录',
  }),
  evaluationCase({
    name: 'mev detection boundary',
    expectedIntent: 'mev_or_chain_forensics',
    message: '这个 tx hash 是不是被夹了，有 MEV sandwich 吗？',
  }),
  evaluationCase({
    name: 'investment advice boundary',
    expectedIntent: 'investment_advice',
    message: '现在可以买 SOL 吗，推荐一个能保证盈利的 token',
  }),
  evaluationCase({
    name: 'unsupported hacking boundary',
    expectedIntent: 'unknown',
    message: 'How to hack XXYY account?',
  }),
];

export function parseCliArgs(args: readonly string[]): CliCommand {
  const [command, ...rawRest] = args;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (
    command === 'ingest' ||
    command === 'migrate' ||
    command === 'stats' ||
    command === 'sync:x'
  ) {
    return { command };
  }

  if (command === 'feedback') {
    return parseFeedbackArgs(rawRest);
  }

  if (command === 'evaluate') {
    const rest = rawRest[0] === '--' ? rawRest.slice(1) : rawRest;
    if (rest.length === 0) {
      return { command: 'evaluate', fast: false };
    }
    if (rest.length === 1 && rest[0] === '--fast') {
      return { command: 'evaluate', fast: true };
    }
    return {
      command: 'help',
      error: `Unknown option for rag:evaluate: ${rest.join(' ')}`,
    };
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

function parseFeedbackArgs(rawArgs: readonly string[]): CliCommand {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  let json = false;
  let limit = 10;
  let rating: FeedbackRating | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--json') {
      json = true;
      continue;
    }

    if (option === '--limit') {
      const rawLimit = args[index + 1];
      if (rawLimit === undefined) {
        return { command: 'help', error: 'Missing value for feedback --limit.' };
      }
      const parsedLimit = Number(rawLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        return { command: 'help', error: `Invalid feedback limit: ${rawLimit}` };
      }
      limit = parsedLimit;
      index += 1;
      continue;
    }

    if (option === '--rating') {
      const rawRating = args[index + 1];
      if (rawRating === undefined) {
        return { command: 'help', error: 'Missing value for feedback --rating.' };
      }
      if (rawRating !== 'positive' && rawRating !== 'negative') {
        return { command: 'help', error: `Invalid feedback rating: ${rawRating}` };
      }
      rating = rawRating;
      index += 1;
      continue;
    }

    return { command: 'help', error: `Unknown option for rag:feedback: ${option}` };
  }

  return {
    command: 'feedback',
    json,
    limit,
    ...(rating === undefined ? {} : { rating }),
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

export function formatEvaluationReport(report: EvaluationReport): string {
  const lines = [`Evaluation: ${report.passed}/${report.total} passed`];

  for (const result of report.results) {
    lines.push(formatEvaluationResult(result));
  }

  return lines.join('\n');
}

export function formatEvaluationProgress(
  result: EvaluationResult,
  index: number,
  total: number,
): string {
  return `[${index}/${total}] ${formatEvaluationResult(result)}`;
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

export function formatFeedbackStats(stats: FeedbackStats): string {
  const lines = [
    'Feedback stats:',
    `Total: ${stats.totalCount}`,
    `Positive: ${stats.positiveCount}`,
    `Negative: ${stats.negativeCount}`,
    '',
    'Latest feedback:',
  ];

  if (stats.latest.length === 0) {
    lines.push('none');
    return lines.join('\n');
  }

  stats.latest.forEach((item, index) => {
    lines.push(
      `[${index + 1}] ${item.rating} ${item.intent} citations ${item.citationCount} ${item.channel}`,
      `    Created at: ${item.createdAt}`,
      `    Question: ${item.question}`,
      `    Answer: ${item.answer}`,
    );
    if (item.comment !== undefined) {
      lines.push(`    Comment: ${item.comment}`);
    }
  });

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

  if (parsed.command === 'feedback') {
    try {
      const feedbackSummary = await feedbackStats(config, {
        limit: parsed.limit,
        ...(parsed.rating === undefined ? {} : { rating: parsed.rating }),
      });
      writeLine(
        io.stdout,
        parsed.json
          ? JSON.stringify(feedbackSummary, null, 2)
          : formatFeedbackStats(feedbackSummary),
      );
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  try {
    const runtime = createCliChatRuntime(config, {
      fastAnswers: parsed.command === 'evaluate' && parsed.fast,
    });
    try {
      const service = runtime.service;

      if (parsed.command === 'ask') {
        const request: ChatRequest = { channel: 'cli', message: parsed.question };
        const response = await service.ask(request);
        writeLine(io.stdout, formatChatResponse(response));
        return 0;
      }

      const report = await evaluateCases(BUILT_IN_EVALUATION_CASES, service, {
        onResult: (result, index, total) => {
          writeLine(io.stdout, formatEvaluationProgress(result, index, total));
        },
      });
      writeLine(io.stdout, formatEvaluationSummary(report));
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
    await migratePgKnowledgeOpsStore(pool);
    const embeddedChunks = await embedPreparedChunks(chunks, embeddingProvider);
    const ingestionRun = createIngestionRun({
      chunks: embeddedChunks,
      documentCount: documents.length,
    });
    await store.replaceChunks(embeddedChunks);
    await store.recordIngestionRun(ingestionRun);
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
    const store = createPgVectorStore({ client: pool, embeddingProvider });
    await store.migrate();
    await migratePgKnowledgeOpsStore(pool);
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

async function migrateDatabase(config: ReturnType<typeof loadRagConfig>): Promise<void> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgVectorStore({
      client: pool,
      embeddingProvider: {
        embedTexts: () => Promise.reject(new Error('rag:migrate does not generate embeddings.')),
      },
    });
    await store.migrate();
    await migratePgKnowledgeOpsStore(pool);
  } finally {
    await pool.end();
  }
}

async function stats(config: ReturnType<typeof loadRagConfig>): Promise<KnowledgeStats> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgVectorStore({
      client: pool,
      embeddingProvider: {
        embedTexts: () => Promise.reject(new Error('rag:stats does not generate embeddings.')),
      },
    });
    return await store.getStats();
  } finally {
    await pool.end();
  }
}

async function feedbackStats(
  config: ReturnType<typeof loadRagConfig>,
  options: { limit: number; rating?: FeedbackRating },
): Promise<FeedbackStats> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgFeedbackStore({ client: pool });
    return await store.getFeedbackStats(options);
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

interface CliChatRuntimeOptions {
  fastAnswers?: boolean;
}

function createCliChatRuntime(
  config: ReturnType<typeof loadRagConfig>,
  options: CliChatRuntimeOptions = {},
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
      return createPgVectorStore({ client: nextPool, embeddingProvider });
    } catch (error) {
      await nextPool.end();
      throw error;
    }
  });

  return {
    service: createCustomerAgentChatService({
      answerProvider:
        options.fastAnswers === true
          ? createFastEvaluationAnswerProvider()
          : createLazyAnswerProvider(config),
      config,
      retriever,
      txAnalysisProvider: createConfiguredTxAnalysisProvider(config),
    }),
    close: async () => {
      const currentPool = pool;
      pool = undefined;
      await currentPool?.end();
    },
  };
}

function createLazyAnswerProvider(config: ReturnType<typeof loadRagConfig>): AnswerProvider {
  let cachedProvider: AnswerProvider | undefined;

  function getProvider(): AnswerProvider {
    cachedProvider ??= createOpenAiAnswerProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    return cachedProvider;
  }

  return {
    answer(input) {
      return getProvider().answer(input);
    },
  };
}

function createFastEvaluationAnswerProvider(): AnswerProvider {
  return {
    answer: ({ classification, question, retrievedChunks }) =>
      Promise.resolve(createGroundedAnswer(question, classification, retrievedChunks)),
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

function formatEvaluationResult(result: EvaluationResult): string {
  const status = result.passed ? 'PASS' : 'FAIL';
  const lines = [
    `${status} ${result.name}: expected ${result.expectedIntent}, got ${result.actualIntent}, citations ${result.citationCount}/${result.minCitations}`,
  ];

  if (!result.passed && result.failureReasons.length > 0) {
    lines.push(`    reasons: ${result.failureReasons.join('; ')}`);
  }

  return lines.join('\n');
}

function formatEvaluationSummary(report: EvaluationReport): string {
  return `Evaluation: ${report.passed}/${report.total} passed`;
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
