import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hookNames = ['pre-commit', 'commit-msg', 'pre-push'];
const gitProbe = spawnSync('git', ['rev-parse', '--git-dir'], {
  cwd: repositoryRoot,
  stdio: 'ignore',
});

if (gitProbe.status !== 0) {
  console.log('Skipping Git hook setup because this checkout has no Git metadata.');
  process.exit(0);
}

for (const hookName of hookNames) {
  const hookPath = resolve(repositoryRoot, '.githooks', hookName);
  if (!existsSync(hookPath)) {
    throw new Error(`Missing required Git hook: .githooks/${hookName}`);
  }
  if (process.platform !== 'win32') {
    chmodSync(hookPath, 0o755);
  }
}

execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  cwd: repositoryRoot,
});
execFileSync(
  'git',
  ['config', '--local', 'commit.template', resolve(repositoryRoot, '.gitmessage')],
  { cwd: repositoryRoot },
);

console.log(`Configured ${hookNames.join(', ')} and .gitmessage for this checkout.`);
