import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadWorkspaceEnv } from './env.js';

describe('loadWorkspaceEnv', () => {
  it('parses workspace .env files with dotenv semantics', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-rag-env-'));
    await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeFile(
      path.join(workspaceRoot, '.env'),
      [
        'POSTGRES_DB=xxyy_ask # inline comment',
        'POSTGRES_PASSWORD="secret # literal hash"',
        'OPENAI_MODEL=openrouter/free',
      ].join('\n'),
    );

    const env = loadWorkspaceEnv({ cwd: workspaceRoot, env: {} });

    expect(env.POSTGRES_DB).toBe('xxyy_ask');
    expect(env.POSTGRES_PASSWORD).toBe('secret # literal hash');
    expect(env.OPENAI_MODEL).toBe('openrouter/free');
  });
});
