import { describe, expect, it } from 'vitest';

import {
  analyzeSandwichWindow,
  SANDWICH_ANALYZER_VERSION,
  type SandwichTrade,
} from './sandwich-analyzer.js';

describe('analyzeSandwichWindow', () => {
  it('detects a same-trader front and back run inside the configured time window', () => {
    const target = trade('target', 'buy', 'User111', 10);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        trade('back-run', 'sell', 'Attacker111', 16),
        trade('after-other-1', 'buy', 'OtherAfter1', 18),
        trade('after-other-2', 'sell', 'OtherAfter2', 19),
        trade('after-other-3', 'buy', 'OtherAfter3', 20),
        trade('after-other-4', 'sell', 'OtherAfter4', 21),
      ],
      before: [
        trade('before-other-1', 'buy', 'OtherBefore1', 1),
        trade('before-other-2', 'sell', 'OtherBefore2', 2),
        trade('front-run', 'buy', 'Attacker111', 8),
        trade('before-other-3', 'sell', 'OtherBefore3', 9),
        trade('before-other-4', 'buy', 'OtherBefore4', 9),
      ],
    });

    expect(analysis.backRun?.hash).toBe('back-run');
    expect(analysis.confidence).toBe(0.9);
    expect(analysis.frontRun?.hash).toBe('front-run');
    expect(analysis.verdict).toBe('sandwiched');
    expect(analysis.evidence.map((item) => item.label)).toEqual([
      '交易窗口覆盖',
      '判断规则版本',
      '同一交易者前后腿',
      '复核交易哈希',
      '时间窗口',
      '判断评分',
    ]);
    expect(analysis.summary).toContain('120 秒');
  });

  it('includes target, front-run, and back-run hashes in sandwich review evidence', () => {
    const target = trade('target-hash', 'buy', 'User111', 10);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        trade('back-run-hash', 'sell', 'Attacker111', 16),
        trade('after-other-1', 'buy', 'OtherAfter1', 18),
        trade('after-other-2', 'sell', 'OtherAfter2', 19),
        trade('after-other-3', 'buy', 'OtherAfter3', 20),
        trade('after-other-4', 'sell', 'OtherAfter4', 21),
      ],
      before: [
        trade('front-run-hash', 'buy', 'Attacker111', 8),
        trade('before-other-1', 'buy', 'OtherBefore1', 1),
        trade('before-other-2', 'sell', 'OtherBefore2', 2),
        trade('before-other-3', 'sell', 'OtherBefore3', 9),
        trade('before-other-4', 'buy', 'OtherBefore4', 9),
      ],
    });

    expect(analysis.evidence).toContainEqual({
      detail:
        '目标交易 target-hash；前置交易 front-run-hash；后置交易 back-run-hash。请结合 XXYY 原页面截图中被标记的目标成交行复核。',
      label: '复核交易哈希',
      severity: 'warning',
    });
  });

  it('ignores candidate legs that reuse the target transaction hash even when EVM hash casing differs', () => {
    const targetHash = `0x${'A'.repeat(64)}`;
    const target = trade(targetHash, 'buy', 'User111', 10);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        trade(`0x${'b'.repeat(64)}`, 'sell', 'Attacker111', 16),
        trade('after-other-1', 'buy', 'OtherAfter1', 18),
        trade('after-other-2', 'sell', 'OtherAfter2', 19),
        trade('after-other-3', 'buy', 'OtherAfter3', 20),
        trade('after-other-4', 'sell', 'OtherAfter4', 21),
      ],
      before: [
        trade(targetHash.toLowerCase(), 'buy', 'Attacker111', 8),
        trade('before-other-1', 'buy', 'OtherBefore1', 1),
        trade('before-other-2', 'sell', 'OtherBefore2', 2),
        trade('before-other-3', 'sell', 'OtherBefore3', 9),
        trade('before-other-4', 'buy', 'OtherBefore4', 9),
      ],
    });

    expect(analysis.frontRun).toBeUndefined();
    expect(analysis.backRun).toBeUndefined();
    expect(analysis.verdict).toBe('not_sandwiched');
  });

  it('ignores front and back legs that reuse the same transaction hash', () => {
    const duplicateLegHash = `0x${'C'.repeat(64)}`;
    const target = trade(`0x${'d'.repeat(64)}`, 'buy', 'User111', 10);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        trade(duplicateLegHash.toLowerCase(), 'sell', 'Attacker111', 16),
        trade('after-other-1', 'buy', 'OtherAfter1', 18),
        trade('after-other-2', 'sell', 'OtherAfter2', 19),
        trade('after-other-3', 'buy', 'OtherAfter3', 20),
        trade('after-other-4', 'sell', 'OtherAfter4', 21),
      ],
      before: [
        trade(duplicateLegHash, 'buy', 'Attacker111', 8),
        trade('before-other-1', 'buy', 'OtherBefore1', 1),
        trade('before-other-2', 'sell', 'OtherBefore2', 2),
        trade('before-other-3', 'sell', 'OtherBefore3', 9),
        trade('before-other-4', 'buy', 'OtherBefore4', 9),
      ],
    });

    expect(analysis.frontRun).toBeUndefined();
    expect(analysis.backRun).toBeUndefined();
    expect(analysis.verdict).toBe('not_sandwiched');
  });

  it('does not explain duplicate target rows as rejected pool candidates', () => {
    const target = tradeInPool('target', 'buy', 'User111', 10, 'PoolA111');

    const analysis = analyzeSandwichWindow(target, {
      after: [
        tradeInPool('back-run-other-pool', 'sell', 'Attacker111', 16, 'PoolB222'),
        tradeInPool('after-other-1', 'buy', 'OtherAfter1', 18, 'PoolA111'),
        tradeInPool('after-other-2', 'sell', 'OtherAfter2', 19, 'PoolA111'),
        tradeInPool('after-other-3', 'buy', 'OtherAfter3', 20, 'PoolA111'),
        tradeInPool('after-other-4', 'sell', 'OtherAfter4', 21, 'PoolA111'),
      ],
      before: [
        tradeInPool('target', 'buy', 'Attacker111', 8, 'PoolB222'),
        tradeInPool('before-other-1', 'buy', 'OtherBefore1', 1, 'PoolA111'),
        tradeInPool('before-other-2', 'sell', 'OtherBefore2', 2, 'PoolA111'),
        tradeInPool('before-other-3', 'sell', 'OtherBefore3', 9, 'PoolA111'),
        tradeInPool('before-other-4', 'buy', 'OtherBefore4', 9, 'PoolA111'),
      ],
    });

    expect(analysis.verdict).toBe('not_sandwiched');
    expect(analysis.evidence.some((item) => item.label === '池子一致性')).toBe(false);
  });

  it('includes the sandwich analyzer version in every analysis result', () => {
    const target = trade('target', 'buy', 'User111', 10);

    const sandwiched = analyzeSandwichWindow(target, {
      after: [
        trade('back-run', 'sell', 'Attacker111', 16),
        trade('after-other-1', 'buy', 'OtherAfter1', 18),
        trade('after-other-2', 'sell', 'OtherAfter2', 19),
        trade('after-other-3', 'buy', 'OtherAfter3', 20),
        trade('after-other-4', 'sell', 'OtherAfter4', 21),
      ],
      before: [
        trade('front-run', 'buy', 'Attacker111', 8),
        trade('before-other-1', 'buy', 'OtherBefore1', 1),
        trade('before-other-2', 'sell', 'OtherBefore2', 2),
        trade('before-other-3', 'sell', 'OtherBefore3', 9),
        trade('before-other-4', 'buy', 'OtherBefore4', 9),
      ],
    });
    const notSandwiched = analyzeSandwichWindow(target, {
      after: [
        trade('after-other-1', 'buy', 'OtherAfter1', 18),
        trade('after-other-2', 'sell', 'OtherAfter2', 19),
        trade('after-other-3', 'buy', 'OtherAfter3', 20),
        trade('after-other-4', 'sell', 'OtherAfter4', 21),
        trade('after-other-5', 'buy', 'OtherAfter5', 22),
      ],
      before: [
        trade('before-other-1', 'buy', 'OtherBefore1', 1),
        trade('before-other-2', 'sell', 'OtherBefore2', 2),
        trade('before-other-3', 'buy', 'OtherBefore3', 3),
        trade('before-other-4', 'sell', 'OtherBefore4', 4),
        trade('before-other-5', 'buy', 'OtherBefore5', 5),
      ],
    });
    const inconclusive = analyzeSandwichWindow(
      {
        hash: 'target',
        side: 'unknown',
        summary: 'target',
        traderAddress: 'User111',
      },
      {
        after: [],
        before: [],
      },
    );

    for (const analysis of [sandwiched, notSandwiched, inconclusive]) {
      expect(analysis).toMatchObject({ ruleVersion: SANDWICH_ANALYZER_VERSION });
      const versionEvidence = analysis.evidence.find((item) => item.label === '判断规则版本');
      expect(versionEvidence?.detail).toContain('sandwich-window-rules-v1');
      expect(versionEvidence?.severity).toBe('info');
    }
  });

  it('explains the model score and selected closest candidate pair', () => {
    const target = trade('target', 'buy', 'User111', 10);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        trade('near-back-run', 'sell', 'AttackerNear', 11),
        trade('far-back-run', 'sell', 'AttackerFar', 17),
        trade('after-other-1', 'buy', 'OtherAfter1', 18),
        trade('after-other-2', 'sell', 'OtherAfter2', 19),
        trade('after-other-3', 'buy', 'OtherAfter3', 20),
      ],
      before: [
        trade('far-front-run', 'buy', 'AttackerFar', 4),
        trade('before-other-1', 'sell', 'OtherBefore1', 6),
        trade('near-front-run', 'buy', 'AttackerNear', 9),
        trade('before-other-2', 'sell', 'OtherBefore2', 9),
        trade('before-other-3', 'buy', 'OtherBefore3', 9),
      ],
    });

    expect(analysis.frontRun?.hash).toBe('near-front-run');
    expect(analysis.backRun?.hash).toBe('near-back-run');
    const scoreEvidence = analysis.evidence.find((item) => item.label === '判断评分');
    expect(scoreEvidence?.detail).toContain('候选组合 2 组');
    expect(scoreEvidence?.detail).toContain('总时间间隔 2 秒');
    expect(scoreEvidence?.detail).toContain('完整窗口');
    expect(scoreEvidence?.detail).toContain('时间戳完整');
    expect(scoreEvidence?.severity).toBe('info');
  });

  it('prefers a timestamped candidate pair over a candidate with missing timestamps', () => {
    const target = trade('target', 'buy', 'User111', 10);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        tradeWithoutTimestamp('unknown-back-run', 'sell', 'AttackerUnknown'),
        trade('known-back-run', 'sell', 'AttackerKnown', 12),
        trade('after-other-1', 'buy', 'OtherAfter1', 13),
        trade('after-other-2', 'sell', 'OtherAfter2', 14),
        trade('after-other-3', 'buy', 'OtherAfter3', 15),
      ],
      before: [
        tradeWithoutTimestamp('unknown-front-run', 'buy', 'AttackerUnknown'),
        trade('known-front-run', 'buy', 'AttackerKnown', 8),
        trade('before-other-1', 'sell', 'OtherBefore1', 6),
        trade('before-other-2', 'buy', 'OtherBefore2', 7),
        trade('before-other-3', 'sell', 'OtherBefore3', 9),
      ],
    });

    expect(analysis.frontRun?.hash).toBe('known-front-run');
    expect(analysis.backRun?.hash).toBe('known-back-run');
    const scoreEvidence = analysis.evidence.find((item) => item.label === '判断评分');
    expect(scoreEvidence?.detail).toContain('候选组合 2 组');
    expect(scoreEvidence?.detail).toContain('总时间间隔 4 秒');
    expect(scoreEvidence?.detail).toContain('时间戳完整');
  });

  it('does not report a zero-second model distance when selected timestamps are missing', () => {
    const target = trade('target', 'buy', 'User111', 10);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        tradeWithoutTimestamp('unknown-back-run', 'sell', 'AttackerUnknown'),
        trade('after-other-1', 'buy', 'OtherAfter1', 13),
        trade('after-other-2', 'sell', 'OtherAfter2', 14),
        trade('after-other-3', 'buy', 'OtherAfter3', 15),
        trade('after-other-4', 'sell', 'OtherAfter4', 16),
      ],
      before: [
        tradeWithoutTimestamp('unknown-front-run', 'buy', 'AttackerUnknown'),
        trade('before-other-1', 'sell', 'OtherBefore1', 6),
        trade('before-other-2', 'buy', 'OtherBefore2', 7),
        trade('before-other-3', 'sell', 'OtherBefore3', 8),
        trade('before-other-4', 'buy', 'OtherBefore4', 9),
      ],
    });

    const scoreEvidence = analysis.evidence.find((item) => item.label === '判断评分');
    expect(scoreEvidence?.detail).toContain('总时间间隔无法计算');
    expect(scoreEvidence?.detail).not.toContain('总时间间隔 0 秒');
    expect(scoreEvidence?.detail).toContain('部分时间戳缺失');
  });

  it('matches EVM attacker addresses case-insensitively', () => {
    const target = trade('target', 'buy', '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa', 10);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        trade('back-run', 'sell', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 16),
        trade('after-other-1', 'buy', '0x1111111111111111111111111111111111111111', 18),
        trade('after-other-2', 'sell', '0x2222222222222222222222222222222222222222', 19),
        trade('after-other-3', 'buy', '0x3333333333333333333333333333333333333333', 20),
        trade('after-other-4', 'sell', '0x4444444444444444444444444444444444444444', 21),
      ],
      before: [
        trade('before-other-1', 'buy', '0x5555555555555555555555555555555555555555', 1),
        trade('before-other-2', 'sell', '0x6666666666666666666666666666666666666666', 2),
        trade('front-run', 'buy', '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb', 8),
        trade('before-other-3', 'sell', '0x7777777777777777777777777777777777777777', 9),
        trade('before-other-4', 'buy', '0x8888888888888888888888888888888888888888', 9),
      ],
    });

    expect(analysis.frontRun?.hash).toBe('front-run');
    expect(analysis.backRun?.hash).toBe('back-run');
    expect(analysis.verdict).toBe('sandwiched');
  });

  it('trims DOM-extracted trader and pool addresses before comparing candidate legs', () => {
    const target = tradeInPool('target', 'buy', 'User111', 10, ' PoolA111 ');

    const analysis = analyzeSandwichWindow(target, {
      after: [
        tradeInPool('back-run', 'sell', '\tAttacker111 ', 16, 'PoolA111\n'),
        tradeInPool('after-other-1', 'buy', 'OtherAfter1', 18, 'PoolA111'),
        tradeInPool('after-other-2', 'sell', 'OtherAfter2', 19, 'PoolA111'),
        tradeInPool('after-other-3', 'buy', 'OtherAfter3', 20, 'PoolA111'),
        tradeInPool('after-other-4', 'sell', 'OtherAfter4', 21, 'PoolA111'),
      ],
      before: [
        tradeInPool('before-other-1', 'buy', 'OtherBefore1', 1, 'PoolA111'),
        tradeInPool('before-other-2', 'sell', 'OtherBefore2', 2, 'PoolA111'),
        tradeInPool('front-run', 'buy', ' Attacker111\n', 8, '\nPoolA111'),
        tradeInPool('before-other-3', 'sell', 'OtherBefore3', 9, 'PoolA111'),
        tradeInPool('before-other-4', 'buy', 'OtherBefore4', 9, 'PoolA111'),
      ],
    });

    expect(analysis.frontRun?.hash).toBe('front-run');
    expect(analysis.backRun?.hash).toBe('back-run');
    expect(analysis.verdict).toBe('sandwiched');
  });

  it('treats blank DOM-extracted pool addresses as missing rather than a different pool', () => {
    const target = tradeInPool('target', 'buy', 'User111', 10, '  ');

    const analysis = analyzeSandwichWindow(target, {
      after: [
        tradeInPool('back-run', 'sell', 'Attacker111', 16, 'PoolA111'),
        tradeInPool('after-other-1', 'buy', 'OtherAfter1', 18, 'PoolB222'),
        tradeInPool('after-other-2', 'sell', 'OtherAfter2', 19, 'PoolB222'),
        tradeInPool('after-other-3', 'buy', 'OtherAfter3', 20, 'PoolB222'),
        tradeInPool('after-other-4', 'sell', 'OtherAfter4', 21, 'PoolB222'),
      ],
      before: [
        tradeInPool('before-other-1', 'buy', 'OtherBefore1', 1, 'PoolB222'),
        tradeInPool('before-other-2', 'sell', 'OtherBefore2', 2, 'PoolB222'),
        tradeInPool('front-run', 'buy', 'Attacker111', 8, 'PoolA111'),
        tradeInPool('before-other-3', 'sell', 'OtherBefore3', 9, 'PoolB222'),
        tradeInPool('before-other-4', 'buy', 'OtherBefore4', 9, 'PoolB222'),
      ],
    });

    expect(analysis.frontRun?.hash).toBe('front-run');
    expect(analysis.backRun?.hash).toBe('back-run');
    expect(analysis.verdict).toBe('sandwiched');
  });

  it('does not treat the target EVM trader address as an attacker only because casing differs', () => {
    const target = trade('target', 'buy', '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa', 10);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        trade('user-after', 'sell', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 16),
        trade('after-other-1', 'buy', '0x1111111111111111111111111111111111111111', 18),
        trade('after-other-2', 'sell', '0x2222222222222222222222222222222222222222', 19),
        trade('after-other-3', 'buy', '0x3333333333333333333333333333333333333333', 20),
        trade('after-other-4', 'sell', '0x4444444444444444444444444444444444444444', 21),
      ],
      before: [
        trade('user-before', 'buy', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 8),
        trade('before-other-1', 'buy', '0x5555555555555555555555555555555555555555', 1),
        trade('before-other-2', 'sell', '0x6666666666666666666666666666666666666666', 2),
        trade('before-other-3', 'sell', '0x7777777777777777777777777777777777777777', 9),
        trade('before-other-4', 'buy', '0x8888888888888888888888888888888888888888', 9),
      ],
    });

    expect(analysis.frontRun).toBeUndefined();
    expect(analysis.backRun).toBeUndefined();
    expect(analysis.verdict).toBe('not_sandwiched');
  });

  it('does not classify attacker legs from a different pool as a sandwich', () => {
    const target = tradeInPool('target', 'buy', 'User111', 10, 'PoolA111');

    const analysis = analyzeSandwichWindow(target, {
      after: [
        tradeInPool('back-run-other-pool', 'sell', 'Attacker111', 16, 'PoolB222'),
        tradeInPool('after-other-1', 'buy', 'OtherAfter1', 18, 'PoolA111'),
        tradeInPool('after-other-2', 'sell', 'OtherAfter2', 19, 'PoolA111'),
        tradeInPool('after-other-3', 'buy', 'OtherAfter3', 20, 'PoolA111'),
        tradeInPool('after-other-4', 'sell', 'OtherAfter4', 21, 'PoolA111'),
      ],
      before: [
        tradeInPool('front-run-other-pool', 'buy', 'Attacker111', 8, 'PoolB222'),
        tradeInPool('before-other-1', 'buy', 'OtherBefore1', 1, 'PoolA111'),
        tradeInPool('before-other-2', 'sell', 'OtherBefore2', 2, 'PoolA111'),
        tradeInPool('before-other-3', 'buy', 'OtherBefore3', 9, 'PoolA111'),
        tradeInPool('before-other-4', 'sell', 'OtherBefore4', 9, 'PoolA111'),
      ],
    });

    expect(analysis.frontRun).toBeUndefined();
    expect(analysis.backRun).toBeUndefined();
    expect(analysis.verdict).toBe('not_sandwiched');
    expect(analysis.evidence).toContainEqual({
      detail:
        '发现同一交易者前后腿候选，但候选交易不在目标交易同一池子/交易对内，不计为典型 sandwich。',
      label: '池子一致性',
      severity: 'info',
    });
  });

  it('does not classify a candidate when only one leg has a pool and it differs from the target pool', () => {
    const target = tradeInPool('target', 'buy', 'User111', 10, 'PoolA111');

    const analysis = analyzeSandwichWindow(target, {
      after: [
        tradeInPool('back-run-other-pool', 'sell', 'Attacker111', 16, 'PoolB222'),
        tradeInPool('after-other-1', 'buy', 'OtherAfter1', 18, 'PoolA111'),
        tradeInPool('after-other-2', 'sell', 'OtherAfter2', 19, 'PoolA111'),
        tradeInPool('after-other-3', 'buy', 'OtherAfter3', 20, 'PoolA111'),
        tradeInPool('after-other-4', 'sell', 'OtherAfter4', 21, 'PoolA111'),
      ],
      before: [
        trade('front-run-missing-pool', 'buy', 'Attacker111', 8),
        tradeInPool('before-other-1', 'buy', 'OtherBefore1', 1, 'PoolA111'),
        tradeInPool('before-other-2', 'sell', 'OtherBefore2', 2, 'PoolA111'),
        tradeInPool('before-other-3', 'buy', 'OtherBefore3', 9, 'PoolA111'),
        tradeInPool('before-other-4', 'sell', 'OtherBefore4', 9, 'PoolA111'),
      ],
    });

    expect(analysis.frontRun).toBeUndefined();
    expect(analysis.backRun).toBeUndefined();
    expect(analysis.verdict).toBe('not_sandwiched');
    expect(analysis.evidence).toContainEqual({
      detail:
        '发现同一交易者前后腿候选，但候选交易不在目标交易同一池子/交易对内，不计为典型 sandwich。',
      label: '池子一致性',
      severity: 'info',
    });
  });

  it('does not classify matching attacker legs as sandwich when they are outside the time window', () => {
    const target = trade('target', 'buy', 'User111', 600);

    const analysis = analyzeSandwichWindow(target, {
      after: [
        trade('far-back-run', 'sell', 'Attacker111', 1200),
        trade('after-other-1', 'buy', 'OtherAfter1', 601),
        trade('after-other-2', 'sell', 'OtherAfter2', 602),
        trade('after-other-3', 'buy', 'OtherAfter3', 603),
        trade('after-other-4', 'sell', 'OtherAfter4', 604),
      ],
      before: [
        trade('far-front-run', 'buy', 'Attacker111', 0),
        trade('before-other-1', 'buy', 'OtherBefore1', 596),
        trade('before-other-2', 'sell', 'OtherBefore2', 597),
        trade('before-other-3', 'buy', 'OtherBefore3', 598),
        trade('before-other-4', 'sell', 'OtherBefore4', 599),
      ],
    });

    expect(analysis.verdict).toBe('not_sandwiched');
    expect(analysis.frontRun).toBeUndefined();
    expect(analysis.backRun).toBeUndefined();
    expect(analysis.summary).toContain('未发现');
    const timeEvidence = analysis.evidence.find((item) => item.label === '时间窗口');
    expect(timeEvidence?.detail).toContain('超过 120 秒');
    expect(timeEvidence?.severity).toBe('info');
  });

  it('returns inconclusive when the target trade identity is incomplete', () => {
    const analysis = analyzeSandwichWindow(
      {
        hash: 'target',
        side: 'unknown',
        summary: 'target trade',
      },
      {
        after: [],
        before: [],
      },
    );

    expect(analysis).toMatchObject({
      confidence: 0.35,
      verdict: 'inconclusive',
    });
    expect(analysis.evidence).toContainEqual({
      detail: '缺少目标交易方向或交易者地址，无法判断同一交易者前后腿。',
      label: '目标交易信息',
      severity: 'warning',
    });
  });

  it('treats a blank target trader address as incomplete target identity', () => {
    const analysis = analyzeSandwichWindow(
      {
        hash: 'target',
        side: 'buy',
        summary: 'target trade with blank trader',
        timestamp: new Date(Date.UTC(2026, 5, 10, 1, 0, 10)).toISOString(),
        traderAddress: '   ',
      },
      {
        after: [
          trade('back-run', 'sell', 'Attacker111', 16),
          trade('after-other-1', 'buy', 'OtherAfter1', 18),
          trade('after-other-2', 'sell', 'OtherAfter2', 19),
          trade('after-other-3', 'buy', 'OtherAfter3', 20),
          trade('after-other-4', 'sell', 'OtherAfter4', 21),
        ],
        before: [
          trade('front-run', 'buy', 'Attacker111', 8),
          trade('before-other-1', 'buy', 'OtherBefore1', 1),
          trade('before-other-2', 'sell', 'OtherBefore2', 2),
          trade('before-other-3', 'sell', 'OtherBefore3', 9),
          trade('before-other-4', 'buy', 'OtherBefore4', 9),
        ],
      },
    );

    expect(analysis).toMatchObject({
      confidence: 0.35,
      verdict: 'inconclusive',
    });
    expect(analysis.frontRun).toBeUndefined();
    expect(analysis.backRun).toBeUndefined();
    expect(analysis.evidence).toContainEqual({
      detail: '缺少目标交易方向或交易者地址，无法判断同一交易者前后腿。',
      label: '目标交易信息',
      severity: 'warning',
    });
  });
});

function trade(
  hash: string,
  side: 'buy' | 'sell',
  traderAddress: string,
  secondsAfterStart: number,
): SandwichTrade {
  return {
    hash,
    side,
    summary: `${side} ${hash}`,
    timestamp: new Date(Date.UTC(2026, 5, 10, 1, 0, secondsAfterStart)).toISOString(),
    traderAddress,
  };
}

function tradeWithoutTimestamp(
  hash: string,
  side: 'buy' | 'sell',
  traderAddress: string,
): SandwichTrade {
  return {
    hash,
    side,
    summary: `${side} ${hash}`,
    traderAddress,
  };
}

type PoolAwareSandwichTrade = SandwichTrade & { poolAddress: string };

function tradeInPool(
  hash: string,
  side: 'buy' | 'sell',
  traderAddress: string,
  secondsAfterStart: number,
  poolAddress: string,
): PoolAwareSandwichTrade {
  return {
    ...trade(hash, side, traderAddress, secondsAfterStart),
    poolAddress,
  };
}
