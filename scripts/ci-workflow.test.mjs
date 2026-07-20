import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('CI workflow', () => {
  it('runs the hardened standard quality gate and commit validation', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow).toContain('timeout-minutes: 20');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('validate-commit-range.mjs');
    expect(workflow).toContain('github.event.merge_group.base_sha');
    expect(workflow).toContain('github.event.merge_group.head_sha');
    expect(workflow).toContain('pnpm install --frozen-lockfile --prefer-offline');
    expect(workflow).toContain('pnpm check');
  });
});
