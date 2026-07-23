import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { secretReferenceSchema } from '@xxyy/evm-chain-analysis-readiness';

import { ChainOperationsCliError } from './runtime-config.js';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;

export async function readControlledManifest(file: string): Promise<unknown> {
  const contents = await readRegularFile(path.resolve(file), MAX_MANIFEST_BYTES);
  try {
    return JSON.parse(contents);
  } catch (cause) {
    throw new ChainOperationsCliError('invalid_input', 'Data-plane manifest is not valid JSON.', {
      cause,
    });
  }
}

export function createMountedSecretResolver(secretDirectory: string): {
  resolve(secretRef: string): Promise<string>;
} {
  const configuredRoot = path.resolve(secretDirectory);
  let trustedRootPromise: Promise<string> | undefined;
  return {
    async resolve(secretRef) {
      const parsedRef = secretReferenceSchema.parse(secretRef);
      const relativePath = parsedRef.slice('secretref:'.length);
      const trustedRoot = await (trustedRootPromise ??= realpath(configuredRoot));
      const candidate = path.resolve(trustedRoot, relativePath);
      if (!candidate.startsWith(`${trustedRoot}${path.sep}`)) {
        throw new ChainOperationsCliError(
          'invalid_input',
          'Secret reference escapes the configured mount.',
        );
      }
      const resolved = await realpath(candidate);
      if (!resolved.startsWith(`${trustedRoot}${path.sep}`)) {
        throw new ChainOperationsCliError(
          'invalid_input',
          'Secret reference resolves outside the configured mount.',
        );
      }
      const value = await readRegularFile(resolved, MAX_SECRET_BYTES);
      return value.endsWith('\n') ? value.slice(0, -1) : value;
    },
  };
}

async function readRegularFile(file: string, maxBytes: number): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new ChainOperationsCliError(
        'invalid_input',
        'Controlled input is not a bounded regular file.',
      );
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    if (offset > maxBytes) {
      throw new ChainOperationsCliError(
        'invalid_input',
        'Controlled input exceeds its size limit.',
      );
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch (cause) {
    if (cause instanceof ChainOperationsCliError) {
      throw cause;
    }
    throw new ChainOperationsCliError('io_error', 'Could not read controlled input.', {
      cause,
    });
  } finally {
    await handle?.close();
  }
}
