import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement, RefObject } from 'react';

import { readChatStream } from './chat-stream.js';
import { Markdown } from './Markdown.js';
import { checkModelHealth, type ModelHealthCheck, type ModelHealthResult } from './model-health.js';
import type { Attachment, ChatMessage, Citation } from './types.js';

const QUICK_PROMPTS = [
  'XXYY 有 APP 吗？',
  'XXYY Pro 有哪些权益？',
  'XXYY 支持跟单么？',
  '如何设置 Telegram 钱包监控？',
  'XXYY 怎么设置挂单交易？',
];

const SESSION_STORAGE_KEY = 'xxyy.ask.sessionId';
export function appendAssistantAnswerDelta(message: ChatMessage, delta: string): ChatMessage {
  const { meta: _meta, statusMessage: _statusMessage, ...rest } = message;
  return {
    ...rest,
    rawAnswer: message.rawAnswer + delta,
    text: message.text + delta,
  };
}

export function App(): ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([createWelcomeMessage()]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelTestBusy, setModelTestBusy] = useState(false);
  const [modelTestOpen, setModelTestOpen] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<ModelHealthResult | undefined>();
  const [sessionId, setSessionId] = useState(() => getSessionId());
  const messagesRef = useRef<HTMLDivElement>(null);

  const scrollMessagesToBottom = (): void => {
    window.requestAnimationFrame(() => {
      const messagesNode = messagesRef.current;
      if (messagesNode !== null) {
        messagesNode.scrollTop = messagesNode.scrollHeight;
      }
    });
  };

  const updateAssistantMessage = (
    id: string,
    updater: (message: ChatMessage) => ChatMessage,
  ): void => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? updater(message) : message)),
    );
    scrollMessagesToBottom();
  };

  const submitPrompt = async (rawText: string): Promise<void> => {
    const text = rawText.trim();
    if (text.length === 0 || busy) {
      return;
    }

    const assistantId = createId('assistant');
    setMessages((current) => [
      ...current.filter((message) => message.id !== 'welcome'),
      createUserMessage(text),
      createAssistantMessage(assistantId),
    ]);
    setInput('');
    setBusy(true);
    scrollMessagesToBottom();

    try {
      const response = await fetch('/api/chat/stream', {
        body: JSON.stringify({ channel: 'web', message: text, sessionId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
        throw new Error(typeof payload.message === 'string' ? payload.message : 'Request failed.');
      }
      if (response.body === null) {
        throw new Error('Streaming response is unavailable.');
      }

      await readChatStream(response.body, (streamEvent) => {
        if (streamEvent.event === 'status') {
          const statusMessage = streamEvent.payload.message ?? '处理中…';
          updateAssistantMessage(assistantId, (message) => ({
            ...message,
            statusMessage,
          }));
          return;
        }

        if (streamEvent.event === 'answer_delta') {
          const delta = streamEvent.payload.delta ?? '';
          updateAssistantMessage(assistantId, (message) =>
            appendAssistantAnswerDelta(message, delta),
          );
          return;
        }

        if (streamEvent.event === 'metadata') {
          const metadata = streamEvent.payload;
          updateAssistantMessage(assistantId, (message) => {
            const { meta: _meta, statusMessage: _statusMessage, ...rest } = message;
            return {
              ...rest,
              attachments: metadata.attachments ?? [],
              citations: metadata.citations ?? [],
              intent: metadata.intent,
            };
          });
          return;
        }

        if (streamEvent.event === 'error') {
          throw new Error(streamEvent.payload.message ?? 'Request failed.');
        }
      });

      updateAssistantMessage(assistantId, (message) => {
        const { meta: _meta, status: _status, statusMessage: _statusMessage, ...rest } = message;
        return rest;
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      updateAssistantMessage(assistantId, (message) => ({
        ...message,
        rawAnswer: errorMessage,
        status: 'error',
        text: errorMessage,
      }));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitPrompt(input);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt(input);
    }
  };

  const clearChat = (): void => {
    const nextSessionId = resetSessionId();
    setSessionId(nextSessionId);
    setMessages([]);
    setInput('');
  };

  const runModelTest = async (): Promise<void> => {
    if (modelTestBusy) {
      return;
    }
    setModelTestBusy(true);
    setModelTestResult(undefined);
    try {
      setModelTestResult(await checkModelHealth(fetch));
    } finally {
      setModelTestBusy(false);
    }
  };

  const openModelTest = (): void => {
    setModelTestOpen(true);
    void runModelTest();
  };

  return (
    <main className="app-shell">
      <Sidebar busy={busy} onPrompt={submitPrompt} />
      <section aria-label="chat" className="chat-workbench">
        <ChatHeader onClear={clearChat} onModelTest={openModelTest} />
        <MessageList messages={messages} messagesRef={messagesRef} />
        <form className="composer-wrap" id="chat-form" onSubmit={onSubmit}>
          <div className="composer">
            <label className="sr-only" htmlFor="message">
              Message
            </label>
            <textarea
              id="message"
              name="message"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="例如：XXYY Pro 有哪些权益？"
              required
              value={input}
            />
            <button aria-label="发送" className="send-button" disabled={busy} type="submit">
              <SendIcon />
            </button>
          </div>
        </form>
      </section>
      {modelTestOpen ? (
        <ModelTestPanel
          busy={modelTestBusy}
          onClose={() => setModelTestOpen(false)}
          onRetry={runModelTest}
          result={modelTestResult}
        />
      ) : undefined}
    </main>
  );
}

function Sidebar({
  busy,
  onPrompt,
}: {
  busy: boolean;
  onPrompt: (prompt: string) => Promise<void>;
}): ReactElement {
  return (
    <aside aria-label="workspace" className="sidebar">
      <div className="brand">
        <div aria-hidden="true" className="brand-mark">
          XY
        </div>
        <div>
          <div className="brand-name">XXYY Ask</div>
          <div className="brand-subtitle">产品客服 Agent</div>
        </div>
      </div>

      <section aria-label="quick questions" className="sidebar-section">
        <div className="section-label">快捷问题</div>
        {QUICK_PROMPTS.map((prompt) => (
          <button
            className="quick-prompt"
            disabled={busy}
            key={prompt}
            onClick={() => {
              void onPrompt(prompt);
            }}
            type="button"
          >
            {shortPrompt(prompt)}
            <ChevronRightIcon />
          </button>
        ))}
      </section>

      <section aria-label="scope" className="sidebar-section secondary">
        <div className="section-label">回答边界</div>
        <ul className="scope-list">
          <li>
            <span className="dot" />
            产品功能与配置
          </li>
          <li>
            <span className="dot" />
            Pro 权益与更新日志
          </li>
          <li>
            <span className="dot warn" />
            不查询账户或交易记录
          </li>
          <li>
            <span className="dot warn" />
            不提供投资建议
          </li>
        </ul>
      </section>
    </aside>
  );
}

function ChatHeader({
  onClear,
  onModelTest,
}: {
  onClear: () => void;
  onModelTest: () => void;
}): ReactElement {
  return (
    <header className="chat-header">
      <div>
        <h1>XXYY Agent</h1>
        <div className="header-subtitle">XXYY 产品问答客服</div>
      </div>
      <div className="header-actions">
        <button className="model-test-button" onClick={onModelTest} type="button">
          模型测试
        </button>
        <button className="clear-button" onClick={onClear} type="button">
          新对话
        </button>
      </div>
    </header>
  );
}

function ModelTestPanel({
  busy,
  onClose,
  onRetry,
  result,
}: {
  busy: boolean;
  onClose: () => void;
  onRetry: () => Promise<void>;
  result: ModelHealthResult | undefined;
}): ReactElement {
  return (
    <div className="model-test-backdrop">
      <section
        aria-labelledby="model-test-title"
        aria-modal="true"
        className="model-test-panel"
        role="dialog"
      >
        <header className="model-test-header">
          <div>
            <h2 id="model-test-title">模型测试</h2>
            <p>检测当前 LLM 与 Embedding 是否可以正常访问。</p>
          </div>
          <button aria-label="关闭模型测试" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <div aria-live="polite" className="model-test-results">
          {busy || result === undefined ? (
            <p className="model-test-loading">正在检测…</p>
          ) : undefined}
          {!busy && result?.kind === 'error' ? (
            <p className="model-test-error" role="alert">
              {result.message}
            </p>
          ) : undefined}
          {!busy && result?.kind === 'report' ? (
            <div className="model-test-grid">
              <ModelTestCard check={result.llm} title="LLM" />
              <ModelTestCard check={result.embedding} title="Embedding" />
            </div>
          ) : undefined}
        </div>

        <footer className="model-test-footer">
          <span>{result === undefined ? '' : `耗时 ${result.durationMs} ms`}</span>
          <button
            disabled={busy}
            onClick={() => {
              void onRetry();
            }}
            type="button"
          >
            重新测试
          </button>
        </footer>
      </section>
    </div>
  );
}

function ModelTestCard({ check, title }: { check: ModelHealthCheck; title: string }): ReactElement {
  return (
    <article className={`model-test-card ${check.status === 'ok' ? 'is-ok' : 'is-error'}`}>
      <div>
        <h3>{title}</h3>
        <span>{check.status === 'ok' ? '正常' : '异常'}</span>
      </div>
      {check.model === undefined ? undefined : <p>模型：{check.model}</p>}
      {check.dimension === undefined ? undefined : <p>维度：{check.dimension}</p>}
      {check.message === undefined ? undefined : (
        <p className="model-test-message">{check.message}</p>
      )}
    </article>
  );
}

function MessageList({
  messages,
  messagesRef,
}: {
  messages: ChatMessage[];
  messagesRef: RefObject<HTMLDivElement | null>;
}): ReactElement {
  return (
    <div aria-live="polite" className="messages" ref={messagesRef}>
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }): ReactElement {
  const messageClassName = ['message', message.role, message.status === 'error' ? 'is-error' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <article
      className={messageClassName}
      data-welcome-message={message.id === 'welcome' || undefined}
    >
      <div aria-hidden="true" className="avatar">
        {message.role === 'user' ? 'You' : 'AI'}
      </div>
      <div className="bubble">
        <div className="bubble-content markdown-rendered">
          {message.status === 'streaming' && message.text.length === 0 ? (
            <span className="thinking">{message.statusMessage ?? 'Thinking'}</span>
          ) : message.role === 'assistant' ? (
            <Markdown text={message.text} />
          ) : (
            message.text
          )}
        </div>
        {message.role === 'assistant' ? (
          <>
            {message.meta === undefined ? undefined : (
              <div className="message-meta">{message.meta}</div>
            )}
            <CitationList citations={message.citations} />
            <AttachmentList attachments={message.attachments} />
          </>
        ) : undefined}
      </div>
    </article>
  );
}

function CitationList({ citations }: { citations: Citation[] }): ReactElement {
  return (
    <div className="citation-list">
      {citations.map((citation, index) => (
        <article className="citation" key={`${citation.file}-${index}`}>
          <div className="citation-title">
            [{index + 1}] {citation.title}
          </div>
          <div className="citation-meta">
            {citation.sourceUrl === undefined ? (
              citation.file
            ) : (
              <a href={citation.sourceUrl} rel="noreferrer" target="_blank">
                {citation.file}
              </a>
            )}
          </div>
          <div className="citation-excerpt">{citation.excerpt}</div>
        </article>
      ))}
    </div>
  );
}

function AttachmentList({ attachments }: { attachments: Attachment[] }): ReactElement {
  return (
    <div className="attachment-list">
      {attachments.map((attachment) => (
        <article className="attachment" key={`${attachment.kind}-${attachment.url}`}>
          <div className="attachment-title">{attachment.title}</div>
          {attachment.kind === 'video' ? (
            <video aria-label={attachment.title} controls preload="metadata" src={attachment.url} />
          ) : (
            <img alt={attachment.title} decoding="async" loading="lazy" src={attachment.url} />
          )}
        </article>
      ))}
    </div>
  );
}

function createWelcomeMessage(): ChatMessage {
  return {
    attachments: [],
    citations: [],
    id: 'welcome',
    rawAnswer: '你好，我可以回答 XXYY 产品功能、Pro 权益、交易设置、钱包监控和更新日志相关问题。',
    role: 'assistant',
    text: '你好，我可以回答 XXYY 产品功能、Pro 权益、交易设置、钱包监控和更新日志相关问题。',
  };
}

function createUserMessage(text: string): ChatMessage {
  return {
    attachments: [],
    citations: [],
    id: createId('user'),
    rawAnswer: text,
    role: 'user',
    text,
  };
}

function createAssistantMessage(id: string): ChatMessage {
  return {
    attachments: [],
    citations: [],
    id,
    rawAnswer: '',
    role: 'assistant',
    status: 'streaming',
    text: '',
  };
}

function shortPrompt(prompt: string): string {
  if (prompt === '如何设置 Telegram 钱包监控？') {
    return '如何设置钱包监控？';
  }
  return prompt;
}

function getSessionId(): string {
  try {
    const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing !== null && existing.length > 0) {
      return existing;
    }
    const next = createId('session');
    window.localStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return createId('session');
  }
}

function resetSessionId(): string {
  const next = createId('session');
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, next);
  } catch {
    // A fresh in-memory id still prevents stale follow-up context in this tab.
  }
  return next;
}

function createId(prefix: string): string {
  return window.crypto && typeof window.crypto.randomUUID === 'function'
    ? `${prefix}-${window.crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function SendIcon(): ReactElement {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 18 18" width="18">
      <path
        d="M9 14.5V3.5m0 0L4.5 8M9 3.5 13.5 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ChevronRightIcon(): ReactElement {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
      <path
        d="m5.25 3.5 3.5 3.5-3.5 3.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
