import { createHash, randomBytes } from 'node:crypto';

const rawArguments = process.argv.slice(2);
const argumentsWithoutSeparator = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
const [rawId = 'admin', rawRole = 'admin'] = argumentsWithoutSeparator;
const id = rawId.trim();
const role = rawRole.trim();
if (
  !/^[A-Za-z0-9_.:@-]{1,160}$/u.test(id) ||
  !['admin', 'publisher', 'reviewer', 'viewer'].includes(role)
) {
  process.stderr.write(
    'Usage: pnpm admin:token:create -- [administrator-id] [admin|publisher|reviewer|viewer]\n',
  );
  process.exitCode = 1;
} else {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  process.stdout.write(
    [
      'Store this plaintext token in the administrator password manager; it will not be shown again:',
      token,
      '',
      'Add this record to KNOWLEDGE_ADMIN_TOKENS_JSON:',
      JSON.stringify({ displayName: id, id, role, tokenHash }),
      '',
    ].join('\n'),
  );
}
