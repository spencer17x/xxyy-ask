import { describe, expect, it } from 'vitest';

import { hasAmbiguousTransactionReferences, parseTransactionReference } from './tx-hash.js';

describe('parseTransactionReference', () => {
  it('extracts an EVM transaction hash', () => {
    expect(
      parseTransactionReference(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 是否被夹了？',
      ),
    ).toEqual({
      chain: 'unknown',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });
  });

  it('extracts an EVM transaction hash with an uppercase hex prefix', () => {
    expect(
      parseTransactionReference(
        '0X1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 是否被夹了？',
      ),
    ).toEqual({
      chain: 'unknown',
      txHash: '0X1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });
  });

  it('infers EVM chains from user text around the hash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`base 链 ${txHash} 是否被夹了？`)?.chain).toBe('base');
    expect(parseTransactionReference(`BSC ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`BNB ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`BNB Chain ${txHash} sandwich?`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`#BNBChain ${txHash} sandwich?`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`BNBSmartChain ${txHash} sandwich?`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`BEP20 ${txHash} 是否被夹`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`BNB Smart Chain ${txHash} sandwich?`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`BNB SmartChain ${txHash} sandwich?`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`Binance Smart Chain ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`Binance SmartChain ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`BinanceSmartChain ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`Binance Chain ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`Binance-Chain ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`Binance-Smart-Chain ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`BEP 20 ${txHash} 是否被夹`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`币安链 ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`币安 ${txHash} 被夹了吗`)?.chain).toBe('bsc');
    expect(parseTransactionReference(`ETH tx ${txHash} sandwich?`)?.chain).toBe('ethereum');
    expect(parseTransactionReference(`以太链 ${txHash} 被夹了吗`)?.chain).toBe('ethereum');
  });

  it('keeps EVM transaction chain unknown when user text mentions multiple EVM chains', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`Base 或 ETH 这笔 ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
    });
    expect(parseTransactionReference(`ETH/BSC ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
    });
  });

  it('extracts a Solana-like transaction hash', () => {
    expect(
      parseTransactionReference(
        '5hQKp7mXw6Lz9qY8rT7uP6nM5bV4cX3zA2sD1fG9hJ8kL7mN6bV5cX4zA3sD2fG1 被夹了吗',
      ),
    ).toEqual({
      chain: 'solana',
      txHash: '5hQKp7mXw6Lz9qY8rT7uP6nM5bV4cX3zA2sD1fG9hJ8kL7mN6bV5cX4zA3sD2fG1',
    });
  });

  it('detects known explorer links', () => {
    expect(
      parseTransactionReference(
        'https://basescan.org/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      ),
    ).toEqual({
      chain: 'base',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    });
  });

  it('treats BSCTrace mainnet links as BSC explorer evidence', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`https://bsctrace.com/tx/${txHash}`)).toEqual({
      chain: 'bsc',
      txHash,
    });
    expect(parseTransactionReference(`https://www.bsctrace.com/tx/${txHash}`)).toEqual({
      chain: 'bsc',
      txHash,
    });
    expect(parseTransactionReference(`https://testnet.bsctrace.com/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'testnet',
      unsupportedExplorerHost: 'testnet.bsctrace.com',
    });
  });

  it('treats Base Blockscout mainnet links as Base explorer evidence', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`https://base.blockscout.com/tx/${txHash}`)).toEqual({
      chain: 'base',
      txHash,
    });
    expect(
      parseTransactionReference(`ETH https://base.blockscout.com/tx/${txHash} 被夹了吗？`),
    ).toBeUndefined();
  });

  it('treats Ethereum Blockscout mainnet links as Ethereum explorer evidence', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`https://eth.blockscout.com/tx/${txHash}`)).toEqual({
      chain: 'ethereum',
      txHash,
    });
    expect(
      parseTransactionReference(`Base https://eth.blockscout.com/tx/${txHash} 被夹了吗？`),
    ).toBeUndefined();
  });

  it('extracts transaction hashes from explorer links with query strings and fragments', () => {
    const evmTx = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const solanaTx =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      parseTransactionReference(`https://basescan.org/tx/${evmTx}?utm_source=x#events`),
    ).toEqual({
      chain: 'base',
      txHash: evmTx,
    });
    expect(
      parseTransactionReference(`https://solscan.io/tx/${solanaTx}?foo=bar#transfers`),
    ).toEqual({
      chain: 'solana',
      txHash: solanaTx,
    });
  });

  it('accepts Solana mainnet explorer links copied with trailing punctuation', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      parseTransactionReference(`https://explorer.solana.com/tx/${txHash}?cluster=mainnet。`),
    ).toEqual({
      chain: 'solana',
      txHash,
    });
    expect(
      parseTransactionReference(`https://explorer.solana.com/tx/${txHash}?cluster=mainnet-beta.`),
    ).toEqual({
      chain: 'solana',
      txHash,
    });
  });

  it('marks Solana non-mainnet explorer links with the unsupported cluster', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      parseTransactionReference(`https://explorer.solana.com/tx/${txHash}?cluster=devnet`),
    ).toEqual({
      chain: 'solana',
      txHash,
      unsupportedChainHint: 'devnet',
      unsupportedExplorerHost: 'explorer.solana.com',
    });
  });

  it('marks Solana non-mainnet explorer links when the cluster is copied in the fragment', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      parseTransactionReference(`https://explorer.solana.com/tx/${txHash}#cluster=devnet`),
    ).toEqual({
      chain: 'solana',
      txHash,
      unsupportedChainHint: 'devnet',
      unsupportedExplorerHost: 'explorer.solana.com',
    });
    expect(parseTransactionReference(`https://solscan.io/tx/${txHash}#cluster=testnet`)).toEqual({
      chain: 'solana',
      txHash,
      unsupportedChainHint: 'testnet',
      unsupportedExplorerHost: 'solscan.io',
    });
    expect(
      parseTransactionReference(`https://explorer.solana.com/tx/${txHash}#cluster=mainnet-beta`),
    ).toEqual({
      chain: 'solana',
      txHash,
    });
  });

  it('only infers EVM chains from supported mainnet explorer hosts', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`https://www.etherscan.io/tx/${txHash}`)?.chain).toBe(
      'ethereum',
    );
    expect(parseTransactionReference(`https://optimistic.etherscan.io/tx/${txHash}`)?.chain).toBe(
      'unknown',
    );
    expect(parseTransactionReference(`https://sepolia.basescan.org/tx/${txHash}`)?.chain).toBe(
      'unknown',
    );
    expect(parseTransactionReference(`https://testnet.bscscan.com/tx/${txHash}`)?.chain).toBe(
      'unknown',
    );
  });

  it('does not infer supported chains from unsupported Blockscout subdomain names', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`https://bsc.blockscout.com/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedExplorerHost: 'bsc.blockscout.com',
    });
  });

  it('marks known unsupported EVM explorer hosts instead of probing supported mainnets', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`https://polygonscan.com/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedExplorerHost: 'polygonscan.com',
    });
    expect(parseTransactionReference(`https://arbiscan.io/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedExplorerHost: 'arbiscan.io',
    });
  });

  it('marks explicit unsupported EVM chain text instead of probing supported mainnets', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`Polygon ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'polygon',
    });
    expect(parseTransactionReference(`Arbitrum ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'arbitrum',
    });
  });

  it('marks common unsupported EVM chain aliases instead of probing supported mainnets', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`MATIC ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'polygon',
    });
    expect(parseTransactionReference(`ARB ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'arbitrum',
    });
    expect(parseTransactionReference(`OP ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'optimism',
    });
    expect(parseTransactionReference(`Optimistic Ethereum ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'optimism',
    });
    expect(parseTransactionReference(`AVAX ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'avalanche',
    });
  });

  it('marks product-supported but transaction-analysis-unsupported EVM chain names', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`X Layer ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'xlayer',
    });
    expect(parseTransactionReference(`XLayer ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'xlayer',
    });
    expect(parseTransactionReference(`X-Layer ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'xlayer',
    });
    expect(parseTransactionReference(`Plasma ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'plasma',
    });
  });

  it('marks emerging unsupported EVM chain names instead of probing supported mainnets', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`Sonic ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'sonic',
    });
    expect(parseTransactionReference(`Berachain ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'berachain',
    });
    expect(parseTransactionReference(`Abstract ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'abstract',
    });
    expect(parseTransactionReference(`Moonriver ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'moonriver',
    });
  });

  it('marks additional common unsupported EVM chain names instead of probing supported mainnets', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`Mode Network ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'mode',
    });
    expect(parseTransactionReference(`Taiko ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'taiko',
    });
    expect(parseTransactionReference(`World Chain ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'worldchain',
    });
    expect(parseTransactionReference(`Zora Network ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'zora',
    });
    expect(parseTransactionReference(`Manta Pacific ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'manta',
    });
  });

  it('marks explicit EVM testnet text instead of probing supported mainnets', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`Base Sepolia ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'testnet',
    });
    expect(parseTransactionReference(`Ethereum Sepolia ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'testnet',
    });
    expect(parseTransactionReference(`BSC Testnet ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'testnet',
    });
    expect(parseTransactionReference(`ETH Goerli ${txHash} sandwich?`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'testnet',
    });
  });

  it('marks Mantle as an unsupported EVM transaction analysis chain', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`Mantle ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'mantle',
    });
    expect(parseTransactionReference(`https://mantlescan.xyz/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedExplorerHost: 'mantlescan.xyz',
    });
  });

  it('marks zkSync Era as an unsupported EVM transaction analysis chain', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`zkSync Era ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'zksync',
    });
    expect(parseTransactionReference(`ZK-Sync Era ${txHash} 被夹了吗？`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'zksync',
    });
    expect(parseTransactionReference(`https://era.zksync.network/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedChainHint: 'zksync',
      unsupportedExplorerHost: 'era.zksync.network',
    });
  });

  it('marks additional unsupported EVM explorer hosts and subdomains', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`https://zkevm.polygonscan.com/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedExplorerHost: 'zkevm.polygonscan.com',
    });
    expect(parseTransactionReference(`https://snowtrace.io/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedExplorerHost: 'snowtrace.io',
    });
    expect(parseTransactionReference(`https://lineascan.build/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedExplorerHost: 'lineascan.build',
    });
    expect(parseTransactionReference(`https://scrollscan.com/tx/${txHash}`)).toEqual({
      chain: 'unknown',
      txHash,
      unsupportedExplorerHost: 'scrollscan.com',
    });
  });

  it('keeps chain unknown when the same EVM hash is pasted with conflicting explorer domains', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      parseTransactionReference(
        `https://basescan.org/tx/${txHash} https://etherscan.io/tx/${txHash}`,
      ),
    ).toEqual({
      chain: 'unknown',
      txHash,
    });
  });

  it('returns undefined when explicit EVM chain text conflicts with the explorer domain', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(
      parseTransactionReference(`Base https://etherscan.io/tx/${txHash} 被夹了吗？`),
    ).toBeUndefined();
    expect(
      parseTransactionReference(`ETH https://bscscan.com/tx/${txHash} 被夹了吗？`),
    ).toBeUndefined();
  });

  it('returns undefined when explicit EVM chain text conflicts with a Solana explorer link', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(
      parseTransactionReference(`Base https://solscan.io/tx/${txHash} 被夹了吗？`),
    ).toBeUndefined();
  });

  it('returns undefined when explicit EVM chain text conflicts with a bare Solana signature', () => {
    const txHash =
      '5uTPyzPctFriE2wPTpvvvduS451Dd32zDr6RrEheuYHYh1M4SptKd7jqcVoHBjPX3CkvHPxj7ecTNjVMYfQBZ4MH';

    expect(parseTransactionReference(`Base ${txHash} 被夹了吗？`)).toBeUndefined();
  });

  it('returns undefined when Solana chain text conflicts with a bare EVM transaction hash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`Solana ${txHash} 被夹了吗？`)).toBeUndefined();
  });

  it('returns undefined when a SOL chain hint conflicts with a bare EVM transaction hash', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`SOL 链 ${txHash} 被夹了吗？`)).toBeUndefined();
    expect(parseTransactionReference(`SOL chain ${txHash} sandwich?`)).toBeUndefined();
  });

  it('returns undefined for ambiguous messages containing multiple distinct transaction hashes', () => {
    expect(
      parseTransactionReference(
        [
          '帮我查这两笔哪个被夹了',
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        ].join(' '),
      ),
    ).toBeUndefined();
  });

  it('accepts the same transaction hash when it appears more than once', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`Base ${txHash} https://basescan.org/tx/${txHash}`)).toEqual({
      chain: 'base',
      txHash,
    });
  });

  it('accepts the same EVM transaction hash when casing differs', () => {
    const txHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    expect(parseTransactionReference(`${txHash} ${txHash.toUpperCase()}`)).toEqual({
      chain: 'unknown',
      txHash,
    });
  });

  it('detects ambiguous messages containing multiple distinct transaction hashes', () => {
    expect(
      hasAmbiguousTransactionReferences(
        [
          '帮我查这两笔哪个被夹了',
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        ].join(' '),
      ),
    ).toBe(true);
  });

  it('returns undefined when no transaction reference is present', () => {
    expect(parseTransactionReference('什么是 MEV？')).toBeUndefined();
  });
});
