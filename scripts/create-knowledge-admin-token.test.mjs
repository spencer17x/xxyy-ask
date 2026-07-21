import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('create-knowledge-admin-token', () => {
  it('accepts the pnpm separator and emits a matching one-time token record', () => {
    const result = spawnSync(
      process.execPath,
      [
        new URL('./create-knowledge-admin-token.mjs', import.meta.url).pathname,
        '--',
        'alice',
        'reviewer',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    const token = lines[1];
    const record = JSON.parse(lines.at(-1) ?? '{}');
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(record).toMatchObject({ displayName: 'alice', id: 'alice', role: 'reviewer' });
    expect(record.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('rejects unknown roles', () => {
    const result = spawnSync(
      process.execPath,
      [new URL('./create-knowledge-admin-token.mjs', import.meta.url).pathname, 'alice', 'root'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });
});
