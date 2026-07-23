import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as publicControlStoreApi from './index.js';

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(SOURCE_DIRECTORY, '../../..');
const PRIVATE_CONTROL_APP_DIRECTORY = join(REPOSITORY_ROOT, 'apps/chain-control-cli');

describe('chain-analysis control-store runtime isolation', () => {
  it('does not export unverified approval or authorization artifact writers', () => {
    expect(publicControlStoreApi).not.toHaveProperty('recordGovernanceAuthorizationArtifact');
    expect(publicControlStoreApi).not.toHaveProperty('recordMainnetSamplingSourceApprovalArtifact');
  });

  it('keeps the backend free of environment, raw network, RPC, Agent, MCP, and app dependencies', async () => {
    const sourceFiles = (await listTypeScriptFiles(SOURCE_DIRECTORY)).filter(
      (path) => !path.includes('.test.') && !path.includes('.test-helper.'),
    );
    const forbidden = [
      /\bfetch\s*\(/u,
      /process\.env/u,
      /node:(?:http|https|net|tls)/u,
      /@langchain\/langgraph/u,
      /@xxyy\/agent-core/u,
      /@xxyy\/evm-data-adapter/u,
      /@xxyy\/evm-execution-data-adapter/u,
      /@xxyy\/evm-mev-observation-data-adapter/u,
      /CapabilityRegistry/u,
      /ToolRegistry/u,
      /\bMCP\b/u,
    ];
    for (const path of sourceFiles) {
      const source = await readFile(path, 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${path} contains ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });

  it('is not imported by the public runtime surfaces', async () => {
    for (const directory of [
      join(REPOSITORY_ROOT, 'apps'),
      join(REPOSITORY_ROOT, 'packages/agent-core/src'),
      join(REPOSITORY_ROOT, 'packages/rag-core/src'),
    ]) {
      for (const path of await listTypeScriptFiles(directory)) {
        if (path.startsWith(`${PRIVATE_CONTROL_APP_DIRECTORY}${sep}`)) {
          continue;
        }
        expect(await readFile(path, 'utf8'), path).not.toContain(
          '@xxyy/evm-chain-analysis-control-store',
        );
      }
    }
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(path);
      }
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    }),
  );
  return files.flat();
}
