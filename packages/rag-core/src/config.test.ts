import { describe, expect, it } from 'vitest';

import { loadRagConfig } from './config.js';

describe('loadRagConfig', () => {
  it('returns deterministic defaults when no environment is provided', () => {
    expect(loadRagConfig({})).toEqual({
      topK: 6,
      answerProvider: 'openai',
      txAnalysisProvider: 'browser',
      txAnalysisReviewer: 'none',
      txAnalysisBrowserHeadless: true,
      txAnalysisDiscoverUrl: undefined,
      txAnalysisBrowserMaxConcurrency: 1,
      txAnalysisBrowserMaxRetries: 1,
      txAnalysisBrowserTimeoutMs: 60000,
      txAnalysisBrowserUserDataDir: '.tx-analysis-browser-profile',
      txAnalysisChromeExecutablePath: undefined,
      txAnalysisReportStore: 'file',
      txAnalysisScreenshotBaseUrl: '/assets',
      txAnalysisScreenshotDir: undefined,
      databaseUrl: undefined,
      openAiApiKey: undefined,
      openAiBaseUrl: 'https://api.openai.com/v1',
      openAiApiKeyPresent: false,
      openAiModel: undefined,
      openAiEmbeddingModel: 'text-embedding-3-small',
      openAiMaxRetries: 1,
      openAiRequestTimeoutMs: 30000,
    });
  });

  it('defaults to OpenAI small embedding model without exposing local mode', () => {
    const config = loadRagConfig({});

    expect(config).not.toHaveProperty('vectorStore');
    expect(config).not.toHaveProperty('indexPath');
    expect(config).not.toHaveProperty('embeddingProvider');
    expect(config.databaseUrl).toBeUndefined();
    expect(config.openAiEmbeddingModel).toBe('text-embedding-3-small');
  });

  it('accepts supported environment overrides without requiring OpenAI calls', () => {
    expect(
      loadRagConfig({
        OPENAI_API_KEY: 'sk-future-only',
        RAG_ANSWER_PROVIDER: 'future-provider',
        RAG_TOP_K: '3',
        OPENAI_BASE_URL: 'https://llm.example/v1',
        OPENAI_MAX_RETRIES: '2',
        OPENAI_MODEL: 'gpt-test',
        OPENAI_REQUEST_TIMEOUT_MS: '12000',
        TX_ANALYSIS_PROVIDER: 'browser',
        TX_ANALYSIS_REVIEWER: 'openai',
        TX_ANALYSIS_BROWSER_HEADLESS: 'true',
        TX_ANALYSIS_BROWSER_MAX_CONCURRENCY: '2',
        TX_ANALYSIS_BROWSER_MAX_RETRIES: '3',
        TX_ANALYSIS_BROWSER_TIMEOUT_MS: '90000',
        TX_ANALYSIS_BROWSER_USER_DATA_DIR: '.browser-profile',
        TX_ANALYSIS_CHROME_EXECUTABLE_PATH:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        TX_ANALYSIS_DISCOVER_URL: 'https://staging.xxyy.io/discover',
        TX_ANALYSIS_REPORT_STORE: 'postgres',
        TX_ANALYSIS_SCREENSHOT_BASE_URL: '/analysis-assets',
        TX_ANALYSIS_SCREENSHOT_DIR: '/tmp/xxyy-analysis-assets',
      }),
    ).toEqual({
      topK: 3,
      answerProvider: 'future-provider',
      txAnalysisProvider: 'browser',
      txAnalysisReviewer: 'openai',
      txAnalysisBrowserHeadless: true,
      txAnalysisDiscoverUrl: 'https://staging.xxyy.io/discover',
      txAnalysisBrowserMaxConcurrency: 2,
      txAnalysisBrowserMaxRetries: 3,
      txAnalysisBrowserTimeoutMs: 90000,
      txAnalysisBrowserUserDataDir: '.browser-profile',
      txAnalysisChromeExecutablePath:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      txAnalysisReportStore: 'postgres',
      txAnalysisScreenshotBaseUrl: '/analysis-assets',
      txAnalysisScreenshotDir: '/tmp/xxyy-analysis-assets',
      databaseUrl: undefined,
      openAiApiKey: 'sk-future-only',
      openAiBaseUrl: 'https://llm.example/v1',
      openAiApiKeyPresent: true,
      openAiModel: 'gpt-test',
      openAiEmbeddingModel: 'text-embedding-3-small',
      openAiMaxRetries: 2,
      openAiRequestTimeoutMs: 12000,
    });
  });

  it('loads database and embedding configuration from env', () => {
    const config = loadRagConfig({
      DATABASE_URL: 'postgres://xxyy:secret@localhost:5432/xxyy_ask',
      OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
    });

    expect(config.databaseUrl).toBe('postgres://xxyy:secret@localhost:5432/xxyy_ask');
    expect(config.openAiEmbeddingModel).toBe('text-embedding-3-large');
  });

  it('derives database URL from Postgres parts when DATABASE_URL is omitted', () => {
    const config = loadRagConfig({
      POSTGRES_DB: 'xxyy_ask',
      POSTGRES_HOST: 'db.internal',
      POSTGRES_PASSWORD: 'secret with symbols/@',
      POSTGRES_PORT: '15432',
      POSTGRES_USER: 'xxyy',
    });

    expect(config.databaseUrl).toBe(
      'postgres://xxyy:secret%20with%20symbols%2F%40@db.internal:15432/xxyy_ask',
    );
  });

  it('keeps a safe topK default for invalid numeric overrides', () => {
    expect(loadRagConfig({ RAG_TOP_K: 'not-a-number' }).topK).toBe(6);
    expect(loadRagConfig({ RAG_TOP_K: '0' }).topK).toBe(6);
  });

  it('keeps safe OpenAI request defaults for invalid numeric overrides', () => {
    const config = loadRagConfig({
      OPENAI_MAX_RETRIES: '-1',
      OPENAI_REQUEST_TIMEOUT_MS: 'not-a-number',
    });

    expect(config.openAiMaxRetries).toBe(1);
    expect(config.openAiRequestTimeoutMs).toBe(30000);
  });

  it('accepts the browser transaction analysis provider for local Solana checks', () => {
    expect(loadRagConfig({ TX_ANALYSIS_PROVIDER: 'browser' }).txAnalysisProvider).toBe('browser');
  });

  it('keeps an explicit transaction analysis provider override for disabling browser checks', () => {
    expect(loadRagConfig({ TX_ANALYSIS_PROVIDER: 'none' }).txAnalysisProvider).toBe('none');
  });
});
