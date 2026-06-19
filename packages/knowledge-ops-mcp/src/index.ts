import { spawn } from 'node:child_process';
import path from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  KnowledgeCandidateNotFoundError,
  createPgKnowledgeOpsStore,
  publishKnowledgeCandidate as publishCandidateToKnowledgeSource,
  type ListKnowledgeCandidatesFilter,
  type ReviewKnowledgeCandidateInput,
} from '@xxyy/knowledge-ops';
import { createPgPool, loadRagConfig, loadWorkspaceEnv, resolveWorkspaceCwd } from '@xxyy/rag-core';

import { createRunKnowledgeGateCommandArgs } from './commands.js';
import { createKnowledgeOpsMcpServer } from './server.js';
import { createKnowledgeOpsToolHandlers } from './tools.js';

const workspaceCwd = resolveWorkspaceCwd(process.cwd(), process.env);
const env = loadWorkspaceEnv({
  cwd: workspaceCwd,
  env: process.env,
});
const config = loadRagConfig(env);
const pool = createPgPool(config.databaseUrl);
const store = createPgKnowledgeOpsStore({ client: pool });
let migrated = false;

async function ensureMigrated(): Promise<void> {
  if (migrated) {
    return;
  }

  await store.migrate();
  migrated = true;
}

const server = createKnowledgeOpsMcpServer({
  handlers: createKnowledgeOpsToolHandlers({
    async listCandidates(input) {
      await ensureMigrated();
      return store.listCandidates(toListCandidatesFilter(input));
    },
    async publishKnowledgeCandidate(input) {
      await ensureMigrated();
      const candidate = await store.getCandidate(input.id);
      if (candidate === undefined) {
        throw new KnowledgeCandidateNotFoundError(input.id);
      }

      const published = await publishCandidateToKnowledgeSource({
        candidate,
        productFeaturesDir: path.join(workspaceCwd, 'docs', 'product-features'),
        ...(input.target === undefined ? {} : { targetFile: input.target }),
      });
      await store.markCandidatePublished(input.id, {
        publishedAt: published.publishedAt,
        publishedTarget: published.publishedTarget,
      });

      return {
        candidateId: input.id,
        publishedTarget: published.publishedTarget,
        publishRunId: published.publishRunId,
      };
    },
    async reviewCandidate(id, input) {
      await ensureMigrated();
      return store.reviewCandidate(id, toReviewCandidateInput(input));
    },
    async runKnowledgeGate(input) {
      const result = await runWorkspaceCommand(createRunKnowledgeGateCommandArgs(input));
      if (input.approvedEvalOnly === true) {
        return {
          approvedEvalOnly: true,
          status: result.exitCode === 0 ? 'passed' : 'failed',
          ...result,
        };
      }

      if (input.id === undefined) {
        throw new Error('run_knowledge_gate requires id unless approvedEvalOnly is true.');
      }

      return {
        candidateId: input.id,
        status: result.exitCode === 0 ? 'passed' : 'failed',
        ...result,
      };
    },
    syncTelegramSupport() {
      return runWorkspaceCommand(['rag:sync:telegram']);
    },
  }),
});
const transport = new StdioServerTransport();

await server.connect(transport);

process.on('SIGINT', () => {
  void server
    .close()
    .finally(async () => {
      await pool.end();
    })
    .finally(() => {
      process.exit(0);
    });
});

function runWorkspaceCommand(args: string[]): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      cwd: workspaceCwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      });
    });
  });
}

function toListCandidatesFilter(input: {
  limit?: number | undefined;
  riskLevel?: ListKnowledgeCandidatesFilter['riskLevel'] | undefined;
  status?: ListKnowledgeCandidatesFilter['status'] | undefined;
  type?: ListKnowledgeCandidatesFilter['type'] | undefined;
}): ListKnowledgeCandidatesFilter {
  return {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.riskLevel === undefined ? {} : { riskLevel: input.riskLevel }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.type === undefined ? {} : { type: input.type }),
  };
}

function toReviewCandidateInput(input: {
  action: ReviewKnowledgeCandidateInput['action'];
  notes?: string | undefined;
  reviewedAt?: string | undefined;
  reviewer: string;
}): ReviewKnowledgeCandidateInput {
  return {
    action: input.action,
    reviewer: input.reviewer,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.reviewedAt === undefined ? {} : { reviewedAt: input.reviewedAt }),
  };
}
