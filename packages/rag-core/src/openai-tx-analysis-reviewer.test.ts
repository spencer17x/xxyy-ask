import { describe, expect, it } from 'vitest';

import { createOpenAiTxAnalysisReviewer } from './openai-tx-analysis-reviewer.js';
import type { BrowserTxAnalysisReviewInput } from './browser-tx-analysis.js';

describe('createOpenAiTxAnalysisReviewer', () => {
  it('asks an OpenAI-compatible chat completion route to review a rule analysis result', async () => {
    const requests: Array<{ body: unknown; headers: unknown; url: string }> = [];
    const fetchImpl: typeof fetch = (url, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected JSON string request body.');
      }
      requests.push({
        body: JSON.parse(init.body) as unknown,
        headers: init.headers,
        url: requestUrlString(url),
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: 0.52,
                    evidence: [
                      {
                        detail: '目标前后腿模式存在，但成交窗口里还有同地址噪声，需要人工复查。',
                        label: '模型复核',
                        severity: 'warning',
                      },
                    ],
                    summary: '模型复核：疑似模式存在，但证据不足以直接确认被夹。',
                    verdict: 'inconclusive',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    };
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://llm.example/v1/chat/completions');
    expect(requests[0]?.headers).toMatchObject({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
    });
    expect(requests[0]?.body).toMatchObject({
      model: 'gpt-test',
      temperature: 0,
    });
    expect(
      (requests[0]?.body as { messages?: Array<{ content?: unknown }> }).messages?.[1]?.content,
    ).toContain('"ruleAnalysis"');
    expect(review).toEqual({
      confidence: 0.52,
      evidence: [
        {
          detail: '目标前后腿模式存在，但成交窗口里还有同地址噪声，需要人工复查。',
          label: '模型复核',
          severity: 'warning',
        },
      ],
      summary: '模型复核：疑似模式存在，但证据不足以直接确认被夹。',
      verdict: 'inconclusive',
    });
  });

  it('accepts fenced JSON even when a model adds a short preface', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    '下面是复核结果：',
                    '```json',
                    JSON.stringify({
                      confidence: 0.71,
                      summary: '模型复核：窗口证据不足，建议人工复查原页面。',
                      verdict: 'inconclusive',
                    }),
                    '```',
                  ].join('\n'),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.71,
      summary: '模型复核：窗口证据不足，建议人工复查原页面。',
      verdict: 'inconclusive',
    });
  });

  it('accepts JSON objects surrounded by plain model text', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    '复核结果如下：',
                    JSON.stringify({
                      confidence: 0.64,
                      summary: '模型复核：没有发现同一地址前后腿夹击证据。',
                      verdict: 'not_sandwiched',
                    }),
                    '请以原页面截图为准。',
                  ].join('\n'),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.64,
      summary: '模型复核：没有发现同一地址前后腿夹击证据。',
      verdict: 'not_sandwiched',
    });
  });

  it('accepts review JSON nested under a result object', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    result: {
                      confidence: 0.78,
                      summary: '模型复核：目标前后窗口存在可疑模式。',
                      verdict: 'sandwiched',
                    },
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.78,
      summary: '模型复核：目标前后窗口存在可疑模式。',
      verdict: 'sandwiched',
    });
  });

  it('accepts OpenAI-compatible text content parts', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    {
                      text: JSON.stringify({
                        confidence: 0.83,
                        summary: '模型复核：未发现典型夹子模式。',
                        verdict: 'not_sandwiched',
                      }),
                      type: 'text',
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.83,
      summary: '模型复核：未发现典型夹子模式。',
      verdict: 'not_sandwiched',
    });
  });

  it('normalizes string confidence and uppercase enum fields from model JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: '0.67',
                    evidence: [
                      {
                        detail: '模型返回了大写 severity，但证据内容仍可用于客服复查。',
                        label: '模型复核',
                        severity: 'WARNING',
                      },
                    ],
                    summary: '模型复核：疑似被夹，但建议结合原页面复查。',
                    verdict: 'SANDWICHED',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.67,
      evidence: [
        {
          detail: '模型返回了大写 severity，但证据内容仍可用于客服复查。',
          label: '模型复核',
          severity: 'warning',
        },
      ],
      summary: '模型复核：疑似被夹，但建议结合原页面复查。',
      verdict: 'sandwiched',
    });
  });

  it('normalizes common evidence severity aliases from model JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: 0.72,
                    evidence: [
                      {
                        detail: '模型用 warn 表示需要人工关注。',
                        label: '模型复核',
                        severity: 'warn',
                      },
                      {
                        detail: '模型用 high 表示高风险证据。',
                        label: '高风险证据',
                        severity: 'high',
                      },
                      {
                        detail: '模型用 low 表示普通上下文。',
                        label: '上下文',
                        severity: 'low',
                      },
                    ],
                    summary: '模型复核：证据别名应被归一化后保留。',
                    verdict: 'sandwiched',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.72,
      evidence: [
        {
          detail: '模型用 warn 表示需要人工关注。',
          label: '模型复核',
          severity: 'warning',
        },
        {
          detail: '模型用 high 表示高风险证据。',
          label: '高风险证据',
          severity: 'critical',
        },
        {
          detail: '模型用 low 表示普通上下文。',
          label: '上下文',
          severity: 'info',
        },
      ],
      summary: '模型复核：证据别名应被归一化后保留。',
      verdict: 'sandwiched',
    });
  });

  it('accepts a single evidence object from model JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: 0.69,
                    evidence: {
                      detail: '模型只返回了一个 evidence 对象，但内容仍可用于客服复查。',
                      label: '模型复核',
                      severity: 'warning',
                    },
                    summary: '模型复核：保留单条证据对象。',
                    verdict: 'inconclusive',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.69,
      evidence: [
        {
          detail: '模型只返回了一个 evidence 对象，但内容仍可用于客服复查。',
          label: '模型复核',
          severity: 'warning',
        },
      ],
      summary: '模型复核：保留单条证据对象。',
      verdict: 'inconclusive',
    });
  });

  it('accepts common evidence field aliases from model JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: 0.73,
                    evidences: [
                      {
                        detail: '模型使用 evidences 字段返回复核证据。',
                        label: '模型复核',
                        severity: 'warning',
                      },
                    ],
                    summary: '模型复核：保留 evidence 字段别名。',
                    verdict: 'inconclusive',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.73,
      evidence: [
        {
          detail: '模型使用 evidences 字段返回复核证据。',
          label: '模型复核',
          severity: 'warning',
        },
      ],
      summary: '模型复核：保留 evidence 字段别名。',
      verdict: 'inconclusive',
    });
  });

  it('accepts common evidence item field aliases from model JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: 0.73,
                    evidence: [
                      {
                        level: 'medium',
                        message: '模型把证据详情放在 message 字段。',
                        title: '模型复核',
                      },
                      {
                        description: '模型把高风险证据放在 description 字段。',
                        name: '高风险证据',
                        riskLevel: 'high',
                      },
                    ],
                    summary: '模型复核：保留 evidence item 字段别名。',
                    verdict: 'inconclusive',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.73,
      evidence: [
        {
          detail: '模型把证据详情放在 message 字段。',
          label: '模型复核',
          severity: 'warning',
        },
        {
          detail: '模型把高风险证据放在 description 字段。',
          label: '高风险证据',
          severity: 'critical',
        },
      ],
      summary: '模型复核：保留 evidence item 字段别名。',
      verdict: 'inconclusive',
    });
  });

  it('accepts review JSON nested under an analysis object with findings', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    analysis: {
                      confidence: 0.76,
                      findings: [
                        {
                          detail: '模型把复核内容包在 analysis.findings 下。',
                          label: '模型复核',
                          severity: 'warning',
                        },
                      ],
                      summary: '模型复核：analysis 包裹也应保留。',
                      verdict: 'inconclusive',
                    },
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.76,
      evidence: [
        {
          detail: '模型把复核内容包在 analysis.findings 下。',
          label: '模型复核',
          severity: 'warning',
        },
      ],
      summary: '模型复核：analysis 包裹也应保留。',
      verdict: 'inconclusive',
    });
  });

  it.each(['not sandwiched', 'not-sandwiched'])(
    'normalizes model verdicts that use spaces or hyphens instead of underscores: %s',
    async (verdict) => {
      const fetchImpl: typeof fetch = () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      confidence: 0.74,
                      summary: '模型复核：没有发现典型夹子模式。',
                      verdict,
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      const reviewer = createOpenAiTxAnalysisReviewer({
        apiKey: 'sk-test',
        baseUrl: 'https://llm.example/v1',
        fetchImpl,
        model: 'gpt-test',
        requestTimeoutMs: 1000,
      });

      const review = await reviewer.review(createReviewInput());

      expect(review).toEqual({
        confidence: 0.74,
        summary: '模型复核：没有发现典型夹子模式。',
        verdict: 'not_sandwiched',
      });
    },
  );

  it.each([
    ['sandwich', 'sandwiched'],
    ['sandwich detected', 'sandwiched'],
    ['no sandwich', 'not_sandwiched'],
    ['not sandwich', 'not_sandwiched'],
    ['uncertain', 'inconclusive'],
    ['unknown', 'inconclusive'],
    ['insufficient evidence', 'inconclusive'],
  ] as const)('normalizes common model verdict aliases: %s', async (verdict, expected) => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: 0.74,
                    summary: '模型复核：模型返回了常见口语化 verdict。',
                    verdict,
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.74,
      summary: '模型复核：模型返回了常见口语化 verdict。',
      verdict: expected,
    });
  });

  it.each([
    ['isSandwiched', true, 'sandwiched'],
    ['is_sandwiched', false, 'not_sandwiched'],
    ['sandwiched', false, 'not_sandwiched'],
  ] as const)('normalizes boolean model verdict field %s=%s', async (field, value, expected) => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: 0.81,
                    [field]: value,
                    summary: '模型复核：模型使用布尔字段表达是否被夹。',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.81,
      summary: '模型复核：模型使用布尔字段表达是否被夹。',
      verdict: expected,
    });
  });

  it.each([
    ['isSandwiched', 'true', 'sandwiched'],
    ['isSandwiched', 'yes', 'sandwiched'],
    ['isSandwiched', '是', 'sandwiched'],
    ['is_sandwiched', 'false', 'not_sandwiched'],
    ['is_sandwiched', '否', 'not_sandwiched'],
    ['sandwiched', 'no', 'not_sandwiched'],
  ] as const)(
    'normalizes string boolean model verdict field %s=%s',
    async (field, value, expected) => {
      const fetchImpl: typeof fetch = () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      confidence: 0.82,
                      [field]: value,
                      summary: '模型复核：模型使用字符串布尔字段表达是否被夹。',
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      const reviewer = createOpenAiTxAnalysisReviewer({
        apiKey: 'sk-test',
        baseUrl: 'https://llm.example/v1',
        fetchImpl,
        model: 'gpt-test',
        requestTimeoutMs: 1000,
      });

      const review = await reviewer.review(createReviewInput());

      expect(review).toEqual({
        confidence: 0.82,
        summary: '模型复核：模型使用字符串布尔字段表达是否被夹。',
        verdict: expected,
      });
    },
  );

  it.each([
    ['isSandwich', true, 'sandwiched'],
    ['is_sandwich', false, 'not_sandwiched'],
    ['hasSandwich', 'yes', 'sandwiched'],
    ['has_sandwich', true, 'sandwiched'],
    ['sandwichDetected', 'no', 'not_sandwiched'],
    ['sandwich_detected', false, 'not_sandwiched'],
  ] as const)(
    'normalizes common model boolean sandwich alias %s=%s',
    async (field, value, expected) => {
      const fetchImpl: typeof fetch = () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      confidence: 0.8,
                      [field]: value,
                      summary: '模型复核：模型使用常见布尔别名表达是否被夹。',
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      const reviewer = createOpenAiTxAnalysisReviewer({
        apiKey: 'sk-test',
        baseUrl: 'https://llm.example/v1',
        fetchImpl,
        model: 'gpt-test',
        requestTimeoutMs: 1000,
      });

      const review = await reviewer.review(createReviewInput());

      expect(review).toEqual({
        confidence: 0.8,
        summary: '模型复核：模型使用常见布尔别名表达是否被夹。',
        verdict: expected,
      });
    },
  );

  it('normalizes percentage confidence strings from model JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: '67%',
                    summary: '模型复核：证据偏弱，建议人工复查。',
                    verdict: 'inconclusive',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.67,
      summary: '模型复核：证据偏弱，建议人工复查。',
      verdict: 'inconclusive',
    });
  });

  it.each([
    ['confidenceScore', '87%'],
    ['confidence_score', 87],
    ['score', '0.87'],
    ['probability', '87 / 100'],
    ['likelihood', 0.87],
  ] as const)('normalizes common model confidence alias %s', async (field, value) => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    [field]: value,
                    summary: '模型复核：模型使用常见置信度字段别名。',
                    verdict: 'inconclusive',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.87,
      summary: '模型复核：模型使用常见置信度字段别名。',
      verdict: 'inconclusive',
    });
  });

  it('normalizes full-width percentage confidence strings from model JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: '67％',
                    summary: '模型复核：置信度字段使用全角百分号。',
                    verdict: 'inconclusive',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.67,
      summary: '模型复核：置信度字段使用全角百分号。',
      verdict: 'inconclusive',
    });
  });

  it('normalizes whole-number percentage confidence values from model JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: 67,
                    summary: '模型复核：置信度字段使用百分制数字。',
                    verdict: 'inconclusive',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.67,
      summary: '模型复核：置信度字段使用百分制数字。',
      verdict: 'inconclusive',
    });
  });

  it('normalizes fraction-style confidence strings from model JSON', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    confidence: '67 / 100',
                    summary: '模型复核：置信度字段使用分数式百分制。',
                    verdict: 'inconclusive',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const reviewer = createOpenAiTxAnalysisReviewer({
      apiKey: 'sk-test',
      baseUrl: 'https://llm.example/v1',
      fetchImpl,
      model: 'gpt-test',
      requestTimeoutMs: 1000,
    });

    const review = await reviewer.review(createReviewInput());

    expect(review).toEqual({
      confidence: 0.67,
      summary: '模型复核：置信度字段使用分数式百分制。',
      verdict: 'inconclusive',
    });
  });
});

