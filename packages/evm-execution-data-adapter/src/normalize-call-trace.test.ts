import { readFile } from 'node:fs/promises';

import {
  MAX_TRACE_BYTES,
  MAX_TRACE_DEPTH,
  MAX_TRACE_NODES,
} from '@xxyy/evm-execution-enrichment-core';
import { describe, expect, it } from 'vitest';

import { EvmTraceNormalizationError } from './errors.js';
import { fingerprintCallTrace, normalizeCallTracerResult } from './normalize-call-trace.js';

const transactionHash = `0x${'a'.repeat(64)}`;
const sourceHash = `sha256:${'b'.repeat(64)}`;

interface ReplayFixture {
  trace: unknown;
}

async function loadFixture(name: string): Promise<ReplayFixture> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as ReplayFixture;
}

function normalize(trace: unknown, providerId = 'rpc_primary') {
  return normalizeCallTracerResult(trace, {
    chainId: '1',
    observedAt: '2026-07-22T00:00:00.000Z',
    payloadHash: sourceHash,
    providerId,
    transactionHash,
  });
}

function callFrame(calls: unknown[] = []): Record<string, unknown> {
  return {
    calls,
    from: '0x1111111111111111111111111111111111111111',
    input: '0x',
    to: '0x2222222222222222222222222222222222222222',
    type: 'CALL',
    value: '0x0',
  };
}

describe('Geth callTracer normalization', () => {
  it('flattens a nested trace losslessly and sanitizes provider errors', async () => {
    const fixture = await loadFixture('provider-success');
    const trace = normalize(fixture.trace);

    expect(trace.nodes.map((node) => node.traceAddress)).toEqual([[], [0], [1], [2], [2, 0]]);
    expect(trace.nodes[0]).toMatchObject({
      gasUsed: '100000',
      input: '0xabcdef',
      status: 'success',
      type: 'call',
      value: '0',
    });
    expect(trace.nodes[1]).toMatchObject({ gasUsed: '21000', value: '2' });
    expect(trace.nodes[2]).toMatchObject({
      errorCode: 'execution_reverted',
      status: 'reverted',
      type: 'delegatecall',
      value: '0',
    });
    expect(trace.nodes[4]).toMatchObject({
      input: '0x',
      type: 'selfdestruct',
      value: '5',
    });
    expect(JSON.stringify(trace)).not.toContain('private provider detail');
  });

  it('uses semantic fingerprints that ignore provider provenance', async () => {
    const fixture = await loadFixture('provider-success');
    const conflicting = await loadFixture('provider-conflict');
    const first = normalize(fixture.trace, 'rpc_a');
    const second = normalize(fixture.trace, 'rpc_b');
    const third = normalize(conflicting.trace, 'rpc_b');

    expect(fingerprintCallTrace(first)).toBe(fingerprintCallTrace(second));
    expect(fingerprintCallTrace(first)).not.toBe(fingerprintCallTrace(third));
  });

  it('maps unknown provider error text to one stable non-leaking code', () => {
    const trace = normalize({
      ...callFrame(),
      error: 'vendor-secret: a proprietary future EVM failure',
      output: '0x',
    });

    expect(trace.nodes[0]?.errorCode).toBe('unknown_execution_error');
    expect(JSON.stringify(trace)).not.toContain('vendor-secret');
  });

  it('rejects traces beyond the node, depth, or bytes contracts before enrichment', () => {
    expect(() =>
      normalize(callFrame(Array.from({ length: MAX_TRACE_NODES }, () => callFrame()))),
    ).toThrowError(expect.objectContaining({ code: 'trace_node_limit_exceeded' }));

    let deep: Record<string, unknown> = callFrame();
    for (let depth = 0; depth <= MAX_TRACE_DEPTH; depth += 1) {
      deep = callFrame([deep]);
    }
    expect(() => normalize(deep)).toThrowError(
      expect.objectContaining({ code: 'trace_depth_limit_exceeded' }),
    );

    expect(() =>
      normalize({ ...callFrame(), input: `0x${'aa'.repeat(MAX_TRACE_BYTES + 1)}` }),
    ).toThrowError(expect.objectContaining({ code: 'trace_bytes_limit_exceeded' }));
  });

  it('rejects malformed quantities, addresses, call types, and child containers', () => {
    for (const invalid of [
      { ...callFrame(), value: '0x01' },
      { ...callFrame(), from: '0x1234' },
      { ...callFrame(), type: 'AUTHCALL' },
      { ...callFrame(), calls: {} },
    ]) {
      expect(() => normalize(invalid)).toThrow(EvmTraceNormalizationError);
      expect(() => normalize(invalid)).toThrowError(
        expect.objectContaining({ code: 'trace_invalid' }),
      );
    }
  });
});
