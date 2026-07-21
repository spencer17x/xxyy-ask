import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { extractTelegramKnowledgeCandidates } from './telegram-knowledge.js';
import type { TrustedAuthor } from './trusted-authors.js';

interface CuratorGoldenCase {
  expectedCandidateCount: number;
  expectedRiskFlags: string[];
  export: unknown;
  forbiddenSubstrings: string[];
  name: string;
  roleMode: 'expired' | 'telegram_current' | 'trusted';
}

describe('Knowledge Curator deterministic golden cases', () => {
  it('passes the versioned Telegram governance fixture set', async () => {
    const cases = await loadGoldenCases();

    for (const testCase of cases) {
      const result = extractTelegramKnowledgeCandidates(testCase.export, {
        ...(testCase.roleMode === 'telegram_current'
          ? { currentAdministratorUserIds: new Set(['123']) }
          : { trustedAuthors: [trustedAuthor(testCase.roleMode === 'expired')] }),
      });
      expect(result.candidates.length, testCase.name).toBe(testCase.expectedCandidateCount);
      const riskFlags = new Set(
        result.candidates.flatMap((candidate) => candidate.riskFlags ?? []),
      );
      for (const riskFlag of testCase.expectedRiskFlags) {
        expect(riskFlags.has(riskFlag), `${testCase.name}: ${riskFlag}`).toBe(true);
      }
      const serialized = JSON.stringify(result.candidates);
      for (const forbidden of testCase.forbiddenSubstrings) {
        expect(serialized, `${testCase.name}: leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

async function loadGoldenCases(): Promise<CuratorGoldenCase[]> {
  const file = new URL('../../../docs/eval/knowledge-curator-golden.jsonl', import.meta.url);
  const content = await readFile(file, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CuratorGoldenCase);
}

function trustedAuthor(expired: boolean): TrustedAuthor {
  return {
    chatId: '-100123',
    createdAt: '2026-07-01T00:00:00.000Z',
    id: 'trusted_author_123',
    role: 'knowledge_editor',
    updatedAt: '2026-07-01T00:00:00.000Z',
    userId: '123',
    validFrom: '2026-07-01T00:00:00.000Z',
    ...(expired ? { validTo: '2026-08-01T00:00:00.000Z' } : {}),
    verificationSource: 'manual',
    verifiedAt: '2026-07-01T00:00:00.000Z',
    verifiedBy: 'operator:alice',
  };
}
