import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateCommitMessage } from './validate-commit-message.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ZERO_SHA_PATTERN = /^0+$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/iu;

function runGit(args, cwd = repositoryRoot) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

export function isUsableCommitSha(value) {
  return (
    typeof value === 'string' && COMMIT_SHA_PATTERN.test(value) && !ZERO_SHA_PATTERN.test(value)
  );
}

export function commitShasInRange({ cwd = repositoryRoot, from, to }) {
  if (!isUsableCommitSha(to)) {
    throw new Error(`无效的目标 commit SHA: ${to ?? '(empty)'}`);
  }
  if (!isUsableCommitSha(from)) {
    return [runGit(['rev-parse', `${to}^{commit}`], cwd)];
  }
  const output = runGit(['rev-list', '--reverse', `${from}..${to}`], cwd);
  if (output.length === 0) {
    return [];
  }
  return output.split('\n').filter(Boolean);
}

export function validateCommitShas(shas, options = {}) {
  const cwd = options.cwd ?? repositoryRoot;
  const failures = [];
  for (const sha of [...new Set(shas)]) {
    if (!isUsableCommitSha(sha)) {
      failures.push({ errors: [`无效的 commit SHA: ${sha}`], header: '', sha });
      continue;
    }
    const message = runGit(['show', '-s', '--format=%B', sha], cwd);
    const errors = validateCommitMessage(message);
    if (errors.length > 0) {
      failures.push({ errors, header: message.split(/\r?\n/u)[0] ?? '', sha });
    }
  }
  return failures;
}

export function validateCommitRange(options) {
  const shas = commitShasInRange(options);
  return { failures: validateCommitShas(shas, options), shas };
}

export function parseCommitRangeArgs(args) {
  const normalizedArgs = args.filter((argument) => argument !== '--');
  const values = new Map();
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const key = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if ((key !== '--from' && key !== '--to') || value === undefined) {
      return undefined;
    }
    values.set(key, value);
  }
  return { from: values.get('--from'), to: values.get('--to') };
}

function printFailures(failures) {
  console.error('以下提交消息不符合 AGENTS.md 中的 Conventional Commits 规范：');
  for (const failure of failures) {
    console.error(`- ${failure.sha.slice(0, 12)} ${failure.header}`);
    for (const error of failure.errors) {
      console.error(`  - ${error}`);
    }
  }
}

async function main(args) {
  const parsed = parseCommitRangeArgs(args);
  if (parsed === undefined || parsed.to === undefined) {
    console.error('用法: node scripts/validate-commit-range.mjs --from <sha> --to <sha>');
    return 2;
  }
  const result = validateCommitRange(parsed);
  if (result.failures.length > 0) {
    printFailures(result.failures);
    return 1;
  }
  console.log(`Commit range check: ${result.shas.length} 个提交通过校验。`);
  return 0;
}

export { printFailures };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
