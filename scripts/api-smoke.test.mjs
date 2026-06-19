import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApiSmokeChecks, runApiSmoke } from './api-smoke.mjs';

describe('createApiSmokeChecks', () => {
  it('checks public health endpoints by default', () => {
    expect(createApiSmokeChecks([], {})).toEqual([
      {
        body: undefined,
        headers: {},
        kind: 'health',
        label: 'health',
        method: 'GET',
        url: 'http://localhost:3000/health',
      },
      {
        body: undefined,
        headers: {},
        kind: 'deepHealth',
        label: 'deep health',
        method: 'GET',
        url: 'http://localhost:3000/health/deep',
      },
    ]);
  });

  it('supports protected ops summary and chat smoke checks', () => {
    expect(
      createApiSmokeChecks(
        [
          '--',
          '--base-url',
          'https://ask.example.com',
          '--ops-token',
          'ops-token',
          '--chat',
          '--question',
          'XXYY Pro 有哪些权益？',
        ],
        {},
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'health',
        url: 'https://ask.example.com/health',
      }),
      expect.objectContaining({
        kind: 'deepHealth',
        url: 'https://ask.example.com/health/deep',
      }),
      expect.objectContaining({
        headers: { Authorization: 'Bearer ops-token' },
        kind: 'opsSummary',
        url: 'https://ask.example.com/api/ops/summary',
      }),
      expect.objectContaining({
        body: JSON.stringify({ channel: 'cli', message: 'XXYY Pro 有哪些权益？' }),
        headers: { 'Content-Type': 'application/json' },
        kind: 'chat',
        method: 'POST',
        url: 'https://ask.example.com/api/chat',
      }),
    ]);
  });

  it('supports multi-turn chat follow-up smoke checks with a shared session', () => {
    const checks = createApiSmokeChecks(
      [
        '--base-url',
        'https://ask.example.com',
        '--chat-follow-up',
        '--question',
        'XXYY Pro 有哪些权益？',
        '--follow-up-question',
        '怎么升级？',
      ],
      {},
    );

    expect(checks).toEqual([
      expect.objectContaining({ kind: 'health' }),
      expect.objectContaining({ kind: 'deepHealth' }),
      expect.objectContaining({
        body: expect.any(String),
        kind: 'chat',
        label: 'chat',
        url: 'https://ask.example.com/api/chat',
      }),
      expect.objectContaining({
        body: expect.any(String),
        kind: 'chatFollowUp',
        label: 'chat follow-up',
        url: 'https://ask.example.com/api/chat',
      }),
    ]);
    const firstBody = JSON.parse(checks[2].body);
    const followUpBody = JSON.parse(checks[3].body);
    expect(firstBody).toEqual({
      channel: 'cli',
      message: 'XXYY Pro 有哪些权益？',
      sessionId: 'api-smoke-session',
    });
    expect(followUpBody).toEqual({
      channel: 'cli',
      message: '怎么升级？',
      sessionId: 'api-smoke-session',
    });
  });

  it('supports boundary chat smoke checks', () => {
    expect(
      createApiSmokeChecks(
        [
          '--base-url',
          'https://ask.example.com',
          '--chat-boundary',
          '--boundary-question',
          '帮我查一下钱包余额',
        ],
        {},
      ),
    ).toContainEqual(
      expect.objectContaining({
        body: JSON.stringify({ channel: 'cli', message: '帮我查一下钱包余额' }),
        headers: { 'Content-Type': 'application/json' },
        kind: 'chatBoundary',
        label: 'chat boundary',
        method: 'POST',
        url: 'https://ask.example.com/api/chat',
      }),
    );
  });

  it('supports transaction analysis smoke checks', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      createApiSmokeChecks(
        [
          '--tx-analysis',
          '--tx-hash',
          txHash,
          '--tx-chain',
          'base',
          '--base-url',
          'https://ask.example.com',
        ],
        {},
      ),
    ).toContainEqual(
      expect.objectContaining({
        body: JSON.stringify({ chain: 'base', txHash }),
        headers: { 'Content-Type': 'application/json' },
        kind: 'txAnalysis',
        method: 'POST',
        url: 'https://ask.example.com/api/tx-analysis',
      }),
    );
  });

  it('supports transaction analysis sample files', async () => {
    const baseTxHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const ethTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const bscTxHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const relatedTxHash = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const frontRunTxHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const backRunTxHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const sampleFile = await writeSmokeSamples({
      samples: [
        {
          chain: 'base',
          expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
          expectedChain: 'base',
          expectedConfidence: 0.82,
          expectedContractAddress: '0x3333333333333333333333333333333333333333',
          expectedDataSource: 'browser',
          expectedExplorerUrl: `https://basescan.org/tx/${baseTxHash}`,
          expectedPoolAddress: '0x1111111111111111111111111111111111111111',
          expectedRelatedTransactionCount: 4,
          expectedRelatedTransactionRoles: ['related', 'front_run', 'user', 'back_run'],
          expectedRelatedTransactions: [
            { hash: relatedTxHash, role: 'related' },
            { hash: frontRunTxHash, role: 'front_run', side: 'buy' },
            { hash: baseTxHash, role: 'user', side: 'buy' },
            { hash: backRunTxHash, role: 'back_run', side: 'sell' },
          ],
          expectedRouterAddress: '0x4444444444444444444444444444444444444444',
          expectedScreenshotTargetRowMarked: true,
          expectedTargetTradeSide: 'buy',
          expectedTargetTraderAddress: '0x2222222222222222222222222222222222222222',
          expectedTransactionTime: '2026-06-13T00:00:00.000Z',
          expectedVerdict: 'not_sandwiched',
          expectedXxyyPoolUrl:
            'https://www.xxyy.io/base/0x1111111111111111111111111111111111111111',
          label: 'Base pool sample',
          txHash: baseTxHash,
        },
        {
          chain: 'ethereum',
          expectedStatus: 'success',
          label: 'Ethereum pool sample',
          requireReport: true,
          requireScreenshot: true,
          txHash: ethTxHash,
        },
        {
          chain: 'bsc',
          expectedFailureMessage: 'BscScan requires browser verification',
          expectedFailureReason: 'browser_verification_required',
          expectedProbeAttempts: [
            {
              chain: 'base',
              reason: 'tx_not_found',
            },
            {
              chain: 'ethereum',
              message: 'Etherscan requires browser verification',
              reason: 'browser_verification_required',
            },
          ],
          expectedStatus: 'failure',
          label: 'BSC blocked sample',
          txHash: bscTxHash,
        },
      ],
    });

    try {
      expect(
        createApiSmokeChecks(
          ['--tx-samples', sampleFile, '--base-url', 'https://ask.example.com'],
          {},
        ),
      ).toEqual([
        expect.objectContaining({
          kind: 'health',
          url: 'https://ask.example.com/health',
        }),
        expect.objectContaining({
          kind: 'deepHealth',
          url: 'https://ask.example.com/health/deep',
        }),
        expect.objectContaining({
          body: JSON.stringify({ chain: 'base', txHash: baseTxHash }),
          expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
          expectedChain: 'base',
          expectedConfidence: 0.82,
          expectedContractAddress: '0x3333333333333333333333333333333333333333',
          expectedDataSource: 'browser',
          expectedExplorerUrl: `https://basescan.org/tx/${baseTxHash}`,
          expectedPoolAddress: '0x1111111111111111111111111111111111111111',
          expectedRelatedTransactionCount: 4,
          expectedRelatedTransactionRoles: ['related', 'front_run', 'user', 'back_run'],
          expectedRelatedTransactions: [
            { hash: relatedTxHash, role: 'related' },
            { hash: frontRunTxHash, role: 'front_run', side: 'buy' },
            { hash: baseTxHash, role: 'user', side: 'buy' },
            { hash: backRunTxHash, role: 'back_run', side: 'sell' },
          ],
          expectedRouterAddress: '0x4444444444444444444444444444444444444444',
          expectedScreenshotTargetRowMarked: true,
          expectedTargetTradeSide: 'buy',
          expectedTargetTraderAddress: '0x2222222222222222222222222222222222222222',
          expectedTransactionTime: '2026-06-13T00:00:00.000Z',
          expectedVerdict: 'not_sandwiched',
          expectedXxyyPoolUrl:
            'https://www.xxyy.io/base/0x1111111111111111111111111111111111111111',
          kind: 'txAnalysis',
          label: 'transaction analysis: Base pool sample',
          requireReport: true,
          requireScreenshot: true,
          verifyAssets: true,
          url: 'https://ask.example.com/api/tx-analysis',
        }),
        expect.objectContaining({
          body: JSON.stringify({ chain: 'ethereum', txHash: ethTxHash }),
          expectedStatus: 'success',
          kind: 'txAnalysis',
          label: 'transaction analysis: Ethereum pool sample',
          requireReport: true,
          requireScreenshot: true,
          url: 'https://ask.example.com/api/tx-analysis',
        }),
        expect.objectContaining({
          body: JSON.stringify({ chain: 'bsc', txHash: bscTxHash }),
          expectedFailureMessage: 'BscScan requires browser verification',
          expectedFailureReason: 'browser_verification_required',
          expectedProbeAttempts: [
            {
              chain: 'base',
              reason: 'tx_not_found',
            },
            {
              chain: 'ethereum',
              message: 'Etherscan requires browser verification',
              reason: 'browser_verification_required',
            },
          ],
          expectedStatus: 'failure',
          kind: 'txAnalysis',
          label: 'transaction analysis: BSC blocked sample',
          requireReport: true,
          requireScreenshot: true,
          url: 'https://ask.example.com/api/tx-analysis',
          verifyAssets: true,
        }),
      ]);
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('loads the checked-in transaction analysis smoke samples', () => {
    const sampleFile = join(process.cwd(), 'docs', 'tx-analysis-smoke-samples.example.json');
    const solanaTxHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';
    const baseTxHash = '0x42a2030a39950aa611a2308c9bc77296a97e44fd75449777340df3e097eaf0ba';
    const ethTxHash = '0x62217195d19d8c2c1058ce844de6862cf4054321a725ee6e60f1d011f5b84806';
    const ethFrontRunTxHash = '0x65b5a30e468af5354fbc7c529b917b9cadd10b61c173de9a216409ee51edb5d7';
    const ethBackRunTxHash = '0xdb3b73c36ec56fd1608caba423fe1bf874e79daed9d9809fcf4e4d177fa9baba';
    const bscTxHash = '0x26540a18818fedb1c83769964619e88e9dd08669cd8a092251431157a886e3cd';

    expect(createApiSmokeChecks(['--tx-samples', sampleFile], {})).toEqual([
      expect.objectContaining({
        kind: 'health',
      }),
      expect.objectContaining({
        kind: 'deepHealth',
      }),
      expect.objectContaining({
        body: JSON.stringify({ chain: 'solana', txHash: solanaTxHash }),
        expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
        expectedChain: 'solana',
        expectedContractAddress: '9smMJxtru37j29w7pfcQZfpKXdsUohuDXqHFaLJcpump',
        expectedConfidence: 0.6,
        expectedDataSource: 'browser',
        expectedPoolAddress: 'HgRhWnmKZMJqNzjrhTixnJ5CSsM4GYPDjhBVnJd6dgNE',
        expectedRelatedTransactionCount: 11,
        expectedRelatedTransactionRoles: [
          'related',
          'related',
          'related',
          'related',
          'related',
          'user',
          'related',
          'related',
          'related',
          'related',
          'related',
        ],
        expectedRelatedTransactions: [
          {
            hash: solanaTxHash,
            role: 'user',
            side: 'sell',
            traderAddress: 'EJLVo2EZ3kYnBgL7RyTPd7ZC8DBK9YWiXwfLvsmVcxhA',
          },
        ],
        expectedScreenshotTargetRowMarked: true,
        expectedStatus: 'success',
        expectedTargetTradeSide: 'sell',
        expectedTargetTraderAddress: 'EJLVo2EZ3kYnBgL7RyTPd7ZC8DBK9YWiXwfLvsmVcxhA',
        expectedTransactionTime: '05:41:34 Jun 10, 2026 (UTC)',
        expectedVerdict: 'not_sandwiched',
        expectedXxyyPoolUrl: 'https://www.xxyy.io/sol/HgRhWnmKZMJqNzjrhTixnJ5CSsM4GYPDjhBVnJd6dgNE',
        kind: 'txAnalysis',
        label: 'transaction analysis: Solana XXYY pool window sample',
        requireReport: true,
        requireScreenshot: true,
        url: 'http://localhost:3000/api/tx-analysis',
        verifyAssets: true,
      }),
      expect.objectContaining({
        body: JSON.stringify({ chain: 'base', txHash: baseTxHash }),
        expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
        expectedChain: 'base',
        expectedContractAddress: '0xbf927b841994731c573bdf09ceb0c6b0aa887cdd',
        expectedConfidence: 0.6,
        expectedDataSource: 'browser',
        expectedPoolAddress: '0x6b0f53cbd9272d8117e9535fe25371dedf39a1be',
        expectedRelatedTransactionCount: 11,
        expectedRelatedTransactionRoles: [
          'related',
          'related',
          'related',
          'related',
          'related',
          'user',
          'related',
          'related',
          'related',
          'related',
          'related',
        ],
        expectedRelatedTransactions: [
          {
            hash: baseTxHash,
            role: 'user',
            side: 'sell',
            traderAddress: '0xf9b6a1eb0190bf76274b0876957ee9f4f508af41',
          },
        ],
        expectedRouterAddress: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
        expectedScreenshotTargetRowMarked: true,
        expectedStatus: 'success',
        expectedTargetTradeSide: 'sell',
        expectedTargetTraderAddress: '0xf9b6a1eb0190bf76274b0876957ee9f4f508af41',
        expectedTransactionTime: '2026-06-13T23:48:33.006Z',
        expectedVerdict: 'not_sandwiched',
        expectedXxyyPoolUrl: 'https://www.xxyy.io/base/0x6b0f53cbd9272d8117e9535fe25371dedf39a1be',
        kind: 'txAnalysis',
        label: 'transaction analysis: Base XXYY pool window sample',
        requireReport: true,
        requireScreenshot: true,
        url: 'http://localhost:3000/api/tx-analysis',
        verifyAssets: true,
      }),
      expect.objectContaining({
        body: JSON.stringify({ chain: 'unknown', txHash: baseTxHash }),
        expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
        expectedChain: 'base',
        expectedContractAddress: '0xbf927b841994731c573bdf09ceb0c6b0aa887cdd',
        expectedConfidence: 0.6,
        expectedDataSource: 'browser',
        expectedPoolAddress: '0x6b0f53cbd9272d8117e9535fe25371dedf39a1be',
        expectedRelatedTransactionCount: 11,
        expectedRelatedTransactionRoles: [
          'related',
          'related',
          'related',
          'related',
          'related',
          'user',
          'related',
          'related',
          'related',
          'related',
          'related',
        ],
        expectedRelatedTransactions: [
          {
            hash: baseTxHash,
            role: 'user',
            side: 'sell',
            traderAddress: '0xf9b6a1eb0190bf76274b0876957ee9f4f508af41',
          },
        ],
        expectedRouterAddress: '0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5',
        expectedScreenshotTargetRowMarked: true,
        expectedStatus: 'success',
        expectedTargetTradeSide: 'sell',
        expectedTargetTraderAddress: '0xf9b6a1eb0190bf76274b0876957ee9f4f508af41',
        expectedTransactionTime: '2026-06-13T23:48:33.006Z',
        expectedVerdict: 'not_sandwiched',
        expectedXxyyPoolUrl: 'https://www.xxyy.io/base/0x6b0f53cbd9272d8117e9535fe25371dedf39a1be',
        kind: 'txAnalysis',
        label: 'transaction analysis: Unknown EVM Base auto-detect sample',
        requireReport: true,
        requireScreenshot: true,
        url: 'http://localhost:3000/api/tx-analysis',
        verifyAssets: true,
      }),
      expect.objectContaining({
        body: JSON.stringify({ chain: 'ethereum', txHash: ethTxHash }),
        expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
        expectedChain: 'ethereum',
        expectedContractAddress: '0x0d7a6caa63bc2b47c881044b0dfa58e087b63bc2',
        expectedConfidence: 0.9,
        expectedDataSource: 'browser',
        expectedPoolAddress: '0x35650bdc37864a3fdca76cb979fabc8b12ffd7b9015e0d1b5d8e03afae05a041',
        expectedRelatedTransactionCount: 11,
        expectedRelatedTransactionRoles: [
          'related',
          'related',
          'related',
          'related',
          'front_run',
          'user',
          'related',
          'related',
          'back_run',
          'related',
          'related',
        ],
        expectedRelatedTransactions: [
          {
            hash: ethFrontRunTxHash,
            role: 'front_run',
            side: 'buy',
            traderAddress: '0xc9f66d1e2f39ee201c7e60718984924c78bb188c',
          },
          {
            hash: ethTxHash,
            role: 'user',
            side: 'buy',
            traderAddress: '0x6582d9ea654cfa1ff2002a174ea3e2715a1f9ea4',
          },
          {
            hash: ethBackRunTxHash,
            role: 'back_run',
            side: 'sell',
            traderAddress: '0xc9f66d1e2f39ee201c7e60718984924c78bb188c',
          },
        ],
        expectedRouterAddress: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
        expectedScreenshotTargetRowMarked: true,
        expectedStatus: 'success',
        expectedTargetTradeSide: 'buy',
        expectedTargetTraderAddress: '0x6582d9ea654cfa1ff2002a174ea3e2715a1f9ea4',
        expectedTransactionTime: '2026-06-13T23:55:11.048Z',
        expectedVerdict: 'sandwiched',
        expectedXxyyPoolUrl:
          'https://www.xxyy.io/eth/0x35650bdc37864a3fdca76cb979fabc8b12ffd7b9015e0d1b5d8e03afae05a041',
        kind: 'txAnalysis',
        label: 'transaction analysis: Ethereum XXYY pool window sample',
        requireReport: true,
        requireScreenshot: true,
        url: 'http://localhost:3000/api/tx-analysis',
        verifyAssets: true,
      }),
      expect.objectContaining({
        body: JSON.stringify({ chain: 'unknown', txHash: ethTxHash }),
        expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
        expectedChain: 'ethereum',
        expectedContractAddress: '0x0d7a6caa63bc2b47c881044b0dfa58e087b63bc2',
        expectedConfidence: 0.9,
        expectedDataSource: 'browser',
        expectedPoolAddress: '0x35650bdc37864a3fdca76cb979fabc8b12ffd7b9015e0d1b5d8e03afae05a041',
        expectedRelatedTransactionCount: 11,
        expectedRelatedTransactionRoles: [
          'related',
          'related',
          'related',
          'related',
          'front_run',
          'user',
          'related',
          'related',
          'back_run',
          'related',
          'related',
        ],
        expectedRelatedTransactions: [
          {
            hash: ethFrontRunTxHash,
            role: 'front_run',
            side: 'buy',
            traderAddress: '0xc9f66d1e2f39ee201c7e60718984924c78bb188c',
          },
          {
            hash: ethTxHash,
            role: 'user',
            side: 'buy',
            traderAddress: '0x6582d9ea654cfa1ff2002a174ea3e2715a1f9ea4',
          },
          {
            hash: ethBackRunTxHash,
            role: 'back_run',
            side: 'sell',
            traderAddress: '0xc9f66d1e2f39ee201c7e60718984924c78bb188c',
          },
        ],
        expectedRouterAddress: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
        expectedScreenshotTargetRowMarked: true,
        expectedStatus: 'success',
        expectedTargetTradeSide: 'buy',
        expectedTargetTraderAddress: '0x6582d9ea654cfa1ff2002a174ea3e2715a1f9ea4',
        expectedTransactionTime: '2026-06-13T23:55:11.048Z',
        expectedVerdict: 'sandwiched',
        expectedXxyyPoolUrl:
          'https://www.xxyy.io/eth/0x35650bdc37864a3fdca76cb979fabc8b12ffd7b9015e0d1b5d8e03afae05a041',
        kind: 'txAnalysis',
        label: 'transaction analysis: Unknown EVM Ethereum auto-detect sample',
        requireReport: true,
        requireScreenshot: true,
        url: 'http://localhost:3000/api/tx-analysis',
        verifyAssets: true,
      }),
      expect.objectContaining({
        body: JSON.stringify({ chain: 'bsc', txHash: bscTxHash }),
        expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
        expectedChain: 'bsc',
        expectedContractAddress: '0x924fa68a0fc644485b8df8abfa0a41c2e7744444',
        expectedConfidence: 0.6,
        expectedDataSource: 'browser',
        expectedPoolAddress: '0x66f289de31eef70d52186729d2637ac978cfc56b',
        expectedRelatedTransactionCount: 11,
        expectedRelatedTransactionRoles: [
          'related',
          'related',
          'related',
          'related',
          'related',
          'user',
          'related',
          'related',
          'related',
          'related',
          'related',
        ],
        expectedRelatedTransactions: [
          {
            hash: bscTxHash,
            role: 'user',
            side: 'buy',
            traderAddress: '0x44df49308b090088bd6e5faea4998304c7a44165',
          },
        ],
        expectedScreenshotTargetRowMarked: true,
        expectedStatus: 'success',
        expectedTargetTradeSide: 'buy',
        expectedTargetTraderAddress: '0x44df49308b090088bd6e5faea4998304c7a44165',
        expectedTransactionTime: '2026-06-13T23:23:11.048Z',
        expectedVerdict: 'not_sandwiched',
        expectedXxyyPoolUrl: 'https://www.xxyy.io/bsc/0x66f289de31eef70d52186729d2637ac978cfc56b',
        kind: 'txAnalysis',
        label: 'transaction analysis: BSC XXYY pool window sample',
        requireReport: true,
        requireScreenshot: true,
        url: 'http://localhost:3000/api/tx-analysis',
        verifyAssets: true,
      }),
      expect.objectContaining({
        body: JSON.stringify({ chain: 'unknown', txHash: bscTxHash }),
        expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
        expectedChain: 'bsc',
        expectedContractAddress: '0x924fa68a0fc644485b8df8abfa0a41c2e7744444',
        expectedConfidence: 0.6,
        expectedDataSource: 'browser',
        expectedPoolAddress: '0x66f289de31eef70d52186729d2637ac978cfc56b',
        expectedRelatedTransactionCount: 11,
        expectedRelatedTransactionRoles: [
          'related',
          'related',
          'related',
          'related',
          'related',
          'user',
          'related',
          'related',
          'related',
          'related',
          'related',
        ],
        expectedRelatedTransactions: [
          {
            hash: bscTxHash,
            role: 'user',
            side: 'buy',
            traderAddress: '0x44df49308b090088bd6e5faea4998304c7a44165',
          },
        ],
        expectedScreenshotTargetRowMarked: true,
        expectedStatus: 'success',
        expectedTargetTradeSide: 'buy',
        expectedTargetTraderAddress: '0x44df49308b090088bd6e5faea4998304c7a44165',
        expectedTransactionTime: '2026-06-13T23:23:11.048Z',
        expectedVerdict: 'not_sandwiched',
        expectedXxyyPoolUrl: 'https://www.xxyy.io/bsc/0x66f289de31eef70d52186729d2637ac978cfc56b',
        kind: 'txAnalysis',
        label: 'transaction analysis: Unknown EVM BSC auto-detect sample',
        requireReport: true,
        requireScreenshot: true,
        url: 'http://localhost:3000/api/tx-analysis',
        verifyAssets: true,
      }),
    ]);
  });

  it('rejects blank expected failure messages in transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedFailureMessage: '   ',
        label: 'Blank failure message sample',
        txHash,
      },
    ]);

    try {
      expect(() => createApiSmokeChecks(['--tx-samples', sampleFile], {})).toThrow(
        'Transaction analysis smoke sample 1 expectedFailureMessage must be non-empty when provided.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('rejects unsupported expected chains in transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'unknown',
        expectedChain: 'polygon',
        label: 'Unsupported expected chain sample',
        txHash,
      },
    ]);

    try {
      expect(() => createApiSmokeChecks(['--tx-samples', sampleFile], {})).toThrow(
        'Transaction analysis smoke sample 1 expectedChain must be a supported chain.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('rejects blank expected probe attempt messages in transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'unknown',
        expectedProbeAttempts: [
          {
            chain: 'base',
            message: '   ',
            reason: 'tx_not_found',
          },
        ],
        label: 'Blank probe message sample',
        txHash,
      },
    ]);

    try {
      expect(() => createApiSmokeChecks(['--tx-samples', sampleFile], {})).toThrow(
        'Transaction analysis smoke sample 1 expectedProbeAttempts item 1 message must be non-empty when provided.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('rejects blank expected explorer URLs in transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedExplorerUrl: '   ',
        label: 'Blank explorer URL sample',
        txHash,
      },
    ]);

    try {
      expect(() => createApiSmokeChecks(['--tx-samples', sampleFile], {})).toThrow(
        'Transaction analysis smoke sample 1 expectedExplorerUrl must be non-empty when provided.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('rejects blank expected related transaction timestamps in transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactions: [
          {
            hash: txHash,
            role: 'user',
            timestamp: '   ',
          },
        ],
        label: 'Blank related transaction timestamp sample',
        txHash,
      },
    ]);

    try {
      expect(() => createApiSmokeChecks(['--tx-samples', sampleFile], {})).toThrow(
        'Transaction analysis smoke sample 1 expectedRelatedTransactions item 1 timestamp must be non-empty when provided.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('rejects non-HTTP expected related transaction explorer URLs in transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactions: [
          {
            hash: txHash,
            role: 'user',
            txUrl: 'not-a-url',
          },
        ],
        label: 'Invalid related transaction explorer URL sample',
        txHash,
      },
    ]);

    try {
      expect(() => createApiSmokeChecks(['--tx-samples', sampleFile], {})).toThrow(
        'Transaction analysis smoke sample 1 expectedRelatedTransactions item 1 explorerUrl must be an HTTP URL when provided.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('rejects invalid expected related transaction counts in transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactionCount: 1.5,
        label: 'Invalid related transaction count sample',
        txHash,
      },
    ]);

    try {
      expect(() => createApiSmokeChecks(['--tx-samples', sampleFile], {})).toThrow(
        'Transaction analysis smoke sample 1 expectedRelatedTransactionCount must be a non-negative integer.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('rejects unsupported expected related transaction roles in transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactionRoles: ['related', 'attacker'],
        label: 'Unsupported related transaction role sample',
        txHash,
      },
    ]);

    try {
      expect(() => createApiSmokeChecks(['--tx-samples', sampleFile], {})).toThrow(
        'Transaction analysis smoke sample 1 expectedRelatedTransactionRoles item 2 must be a supported role.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('rejects unsupported expected target trade sides in transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedTargetTradeSide: 'mint',
        label: 'Unsupported target side sample',
        txHash,
      },
    ]);

    try {
      expect(() => createApiSmokeChecks(['--tx-samples', sampleFile], {})).toThrow(
        'Transaction analysis smoke sample 1 expectedTargetTradeSide must be buy, sell, or unknown.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('reads base URL and ops token from environment', () => {
    expect(
      createApiSmokeChecks([], {
        API_BASE_URL: 'https://ask.example.com/',
        API_OPS_TOKEN: 'env-token',
      }),
    ).toContainEqual(
      expect.objectContaining({
        headers: { Authorization: 'Bearer env-token' },
        kind: 'opsSummary',
        url: 'https://ask.example.com/api/ops/summary',
      }),
    );
  });
});

