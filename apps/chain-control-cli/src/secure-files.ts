import { constants } from 'node:fs';
import { mkdir, open, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { ChainControlCliError } from './runtime-config.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;

export async function readControlledJson(file: string): Promise<unknown> {
  const contents = await readControlledFile(file, {
    maxBytes: MAX_JSON_BYTES,
    requireOwnerOnly: false,
  });
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new ChainControlCliError('invalid_input', 'Controlled JSON input is invalid.', {
      cause: error,
    });
  }
}

export async function readPrivateKeyFile(file: string): Promise<string> {
  return readControlledFile(file, {
    maxBytes: MAX_KEY_BYTES,
    requireOwnerOnly: true,
  });
}

export async function readPublicKeyFile(file: string): Promise<string> {
  return readControlledFile(file, {
    maxBytes: MAX_KEY_BYTES,
    requireOwnerOnly: false,
  });
}

export async function writeControlledJson(file: string, value: unknown): Promise<void> {
  try {
    const resolvedFile = path.resolve(file);
    await mkdir(path.dirname(resolvedFile), { mode: 0o700, recursive: true });
    await writeFile(resolvedFile, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    throw new ChainControlCliError(
      'io_error',
      'Could not create the controlled output file; existing files are never overwritten.',
      { cause: error },
    );
  }
}

async function readControlledFile(
  file: string,
  options: { maxBytes: number; requireOwnerOnly: boolean },
): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ChainControlCliError(
        'invalid_input',
        'Controlled input must be a regular file, not a directory or symbolic link.',
      );
    }
    if (metadata.size > options.maxBytes) {
      throw new ChainControlCliError('invalid_input', 'Controlled input exceeds its size limit.');
    }
    if (options.requireOwnerOnly && (metadata.mode & 0o077) !== 0) {
      throw new ChainControlCliError(
        'invalid_input',
        'Authority private key file must not be accessible by group or other users.',
      );
    }
    return await readBoundedUtf8(handle, options.maxBytes);
  } catch (error) {
    if (error instanceof ChainControlCliError) {
      throw error;
    }
    throw new ChainControlCliError('io_error', 'Could not read the controlled input file.', {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

async function readBoundedUtf8(handle: FileHandle, maxBytes: number): Promise<string> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  if (bytesRead > maxBytes) {
    throw new ChainControlCliError('invalid_input', 'Controlled input exceeds its size limit.');
  }
  return buffer.subarray(0, bytesRead).toString('utf8');
}
