import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gitProbe = spawnSync('git', ['rev-parse', '--git-dir'], {
  cwd: repositoryRoot,
  stdio: 'ignore',
});

if (gitProbe.status !== 0) {
  console.log('Skipping Git hook setup because this checkout has no Git metadata.');
  process.exit(0);
}

execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  cwd: repositoryRoot,
});
execFileSync(
  'git',
  ['config', '--local', 'commit.template', resolve(repositoryRoot, '.gitmessage')],
  { cwd: repositoryRoot },
);

console.log('Configured .githooks and .gitmessage for this checkout.');