function createReviewInput(): BrowserTxAnalysisReviewInput {
  return {
    chain: 'base',
    contractAddress: '0xToken000000000000000000000000000000000000',
    poolAddress: '0xPool0000000000000000000000000000000000000',
    requestedTxHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    ruleAnalysis: {
      backRun: {
        hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        side: 'sell',
        summary: 'back run',
        traderAddress: '0xAttacker000000000000000000000000000000000',
      },
      confidence: 0.9,
      evidence: [
        {
          detail: '规则发现同一交易者前后腿。',
          label: '同一交易者前后腿',
          severity: 'warning',
        },
      ],
      frontRun: {
        hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        side: 'buy',
        summary: 'front run',
        traderAddress: '0xAttacker000000000000000000000000000000000',
      },
      ruleVersion: 'sandwich-window-rules-v1',
      summary: '规则判断疑似被夹。',
      verdict: 'sandwiched',
    },
    targetTrade: {
      hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      side: 'buy',
      summary: 'target buy',
      traderAddress: '0xUser0000000000000000000000000000000000000',
    },
    tradeWindow: {
      after: [],
      before: [],
    },
  };
}

function requestUrlString(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === 'string') {
    return url;
  }
  if (url instanceof URL) {
    return url.toString();
  }

  return url.url;
}
