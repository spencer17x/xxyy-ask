import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_STAGED_FILE_BYTES = 95 * 1024 * 1024;
const ESLINT_FILE_PATTERN = /\.(?:cjs|js|mjs|ts|tsx)$/iu;
const FORBIDDEN_PATH_PATTERNS = [
  { pattern: /(?:^|\/)\.env(?:\..+)?$/u, reason: '环境变量文件不能提交' },
  { pattern: /(?:^|\/)\.rag(?:\/|$)/u, reason: '.rag 本地索引不能提交' },
  { pattern: /(?:^|\/)node_modules(?:\/|$)/u, reason: 'node_modules 不能提交' },
  { pattern: /(?:^|\/)(?:coverage|dist)(?:\/|$)/u, reason: '构建或覆盖率产物不能提交' },
  { pattern: /\.(?:sqlite|sqlite3)$/iu, reason: '本地数据库文件不能提交' },
  {
    pattern: /(?:^|\/)(?:id_rsa|id_ed25519|[^/]+\.(?:key|p12|pfx|pem))$/iu,
    reason: '私钥或证书密钥文件不能提交',
  },
];
const ALLOWED_ENV_FILES = new Set(['.env.example', '.env.sample', '.env.template']);

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: options.stdio,
  });
}

export function stagedPathError(file) {
  const normalized = file.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized);
  if (ALLOWED_ENV_FILES.has(basename)) {
    return undefined;
  }
  return FORBIDDEN_PATH_PATTERNS.find(({ pattern }) => pattern.test(normalized))?.reason;
}

function listStagedFiles(cwd) {
  const output = runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    cwd,
    encoding: null,
  });
  return output
    .toString('utf8')
    .split('\0')
    .filter((file) => file.length > 0);
}

function readStagedFile(cwd, file) {
  return runGit(['show', `:${file}`], { cwd });
}

function stagedFileSize(cwd, file) {
  return Number.parseInt(runGit(['cat-file', '-s', `:${file}`], { cwd }).trim(), 10);
}

function checkGitDiff(cwd) {
  const result = spawnSync('git', ['diff', '--cached', '--check'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    return [];
  }
  return [result.stdout.trim() || result.stderr.trim() || 'git diff --cached --check 失败'];
}

async function checkPrettier(cwd, files, contents) {
  let prettier;
  try {
    prettier = await import('prettier');
  } catch {
    return ['无法加载 Prettier；请先运行 pnpm install'];
  }

  const errors = [];
  for (const file of files) {
    const absoluteFile = path.join(cwd, file);
    const fileInfo = await prettier.getFileInfo(absoluteFile, {
      ignorePath: path.join(cwd, '.prettierignore'),
    });
    if (fileInfo.ignored || fileInfo.inferredParser === null) {
      continue;
    }
    const config = (await prettier.resolveConfig(absoluteFile)) ?? {};
    const formatted = await prettier.check(contents.get(file) ?? '', {
      ...config,
      filepath: absoluteFile,
    });
    if (!formatted) {
      errors.push(`${file}: 不符合 Prettier 格式；运行 pnpm exec prettier --write ${file}`);
    }
  }
  return errors;
}

async function checkEslint(cwd, files, contents) {
  const lintFiles = files.filter((file) => ESLINT_FILE_PATTERN.test(file));
  if (lintFiles.length === 0) {
    return [];
  }

  let ESLint;
  try {
    ({ ESLint } = await import('eslint'));
  } catch {
    return ['无法加载 ESLint；请先运行 pnpm install'];
  }

  const eslint = new ESLint({ cwd, errorOnUnmatchedPattern: false, warnIgnored: false });
  const results = await Promise.all(
    lintFiles.map((file) =>
      eslint.lintText(contents.get(file) ?? '', {
        filePath: path.join(cwd, file),
        warnIgnored: false,
      }),
    ),
  );
  const failures = results.flat().filter((result) => result.errorCount + result.warningCount > 0);
  if (failures.length === 0) {
    return [];
  }
  const formatter = await eslint.loadFormatter('stylish');
  return [(await formatter.format(failures)).trim()];
}

export async function validateStagedFiles(options = {}) {
  const cwd = options.cwd ?? repositoryRoot;
  const errors = checkGitDiff(cwd);
  const files = listStagedFiles(cwd);
  const contents = new Map();

  for (const file of files) {
    const pathError = stagedPathError(file);
    if (pathError !== undefined) {
      errors.push(`${file}: ${pathError}`);
      continue;
    }
    const size = stagedFileSize(cwd, file);
    if (!Number.isFinite(size) || size > MAX_STAGED_FILE_BYTES) {
      errors.push(`${file}: 暂存文件大小 ${size} 字节，超过 GitHub 允许范围前的 95 MiB 门禁`);
      continue;
    }
    contents.set(file, readStagedFile(cwd, file));
  }

  const checkableFiles = files.filter((file) => contents.has(file));
  errors.push(
    ...(await checkPrettier(cwd, checkableFiles, contents)),
    ...(await checkEslint(cwd, checkableFiles, contents)),
  );
  return { errors, files };
}

async function main() {
  const result = await validateStagedFiles();
  if (result.errors.length === 0) {
    console.log(
      result.files.length === 0
        ? 'pre-commit: 没有需要检查的暂存文件。'
        : `pre-commit: ${result.files.length} 个暂存文件通过检查。`,
    );
    return 0;
  }

  console.error('pre-commit 检查失败：');
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
