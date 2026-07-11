import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './types.js';
import * as appModule from './App.js';

type AppendAnswerDelta = (message: ChatMessage, delta: string) => ChatMessage;

describe('appendAssistantAnswerDelta', () => {
  it('removes transient status metadata while appending streamed text', () => {
    const appendAssistantAnswerDelta = (
      appModule as typeof appModule & { appendAssistantAnswerDelta?: AppendAnswerDelta }
    ).appendAssistantAnswerDelta;
    expect(appendAssistantAnswerDelta).toBeTypeOf('function');
    if (appendAssistantAnswerDelta === undefined) {
      throw new Error('Expected appendAssistantAnswerDelta to be implemented.');
    }

    const message: ChatMessage = {
      attachments: [],
      citations: [],
      id: 'assistant-1',
      meta: '正在分析问题…',
      rawAnswer: '第一段',
      role: 'assistant',
      status: 'streaming',
      statusMessage: '正在分析问题…',
      text: '第一段',
    };

    expect(appendAssistantAnswerDelta(message, '第二段')).toEqual({
      attachments: [],
      citations: [],
      id: 'assistant-1',
      rawAnswer: '第一段第二段',
      role: 'assistant',
      status: 'streaming',
      text: '第一段第二段',
    });
  });
});
