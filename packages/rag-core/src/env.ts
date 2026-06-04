import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'dotenv';

import type { RagEnv } from './config.js';

export type EnvRecord = Partial<Record<string, string | undefined>>;
export type WorkspaceEnv = EnvRecord & RagEnv;

export interface LoadWorkspaceEnvOptions {
  cwd?: string;
  env?: EnvRecord;
}

export function loadWorkspaceEnv(options: LoadWorkspaceEnvOptions = {}): WorkspaceEnv {
  const cwd = options.cwd ?? process.cwd();
  const shellEnv = options.env ?? process.env;
  const workspaceCwd = resolveWorkspaceCwd(cwd, shellEnv);

  return mergeEnv(loadDotEnvFile(path.join(workspaceCwd, '.env')), shellEnv);
}

export function resolveWorkspaceCwd(cwd: string, env: EnvRecord = {}): string {
  const initCwd = env.INIT_CWD;
  if (initCwd !== undefined && hasWorkspaceEvidence(initCwd)) {
    return path.resolve(initCwd);
  }

  if (hasWorkspaceEvidence(cwd)) {
    return path.resolve(cwd);
  }

  return findWorkspaceRoot(cwd) ?? path.resolve(cwd);
}

function loadDotEnvFile(filePath: string): EnvRecord {
  if (!existsSync(filePath)) {
    return {};
  }

  return parse(readFileSync(filePath, 'utf8'));
}

function mergeEnv(fileEnv: EnvRecord, shellEnv: EnvRecord): WorkspaceEnv {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(fileEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(shellEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
}

function hasWorkspaceEvidence(candidatePath: string): boolean {
  return (
    existsSync(path.join(candidatePath, 'pnpm-workspace.yaml')) ||
    existsSync(path.join(candidatePath, 'docs', 'product-features'))
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
