export interface ProviderCacheEntry {
  body: Uint8Array;
  contentType?: string | undefined;
  status: number;
}

export interface ProviderResponseCache {
  read(key: string, nowMs: number): Promise<ProviderCacheEntry | undefined>;
  write(key: string, entry: ProviderCacheEntry, expiresAtMs: number): Promise<void>;
}

interface MemoryEntry extends ProviderCacheEntry {
  expiresAtMs: number;
}

export function createMemoryProviderResponseCache(options: {
  maxEntries: number;
  maxTotalBytes: number;
}): ProviderResponseCache {
  const maxEntries = normalizeMaxEntries(options.maxEntries);
  const maxTotalBytes = normalizeMaxTotalBytes(options.maxTotalBytes);
  const entries = new Map<string, MemoryEntry>();
  let totalBytes = 0;
  const remove = (key: string): void => {
    const existing = entries.get(key);
    if (existing !== undefined) {
      entries.delete(key);
      totalBytes -= existing.body.byteLength;
    }
  };
  return {
    read(key, nowMs) {
      const entry = entries.get(key);
      if (entry === undefined) {
        return Promise.resolve(undefined);
      }
      if (entry.expiresAtMs <= nowMs) {
        remove(key);
        return Promise.resolve(undefined);
      }
      entries.delete(key);
      entries.set(key, entry);
      return Promise.resolve({
        body: entry.body.slice(),
        ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }),
        status: entry.status,
      });
    },
    write(key, entry, expiresAtMs) {
      remove(key);
      if (
        maxEntries === 0 ||
        maxTotalBytes === 0 ||
        expiresAtMs <= 0 ||
        entry.body.byteLength > maxTotalBytes
      ) {
        return Promise.resolve();
      }
      while (entries.size >= maxEntries || totalBytes + entry.body.byteLength > maxTotalBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        remove(oldest);
      }
      entries.set(key, {
        body: entry.body.slice(),
        ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }),
        expiresAtMs,
        status: entry.status,
      });
      totalBytes += entry.body.byteLength;
      return Promise.resolve();
    },
  };
}

function normalizeMaxTotalBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_073_741_824) {
    throw new RangeError('maxTotalBytes must be an integer between 0 and 1073741824.');
  }
  return value;
}

function normalizeMaxEntries(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError('maxEntries must be an integer between 0 and 10000.');
  }
  return value;
}
