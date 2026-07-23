import { describe, expect, it } from 'vitest';

import { parseChainOperationsArgs } from './index.js';

describe('chain operations CLI arguments', () => {
  it('parses bounded private operations commands', () => {
    expect(parseChainOperationsArgs(['validate'])).toEqual({ command: 'validate' });
    expect(parseChainOperationsArgs(['bootstrap'])).toEqual({ command: 'bootstrap' });
    expect(parseChainOperationsArgs(['worker:reconcile'])).toEqual({
      command: 'worker_reconcile',
    });
    expect(parseChainOperationsArgs(['worker:retention'])).toEqual({
      command: 'worker_retention',
    });
    expect(
      parseChainOperationsArgs(['probe:snapshot', '--transaction-hash', `0x${'12'.repeat(32)}`]),
    ).toEqual({
      command: 'probe_snapshot',
      transactionHash: `0x${'12'.repeat(32)}`,
    });
    expect(
      parseChainOperationsArgs([
        'probe:snapshot',
        '--',
        '--transaction-hash',
        `0x${'12'.repeat(32)}`,
      ]),
    ).toEqual({
      command: 'probe_snapshot',
      transactionHash: `0x${'12'.repeat(32)}`,
    });
  });

  it('rejects unknown, duplicate, and malformed flags', () => {
    expect(() => parseChainOperationsArgs(['unknown'])).toThrow();
    expect(() =>
      parseChainOperationsArgs([
        'probe:snapshot',
        '--transaction-hash',
        `0x${'12'.repeat(32)}`,
        '--transaction-hash',
        `0x${'34'.repeat(32)}`,
      ]),
    ).toThrow();
    expect(() => parseChainOperationsArgs(['probe:snapshot', '--transaction-hash'])).toThrow();
  });
});
