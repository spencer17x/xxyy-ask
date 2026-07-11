import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement, RefObject } from 'react';

import { createApiHeaders } from './api-auth.js';
import { checkAiService } from './ai-service-check.js';
import { readChatStream } from './chat-stream.js';
import { Markdown } from './Markdown.js';
import type { Attachment, ChatMessage, Citation } from './types.js';

const QUICK_PROMPTS = [
  'XXYY 有 APP 吗？',
  'XXYY Pro 有哪些权益？',
  'XXYY 支持跟单么？',
  '如何设置 Telegram 钱包监控？',
  'XXYY 怎么设置挂单交易？',
];

const SESSION_STORAGE_KEY = 'xxyy.ask.sessionId';
const AI_CHECK_IDLE_STATUS = 'AI 未测试';

export function appendAssistantAnswerDelta(message: ChatMessage, delta: string): ChatMessage {
  const { meta: _meta, statusMessage: _statusMessage, ...rest } = message;
  return {
    ...rest,
    rawAnswer: message.rawAnswer + delta,
    text: message.text + delta,
  };
}

export function App(): ReactElement {
  const [authToken, setAuthToken] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([createWelcomeMessage()]);
  const [input, setInput] = useState('');
  const [aiCheckBusy, setAiCheckBusy] = useState(false);
  const [aiCheckOk, setAiCheckOk] = useState<boolean | undefined>(undefined);
  const [aiCheckStatus, setAiCheckStatus] = useState(AI_CHECK_IDLE_STATUS);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [intent, setIntent] = useState('intent pending');
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
    setStatus('Sending');
    setIntent('retrieving');
    scrollMessagesToBottom();

    try {
      const response = await fetch('/api/chat/stream', {
        body: JSON.stringify({ channel: 'web', message: text, sessionId }),
        headers: createApiHeaders(authToken),
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
            meta: statusMessage,
            statusMessage,
          }));
          setStatus(statusMessage);
          return;
        }

        if (streamEvent.event === 'answer_delta') {
          const delta = streamEvent.payload.delta ?? '';
          updateAssistantMessage(assistantId, (message) =>
            appendAssistantAnswerDelta(message, delta),
          );
          setStatus('Receiving');
          return;
        }

        if (streamEvent.event === 'metadata') {
          const metadata = streamEvent.payload;
          updateAssistantMessage(assistantId, (message) => {
            const { statusMessage: _statusMessage, ...rest } = message;
            return {
              ...rest,
              attachments: metadata.attachments ?? [],
              citations: metadata.citations ?? [],
              intent: metadata.intent,
              meta: `${metadata.intent} · confidence ${metadata.confidence.toFixed(2)}`,
            };
          });
          setStatus(`${metadata.intent} · ${metadata.confidence.toFixed(2)}`);
          setIntent(metadata.intent);
          return;
        }

        if (streamEvent.event === 'error') {
          throw new Error(streamEvent.payload.message ?? 'Request failed.');
        }
      });

      updateAssistantMessage(assistantId, (message) => {
        const { status: _status, statusMessage: _statusMessage, ...rest } = message;
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
      setStatus('Error');
    } finally {
      setBusy(false);
    }
  };

  const testAiService = async (): Promise<void> => {
    if (aiCheckBusy) {
      return;
    }

    setAiCheckBusy(true);
    setAiCheckOk(undefined);
    setAiCheckStatus('AI 检测中');
    try {
      const result = await checkAiService(fetch, sessionId, authToken);
      setAiCheckOk(result.ok);
      setAiCheckStatus(result.statusText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAiCheckOk(false);
      setAiCheckStatus(`AI 服务不可用：${message}`);
    } finally {
      setAiCheckBusy(false);
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
    setIntent('intent pending');
    setStatus('Ready');
    setAiCheckOk(undefined);
    setAiCheckStatus(AI_CHECK_IDLE_STATUS);
  };

  return (
    <main className="app-shell">
      <Sidebar busy={busy} onPrompt={submitPrompt} />
      <section aria-label="chat" className="chat-workbench">
        <ChatHeader
          aiCheckBusy={aiCheckBusy}
          aiCheckOk={aiCheckOk}
          aiCheckStatus={aiCheckStatus}
          authToken={authToken}
          intent={intent}
          onAiCheck={testAiService}
          onAuthTokenChange={setAuthToken}
          onClear={clearChat}
          status={status}
        />
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
  aiCheckBusy,
  aiCheckOk,
  aiCheckStatus,
  authToken,
  intent,
  onAiCheck,
  onAuthTokenChange,
  onClear,
  status,
}: {
  aiCheckBusy: boolean;
  aiCheckOk: boolean | undefined;
  aiCheckStatus: string;
  authToken: string;
  intent: string;
  onAiCheck: () => Promise<void>;
  onAuthTokenChange: (token: string) => void;
  onClear: () => void;
  status: string;
}): ReactElement {
  const aiCheckClassName = [
    'status-pill',
    'ai-check-status',
    aiCheckOk === true ? 'is-ok' : '',
    aiCheckOk === false ? 'is-error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <header className="chat-header">
      <div>
        <h1>产品问答</h1>
        <div className="header-subtitle">基于 XXYY 文档和更新日志回答</div>
      </div>
      <div className="status-group">
        <label className="api-token-field">
          <span>API token</span>
          <input
            autoComplete="off"
            onChange={(event) => onAuthTokenChange(event.target.value)}
            placeholder="Bearer token"
            type="password"
            value={authToken}
          />
        </label>
        <button
          className="ai-check-button"
          disabled={aiCheckBusy}
          onClick={() => {
            void onAiCheck();
          }}
          type="button"
        >
          {aiCheckBusy ? '检测中' : '测试 AI'}
        </button>
        <button className="clear-button" onClick={onClear} type="button">
          New chat
        </button>
        <div aria-live="polite" className={aiCheckClassName} role="status">
          {aiCheckStatus}
        </div>
        <div className="status-pill">{intent}</div>
        <div aria-live="polite" className="status-pill strong" role="status">
          {status}
        </div>
      </div>
    </header>
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
            <div className="message-meta">{message.meta ?? 'waiting for citations'}</div>
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
    meta: '客服模式 · RAG 检索 · 流式输出',
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
