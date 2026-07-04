import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('golden QA dataset', () => {
  it('covers core product, how-to, boundary, and citation scenarios', async () => {
    const content = await readFile(
      new URL('../docs/eval/golden-qa.jsonl', import.meta.url),
      'utf8',
    );
    const records = content
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    expect(records.length).toBeGreaterThanOrEqual(8);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ expectedIntent: 'product_qa', boundaryExpected: false }),
        expect.objectContaining({ expectedIntent: 'how_to', boundaryExpected: false }),
        expect.objectContaining({
          expectedIntent: 'realtime_account_query',
          boundaryExpected: true,
        }),
        expect.objectContaining({ expectedIntent: 'investment_advice', boundaryExpected: true }),
        expect.objectContaining({ expectedIntent: 'unknown', boundaryExpected: true }),
        expect.objectContaining({
          expectedIntent: 'product_qa',
          expectedCitationFiles: expect.arrayContaining([expect.any(String)]),
        }),
      ]),
    );
  });
});
