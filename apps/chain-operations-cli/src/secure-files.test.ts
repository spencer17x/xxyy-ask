import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMountedSecretResolver, readControlledManifest } from './secure-files.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('controlled chain operations files', () => {
  it('reads bounded regular manifests and mounted secret references', async () => {
    const root = await temporaryDirectory();
    const manifestFile = path.join(root, 'manifest.json');
    const secretDirectory = path.join(root, 'secrets');
    const endpointFile = path.join(secretDirectory, 'providers/snapshot/primary/endpoint');
    await mkdir(path.dirname(endpointFile), { recursive: true });
    await writeFile(manifestFile, '{"version":"test"}', { mode: 0o600 });
    await writeFile(endpointFile, 'https://rpc.example/v1\n', { mode: 0o600 });

    await expect(readControlledManifest(manifestFile)).resolves.toEqual({ version: 'test' });
    await expect(
      createMountedSecretResolver(secretDirectory).resolve(
        'secretref:providers/snapshot/primary/endpoint',
      ),
    ).resolves.toBe('https://rpc.example/v1');
  });

  it('rejects final and ancestor symlinks that escape controlled files', async () => {
    const root = await temporaryDirectory();
    const secretDirectory = path.join(root, 'secrets');
    const outsideDirectory = path.join(root, 'outside');
    await mkdir(path.join(secretDirectory, 'providers'), { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    const outsideSecret = path.join(outsideDirectory, 'endpoint');
    await writeFile(outsideSecret, 'https://rpc.example/v1', { mode: 0o600 });

    const finalSymlink = path.join(secretDirectory, 'providers/final');
    await symlink(outsideSecret, finalSymlink);
    await expect(
      createMountedSecretResolver(secretDirectory).resolve('secretref:providers/final'),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    const ancestorSymlink = path.join(secretDirectory, 'providers/ancestor');
    await symlink(outsideDirectory, ancestorSymlink);
    await expect(
      createMountedSecretResolver(secretDirectory).resolve('secretref:providers/ancestor/endpoint'),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(readControlledManifest(finalSymlink)).rejects.toMatchObject({
      code: 'io_error',
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'xxyy-chain-operations-'));
  temporaryDirectories.push(directory);
  return directory;
}
