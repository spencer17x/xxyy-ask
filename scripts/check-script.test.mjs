import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('root quality gate', () => {
  it('runs the deterministic golden QA evaluation as part of pnpm check', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));

    expect(packageJson.scripts.check).toContain('pnpm rag:evaluate');
  });
});
