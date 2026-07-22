import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(SOURCE_DIRECTORY, '../../..');

describe('chain-analysis readiness runtime isolation', () => {
  it('keeps production modules free of network, environment, Agent, MCP, and app dependencies', async () => {
    const sourceFiles = (await listTypeScriptFiles(SOURCE_DIRECTORY)).filter(
      (path) => !path.endsWith('.test.ts') && !path.includes('/fixtures/'),
    );
    const forbidden = [
      /\bfetch\s*\(/u,
      /process\.env/u,
      /node:(?:http|https|net|tls)/u,
      /@langchain\/langgraph/u,
      /@xxyy\/agent-core/u,
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

  it('is not imported by the current public runtime surfaces', async () => {
    const runtimeDirectories = [
      join(REPOSITORY_ROOT, 'apps'),
      join(REPOSITORY_ROOT, 'packages/agent-core/src'),
    ];
    for (const directory of runtimeDirectories) {
      for (const path of await listTypeScriptFiles(directory)) {
        expect(await readFile(path, 'utf8'), path).not.toContain(
          '@xxyy/evm-chain-analysis-readiness',
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
