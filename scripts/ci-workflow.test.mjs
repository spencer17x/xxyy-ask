import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('CI workflow', () => {
  it('runs the standard check', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain('pnpm check');
  });
});
