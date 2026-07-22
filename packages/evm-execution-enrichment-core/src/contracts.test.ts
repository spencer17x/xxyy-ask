import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  MAX_TRACE_BYTES,
  MAX_TRACE_DEPTH,
  MAX_TRACE_NODES,
  evmCallTraceSchema,
  evmExecutionEnrichmentInputSchema,
  evmPoolMetadataSchema,
  traceAddressKey,
} from './contracts.js';

async function loadFixture(): Promise<Record<string, unknown>> {
  const content = await readFile(
    new URL('./fixtures/success-internal-swaps.json', import.meta.url),
    'utf8',
  );
  return JSON.parse(content) as Record<string, unknown>;
}

describe('EVM execution enrichment input contracts', () => {
  it('accepts a bounded flat trace and canonicalizes EVM addresses and bytes', async () => {
    const fixture = await loadFixture();
    const rawTrace = fixture.trace as Record<string, unknown>;
    const nodes = rawTrace.nodes as Array<Record<string, unknown>>;
    const parsed = evmCallTraceSchema.parse({
      ...rawTrace,
      nodes: nodes.map((node, index) =>
        index === 0
          ? {
              ...node,
              input: '0xABCD',
              to: '0x222222222222222222222222222222222222222A',
            }
          : node,
      ),
    });

    expect(parsed.nodes[0]).toMatchObject({
      input: '0xabcd',
      to: '0x222222222222222222222222222222222222222a',
      traceAddress: [],
    });
    expect(traceAddressKey([])).toBe('root');
    expect(traceAddressKey([2, 1])).toBe('2.1');
  });

  it('rejects duplicate paths, missing parents, multiple roots, and mismatched sources', async () => {
    const fixture = await loadFixture();
    const trace = evmCallTraceSchema.parse(fixture.trace);
    const root = trace.nodes.find((node) => node.traceAddress.length === 0);
    if (root === undefined) {
      throw new Error('Expected a root trace node.');
    }

    expect(
      evmCallTraceSchema.safeParse({ ...trace, nodes: [...trace.nodes, { ...root }] }).success,
    ).toBe(false);
    expect(
      evmCallTraceSchema.safeParse({
        ...trace,
        nodes: trace.nodes.map((node) =>
          node.traceAddress.length === 2 ? { ...node, traceAddress: [9, 0] } : node,
        ),
      }).success,
    ).toBe(false);
    expect(
      evmCallTraceSchema.safeParse({
        ...trace,
        nodes: trace.nodes.map((node, index) =>
          index === 0 ? { ...node, sourceId: 'other-source' } : node,
        ),
      }).success,
    ).toBe(false);
  });

  it('rejects missing destinations and error codes on successful nodes', async () => {
    const fixture = await loadFixture();
    const trace = evmCallTraceSchema.parse(fixture.trace);

    expect(
      evmCallTraceSchema.safeParse({
        ...trace,
        nodes: trace.nodes.map((node, index) => (index === 0 ? { ...node, to: null } : node)),
      }).success,
    ).toBe(false);
    expect(
      evmCallTraceSchema.safeParse({
        ...trace,
        nodes: trace.nodes.map((node, index) =>
          index === 0 ? { ...node, errorCode: 'unexpected_error' } : node,
        ),
      }).success,
    ).toBe(false);
  });

  it('enforces node, depth, and per-node byte bounds before analysis', async () => {
    const fixture = await loadFixture();
    const trace = evmCallTraceSchema.parse(fixture.trace);
    const root = trace.nodes.find((node) => node.traceAddress.length === 0);
    if (root === undefined) {
      throw new Error('Expected a root trace node.');
    }

    const tooManyNodes = Array.from({ length: MAX_TRACE_NODES + 1 }, (_, index) => ({
      ...root,
      traceAddress: index === 0 ? [] : [index - 1],
    }));
    expect(evmCallTraceSchema.safeParse({ ...trace, nodes: tooManyNodes }).success).toBe(false);
    expect(
      evmCallTraceSchema.safeParse({
        ...trace,
        nodes: [
          root,
          {
            ...root,
            traceAddress: Array.from({ length: MAX_TRACE_DEPTH + 1 }, () => 0),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      evmCallTraceSchema.safeParse({
        ...trace,
        nodes: trace.nodes.map((node, index) =>
          index === 0 ? { ...node, output: `0x${'00'.repeat(MAX_TRACE_BYTES + 1)}` } : node,
        ),
      }).success,
    ).toBe(false);
  });

  it('requires unique pool identity and distinct token addresses', async () => {
    const fixture = await loadFixture();
    const pools = evmPoolMetadataSchema.parse(fixture.poolMetadata);

    expect(evmPoolMetadataSchema.safeParse([...pools, pools[0]]).success).toBe(false);
    expect(
      evmPoolMetadataSchema.safeParse([{ ...pools[0], token1: pools[0]?.token0 }]).success,
    ).toBe(false);
  });

  it('keeps trace and metadata payloads opaque in the envelope so malformed enrichment can degrade', async () => {
    const fixture = await loadFixture();
    const parsed = evmExecutionEnrichmentInputSchema.parse({
      snapshot: fixture.snapshot,
      trace: { untrusted: true },
      poolMetadata: { untrusted: true },
    });

    expect(parsed.trace).toEqual({ untrusted: true });
    expect(parsed.poolMetadata).toEqual({ untrusted: true });
  });
});