describe('runApiSmoke', () => {
  it('runs checks and validates chat responses when requested', async () => {
    const calls = [];
    const exitCode = await runApiSmoke({
      args: ['--chat'],
      env: {},
      fetch: (url, request) => {
        calls.push({ request, url });
        if (url.endsWith('/api/chat')) {
          return Promise.resolve(
            jsonResponse({
              answer: 'XXYY Pro 提供更多权益。',
              citations: [{ title: 'XXYY Pro 权益' }],
              intent: 'product_qa',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: () => {},
    });

    expect(exitCode).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/health',
      'http://localhost:3000/health/deep',
      'http://localhost:3000/api/chat',
    ]);
  });

  it('fails chat smoke when the response asks for handoff', async () => {
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--chat'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/chat')) {
          return Promise.resolve(
            jsonResponse({
              answer: '已帮你提交工单，稍后会有人工客服接管处理。',
              citations: [{ title: 'XXYY Pro 权益' }],
              intent: 'product_qa',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain('Failed chat: chat response must not ask for manual handoff.');
  });

  it('runs multi-turn chat follow-up smoke and fails on handoff wording', async () => {
    const messages = [];
    const calls = [];
    const exitCode = await runApiSmoke({
      args: ['--chat-follow-up'],
      env: {},
      fetch: (url, request) => {
        calls.push({ request, url });
        if (url.endsWith('/api/chat')) {
          const body = JSON.parse(request.body);
          if (body.message === '怎么升级？') {
            return Promise.resolve(
              jsonResponse({
                answer: '这个问题需要转人工客服处理。',
                citations: [{ title: 'XXYY Pro 升级' }],
                intent: 'how_to',
              }),
            );
          }
          return Promise.resolve(
            jsonResponse({
              answer: 'XXYY Pro 提供更多权益。',
              citations: [{ title: 'XXYY Pro 权益' }],
              intent: 'product_qa',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/health',
      'http://localhost:3000/health/deep',
      'http://localhost:3000/api/chat',
      'http://localhost:3000/api/chat',
    ]);
    expect(messages).toContain(
      'Failed chat follow-up: chat follow-up response must not ask for manual handoff.',
    );
  });

  it('runs boundary chat smoke without requiring citations', async () => {
    const calls = [];
    const exitCode = await runApiSmoke({
      args: ['--chat-boundary'],
      env: {},
      fetch: (url, request) => {
        calls.push({ request, url });
        if (url.endsWith('/api/chat')) {
          return Promise.resolve(
            jsonResponse({
              answer: '我不能查询钱包余额或账户资产，可以说明 XXYY 产品功能和公开文档内容。',
              citations: [],
              intent: 'realtime_account_query',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: () => {},
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      expect.objectContaining({ url: 'http://localhost:3000/health' }),
      expect.objectContaining({ url: 'http://localhost:3000/health/deep' }),
      expect.objectContaining({
        request: expect.objectContaining({
          body: JSON.stringify({ channel: 'cli', message: '帮我查一下钱包余额' }),
          method: 'POST',
        }),
        url: 'http://localhost:3000/api/chat',
      }),
    ]);
  });

  it('fails boundary chat smoke when the response asks for handoff', async () => {
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--chat-boundary'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/chat')) {
          return Promise.resolve(
            jsonResponse({
              answer: '这个问题需要转人工客服处理。',
              citations: [],
              intent: 'realtime_account_query',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed chat boundary: chat boundary response must not ask for manual handoff.',
    );
  });

  it('fails boundary chat smoke when the response uses the wrong intent', async () => {
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--chat-boundary'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/chat')) {
          return Promise.resolve(
            jsonResponse({
              answer: 'XXYY Pro 提供更多权益。',
              citations: [{ title: 'XXYY Pro 权益' }],
              intent: 'product_qa',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed chat boundary: chat boundary response must use realtime_account_query intent.',
    );
  });

  it('runs and validates transaction analysis smoke responses when requested', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base'],
      env: {},
      fetch: (url, request) => {
        calls.push({ request, url });
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。',
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: () => {},
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      expect.objectContaining({ url: 'http://localhost:3000/health' }),
      expect.objectContaining({ url: 'http://localhost:3000/health/deep' }),
      expect.objectContaining({
        request: expect.objectContaining({
          body: JSON.stringify({ chain: 'base', txHash }),
          method: 'POST',
        }),
        url: 'http://localhost:3000/api/tx-analysis',
      }),
    ]);
  });

  it('validates ops summary knowledge candidate queue fields', async () => {
    const exitCode = await runApiSmoke({
      args: ['--ops-token', 'ops-token'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/ops/summary')) {
          return Promise.resolve(jsonResponse(opsSummaryPayload()));
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: () => {},
    });

    expect(exitCode).toBe(0);
  });

  it('fails ops summary smoke when quality gap queue fields are missing', async () => {
    const messages = [];
    const payload = opsSummaryPayload();
    delete payload.knowledgeCandidateQueues.recentQualitySignals;

    const exitCode = await runApiSmoke({
      args: ['--ops-token', 'ops-token'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/ops/summary')) {
          return Promise.resolve(jsonResponse(payload));
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed ops summary: ops summary must include knowledge candidate queue counts and recent quality gaps.',
    );
  });

  it('fails ops summary smoke when quality reason counts are missing', async () => {
    const messages = [];
    const payload = opsSummaryPayload();
    delete payload.knowledgeCandidateQueues.qualitySignalReasonCounts;

    const exitCode = await runApiSmoke({
      args: ['--ops-token', 'ops-token'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/ops/summary')) {
          return Promise.resolve(jsonResponse(payload));
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed ops summary: ops summary must include valid quality signal reason counts.',
    );
  });

  it('fails ops summary smoke when quality route counts are missing', async () => {
    const messages = [];
    const payload = opsSummaryPayload();
    delete payload.knowledgeCandidateQueues.qualitySignalAgentRouteCounts;

    const exitCode = await runApiSmoke({
      args: ['--ops-token', 'ops-token'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/ops/summary')) {
          return Promise.resolve(jsonResponse(payload));
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed ops summary: ops summary must include valid quality signal route counts.',
    );
  });

  it('fails ops summary smoke when eval failure reason counts are missing', async () => {
    const messages = [];
    const payload = opsSummaryPayload();
    delete payload.knowledgeCandidateQueues.evalFailureReasonCounts;

    const exitCode = await runApiSmoke({
      args: ['--ops-token', 'ops-token'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/ops/summary')) {
          return Promise.resolve(jsonResponse(payload));
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed ops summary: ops summary must include valid eval failure reason counts.',
    );
  });

  it('fails ops summary smoke when eval failure reason counts are invalid', async () => {
    const messages = [];
    const payload = opsSummaryPayload({
      knowledgeCandidateQueues: {
        ...opsSummaryPayload().knowledgeCandidateQueues,
        evalFailureReasonCounts: {
          'missing expected answer text': -1,
        },
      },
    });

    const exitCode = await runApiSmoke({
      args: ['--ops-token', 'ops-token'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/ops/summary')) {
          return Promise.resolve(jsonResponse(payload));
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed ops summary: ops summary must include valid eval failure reason counts.',
    );
  });

  it('fails ops summary smoke when quality reason totals drift from the queue count', async () => {
    const messages = [];
    const payload = opsSummaryPayload({
      knowledgeCandidateQueues: {
        ...opsSummaryPayload().knowledgeCandidateQueues,
        qualitySignalReasonCounts: {
          missing_citations: 2,
        },
      },
    });

    const exitCode = await runApiSmoke({
      args: ['--ops-token', 'ops-token'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/ops/summary')) {
          return Promise.resolve(jsonResponse(payload));
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed ops summary: ops summary quality signal reason counts must match the quality gap queue count.',
    );
  });

  it('fails ops summary smoke when quality route totals drift from the queue count', async () => {
    const messages = [];
    const payload = opsSummaryPayload({
      knowledgeCandidateQueues: {
        ...opsSummaryPayload().knowledgeCandidateQueues,
        qualitySignalAgentRouteCounts: {
          clarify: 1,
          product_answer: 1,
        },
      },
    });

    const exitCode = await runApiSmoke({
      args: ['--ops-token', 'ops-token'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/ops/summary')) {
          return Promise.resolve(jsonResponse(payload));
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed ops summary: ops summary quality signal route counts must match the quality gap queue count.',
    );
  });

  it('fails ops summary smoke when transaction analysis browser runtime settings are missing', async () => {
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--ops-token', 'ops-token'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/ops/summary')) {
          return Promise.resolve(
            jsonResponse({
              txAnalysisRuntime: {
                browser: {
                  headless: false,
                  maxRetries: 1,
                  screenshotBaseUrl: '/assets',
                  timeoutMs: 60000,
                },
                provider: 'browser',
                reportStore: 'file',
                reviewer: 'none',
              },
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed ops summary: ops summary must include transaction analysis browser concurrency, retries, and timeout.',
    );
  });

  it('runs transaction analysis smoke responses from sample files', async () => {
    const baseTxHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const bscTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        label: 'Base sample',
        txHash: baseTxHash,
      },
      {
        chain: 'bsc',
        label: 'BSC sample',
        txHash: bscTxHash,
      },
    ]);
    const calls = [];
    const labels = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url, request) => {
          calls.push({ request, url });
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。',
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => {
          if (message.startsWith('==> ')) {
            labels.push(message.replace('==> ', ''));
          }
        },
      });

      expect(exitCode).toBe(0);
      expect(labels).toEqual([
        'health',
        'deep health',
        'transaction analysis: Base sample',
        'transaction analysis: BSC sample',
      ]);
      expect(
        calls
          .filter((call) => call.url.endsWith('/api/tx-analysis'))
          .map((call) => JSON.parse(call.request.body)),
      ).toEqual([
        { chain: 'base', txHash: baseTxHash },
        { chain: 'bsc', txHash: bscTxHash },
      ]);
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the report verdict does not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedVerdict: 'sandwiched',
        label: 'Expected sandwich sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, { verdict: 'not_sandwiched' }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report verdict must match expected sample verdict.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the data source does not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedDataSource: 'browser',
        label: 'Expected browser data source sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, { dataSource: 'fixture' }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report data source must match expected sample data source.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the confidence does not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedConfidence: 0.9,
        label: 'Expected confidence sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, { confidence: 0.82 }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report confidence must match expected sample confidence.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the rule version does not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedAnalysisRuleVersion: 'sandwich-window-rules-v1',
        label: 'Expected rule version sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  analysisRuleVersion: 'legacy-rule-v0',
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report rule version must match expected sample rule version.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when review URLs do not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedExplorerUrl: `https://basescan.org/tx/${txHash}`,
        expectedXxyyPoolUrl: 'https://www.xxyy.io/base/0x1111111111111111111111111111111111111111',
        label: 'Expected review URLs sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  explorerUrl: `https://base.blockscout.com/tx/${txHash}`,
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report explorer URL must match expected sample explorer URL.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the failure reason does not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedFailureReason: 'screenshot_unavailable',
        label: 'Expected screenshot failure sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析失败截图',
                    url: '/assets/tx-analysis-base-failure.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
            return Promise.resolve(
              jsonResponse({
                failure: {
                  message: '已打开 XXYY 池子页面，但未能定位目标交易。',
                  metadata: {
                    explorerUrl: `https://basescan.org/tx/${txHash}`,
                    screenshotUrl: '/assets/tx-analysis-base-failure.png',
                    xxyyPoolUrl:
                      'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                  },
                  reason: 'target_trade_not_found',
                },
                reference: { chain: 'base', txHash },
                status: 'failure',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis failure reason must match expected sample reason.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the failure message does not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedFailureMessage: '已打开 XXYY 池子页面，但未能定位目标交易。',
        expectedFailureReason: 'target_trade_not_found',
        label: 'Expected failure message sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析失败截图',
                    url: '/assets/tx-analysis-base-failure.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
            return Promise.resolve(
              jsonResponse({
                failure: {
                  message: '公开浏览器要求完成真人验证。',
                  metadata: {
                    explorerUrl: `https://basescan.org/tx/${txHash}`,
                    screenshotUrl: '/assets/tx-analysis-base-failure.png',
                    xxyyPoolUrl:
                      'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                  },
                  reason: 'target_trade_not_found',
                },
                reference: { chain: 'base', txHash },
                status: 'failure',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis failure message must match expected sample message.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when expected probe attempts are missing', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'unknown',
        expectedFailureReason: 'tx_not_found',
        expectedProbeAttempts: [
          {
            chain: 'base',
            message: 'BaseScan did not find the transaction',
            reason: 'tx_not_found',
          },
          {
            chain: 'ethereum',
            message: 'Etherscan requires browser verification',
            reason: 'browser_verification_required',
          },
        ],
        label: 'Expected probe attempts sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-unknown-failure.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析失败截图',
                    url: '/assets/tx-analysis-unknown-failure.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-unknown-failure.json')) {
            return Promise.resolve(
              jsonResponse({
                failure: {
                  message: '无法识别该 EVM 交易属于哪条已支持链。',
                  metadata: {
                    explorerUrl: `https://basescan.org/tx/${txHash}`,
                    probeAttempts: [
                      {
                        chain: 'base',
                        message: 'BaseScan did not find the transaction',
                        reason: 'tx_not_found',
                      },
                    ],
                    screenshotUrl: '/assets/tx-analysis-unknown-failure.png',
                    xxyyPoolUrl:
                      'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                  },
                  reason: 'tx_not_found',
                },
                reference: { chain: 'unknown', txHash },
                status: 'failure',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-unknown-failure.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis failure probe attempts must include expected sample probes.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification with a probe chain mismatch message', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = await runExpectedProbeAttemptMismatchSmoke({
      expectedProbeAttempt: {
        chain: 'ethereum',
        message: 'Explorer did not find the transaction',
        reason: 'tx_not_found',
      },
      reportedProbeAttempt: {
        chain: 'base',
        message: 'Explorer did not find the transaction',
        reason: 'tx_not_found',
      },
      txHash,
    });

    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure probe attempt chain must match expected sample probe.',
    );
  });

  it('fails sample asset verification with a probe reason mismatch message', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = await runExpectedProbeAttemptMismatchSmoke({
      expectedProbeAttempt: {
        chain: 'base',
        message: 'BaseScan response was blocked by verification',
        reason: 'browser_verification_required',
      },
      reportedProbeAttempt: {
        chain: 'base',
        message: 'BaseScan response was blocked by verification',
        reason: 'tx_not_found',
      },
      txHash,
    });

    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure probe attempt reason must match expected sample probe.',
    );
  });

  it('fails sample asset verification with a probe message mismatch message', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = await runExpectedProbeAttemptMismatchSmoke({
      expectedProbeAttempt: {
        chain: 'base',
        message: 'BaseScan did not find the transaction',
        reason: 'tx_not_found',
      },
      reportedProbeAttempt: {
        chain: 'base',
        message: 'BaseScan timed out while loading the transaction',
        reason: 'tx_not_found',
      },
      txHash,
    });

    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure probe attempt message must match expected sample probe.',
    );
  });

  it('fails sample asset verification when the parsed pool address does not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const expectedPoolAddress = '0x1111111111111111111111111111111111111111';
    const reportedPoolAddress = '0x2222222222222222222222222222222222222222';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedPoolAddress,
        label: 'Expected pool sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  poolAddress: reportedPoolAddress,
                  xxyyPoolUrl: `https://www.xxyy.io/base/${reportedPoolAddress}`,
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report pool address must match expected sample pool address.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the parsed router address does not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const expectedRouterAddress = '0x1111111111111111111111111111111111111111';
    const reportedRouterAddress = '0x2222222222222222222222222222222222222222';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRouterAddress,
        label: 'Expected router sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  routerAddress: reportedRouterAddress,
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report router address must match expected sample router address.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when expected related transactions are missing', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontRunTxHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactions: [{ hash: frontRunTxHash, role: 'front_run' }],
        label: 'Expected front-run sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report related transactions must include expected sample transactions.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the related transaction count differs', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactionCount: 11,
        label: 'Expected related transaction count sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report related transaction count must match expected sample count.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the related transaction roles differ', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactionRoles: ['related', 'user', 'related'],
        label: 'Expected related transaction roles sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report related transaction roles must match expected sample roles.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when an expected related transaction explorer URL differs', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontRunTxHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactions: [
          {
            explorerUrl: `https://basescan.org/tx/${frontRunTxHash}`,
            hash: frontRunTxHash,
            role: 'front_run',
          },
        ],
        label: 'Expected front-run explorer sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  relatedTransactions: [
                    {
                      explorerUrl: `https://base.blockscout.com/tx/${frontRunTxHash}`,
                      hash: frontRunTxHash,
                      role: 'front_run',
                      summary: '前置交易',
                    },
                    {
                      explorerUrl: `https://basescan.org/tx/${txHash}`,
                      hash: txHash,
                      role: 'user',
                      summary: '用户提交的交易',
                    },
                  ],
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report related transaction explorer URL must match expected sample transaction.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('honors related transaction explorer URL aliases in expected smoke samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontRunTxHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactions: [
          {
            hash: frontRunTxHash,
            role: 'front_run',
            txUrl: `https://basescan.org/tx/${frontRunTxHash}`,
          },
        ],
        label: 'Expected front-run txUrl sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  relatedTransactions: [
                    {
                      explorerUrl: `https://base.blockscout.com/tx/${frontRunTxHash}`,
                      hash: frontRunTxHash,
                      role: 'front_run',
                      summary: '前置交易',
                    },
                    {
                      explorerUrl: `https://basescan.org/tx/${txHash}`,
                      hash: txHash,
                      role: 'user',
                      summary: '用户提交的交易',
                    },
                  ],
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report related transaction explorer URL must match expected sample transaction.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the expected target trade side differs', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedTargetTradeSide: 'buy',
        label: 'Expected target side sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, { targetTradeSide: 'sell' }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report target trade side must match expected sample target trade side.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the screenshot target row marker differs', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedScreenshotTargetRowMarked: false,
        label: 'Expected unmarked screenshot sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, { screenshotTargetRowMarked: true }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report screenshot target row marker must match expected sample value.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when an expected related transaction trader differs', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontRunTxHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const expectedFrontRunTrader = '0x1111111111111111111111111111111111111111';
    const reportedFrontRunTrader = '0x2222222222222222222222222222222222222222';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactions: [
          {
            hash: frontRunTxHash,
            role: 'front_run',
            traderAddress: expectedFrontRunTrader,
          },
        ],
        label: 'Expected front-run trader sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  relatedTransactions: [
                    {
                      explorerUrl: `https://basescan.org/tx/${frontRunTxHash}`,
                      hash: frontRunTxHash,
                      role: 'front_run',
                      summary: '前置交易',
                      timestamp: '2026-06-13T00:00:00.000Z',
                      traderAddress: reportedFrontRunTrader,
                    },
                    {
                      explorerUrl: `https://basescan.org/tx/${txHash}`,
                      hash: txHash,
                      role: 'user',
                      summary: '用户提交的交易',
                    },
                  ],
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report related transaction trader address must match expected sample transaction.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when an expected related transaction side differs', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontRunTxHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactions: [
          {
            hash: frontRunTxHash,
            role: 'front_run',
            side: 'buy',
          },
        ],
        label: 'Expected front-run side sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  relatedTransactions: [
                    {
                      explorerUrl: `https://basescan.org/tx/${frontRunTxHash}`,
                      hash: frontRunTxHash,
                      role: 'front_run',
                      side: 'sell',
                      summary: '前置交易',
                    },
                    {
                      explorerUrl: `https://basescan.org/tx/${txHash}`,
                      hash: txHash,
                      role: 'user',
                      summary: '用户提交的交易',
                    },
                  ],
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report related transaction side must match expected sample transaction.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when an expected related transaction timestamp differs', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const backRunTxHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedRelatedTransactions: [
          {
            hash: backRunTxHash,
            role: 'back_run',
            timestamp: '2026-06-13T00:00:05.000Z',
          },
        ],
        label: 'Expected back-run timestamp sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  relatedTransactions: [
                    {
                      explorerUrl: `https://basescan.org/tx/${txHash}`,
                      hash: txHash,
                      role: 'user',
                      summary: '用户提交的交易',
                    },
                    {
                      explorerUrl: `https://basescan.org/tx/${backRunTxHash}`,
                      hash: backRunTxHash,
                      role: 'back_run',
                      summary: '后置交易',
                      timestamp: '2026-06-13T00:00:06.000Z',
                    },
                  ],
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report related transaction timestamp must match expected sample transaction.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the transaction time does not match the sample expectation', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedTransactionTime: '2026-06-13T00:00:00.000Z',
        label: 'Expected transaction time sample',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash, {
                  transactionTime: '2026-06-14T00:00:00.000Z',
                }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report transaction time must match expected sample transaction time.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails transaction analysis asset verification when success report text fields are padded', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              generatedAt: '2026-06-13T00:00:00.000Z',
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                analyzedAt: '  2026-06-13T00:00:00.000Z  ',
                evidence: [
                  {
                    detail: '  目标交易前后窗口已检查。  ',
                    label: '  前后交易窗口  ',
                    severity: 'info',
                  },
                ],
                summary: '  未发现明确被夹迹象。  ',
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report result must include verdict, confidence, summary, evidence, related transactions, and analyzedAt.',
    );
  });

  it('fails transaction analysis smoke when a required screenshot attachment is missing', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-require-screenshot'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis: transaction analysis response must include an image attachment.',
    );
  });

  it('fails transaction analysis smoke when a required report link is missing', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-require-report'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis: transaction analysis response must include a report link.',
    );
  });

  it('fails transaction analysis asset verification when the image attachment is missing', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls = [];
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url, request) => {
        calls.push({ request, url });
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/health',
      'http://localhost:3000/health/deep',
      'http://localhost:3000/api/tx-analysis',
    ]);
    expect(messages).toContain(
      'Failed transaction analysis: transaction analysis response must include an image attachment when verifying assets.',
    );
  });

  it('fails transaction analysis asset verification when the report link is missing', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls = [];
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url, request) => {
        calls.push({ request, url });
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/health',
      'http://localhost:3000/health/deep',
      'http://localhost:3000/api/tx-analysis',
    ]);
    expect(messages).toContain(
      'Failed transaction analysis: transaction analysis response must include a report link when verifying assets.',
    );
  });

  it('verifies transaction analysis screenshot and report links when requested', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const calls = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url, request) => {
        calls.push({ request, url });
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              generatedAt: '2026-06-13T00:00:00.000Z',
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: () => {},
    });

    expect(exitCode).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([
      'http://localhost:3000/health',
      'http://localhost:3000/health/deep',
      'http://localhost:3000/api/tx-analysis',
      'http://localhost:3000/assets/tx-analysis-base-window.png',
      'http://localhost:3000/assets/tx-analysis-report-base.json',
    ]);
  });

  it('matches transaction analysis report chains through supported aliases', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'ETH', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-ethereum.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-ethereum-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-ethereum.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'ethereum', txHash },
              result: successReportResult(txHash, {
                chain: 'ethereum',
                explorerUrl: `https://etherscan.io/tx/${txHash}`,
                relatedTransactions: [
                  {
                    explorerUrl: `https://etherscan.io/tx/${txHash}`,
                    hash: txHash,
                    role: 'user',
                    summary: '用户提交的交易',
                  },
                ],
                screenshotUrl: '/assets/tx-analysis-ethereum-window.png',
                xxyyPoolUrl: 'https://www.xxyy.io/eth/0x1234567890abcdef1234567890abcdef12345678',
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-ethereum-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(0);
    expect(messages).toContain('OK transaction analysis report');
  });

  it('supports expected concrete chains for unknown EVM transaction analysis samples', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'unknown',
        expectedChain: 'base',
        expectedStatus: 'success',
        label: 'Unknown EVM auto-detects Base',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile, '--tx-verify-assets'],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(0);
      expect(messages).toContain('OK transaction analysis report');
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails sample asset verification when the expected concrete chain differs', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'unknown',
        expectedChain: 'ethereum',
        expectedStatus: 'success',
        label: 'Unknown EVM should not resolve to Base',
        txHash,
      },
    ]);
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile, '--tx-verify-assets'],
        env: {},
        fetch: (url) => {
          if (url.endsWith('/api/tx-analysis')) {
            return Promise.resolve(
              jsonResponse({
                answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-base.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash },
                result: successReportResult(txHash),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => messages.push(message),
      });

      expect(exitCode).toBe(1);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report reference must match expected sample chain.',
      );
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });

  it('fails asset verification when the report link is not a transaction analysis report document', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report document must include version 1, status, reference, and result/failure.',
    );
  });

  it('fails asset verification when the report document belongs to another transaction', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash: otherTxHash },
              result: successReportResult(otherTxHash),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report reference must match requested transaction hash.',
    );
  });

  it('fails asset verification when the success report result belongs to another transaction', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(otherTxHash),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report result must match requested transaction hash.',
    );
  });

  it('fails asset verification when the success report screenshot differs from the attachment', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, { screenshotUrl: '/assets/another-window.png' }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report result screenshot must match the returned image attachment.',
    );
  });

  it('fails asset verification when the success report screenshot URL is padded', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                screenshotUrl: '  /assets/tx-analysis-base-window.png  ',
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report result must include a clean screenshot URL.',
    );
  });

  it('fails asset verification when the failure report screenshot differs from the attachment', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '未能定位目标交易。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  screenshotUrl: '/assets/another-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'target_trade_not_found',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure report screenshot must match the returned image attachment.',
    );
  });

  it('fails asset verification when the failure report screenshot URL is padded', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '未能定位目标交易。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  screenshotUrl: '  /assets/tx-analysis-base-failure.png  ',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'target_trade_not_found',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure metadata must not contain blank or untrimmed review fields.',
    );
  });

  it('fails asset verification when the failure report is missing a reason and message', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                metadata: { screenshotUrl: '/assets/tx-analysis-base-failure.png' },
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure report must include a supported reason and clean non-empty message.',
    );
  });

  it('fails asset verification when the failure report message is padded', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '  未能定位目标交易。  ',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'target_trade_not_found',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure report must include a supported reason and clean non-empty message.',
    );
  });

  it('fails asset verification when failure metadata contains blank review fields', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '公开交易浏览器暂时不可用。',
                metadata: {
                  contractAddress: '   ',
                  probeAttempts: [
                    {
                      chain: 'base',
                      message: '   ',
                      reason: 'tx_not_found',
                    },
                    {
                      chain: 'ethereum',
                      message: '  Etherscan requires browser verification  ',
                      reason: 'browser_verification_required',
                    },
                  ],
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                },
                reason: 'provider_unavailable',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure metadata must not contain blank or untrimmed review fields.',
    );
  });

  it('fails asset verification when failure metadata screenshot marker is not boolean', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已定位交易窗口，但无法生成带目标行标记的截图。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  screenshotTargetRowMarked: 'true',
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'screenshot_unavailable',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure metadata must not contain blank or untrimmed review fields.',
    );
  });

  it('fails asset verification when a target-trade failure report is missing review links', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已打开 XXYY 池子页面，但未能定位目标交易。',
                metadata: { screenshotUrl: '/assets/tx-analysis-base-failure.png' },
                reason: 'target_trade_not_found',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis target-trade failure report must include transaction explorer and XXYY pool URLs.',
    );
  });

  it('fails asset verification when target-trade failure review links belong to another chain', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已打开 XXYY 池子页面，但未能定位目标交易。',
                metadata: {
                  explorerUrl: `https://etherscan.io/tx/${txHash}`,
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl: 'https://www.xxyy.io/eth/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'target_trade_not_found',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure review links must match requested chain.',
    );
  });

  it('fails asset verification when target-trade failure explorer URL points to another same-chain hash', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已打开 XXYY 池子页面，但未能定位目标交易。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${otherTxHash}`,
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'target_trade_not_found',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure explorer URL must match requested transaction hash.',
    );
  });

  it('fails asset verification when target-trade failure XXYY pool URL points to another same-chain pool', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const poolAddress = '0x1111111111111111111111111111111111111111';
    const otherPoolAddress = '0x2222222222222222222222222222222222222222';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已打开 XXYY 池子页面，但未能定位目标交易。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  poolAddress,
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl: `https://www.xxyy.io/base/${otherPoolAddress}`,
                },
                reason: 'target_trade_not_found',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure XXYY pool URL must match reported pool address.',
    );
  });

  it('fails asset verification when target-trade failure related transaction links belong to another chain', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已定位目标交易窗口，但无法生成带目标行标记的原页面截图。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  relatedTransactions: [
                    {
                      explorerUrl: `https://etherscan.io/tx/${txHash}`,
                      hash: txHash,
                      role: 'user',
                      summary: '用户提交的交易',
                    },
                  ],
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'screenshot_unavailable',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure review links must match requested chain.',
    );
  });

  it('fails asset verification when target-trade failure related transactions miss the requested user transaction', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已定位目标交易窗口，但无法生成带目标行标记的原页面截图。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  relatedTransactions: [
                    {
                      explorerUrl: `https://basescan.org/tx/${otherTxHash}`,
                      hash: otherTxHash,
                      role: 'user',
                      summary: '错误的用户交易',
                    },
                  ],
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'screenshot_unavailable',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure related transactions must include requested user transaction.',
    );
  });

  it('fails asset verification when failure related transactions have invalid roles', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已定位目标交易窗口，但无法生成带目标行标记的原页面截图。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  relatedTransactions: [
                    {
                      explorerUrl: `https://basescan.org/tx/${txHash}`,
                      hash: txHash,
                      role: 'target',
                      summary: '用户提交的交易',
                    },
                  ],
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'screenshot_unavailable',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure related transactions must include valid role, hash, and summary.',
    );
  });

  it('fails asset verification when failure related transactions duplicate a hash', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已定位目标交易窗口，但无法生成带目标行标记的原页面截图。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  relatedTransactions: [
                    {
                      explorerUrl: `https://basescan.org/tx/${txHash.toUpperCase()}`,
                      hash: txHash.toUpperCase(),
                      role: 'related',
                      summary: '重复的上下文交易',
                    },
                    {
                      explorerUrl: `https://basescan.org/tx/${txHash}`,
                      hash: txHash,
                      role: 'user',
                      summary: '用户提交的交易',
                    },
                  ],
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'screenshot_unavailable',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure related transactions must not contain duplicate hashes.',
    );
  });

  it('fails asset verification when failure related transaction review fields are padded', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已定位目标交易窗口，但无法生成带目标行标记的原页面截图。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  relatedTransactions: [
                    {
                      explorerUrl: `https://basescan.org/tx/${txHash}`,
                      hash: txHash,
                      role: 'user',
                      summary: '用户提交的交易',
                      timestamp: '  2026-06-13T00:00:00.000Z  ',
                      traderAddress: '  0x2222222222222222222222222222222222222222  ',
                    },
                  ],
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'screenshot_unavailable',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure related transactions must include valid role, hash, and summary.',
    );
  });

  it('fails asset verification when target-trade failure related transaction URLs point to another same-chain hash', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-base-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-base-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '已定位目标交易窗口，但无法生成带目标行标记的原页面截图。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  relatedTransactions: [
                    {
                      explorerUrl: `https://basescan.org/tx/${otherTxHash}`,
                      hash: txHash,
                      role: 'user',
                      summary: '用户提交的交易',
                    },
                  ],
                  screenshotUrl: '/assets/tx-analysis-base-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'screenshot_unavailable',
              },
              reference: { chain: 'base', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis failure related transaction explorer URLs must match their transaction hashes.',
    );
  });

  it('fails asset verification when the success report result is missing analysis fields', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: {
                chain: 'base',
                screenshotUrl: '/assets/tx-analysis-base-window.png',
                txHash,
              },
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report result must include verdict, confidence, summary, evidence, related transactions, and analyzedAt.',
    );
  });

  it('fails asset verification when the success report result is missing review links', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                explorerUrl: '',
                xxyyPoolUrl: '',
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report result must include transaction explorer and XXYY pool URLs.',
    );
  });

  it('fails asset verification when a success report screenshot is not marked on the target row', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, { screenshotTargetRowMarked: false }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report result screenshot must be marked on the target row.',
    );
  });

  it('fails asset verification when success report review links belong to another chain', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                explorerUrl: `https://etherscan.io/tx/${txHash}`,
                relatedTransactions: [
                  {
                    explorerUrl: `https://etherscan.io/tx/${txHash}`,
                    hash: txHash,
                    role: 'user',
                    summary: '用户提交的交易',
                  },
                ],
                xxyyPoolUrl: 'https://www.xxyy.io/eth/0x1234567890abcdef1234567890abcdef12345678',
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report review links must match requested chain.',
    );
  });

  it('fails asset verification when success report explorer URL points to another same-chain hash', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                explorerUrl: `https://basescan.org/tx/${otherTxHash}`,
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report explorer URL must match requested transaction hash.',
    );
  });

  it('fails asset verification when success report XXYY pool URL points to another same-chain pool', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const poolAddress = '0x1111111111111111111111111111111111111111';
    const otherPoolAddress = '0x2222222222222222222222222222222222222222';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                poolAddress,
                xxyyPoolUrl: `https://www.xxyy.io/base/${otherPoolAddress}`,
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report XXYY pool URL must match reported pool address.',
    );
  });

  it('fails asset verification when the success report related transaction is missing an explorer link', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                relatedTransactions: [
                  {
                    hash: txHash,
                    role: 'user',
                    summary: '用户提交的交易',
                  },
                ],
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report related transactions must include valid explorer URLs.',
    );
  });

  it('fails asset verification when success report related transactions have blank summaries', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                relatedTransactions: [
                  {
                    explorerUrl: `https://basescan.org/tx/${txHash}`,
                    hash: txHash,
                    role: 'user',
                    summary: '   ',
                  },
                ],
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report related transactions must include valid role, hash, and summary.',
    );
  });

  it('fails asset verification when success report related transactions duplicate a hash', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                relatedTransactions: [
                  {
                    explorerUrl: `https://basescan.org/tx/${txHash.toUpperCase()}`,
                    hash: txHash.toUpperCase(),
                    role: 'related',
                    summary: '重复的上下文交易',
                  },
                  {
                    explorerUrl: `https://basescan.org/tx/${txHash}`,
                    hash: txHash,
                    role: 'user',
                    summary: '用户提交的交易',
                  },
                ],
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report related transactions must not contain duplicate hashes.',
    );
  });

  it('fails asset verification when success report related transaction review fields are padded', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                relatedTransactions: [
                  {
                    explorerUrl: `https://basescan.org/tx/${txHash}`,
                    hash: txHash,
                    role: 'user',
                    summary: '用户提交的交易',
                    timestamp: '  2026-06-13T00:00:00.000Z  ',
                    traderAddress: '  0x2222222222222222222222222222222222222222  ',
                  },
                ],
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report related transactions must include valid role, hash, and summary.',
    );
  });

  it('fails asset verification when success report related transaction URLs point to another same-chain hash', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const otherTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                relatedTransactions: [
                  {
                    explorerUrl: `https://basescan.org/tx/${otherTxHash}`,
                    hash: txHash,
                    role: 'user',
                    summary: '用户提交的交易',
                  },
                ],
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: transaction analysis report related transaction explorer URLs must match their transaction hashes.',
    );
  });

  it('fails asset verification when a sandwiched report is missing front and back transactions', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                summary: '疑似存在 sandwich 模式。',
                verdict: 'sandwiched',
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: sandwiched reports must include front-run and back-run transactions.',
    );
  });

  it('fails asset verification when a sandwiched report evidence omits the target and leg hashes', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const frontHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const backHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash, {
                evidence: [
                  {
                    detail: '同一交易者前后腿已命中，但没有列出交易哈希。',
                    label: '同一交易者前后腿',
                    severity: 'warning',
                  },
                ],
                relatedTransactions: [
                  {
                    explorerUrl: `https://basescan.org/tx/${frontHash}`,
                    hash: frontHash,
                    role: 'front_run',
                    summary: '前置交易',
                  },
                  {
                    explorerUrl: `https://basescan.org/tx/${txHash}`,
                    hash: txHash,
                    role: 'user',
                    summary: '用户提交的交易',
                  },
                  {
                    explorerUrl: `https://basescan.org/tx/${backHash}`,
                    hash: backHash,
                    role: 'back_run',
                    summary: '后置交易',
                  },
                ],
                summary: '疑似存在 sandwich 模式。',
                verdict: 'sandwiched',
              }),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis report: sandwiched reports must include evidence that references the target, front-run, and back-run hashes.',
    );
  });

  it('fails asset verification when the screenshot link is not an image response', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash),
              status: 'success',
              version: 1,
            }),
          );
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis screenshot: transaction analysis screenshot must return an image content type.',
    );
  });

  it('fails asset verification when the screenshot response is not a supported image body', async () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const messages = [];
    const exitCode = await runApiSmoke({
      args: ['--tx-analysis', '--tx-hash', txHash, '--tx-chain', 'base', '--tx-verify-assets'],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '交易分析完成。\n报告：/assets/tx-analysis-report-base.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析截图',
                  url: '/assets/tx-analysis-base-window.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-base.json')) {
          return Promise.resolve(
            jsonResponse({
              reference: { chain: 'base', txHash },
              result: successReportResult(txHash),
              status: 'success',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-base-window.png')) {
          return Promise.resolve(imageResponse({ body: 'not an image' }));
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain(
      'Failed transaction analysis screenshot: transaction analysis screenshot must return a non-empty supported image body.',
    );
  });

  it('fails on the first unavailable endpoint', async () => {
    const labels = [];
    const exitCode = await runApiSmoke({
      args: [],
      env: {},
      fetch: (url) =>
        Promise.resolve(
          url.endsWith('/health') ? jsonResponse({ status: 'ok' }) : jsonResponse({}, 503),
        ),
      log: (message) => {
        if (message.startsWith('==> ')) {
          labels.push(message.replace('==> ', ''));
        }
      },
    });

    expect(exitCode).toBe(1);
    expect(labels).toEqual(['health', 'deep health']);
  });

  it('continues through later transaction analysis samples when continue-on-error is enabled', async () => {
    const firstTxHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const secondTxHash = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const sampleFile = await writeSmokeSamples([
      {
        chain: 'base',
        expectedVerdict: 'sandwiched',
        label: 'First sample fails',
        txHash: firstTxHash,
      },
      {
        chain: 'base',
        expectedVerdict: 'not_sandwiched',
        label: 'Second sample still runs',
        txHash: secondTxHash,
      },
    ]);
    const labels = [];
    const messages = [];

    try {
      const exitCode = await runApiSmoke({
        args: ['--tx-samples', sampleFile, '--continue-on-error'],
        env: {},
        fetch: (url, init = {}) => {
          if (url.endsWith('/api/tx-analysis')) {
            const txHash = JSON.parse(init.body).txHash;
            const reportName =
              txHash === firstTxHash
                ? 'tx-analysis-report-first.json'
                : 'tx-analysis-report-second.json';
            return Promise.resolve(
              jsonResponse({
                answer: `交易分析完成。\n报告：/assets/${reportName}`,
                attachments: [
                  {
                    kind: 'image',
                    mediaType: 'image/png',
                    title: '交易分析截图',
                    url: '/assets/tx-analysis-base-window.png',
                  },
                ],
                citations: [],
                intent: 'tx_sandwich_detection',
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-first.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash: firstTxHash },
                result: successReportResult(firstTxHash, { verdict: 'not_sandwiched' }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-report-second.json')) {
            return Promise.resolve(
              jsonResponse({
                generatedAt: '2026-06-13T00:00:00.000Z',
                reference: { chain: 'base', txHash: secondTxHash },
                result: successReportResult(secondTxHash, { verdict: 'not_sandwiched' }),
                status: 'success',
                version: 1,
              }),
            );
          }
          if (url.endsWith('/assets/tx-analysis-base-window.png')) {
            return Promise.resolve(imageResponse());
          }
          return Promise.resolve(jsonResponse({ status: 'ok' }));
        },
        log: (message) => {
          messages.push(message);
          if (message.startsWith('==> ')) {
            labels.push(message.replace('==> ', ''));
          }
        },
      });

      expect(exitCode).toBe(1);
      expect(labels).toEqual([
        'health',
        'deep health',
        'transaction analysis: First sample fails',
        'transaction analysis screenshot',
        'transaction analysis report',
        'transaction analysis: Second sample still runs',
        'transaction analysis screenshot',
        'transaction analysis report',
      ]);
      expect(messages).toContain(
        'Failed transaction analysis report: transaction analysis report verdict must match expected sample verdict.',
      );
      expect(messages).toContain('API smoke failed: 1 check failed.');
    } finally {
      await removeSmokeSample(sampleFile);
    }
  });
});

function jsonResponse(payload, status = 200) {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

function opsSummaryPayload(overrides = {}) {
  return {
    knowledgeCandidateQueues: {
      approvedEvalCaseCount: 1,
      evalFailedCount: 1,
      evalFailureReasonCounts: {
        'missing expected answer text': 1,
      },
      needsReviewCount: 2,
      qualitySignalNeedsReviewCount: 1,
      qualitySignalAgentRouteCounts: {
        product_answer: 1,
      },
      qualitySignalReasonCounts: {
        missing_citations: 1,
      },
      recentEvalFailures: [],
      recentQualitySignals: [
        {
          agentRoute: 'product_answer',
          candidateId: 'kc_quality_gap_1',
          createdAt: '2026-06-19T07:30:00.000Z',
          question: 'XXYY Pro 价格是多少？',
          riskLevel: 'medium',
          targetCategory: 'eval_case',
          type: 'eval_case',
        },
      ],
    },
    txAnalysisRuntime: {
      browser: {
        headless: false,
        maxConcurrency: 1,
        maxRetries: 1,
        screenshotBaseUrl: '/assets',
        timeoutMs: 60000,
      },
      provider: 'browser',
      reportStore: 'file',
      reviewer: 'none',
    },
    ...overrides,
  };
}

function imageResponse(options = {}) {
  const body = options.body ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const status = options.status ?? 200;

  return {
    headers: new Headers({ 'content-type': 'image/png' }),
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    json: () => Promise.reject(new Error('image response is not JSON')),
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
  };
}

function successReportResult(txHash, overrides = {}) {
  return {
    analyzedAt: '2026-06-13T00:00:00.000Z',
    chain: 'base',
    confidence: 0.82,
    evidence: [
      {
        detail: '目标交易前后窗口已检查。',
        label: '前后交易窗口',
        severity: 'info',
      },
    ],
    explorerUrl: `https://basescan.org/tx/${txHash}`,
    relatedTransactions: [
      {
        explorerUrl: `https://basescan.org/tx/${txHash}`,
        hash: txHash,
        role: 'user',
        summary: '用户提交的交易',
      },
    ],
    screenshotUrl: '/assets/tx-analysis-base-window.png',
    screenshotTargetRowMarked: true,
    summary: '未发现明确被夹迹象。',
    txHash,
    verdict: 'not_sandwiched',
    xxyyPoolUrl: 'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
    ...overrides,
  };
}

async function writeSmokeSamples(samples) {
  const directory = await mkdtemp(join(tmpdir(), 'xxyy-api-smoke-'));
  const filePath = join(directory, 'tx-samples.json');
  await writeFile(filePath, JSON.stringify(samples), 'utf8');
  return filePath;
}

async function removeSmokeSample(filePath) {
  await rm(dirname(filePath), { force: true, recursive: true });
}

async function runExpectedProbeAttemptMismatchSmoke({
  expectedProbeAttempt,
  reportedProbeAttempt,
  txHash,
}) {
  const sampleFile = await writeSmokeSamples([
    {
      chain: 'unknown',
      expectedFailureReason: 'tx_not_found',
      expectedProbeAttempts: [expectedProbeAttempt],
      label: 'Expected probe mismatch sample',
      txHash,
    },
  ]);
  const messages = [];

  try {
    const exitCode = await runApiSmoke({
      args: ['--tx-samples', sampleFile],
      env: {},
      fetch: (url) => {
        if (url.endsWith('/api/tx-analysis')) {
          return Promise.resolve(
            jsonResponse({
              answer: '未能完成交易分析。\n报告：/assets/tx-analysis-report-unknown-failure.json',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/png',
                  title: '交易分析失败截图',
                  url: '/assets/tx-analysis-unknown-failure.png',
                },
              ],
              citations: [],
              intent: 'tx_sandwich_detection',
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-report-unknown-failure.json')) {
          return Promise.resolve(
            jsonResponse({
              failure: {
                message: '无法识别该 EVM 交易属于哪条已支持链。',
                metadata: {
                  explorerUrl: `https://basescan.org/tx/${txHash}`,
                  probeAttempts: [reportedProbeAttempt],
                  screenshotUrl: '/assets/tx-analysis-unknown-failure.png',
                  xxyyPoolUrl:
                    'https://www.xxyy.io/base/0x1234567890abcdef1234567890abcdef12345678',
                },
                reason: 'tx_not_found',
              },
              reference: { chain: 'unknown', txHash },
              status: 'failure',
              version: 1,
            }),
          );
        }
        if (url.endsWith('/assets/tx-analysis-unknown-failure.png')) {
          return Promise.resolve(imageResponse());
        }
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      },
      log: (message) => messages.push(message),
    });

    expect(exitCode).toBe(1);
    return messages;
  } finally {
    await removeSmokeSample(sampleFile);
  }
}
