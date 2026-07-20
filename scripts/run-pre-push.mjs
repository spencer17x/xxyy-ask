import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isUsableCommitSha, printFailures, validateCommitShas } from './validate-commit-range.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function runGit(args, cwd = repositoryRoot) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

export function parsePrePushInput(input) {
  return input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha, ...extra] = line.split(/\s+/u);
      if (
        localRef === undefined ||
        localSha === undefined ||
        remoteRef === undefined ||
        remoteSha === undefined ||
        extra.length > 0
      ) {
        throw new Error(`无法解析 pre-push 输入: ${line}`);
      }
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

function listCommitShasForUpdate(update, cwd) {
  if (!isUsableCommitSha(update.localSha)) {
    return [];
  }
  const args = isUsableCommitSha(update.remoteSha)
    ? ['rev-list', '--reverse', `${update.remoteSha}..${update.localSha}`]
    : ['rev-list', '--reverse', update.localSha, '--not', '--remotes'];
  const output = runGit(args, cwd);
  return output.length === 0 ? [] : output.split('\n').filter(Boolean);
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function runFullCheck(cwd) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, ['check'], { cwd, stdio: 'inherit' });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result.status ?? 1;
}

async function main(args) {
  const [remoteName = '(unknown)', remoteUrl = '(unknown)'] = args;
  const updates = parsePrePushInput(await readStdin());
  if (updates.length === 0) {
    console.log('pre-push: 未收到引用更新，按手工调用执行完整质量门禁。');
    return runFullCheck(repositoryRoot);
  }
  const activeUpdates = updates.filter((update) => isUsableCommitSha(update.localSha));
  if (activeUpdates.length === 0) {
    console.log('pre-push: 只有远程引用删除操作，跳过代码检查。');
    return 0;
  }

  const shas = [
    ...new Set(activeUpdates.flatMap((update) => listCommitShasForUpdate(update, repositoryRoot))),
  ];
  const failures = validateCommitShas(shas, { cwd: repositoryRoot });
  if (failures.length > 0) {
    printFailures(failures);
    return 1;
  }
  console.log(
    `pre-push: ${shas.length} 个待推送提交通过消息校验；正在检查 ${remoteName} (${remoteUrl})。`,
  );
  return runFullCheck(repositoryRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
