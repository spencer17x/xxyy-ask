import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePrePushInput } from './run-pre-push.mjs';
import {
  isUsableCommitSha,
  parseCommitRangeArgs,
  validateCommitRange,
} from './validate-commit-range.mjs';
import { stagedPathError } from './validate-staged-files.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createCommitFixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'xxyy-hooks-'));
  git(cwd, ['init', '--quiet']);
  git(cwd, ['config', 'user.email', 'hooks@example.test']);
  git(cwd, ['config', 'user.name', 'Hooks Test']);
  await writeFile(path.join(cwd, 'fixture.txt'), 'one\n');
  git(cwd, ['add', 'fixture.txt']);
  git(cwd, ['commit', '--quiet', '-m', 'chore(test): initialize hook fixture']);
  const base = git(cwd, ['rev-parse', 'HEAD']);

  await writeFile(path.join(cwd, 'fixture.txt'), 'two\n');
  git(cwd, ['add', 'fixture.txt']);
  git(cwd, ['commit', '--quiet', '-m', 'fix(test): validate pushed commits']);
  const validHead = git(cwd, ['rev-parse', 'HEAD']);

  await writeFile(path.join(cwd, 'fixture.txt'), 'three\n');
  git(cwd, ['add', 'fixture.txt']);
  git(cwd, ['commit', '--quiet', '-m', 'invalid commit title']);
  const invalidHead = git(cwd, ['rev-parse', 'HEAD']);
  return { base, cwd, invalidHead, validHead };
}

describe('Git hooks', () => {
  it.each(['pre-commit', 'commit-msg', 'pre-push'])('ships executable %s hook', async (name) => {
    const file = path.join(repositoryRoot, '.githooks', name);
    const [content, metadata] = await Promise.all([readFile(file, 'utf8'), stat(file)]);

    expect(content).toMatch(/^#!\/bin\/sh/u);
    expect(metadata.mode & 0o111).not.toBe(0);
  });

  it('rejects local or sensitive staged paths while allowing templates', () => {
    expect(stagedPathError('.env.example')).toBeUndefined();
    expect(stagedPathError('.env.production')).toContain('环境变量');
    expect(stagedPathError('.rag/index.json')).toContain('本地索引');
    expect(stagedPathError('data/cache.sqlite')).toContain('数据库');
    expect(stagedPathError('certs/private.pem')).toContain('私钥');
  });

  it('parses updates supplied by Git to pre-push', () => {
    const localSha = 'a'.repeat(40);
    const remoteSha = 'b'.repeat(40);

    expect(parsePrePushInput(`refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`)).toEqual(
      [
        {
          localRef: 'refs/heads/main',
          localSha,
          remoteRef: 'refs/heads/main',
          remoteSha,
        },
      ],
    );
    expect(isUsableCommitSha(localSha)).toBe(true);
    expect(isUsableCommitSha('0'.repeat(40))).toBe(false);
  });

  it('accepts commit range arguments with the pnpm separator', () => {
    expect(parseCommitRangeArgs(['--', '--from', 'abc1234', '--to', 'def5678'])).toEqual({
      from: 'abc1234',
      to: 'def5678',
    });
  });

  it('uses the commit-msg rules for commit ranges', async () => {
    const fixture = await createCommitFixture();

    expect(
      validateCommitRange({ cwd: fixture.cwd, from: fixture.base, to: fixture.validHead }),
    ).toMatchObject({ failures: [], shas: [fixture.validHead] });
    const invalid = validateCommitRange({
      cwd: fixture.cwd,
      from: fixture.validHead,
      to: fixture.invalidHead,
    });
    expect(invalid.failures).toHaveLength(1);
    expect(invalid.failures[0]?.header).toBe('invalid commit title');
  });
});
