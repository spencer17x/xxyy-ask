import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function renderChatPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>XXYY Ask</title>
    <style>
      :root {
        color-scheme: light;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          sans-serif;
        background: #f3f6f8;
        color: #17202e;
        --bg: #f3f6f8;
        --panel: #ffffff;
        --panel-soft: #f8fafb;
        --line: #dbe3ec;
        --line-soft: #edf1f5;
        --text: #17202e;
        --muted: #647083;
        --accent: #176b5b;
        --accent-strong: #105247;
        --accent-soft: #e4f3ee;
        --blue-soft: #e9f0fb;
        --amber-soft: #fbf1db;
        --danger: #a73939;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        overflow: hidden;
        overflow-x: hidden;
        min-height: 100vh;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(243, 246, 248, 0.96)),
          var(--bg);
        color: var(--text);
      }

      button,
      textarea {
        font: inherit;
      }

      button {
        cursor: pointer;
      }

      .app-shell {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
        width: 100vw;
        height: 100vh;
        min-width: 0;
      }

      .sidebar {
        display: grid;
        grid-template-rows: auto 1fr auto;
        gap: 24px;
        min-width: 0;
        min-height: 0;
        padding: 24px;
        border-right: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.86);
      }

      .brand {
        display: grid;
        grid-template-columns: 42px 1fr;
        gap: 12px;
        align-items: center;
      }

      .brand-mark {
        display: grid;
        place-items: center;
        width: 42px;
        height: 42px;
        border-radius: 8px;
        background: var(--accent);
        color: #fff;
        font-size: 14px;
        font-weight: 800;
        letter-spacing: 0;
      }

      .brand-name {
        font-size: 17px;
        font-weight: 750;
      }

      .brand-subtitle {
        margin-top: 3px;
        color: var(--muted);
        font-size: 12px;
      }

      .sidebar-section {
        display: grid;
        align-content: start;
        gap: 10px;
        grid-auto-rows: max-content;
      }

      .section-label {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      .quick-prompt {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        align-items: center;
        width: 100%;
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        color: var(--text);
        padding: 10px 12px;
        text-align: left;
        transition:
          border-color 140ms ease,
          background 140ms ease,
          transform 140ms ease;
      }

      .quick-prompt:hover {
        border-color: #8fbcb2;
        background: #fbfefd;
        transform: translateY(-1px);
      }

      .quick-prompt span {
        color: var(--muted);
      }

      .scope-list {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .scope-list li {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 13px;
      }

      .dot {
        width: 7px;
        height: 7px;
        border-radius: 99px;
        background: var(--accent);
      }

      .dot.warn {
        background: #c48a27;
      }

      .chat-workbench {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        min-width: 0;
        min-height: 0;
      }

      .chat-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 74px;
        padding: 18px 28px;
        border-bottom: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.72);
      }

      h1 {
        margin: 0;
        color: var(--text);
        font-size: 20px;
        font-weight: 760;
        letter-spacing: 0;
      }

      .header-subtitle {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }

      .status-group {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }

      .status-pill {
        min-height: 28px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--panel);
        color: var(--muted);
        padding: 5px 10px;
        font-size: 12px;
      }

      .status-pill.strong {
        border-color: #c7e3da;
        background: var(--accent-soft);
        color: var(--accent-strong);
      }

      .messages {
        display: grid;
        align-content: start;
        gap: 18px;
        min-height: 0;
        overflow: auto;
        padding: 28px;
        scroll-behavior: smooth;
      }

      .message {
        display: grid;
        grid-template-columns: 36px minmax(0, 740px);
        gap: 12px;
        align-items: start;
        width: 100%;
        min-width: 0;
      }

      .message.user {
        grid-template-columns: minmax(0, 740px) 36px;
        justify-content: end;
      }

      .avatar {
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        border-radius: 8px;
        background: var(--blue-soft);
        color: #29405f;
        font-size: 12px;
        font-weight: 800;
      }

      .user .avatar {
        grid-column: 2;
        background: var(--accent);
        color: white;
      }

      .bubble {
        max-width: 100%;
        min-width: 0;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        box-shadow: 0 12px 28px rgba(28, 39, 52, 0.06);
      }

      .user .bubble {
        grid-column: 1;
        justify-self: end;
        border-color: var(--accent);
        background: var(--accent);
        color: #fff;
        box-shadow: none;
      }

      .bubble-content {
        padding: 14px 16px;
        line-height: 1.7;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .bubble-content.markdown-rendered {
        white-space: normal;
      }

      .bubble-content.markdown-rendered > *:first-child {
        margin-top: 0;
      }

      .bubble-content.markdown-rendered > *:last-child {
        margin-bottom: 0;
      }

      .bubble-content.markdown-rendered p,
      .bubble-content.markdown-rendered ul,
      .bubble-content.markdown-rendered ol,
      .bubble-content.markdown-rendered pre {
        margin: 0 0 10px;
      }

      .bubble-content.markdown-rendered ul,
      .bubble-content.markdown-rendered ol {
        padding-left: 22px;
      }

      .bubble-content.markdown-rendered li {
        margin: 3px 0;
      }

      .bubble-content.markdown-rendered h3 {
        margin: 12px 0 8px;
        font-size: 15px;
        line-height: 1.45;
      }

      .bubble-content.markdown-rendered code {
        border: 1px solid var(--line-soft);
        border-radius: 6px;
        background: var(--panel-soft);
        padding: 1px 5px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
          monospace;
        font-size: 0.92em;
      }

      .bubble-content.markdown-rendered pre {
        overflow: auto;
        border: 1px solid var(--line-soft);
        border-radius: 8px;
        background: #101827;
        color: #f8fafc;
        padding: 10px 12px;
      }

      .bubble-content.markdown-rendered pre code {
        border: 0;
        background: transparent;
        color: inherit;
        padding: 0;
      }

      .bubble-content.markdown-rendered a {
        color: var(--accent-strong);
        font-weight: 650;
      }

      .message-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 0 16px 12px;
        color: var(--muted);
        font-size: 12px;
      }

      .thinking {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--muted);
      }

      .thinking::before {
        content: "";
        width: 7px;
        height: 7px;
        border-radius: 99px;
        background: var(--accent);
        animation: pulse 1s ease-in-out infinite;
      }

      .citation-list,
      .attachment-list {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0 16px 16px;
      }

      .feedback-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 0 16px 16px;
      }

      .feedback-button {
        min-height: 30px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        color: var(--muted);
        padding: 5px 10px;
        font-size: 12px;
        font-weight: 700;
      }

      .feedback-button:hover {
        border-color: #8fbcb2;
        color: var(--accent-strong);
      }

      .feedback-button:disabled {
        cursor: default;
        opacity: 0.65;
      }

      .feedback-status {
        color: var(--muted);
        font-size: 12px;
      }

      .citation,
      .attachment {
        display: grid;
        gap: 5px;
        border: 1px solid var(--line-soft);
        border-radius: 8px;
        background: var(--panel-soft);
        padding: 10px 12px;
      }

      .citation-title,
      .attachment-title {
        color: var(--text);
        font-size: 13px;
        font-weight: 650;
      }

      .citation-meta {
        overflow-wrap: anywhere;
        color: var(--muted);
        font-size: 12px;
      }

      .citation-excerpt {
        color: #354154;
        font-size: 13px;
        line-height: 1.55;
      }

      .attachment video,
      .attachment img {
        width: 100%;
        max-height: 420px;
        border: 1px solid var(--line);
        border-radius: 8px;
      }

      .attachment video {
        background: #111827;
      }

      .attachment img {
        display: block;
        height: auto;
        background: #ffffff;
        object-fit: contain;
      }

      .composer-wrap {
        padding: 18px 28px 24px;
        border-top: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.78);
      }

      .composer {
        display: grid;
        grid-template-columns: 1fr 44px;
        gap: 10px;
        align-items: end;
        max-width: 920px;
        margin: 0 auto;
      }

      textarea {
        width: 100%;
        min-height: 52px;
        max-height: 180px;
        resize: vertical;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        background: var(--panel);
        color: var(--text);
        padding: 13px 14px;
        line-height: 1.5;
        outline: none;
      }

      textarea:focus {
        border-color: #78aaa0;
        box-shadow: 0 0 0 3px rgba(23, 107, 91, 0.12);
      }

      .send-button,
      .clear-button {
        display: inline-grid;
        place-items: center;
        border: 0;
        border-radius: 8px;
        font-weight: 700;
      }

      .send-button {
        width: 44px;
        height: 52px;
        background: var(--accent);
        color: #fff;
      }

      .clear-button {
        min-height: 28px;
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--muted);
        padding: 0 10px;
        font-size: 12px;
      }

      .send-button:disabled,
      .quick-prompt:disabled {
        cursor: progress;
        opacity: 0.65;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
      }

      .is-error .bubble {
        border-color: #e0b1b1;
        background: #fff8f8;
      }

      .is-error .avatar {
        background: #f8dddd;
        color: var(--danger);
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 0.35;
          transform: scale(0.8);
        }

        50% {
          opacity: 1;
          transform: scale(1);
        }
      }

      @media (max-width: 860px) {
        body {
          overflow-x: hidden;
          overflow-y: auto;
        }

        .app-shell {
          grid-template-columns: 1fr;
          width: 100%;
          height: auto;
          min-height: 100vh;
        }

        .sidebar {
          grid-template-rows: auto;
          gap: 18px;
          border-right: 0;
          border-bottom: 1px solid var(--line);
          padding: 18px;
        }

        .sidebar-section.secondary {
          display: none;
        }

        .chat-workbench {
          width: 100vw;
          max-width: 100vw;
          overflow: hidden;
          min-height: 72vh;
        }

        .chat-header,
        .messages,
        .composer-wrap {
          width: 100vw;
          max-width: 100vw;
          padding-left: 18px;
          padding-right: 18px;
        }

        .chat-header {
          align-items: flex-start;
          flex-direction: column;
        }

        .status-group {
          justify-content: flex-start;
        }

        .message,
        .message.user {
          grid-template-columns: 1fr;
          width: min(100%, calc(100vw - 36px));
          max-width: calc(100vw - 36px);
        }

        .avatar,
        .user .avatar {
          display: none;
        }

        .bubble,
        .user .bubble {
          grid-column: 1;
          justify-self: stretch;
          width: calc(100vw - 36px);
          max-width: calc(100vw - 36px);
        }
      }

      @media (max-width: 560px) {
        .messages {
          gap: 14px;
          padding-top: 18px;
          padding-bottom: 18px;
        }

        .composer {
          grid-template-columns: 1fr;
        }

        .send-button {
          width: 100%;
          height: 44px;
        }
      }
    </style>
  </head>
  <body>
    <main class="app-shell">
      <aside class="sidebar" aria-label="workspace">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">XY</div>
          <div>
            <div class="brand-name">XXYY Ask</div>
            <div class="brand-subtitle">产品客服 Agent</div>
          </div>
        </div>

        <section class="sidebar-section" aria-label="quick questions">
          <div class="section-label">快捷问题</div>
          <button class="quick-prompt" type="button" data-prompt="XXYY 有 APP 吗？">
            XXYY 有 APP 吗？<span>→</span>
          </button>
          <button class="quick-prompt" type="button" data-prompt="XXYY Pro 有哪些权益？">
            XXYY Pro 有哪些权益？<span>→</span>
          </button>
          <button class="quick-prompt" type="button" data-prompt="XXYY 支持跟单么？">
            XXYY 支持跟单么？<span>→</span>
          </button>
          <button class="quick-prompt" type="button" data-prompt="如何设置 Telegram 钱包监控？">
            如何设置钱包监控？<span>→</span>
          </button>
          <button class="quick-prompt" type="button" data-prompt="XXYY 怎么设置挂单交易？">
            怎么设置挂单交易？<span>→</span>
          </button>
        </section>

        <section class="sidebar-section secondary" aria-label="scope">
          <div class="section-label">回答边界</div>
          <ul class="scope-list">
            <li><span class="dot"></span>产品功能与配置</li>
            <li><span class="dot"></span>Pro 权益与更新日志</li>
            <li><span class="dot warn"></span>不查询账户或交易记录</li>
            <li><span class="dot warn"></span>不提供投资建议</li>
          </ul>
        </section>
      </aside>

      <section class="chat-workbench" aria-label="chat">
        <header class="chat-header">
          <div>
            <h1>产品问答</h1>
            <div class="header-subtitle">基于 XXYY 文档和更新日志回答</div>
          </div>
          <div class="status-group">
            <button id="clear" class="clear-button" type="button">New chat</button>
            <div id="intent" class="status-pill">intent pending</div>
            <div id="status" class="status-pill strong" role="status" aria-live="polite">Ready</div>
          </div>
        </header>

        <div id="messages" class="messages" aria-live="polite">
          <article class="message assistant" data-welcome-message>
            <div class="avatar" aria-hidden="true">AI</div>
            <div class="bubble">
              <div class="bubble-content">你好，我可以回答 XXYY 产品功能、Pro 权益、交易设置、钱包监控和更新日志相关问题。</div>
              <div class="message-meta">
                <span>客服模式</span>
                <span>RAG 检索</span>
                <span>流式输出</span>
              </div>
            </div>
          </article>
        </div>

        <form id="chat-form" class="composer-wrap">
          <div class="composer">
            <label class="sr-only" for="message">Message</label>
            <textarea id="message" name="message" placeholder="例如：XXYY Pro 有哪些权益？" required></textarea>
            <button id="send" class="send-button" type="submit" aria-label="发送">↑</button>
          </div>
        </form>
      </section>
    </main>
    <script>
      const form = document.querySelector("#chat-form");
      const message = document.querySelector("#message");
      const messages = document.querySelector("#messages");
      const status = document.querySelector("#status");
      const intent = document.querySelector("#intent");
      const send = document.querySelector("#send");
      const clear = document.querySelector("#clear");
      const quickPrompts = Array.from(document.querySelectorAll(".quick-prompt"));
      let sessionId = getSessionId();

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        await submitPrompt(message.value);
      });

      message.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          form.requestSubmit();
        }
      });

      clear.addEventListener("click", () => {
        sessionId = resetSessionId();
        messages.replaceChildren();
        intent.textContent = "intent pending";
        status.textContent = "Ready";
        message.value = "";
        message.focus();
      });

      for (const prompt of quickPrompts) {
        prompt.addEventListener("click", async () => {
          await submitPrompt(prompt.dataset.prompt || prompt.textContent || "");
        });
      }

      async function submitPrompt(rawText) {
        const text = rawText.trim();
        if (!text || send.disabled) return;

        removeWelcomeMessage();
        appendMessage("user", { text });
        const assistantMessage = appendMessage("assistant", {
          question: text,
          streaming: true,
          text: "",
        });

        message.value = "";
        setBusy(true);
        status.textContent = "Sending";
        intent.textContent = "retrieving";

        try {
          const response = await fetch("/api/chat/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, channel: "web", sessionId }),
          });
          if (!response.ok) {
            const payload = await response.json();
            throw new Error(payload.message || "Request failed.");
          }
          if (!response.body) {
            throw new Error("Streaming response is unavailable.");
          }

          await readChatStream(response.body, assistantMessage);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          assistantMessage.node.classList.add("is-error");
          assistantMessage.rawAnswer = errorMessage;
          assistantMessage.answer.textContent = errorMessage;
          status.textContent = "Error";
        } finally {
          assistantMessage.node.classList.remove("is-streaming");
          setBusy(false);
        }
      }

      async function readChatStream(body, assistantMessage) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const result = await reader.read();
          if (result.done) break;

          buffer += decoder.decode(result.value, { stream: true });
          const blocks = buffer.split("\\n\\n");
          buffer = blocks.pop() || "";
          for (const block of blocks) {
            handleSseBlock(block, assistantMessage);
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
          handleSseBlock(buffer, assistantMessage);
        }
      }

      function handleSseBlock(block, assistantMessage) {
        const lines = block.split(/\\r?\\n/);
        let eventName = "message";
        const data = [];

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
          }
          if (line.startsWith("data:")) {
            data.push(line.slice("data:".length).trim());
          }
        }

        if (!data.length) return;

        const payload = JSON.parse(data.join("\\n"));
        if (eventName === "answer_delta") {
          if (!assistantMessage.hasContent) {
            assistantMessage.answer.textContent = "";
            assistantMessage.hasContent = true;
          }
          assistantMessage.rawAnswer += payload.delta || "";
          assistantMessage.answer.textContent = assistantMessage.rawAnswer;
          status.textContent = "Receiving";
          scrollMessagesToBottom();
          return;
        }

        if (eventName === "metadata") {
          renderMarkdown(assistantMessage.answer, assistantMessage.rawAnswer);
          assistantMessage.meta.textContent =
            payload.intent + " · confidence " + Number(payload.confidence).toFixed(2);
          renderCitations(assistantMessage.citations, payload.citations || []);
          renderAttachments(assistantMessage.attachments, payload.attachments || []);
          assistantMessage.intentValue = payload.intent;
          assistantMessage.citationCount = (payload.citations || []).length;
          assistantMessage.feedback.hidden = false;
          status.textContent = payload.intent + " · " + Number(payload.confidence).toFixed(2);
          intent.textContent = payload.intent;
          scrollMessagesToBottom();
          return;
        }

        if (eventName === "error") {
          throw new Error(payload.message || "Request failed.");
        }
      }

      function appendMessage(role, options) {
        const node = document.createElement("article");
        node.className = "message " + role + (options.streaming ? " is-streaming" : "");

        const avatar = document.createElement("div");
        avatar.className = "avatar";
        avatar.setAttribute("aria-hidden", "true");
        avatar.textContent = role === "user" ? "You" : "AI";

        const bubble = document.createElement("div");
        bubble.className = "bubble";

        const answer = document.createElement("div");
        answer.className = "bubble-content";
        if (options.streaming) {
          const thinking = document.createElement("span");
          thinking.className = "thinking";
          thinking.textContent = "Thinking";
          answer.append(thinking);
        } else {
          answer.textContent = options.text;
        }

        const meta = document.createElement("div");
        meta.className = "message-meta";
        meta.textContent = role === "assistant" ? "waiting for citations" : "web";

        const citations = document.createElement("div");
        citations.className = "citation-list";

        const attachments = document.createElement("div");
        attachments.className = "attachment-list";

        const feedback = document.createElement("div");
        feedback.className = "feedback-actions";
        feedback.hidden = true;

        const feedbackStatus = document.createElement("span");
        feedbackStatus.className = "feedback-status";

        bubble.append(answer);
        const messageRecord = {
          answer,
          attachments,
          citationCount: 0,
          citations,
          feedback,
          feedbackStatus,
          hasContent: !options.streaming,
          intentValue: "unknown",
          meta,
          node,
          question: options.question || options.text || "",
          rawAnswer: options.text || "",
        };
        if (role === "assistant") {
          setupFeedbackActions(messageRecord);
          bubble.append(meta, citations, attachments, feedback);
        }
        node.append(avatar, bubble);
        messages.append(node);
        scrollMessagesToBottom();

        return messageRecord;
      }

      function setupFeedbackActions(assistantMessage) {
        const positive = document.createElement("button");
        positive.className = "feedback-button";
        positive.type = "button";
        positive.textContent = "Good";
        positive.setAttribute("aria-label", "Mark answer as helpful");

        const negative = document.createElement("button");
        negative.className = "feedback-button";
        negative.type = "button";
        negative.textContent = "Improve";
        negative.setAttribute("aria-label", "Mark answer as needing improvement");

        positive.addEventListener("click", () => {
          void submitFeedback(assistantMessage, "positive");
        });
        negative.addEventListener("click", () => {
          void submitFeedback(assistantMessage, "negative");
        });

        assistantMessage.feedback.append(positive, negative, assistantMessage.feedbackStatus);
      }

      async function submitFeedback(assistantMessage, rating) {
        if (assistantMessage.feedbackSent) return;

        const buttons = Array.from(assistantMessage.feedback.querySelectorAll("button"));
        for (const button of buttons) {
          button.disabled = true;
        }
        assistantMessage.feedbackStatus.textContent = "Sending";

        try {
          const response = await fetch("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              answer: assistantMessage.rawAnswer || assistantMessage.answer.textContent || "",
              channel: "web",
              citationCount: assistantMessage.citationCount,
              intent: assistantMessage.intentValue,
              question: assistantMessage.question,
              rating,
              sessionId,
            }),
          });
          if (!response.ok) {
            const payload = await response.json();
            throw new Error(payload.message || "Feedback failed.");
          }
          assistantMessage.feedbackSent = true;
          assistantMessage.feedbackStatus.textContent = "Saved";
        } catch (error) {
          assistantMessage.feedbackStatus.textContent =
            error instanceof Error ? error.message : "Feedback failed.";
          for (const button of buttons) {
            button.disabled = false;
          }
        }
      }

      function renderMarkdown(target, markdown) {
        target.classList.add("markdown-rendered");
        const blocks = [];
        const lines = markdown.replace(/\\r\\n?/g, "\\n").split("\\n");
        let paragraphLines = [];
        let list = null;
        let codeLines = [];
        let inCodeBlock = false;

        function flushParagraph() {
          if (paragraphLines.length === 0) return;
          const paragraph = document.createElement("p");
          appendInlineMarkdown(paragraph, paragraphLines.join(" "));
          blocks.push(paragraph);
          paragraphLines = [];
        }

        function flushList() {
          if (list === null) return;
          blocks.push(list);
          list = null;
        }

        function flushCodeBlock() {
          const pre = document.createElement("pre");
          const code = document.createElement("code");
          code.textContent = codeLines.join("\\n");
          pre.append(code);
          blocks.push(pre);
          codeLines = [];
        }

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("\`\`\`")) {
            if (inCodeBlock) {
              flushCodeBlock();
              inCodeBlock = false;
              continue;
            }
            flushParagraph();
            flushList();
            codeLines = [];
            inCodeBlock = true;
            continue;
          }

          if (inCodeBlock) {
            codeLines.push(line);
            continue;
          }

          if (trimmed.length === 0) {
            flushParagraph();
            flushList();
            continue;
          }

          const headingMatch = /^(#{1,4})\\s+(.+)$/u.exec(trimmed);
          if (headingMatch !== null) {
            flushParagraph();
            flushList();
            const heading = document.createElement("h3");
            appendInlineMarkdown(heading, headingMatch[2]);
            blocks.push(heading);
            continue;
          }

          const unorderedMatch = /^[-*]\\s+(.+)$/u.exec(trimmed);
          const orderedMatch = /^\\d+[.)]\\s+(.+)$/u.exec(trimmed);
          if (unorderedMatch !== null || orderedMatch !== null) {
            flushParagraph();
            const listType = unorderedMatch !== null ? "ul" : "ol";
            if (list === null || list.tagName.toLowerCase() !== listType) {
              flushList();
              list = document.createElement(listType);
            }
            const item = document.createElement("li");
            appendInlineMarkdown(item, unorderedMatch?.[1] || orderedMatch?.[1] || "");
            list.append(item);
            continue;
          }

          flushList();
          paragraphLines.push(trimmed);
        }

        if (inCodeBlock) {
          flushCodeBlock();
        }
        flushParagraph();
        flushList();

        if (blocks.length === 0) {
          target.textContent = markdown;
          return;
        }
        target.replaceChildren(...blocks);
      }

      function appendInlineMarkdown(parent, text) {
        const tokenPattern = /(\\*\\*([^*]+)\\*\\*|\\x60([^\\x60]+)\\x60|\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\))/gu;
        let cursor = 0;
        for (const match of text.matchAll(tokenPattern)) {
          if (match.index > cursor) {
            parent.append(document.createTextNode(text.slice(cursor, match.index)));
          }

          if (match[2] !== undefined) {
            const strong = document.createElement("strong");
            strong.textContent = match[2];
            parent.append(strong);
          } else if (match[3] !== undefined) {
            const code = document.createElement("code");
            code.textContent = match[3];
            parent.append(code);
          } else if (match[4] !== undefined && match[5] !== undefined) {
            const link = document.createElement("a");
            link.href = match[5];
            link.target = "_blank";
            link.rel = "noreferrer";
            link.textContent = match[4];
            parent.append(link);
          }

          cursor = match.index + match[0].length;
        }

        if (cursor < text.length) {
          parent.append(document.createTextNode(text.slice(cursor)));
        }
      }

      function renderCitations(target, nextCitations) {
        target.replaceChildren(
          ...nextCitations.map((citation, index) => {
            const article = document.createElement("article");
            article.className = "citation";

            const title = document.createElement("div");
            title.className = "citation-title";
            title.textContent = "[" + (index + 1) + "] " + citation.title;

            const meta = document.createElement("div");
            meta.className = "citation-meta";
            if (citation.sourceUrl) {
              const link = document.createElement("a");
              link.href = citation.sourceUrl;
              link.target = "_blank";
              link.rel = "noreferrer";
              link.textContent = citation.file;
              meta.append(link);
            } else {
              meta.textContent = citation.file;
            }

            const excerpt = document.createElement("div");
            excerpt.className = "citation-excerpt";
            excerpt.textContent = citation.excerpt;

            article.append(title, meta, excerpt);
            return article;
          }),
        );
      }

      function renderAttachments(target, nextAttachments) {
        target.replaceChildren(
          ...nextAttachments.map((attachment) => {
            const article = document.createElement("article");
            article.className = "attachment";

            const title = document.createElement("div");
            title.className = "attachment-title";
            title.textContent = attachment.title;

            if (attachment.kind === "video") {
              const video = document.createElement("video");
              video.controls = true;
              video.preload = "metadata";
              video.src = attachment.url;
              video.setAttribute("aria-label", attachment.title);
              article.append(title, video);
              return article;
            }

            if (attachment.kind === "image") {
              const image = document.createElement("img");
              image.src = attachment.url;
              image.alt = attachment.title;
              image.loading = "lazy";
              image.decoding = "async";
              article.append(title, image);
              return article;
            }

            article.append(title);
            return article;
          }),
        );
      }

      function removeWelcomeMessage() {
        const welcome = document.querySelector("[data-welcome-message]");
        if (welcome) {
          welcome.remove();
        }
      }

      function setBusy(isBusy) {
        send.disabled = isBusy;
        for (const prompt of quickPrompts) {
          prompt.disabled = isBusy;
        }
      }

      function scrollMessagesToBottom() {
        messages.scrollTop = messages.scrollHeight;
      }

      function getSessionId() {
        const key = "xxyy.ask.sessionId";
        try {
          const existing = window.localStorage.getItem(key);
          if (existing) return existing;
          const next = createSessionId();
          window.localStorage.setItem(key, next);
          return next;
        } catch (_error) {
          return createSessionId();
        }
      }

      function resetSessionId() {
        const key = "xxyy.ask.sessionId";
        const next = createSessionId();
        try {
          window.localStorage.setItem(key, next);
        } catch (_error) {
          // A fresh in-memory id still prevents stale follow-up context in this tab.
        }
        return next;
      }

      function createSessionId() {
        return window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : "session-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      }
    </script>
  </body>
</html>`;
}

export function renderOpsPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>XXYY Ops</title>
    <style>
      :root {
        color-scheme: light;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          sans-serif;
        background: #f3f6f8;
        color: #17202e;
        --bg: #f3f6f8;
        --panel: #ffffff;
        --panel-soft: #f8fafb;
        --line: #dbe3ec;
        --text: #17202e;
        --muted: #647083;
        --accent: #176b5b;
        --accent-strong: #105247;
        --accent-soft: #e4f3ee;
        --danger: #a73939;
        --warn: #a15c09;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
      }

      button,
      input,
      select,
      textarea {
        font: inherit;
      }

      .ops-shell {
        display: grid;
        gap: 18px;
        width: min(1180px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 24px 0 36px;
      }

      .ops-header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        border-bottom: 1px solid var(--line);
        padding-bottom: 18px;
      }

      h1 {
        margin: 0;
        font-size: 22px;
        letter-spacing: 0;
      }

      .subtitle {
        margin-top: 4px;
        color: var(--muted);
        font-size: 13px;
      }

      .token-form {
        display: grid;
        grid-template-columns: minmax(220px, 360px) auto;
        gap: 10px;
        align-items: center;
      }

      input,
      select,
      textarea {
        min-height: 40px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        background: var(--panel);
        color: var(--text);
        padding: 8px 10px;
      }

      textarea {
        resize: vertical;
      }

      label {
        display: grid;
        gap: 5px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      button {
        min-height: 40px;
        border: 0;
        border-radius: 8px;
        background: var(--accent);
        color: #fff;
        font-weight: 750;
        padding: 8px 14px;
      }

      button:disabled {
        cursor: progress;
        opacity: 0.7;
      }

      .status-line {
        min-height: 22px;
        color: var(--muted);
        font-size: 13px;
      }

      .summary-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }

      .metric,
      .panel {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }

      .metric {
        display: grid;
        gap: 6px;
        padding: 14px;
      }

      .metric-label {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }

      .metric-value {
        font-size: 24px;
        font-weight: 800;
      }

      .metric.ok .metric-value {
        color: var(--accent-strong);
      }

      .metric.warn .metric-value {
        color: var(--warn);
      }

      .metric.error .metric-value {
        color: var(--danger);
      }

      .panel-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }

      .panel {
        min-width: 0;
        overflow: hidden;
      }

      .panel.wide-panel {
        grid-column: 1 / -1;
      }

      .panel h2 {
        margin: 0;
        border-bottom: 1px solid var(--line);
        padding: 13px 14px;
        font-size: 15px;
      }

      .panel-body {
        display: grid;
        gap: 10px;
        padding: 14px;
      }

      .tx-report-form {
        display: grid;
        grid-template-columns: minmax(220px, 2fr) repeat(6, minmax(110px, 1fr)) auto;
        gap: 10px;
        align-items: end;
      }

      .tx-report-form button {
        white-space: nowrap;
      }

      .tx-report-bulk-review {
        display: grid;
        grid-template-columns: minmax(130px, 0.7fr) minmax(220px, 1.4fr) auto auto auto minmax(130px, 0.8fr);
        gap: 8px;
        align-items: end;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel-soft);
        padding: 10px;
      }

      .tx-report-bulk-review input {
        min-height: 34px;
        padding: 6px 8px;
      }

      .tx-report-bulk-review button {
        min-height: 34px;
        padding: 6px 10px;
        white-space: nowrap;
      }

      .tx-report-bulk-status {
        min-height: 18px;
        align-self: center;
        color: var(--muted);
        font-size: 12px;
      }

      .report-review-form {
        display: grid;
        flex-basis: 100%;
        grid-template-columns: minmax(110px, 0.7fr) minmax(130px, 0.8fr) minmax(180px, 1.4fr) auto auto auto auto;
        gap: 8px;
        align-items: end;
        width: 100%;
        margin-top: 4px;
      }

      .report-review-form input,
      .report-review-form select {
        min-height: 34px;
        padding: 6px 8px;
      }

      .report-review-form button {
        min-height: 34px;
        padding: 6px 10px;
        white-space: nowrap;
      }

      .report-review-status {
        grid-column: 1 / -1;
        min-height: 18px;
        align-self: center;
        color: var(--muted);
        font-size: 12px;
      }

      .knowledge-candidate-form {
        display: grid;
        grid-template-columns: minmax(150px, 1fr) minmax(140px, 0.8fr) minmax(130px, 0.8fr) minmax(100px, 140px) auto;
        gap: 10px;
        align-items: end;
      }

      .knowledge-candidate-form button {
        white-space: nowrap;
      }

      .knowledge-candidate-section {
        display: grid;
        gap: 8px;
      }

      .knowledge-candidate-section h3 {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0;
      }

      .tx-report-results {
        display: grid;
        gap: 10px;
      }

      .check,
      .feedback-item,
      .knowledge-candidate-item,
      .tx-analysis-item,
      .source-row {
        display: grid;
        gap: 4px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel-soft);
        padding: 10px;
      }

      .row-title {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
        font-size: 13px;
        font-weight: 750;
      }

      .row-title span {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .row-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }

      .row-meta a {
        color: var(--accent-strong);
        font-weight: 700;
      }

      .tx-report-select {
        display: inline-flex;
        gap: 5px;
        align-items: center;
        color: var(--text);
        font-weight: 700;
      }

      .tx-report-select input {
        min-height: 0;
        width: 16px;
        height: 16px;
        padding: 0;
      }

      .empty {
        color: var(--muted);
        font-size: 13px;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
      }

      @media (max-width: 860px) {
         .token-form,
         .knowledge-candidate-form,
         .tx-report-form,
         .tx-report-bulk-review,
         .report-review-form,
         .summary-grid,
         .panel-grid {
           grid-template-columns: 1fr;
        }

        .ops-header {
          align-items: stretch;
        }
      }
    </style>
  </head>
  <body>
    <main class="ops-shell">
      <header class="ops-header">
        <div>
          <h1>XXYY Ops</h1>
          <div class="subtitle">RAG production health, knowledge, and feedback summary</div>
        </div>
        <form id="token-form" class="token-form">
          <label class="sr-only" for="ops-token">Ops token</label>
          <input id="ops-token" name="ops-token" type="password" autocomplete="current-password" placeholder="Ops token" />
          <button id="refresh" type="submit">Refresh</button>
        </form>
      </header>

      <div id="status" class="status-line" role="status" aria-live="polite">Enter token to load summary.</div>
      <section id="summary" class="summary-grid" aria-label="summary"></section>
      <section class="panel-grid">
        <article class="panel">
          <h2>Health</h2>
          <div id="health" class="panel-body"></div>
        </article>
        <article class="panel">
          <h2>Knowledge</h2>
          <div id="knowledge" class="panel-body"></div>
        </article>
        <article class="panel">
          <h2>Feedback</h2>
          <div id="feedback" class="panel-body"></div>
        </article>
        <article class="panel wide-panel">
          <h2>Knowledge Candidates</h2>
          <div class="panel-body">
            <form id="knowledge-candidate-form" class="knowledge-candidate-form">
              <label for="knowledge-candidate-status-filter">
                Status
                <select id="knowledge-candidate-status-filter" name="status">
                  <option value="needs_review">Needs review</option>
                  <option value="approved">Approved</option>
                  <option value="eval_failed">Eval failed</option>
                </select>
              </label>
              <label for="knowledge-candidate-type">
                Type
                <select id="knowledge-candidate-type" name="type">
                  <option value="">Any type</option>
                  <option value="faq">FAQ</option>
                  <option value="doc_patch">Doc patch</option>
                  <option value="boundary_example">Boundary examples</option>
                  <option value="eval_case">Eval cases</option>
                </select>
              </label>
              <label for="knowledge-candidate-source">
                Source
                <select id="knowledge-candidate-source" name="source">
                  <option value="">Any source</option>
                  <option value="answer_feedback">Answer feedback</option>
                  <option value="answer_quality_signal">Quality signals</option>
                  <option value="telegram">Telegram support</option>
                </select>
              </label>
              <label for="knowledge-candidate-limit">
                Limit
                <input id="knowledge-candidate-limit" name="limit" type="number" min="1" max="50" value="10" />
              </label>
              <button id="knowledge-candidate-submit" type="submit">Load</button>
            </form>
            <div class="knowledge-candidate-section">
              <h3>Recent Quality Gaps</h3>
              <div id="knowledge-quality-signals" class="tx-report-results"></div>
            </div>
            <div class="knowledge-candidate-section">
              <h3>Quality Gap Reasons</h3>
              <div id="knowledge-quality-reasons" class="tx-report-results"></div>
            </div>
            <div class="knowledge-candidate-section">
              <h3>Quality Gap Routes</h3>
              <div id="knowledge-quality-routes" class="tx-report-results"></div>
            </div>
            <div class="knowledge-candidate-section">
              <h3>Quality Gap Clusters</h3>
              <div id="knowledge-quality-clusters" class="tx-report-results"></div>
            </div>
            <div class="knowledge-candidate-section">
              <h3>Eval Failure Reasons</h3>
              <div id="knowledge-eval-failure-reasons" class="tx-report-results"></div>
            </div>
            <div class="knowledge-candidate-section">
              <h3>Recent Eval Failures</h3>
              <div id="knowledge-eval-failures" class="tx-report-results"></div>
            </div>
            <div id="knowledge-candidate-status" class="status-line" role="status" aria-live="polite">Enter token to load needs-review candidates.</div>
            <div id="knowledge-candidates" class="tx-report-results"></div>
          </div>
        </article>
        <article class="panel">
          <h2>Transaction Analysis</h2>
          <div id="tx-analysis" class="panel-body"></div>
        </article>
        <article class="panel wide-panel">
          <h2>Report Search</h2>
          <div class="panel-body">
            <form id="tx-report-form" class="tx-report-form">
              <label for="tx-report-hash">
                Tx hash
                <input id="tx-report-hash" name="txHash" autocomplete="off" placeholder="0x... or signature" />
              </label>
              <label for="tx-report-chain">
                Chain
                <input id="tx-report-chain" name="chain" autocomplete="off" list="tx-report-chain-options" placeholder="base, ETH, BNBChain" />
                <datalist id="tx-report-chain-options">
                  <option value="solana">
                  <option value="base">
                  <option value="ethereum">
                  <option value="bsc">
                  <option value="ETH">
                  <option value="BNBChain">
                  <option value="BNB Smart Chain">
                  <option value="BEP20">
                  <option value="unknown">
                </datalist>
              </label>
              <label for="tx-report-status">
                Status
                <select id="tx-report-status" name="status">
                  <option value="">Any</option>
                  <option value="success">Success</option>
                  <option value="failure">Failure</option>
                </select>
              </label>
              <label for="tx-report-review-status">
                Review
                <select id="tx-report-review-status" name="reviewStatus">
                  <option value="">Any</option>
                  <option value="open">Open</option>
                  <option value="in_review">In review</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
              <label for="tx-report-assignee">
                Assignee
                <input id="tx-report-assignee" name="assignee" autocomplete="off" placeholder="alice" />
              </label>
              <label for="tx-report-reason">
                Failure
                <select id="tx-report-reason" name="reason">
                  <option value="">Any</option>
                  <option value="browser_verification_required">browser_verification_required</option>
                  <option value="invalid_reference">invalid_reference</option>
                  <option value="not_configured">not_configured</option>
                  <option value="pool_not_found">pool_not_found</option>
                  <option value="provider_unavailable">provider_unavailable</option>
                  <option value="screenshot_unavailable">screenshot_unavailable</option>
                  <option value="target_trade_not_found">target_trade_not_found</option>
                  <option value="timeout">timeout</option>
                  <option value="tx_failed">tx_failed</option>
                  <option value="tx_pending">tx_pending</option>
                  <option value="tx_not_found">tx_not_found</option>
                  <option value="unsupported_chain">unsupported_chain</option>
                </select>
              </label>
              <label for="tx-report-limit">
                Limit
                <input id="tx-report-limit" name="limit" type="number" min="1" max="100" value="20" />
              </label>
              <button id="tx-report-submit" type="submit">Search</button>
            </form>
            <div id="tx-report-bulk-review" class="tx-report-bulk-review">
              <label for="tx-report-bulk-assignee">
                Assignee
                <input id="tx-report-bulk-assignee" autocomplete="off" placeholder="alice" />
              </label>
              <label for="tx-report-bulk-note">
                Note
                <input id="tx-report-bulk-note" autocomplete="off" placeholder="handled" />
              </label>
              <button type="button" data-action="claim">Claim</button>
              <button type="button" data-action="close">Close</button>
              <button type="button" data-action="reopen">Reopen</button>
              <div id="tx-report-bulk-status" class="tx-report-bulk-status" role="status" aria-live="polite">0 selected</div>
            </div>
            <div id="tx-report-status-line" class="status-line" role="status" aria-live="polite"></div>
            <div id="tx-report-results" class="tx-report-results"></div>
          </div>
        </article>
        <article class="panel">
          <h2>Latest Feedback</h2>
          <div id="latest-feedback" class="panel-body"></div>
        </article>
      </section>
    </main>

    <script>
      const form = document.querySelector("#token-form");
      const tokenInput = document.querySelector("#ops-token");
      const refresh = document.querySelector("#refresh");
      const status = document.querySelector("#status");
      const summaryTarget = document.querySelector("#summary");
      const healthTarget = document.querySelector("#health");
      const knowledgeTarget = document.querySelector("#knowledge");
      const feedbackTarget = document.querySelector("#feedback");
      const txAnalysisTarget = document.querySelector("#tx-analysis");
      const latestFeedbackTarget = document.querySelector("#latest-feedback");
      const queryKnowledgeCandidates = document.querySelector("#knowledge-candidate-form");
      const knowledgeCandidateStatusFilter = document.querySelector("#knowledge-candidate-status-filter");
      const knowledgeCandidateType = document.querySelector("#knowledge-candidate-type");
      const knowledgeCandidateSource = document.querySelector("#knowledge-candidate-source");
      const knowledgeCandidateLimit = document.querySelector("#knowledge-candidate-limit");
      const knowledgeCandidateSubmit = document.querySelector("#knowledge-candidate-submit");
      const knowledgeCandidateStatus = document.querySelector("#knowledge-candidate-status");
      const knowledgeCandidatesTarget = document.querySelector("#knowledge-candidates");
      const knowledgeEvalFailuresTarget = document.querySelector("#knowledge-eval-failures");
      const knowledgeEvalFailureReasonsTarget = document.querySelector("#knowledge-eval-failure-reasons");
      const knowledgeQualitySignalsTarget = document.querySelector("#knowledge-quality-signals");
      const knowledgeQualityReasonsTarget = document.querySelector("#knowledge-quality-reasons");
      const knowledgeQualityRoutesTarget = document.querySelector("#knowledge-quality-routes");
      const knowledgeQualityClustersTarget = document.querySelector("#knowledge-quality-clusters");
      const queryTxReports = document.querySelector("#tx-report-form");
      const txReportHash = document.querySelector("#tx-report-hash");
      const txReportChain = document.querySelector("#tx-report-chain");
      const txReportStatus = document.querySelector("#tx-report-status");
      const txReportReviewStatus = document.querySelector("#tx-report-review-status");
      const txReportAssignee = document.querySelector("#tx-report-assignee");
      const txReportReason = document.querySelector("#tx-report-reason");
      const txReportLimit = document.querySelector("#tx-report-limit");
      const txReportSubmit = document.querySelector("#tx-report-submit");
      const txReportSearchStatus = document.querySelector("#tx-report-status-line");
      const txReportResultsTarget = document.querySelector("#tx-report-results");
      const txReportBulkReview = document.querySelector("#tx-report-bulk-review");
      const txReportBulkAssignee = document.querySelector("#tx-report-bulk-assignee");
      const txReportBulkNote = document.querySelector("#tx-report-bulk-note");
      const txReportBulkStatus = document.querySelector("#tx-report-bulk-status");
      const txReportBulkButtons = Array.from(document.querySelectorAll("#tx-report-bulk-review button[data-action]"));
      let currentKnowledgeCandidates = [];
      let currentTxReports = [];

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        await loadSummary();
      });

      queryTxReports.addEventListener("submit", async (event) => {
        event.preventDefault();
        await loadTxReports();
      });

      queryKnowledgeCandidates.addEventListener("submit", async (event) => {
        event.preventDefault();
        await loadKnowledgeCandidates();
      });

      knowledgeQualityClustersTarget.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement)) {
          return;
        }
        const clusterKey = target.dataset.qualityClusterKey;
        if (!clusterKey) {
          return;
        }
        await loadQualitySignalClusterCandidates(clusterKey);
      });

      knowledgeCandidateSource.addEventListener("change", () => {
        if (tokenInput.value.trim()) {
          void loadKnowledgeCandidates();
        }
      });

      knowledgeCandidateStatusFilter.addEventListener("change", () => {
        if (tokenInput.value.trim()) {
          void loadKnowledgeCandidates();
        }
      });

      knowledgeCandidateType.addEventListener("change", () => {
        if (tokenInput.value.trim()) {
          void loadKnowledgeCandidates();
        }
      });

      txReportBulkReview.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLButtonElement)) {
          return;
        }
        const action = target.dataset.action;
        if (!action) {
          return;
        }
        await updateBulkReportReview(action);
      });

      async function loadSummary() {
        const token = tokenInput.value.trim();
        if (!token) {
          status.textContent = "Ops token is required.";
          tokenInput.focus();
          return;
        }

        refresh.disabled = true;
        status.textContent = "Loading";

        try {
          const response = await fetch("/api/ops/summary", {
            headers: { Authorization: "Bearer " + token },
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.message || "Unable to load ops summary.");
          }

          const summary = payload;
          renderSummary(summary);
          renderHealth(summary.health);
          renderKnowledge(summary.knowledge);
          renderFeedback(summary.feedback);
          renderEvalFailures(summary.knowledgeCandidateQueues?.recentEvalFailures || []);
          renderEvalFailureReasons(summary.knowledgeCandidateQueues?.evalFailureReasonCounts || {});
          renderQualitySignals(summary.knowledgeCandidateQueues?.recentQualitySignals || []);
          renderQualitySignalReasons(summary.knowledgeCandidateQueues?.qualitySignalReasonCounts || {});
          renderQualitySignalRoutes(summary.knowledgeCandidateQueues?.qualitySignalAgentRouteCounts || {});
          renderQualitySignalClusters(summary.knowledgeCandidateQueues?.qualitySignalClusters || []);
          renderTxAnalysis(summary.txAnalysis, summary.txAnalysisRuntime);
          void loadKnowledgeCandidates();
          status.textContent = "Updated " + summary.generatedAt;
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          refresh.disabled = false;
        }
      }

      function renderSummary(summary) {
        summaryTarget.replaceChildren(
          metric("Health", summary.health.status, summary.health.status),
          metric("Documents", summary.knowledge.documentCount, "ok"),
          metric("Chunks", summary.knowledge.chunkCount, "ok"),
          metric("Negative", summary.feedback.negativeCount, summary.feedback.negativeCount > 0 ? "warn" : "ok"),
          metric("Candidates", summary.knowledgeCandidateQueues?.needsReviewCount || 0, (summary.knowledgeCandidateQueues?.needsReviewCount || 0) > 0 ? "warn" : "ok"),
          metric("Quality Gaps", summary.knowledgeCandidateQueues?.qualitySignalNeedsReviewCount || 0, (summary.knowledgeCandidateQueues?.qualitySignalNeedsReviewCount || 0) > 0 ? "warn" : "ok"),
          metric("Oldest Gap", summary.knowledgeCandidateQueues?.oldestQualitySignalCreatedAt || "-", summary.knowledgeCandidateQueues?.oldestQualitySignalCreatedAt ? "warn" : "ok"),
          metric("Eval Ready", summary.knowledgeCandidateQueues?.approvedEvalCaseCount || 0, (summary.knowledgeCandidateQueues?.approvedEvalCaseCount || 0) > 0 ? "warn" : "ok"),
          metric("Eval Failed", summary.knowledgeCandidateQueues?.evalFailedCount || 0, (summary.knowledgeCandidateQueues?.evalFailedCount || 0) > 0 ? "error" : "ok"),
          metric("Tx Failures", summary.txAnalysis?.failureCount || 0, (summary.txAnalysis?.failureCount || 0) > 0 ? "warn" : "ok"),
        );
      }

      function renderHealth(summary) {
        const checks = summary.checks || {};
        healthTarget.replaceChildren(
          ...Object.keys(checks).map((name) => {
            const check = checks[name];
            return row("check " + check.status, name, check.status, check.message || check.model || "");
          }),
        );
      }

      function renderKnowledge(summary) {
        const sourceRows = (summary.sourceStats || []).map((source) =>
          row("source-row", source.sourceType, source.chunkCount + " chunks", source.documentCount + " documents"),
        );
        knowledgeTarget.replaceChildren(
          row("source-row", "Source URLs", String(summary.sourceUrlCount), ""),
          row("source-row", "Latest chunk update", summary.latestChunkUpdatedAt || "none", ""),
          ...sourceRows,
        );
      }

      function renderFeedback(summary) {
        feedbackTarget.replaceChildren(
          row("feedback-item", "Total", String(summary.totalCount), ""),
          row("feedback-item", "Positive", String(summary.positiveCount), ""),
          row("feedback-item", "Negative", String(summary.negativeCount), ""),
        );

        const latest = summary.latest || [];
        if (latest.length === 0) {
          latestFeedbackTarget.replaceChildren(empty("No feedback yet."));
          return;
        }

        latestFeedbackTarget.replaceChildren(
          ...latest.map((item) =>
            row(
              "feedback-item",
              item.rating + " · " + item.intent,
              item.question,
              item.comment || item.answer || item.createdAt,
            ),
          ),
        );
      }

      function renderEvalFailures(recentFailures) {
        if (recentFailures.length === 0) {
          knowledgeEvalFailuresTarget.replaceChildren(empty("No recent eval failures."));
          return;
        }

        knowledgeEvalFailuresTarget.replaceChildren(
          ...recentFailures.map((recent) =>
            row(
              "knowledge-candidate-item",
              "Eval failed · " + recent.candidateId,
              recent.question,
              [
                ...(recent.failureReasons || []),
                recent.evaluatedAt ? "Evaluated " + recent.evaluatedAt : "",
                recent.runId ? "Run " + recent.runId : "",
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          ),
        );
      }

      function renderEvalFailureReasons(reasonCounts) {
        const rows = Object.entries(reasonCounts)
          .filter((entry) => Number(entry[1]) > 0)
          .sort((left, right) => Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0]));
        if (rows.length === 0) {
          knowledgeEvalFailureReasonsTarget.replaceChildren(empty("No eval failure reason counts."));
          return;
        }

        knowledgeEvalFailureReasonsTarget.replaceChildren(
          ...rows.map(([reason, count]) =>
            row("knowledge-candidate-item", "Eval reason · " + reason, String(count), "Eval failed"),
          ),
        );
      }

      function renderQualitySignalReasons(reasonCounts) {
        const rows = Object.entries(reasonCounts)
          .filter((entry) => Number(entry[1]) > 0)
          .sort((left, right) => Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0]));
        if (rows.length === 0) {
          knowledgeQualityReasonsTarget.replaceChildren(empty("No quality reason counts."));
          return;
        }

        knowledgeQualityReasonsTarget.replaceChildren(
          ...rows.map(([reason, count]) =>
            row("knowledge-candidate-item", "Quality reason · " + reason, String(count), "Needs review"),
          ),
        );
      }

      function renderQualitySignalRoutes(routeCounts) {
        const rows = Object.entries(routeCounts)
          .filter((entry) => Number(entry[1]) > 0)
          .sort((left, right) => Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0]));
        if (rows.length === 0) {
          knowledgeQualityRoutesTarget.replaceChildren(empty("No quality route counts."));
          return;
        }

        knowledgeQualityRoutesTarget.replaceChildren(
          ...rows.map(([route, count]) =>
            row("knowledge-candidate-item", "Quality route · " + route, String(count), "Needs review"),
          ),
        );
      }

      function renderQualitySignalClusters(clusters) {
        if (clusters.length === 0) {
          knowledgeQualityClustersTarget.replaceChildren(empty("No quality clusters."));
          return;
        }

        knowledgeQualityClustersTarget.replaceChildren(
          ...clusters.map((cluster) =>
            rowWithMetaNodes(
              "knowledge-candidate-item",
              "Quality cluster · " + cluster.agentRoute + " / " + cluster.reason,
              String(cluster.count),
              [
                createQualityClusterButton(cluster),
                cluster.targetCategory ? text("Target " + cluster.targetCategory) : undefined,
                cluster.type ? text("Type " + cluster.type) : undefined,
                cluster.oldestCreatedAt ? text("Oldest " + cluster.oldestCreatedAt) : undefined,
                cluster.latestCreatedAt ? text("Latest " + cluster.latestCreatedAt) : undefined,
                cluster.candidateIds?.length ? text("Candidates " + cluster.candidateIds.join(", ")) : undefined,
                cluster.sampleQuestions?.length ? text("Samples " + cluster.sampleQuestions.join(" | ")) : undefined,
              ],
            ),
          ),
        );
      }

      function createQualityClusterButton(cluster) {
        if (!cluster.clusterKey) {
          return undefined;
        }

        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("data-quality-cluster-key", cluster.clusterKey);
        button.textContent = "Load cluster";
        return button;
      }

      async function loadQualitySignalClusterCandidates(clusterKey) {
        knowledgeCandidateStatusFilter.value = "needs_review";
        knowledgeCandidateType.value = "";
        knowledgeCandidateSource.value = "answer_quality_signal";
        await loadKnowledgeCandidates({ qualitySignalClusterKey: clusterKey });
      }

      function renderQualitySignals(recentSignals) {
        if (recentSignals.length === 0) {
          knowledgeQualitySignalsTarget.replaceChildren(empty("No recent quality gaps."));
          return;
        }

        knowledgeQualitySignalsTarget.replaceChildren(
          ...recentSignals.map((recent) =>
            row(
              "knowledge-candidate-item",
              "Quality gap · " + recent.candidateId,
              recent.question,
              [
                recent.agentRoute ? "Route " + recent.agentRoute : "",
                recent.targetCategory ? "Target " + recent.targetCategory : "",
                recent.type ? "Type " + recent.type : "",
                recent.riskLevel ? "Risk " + recent.riskLevel : "",
                recent.createdAt ? "Created " + recent.createdAt : "",
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          ),
        );
      }

      function renderTxAnalysis(summary, runtime) {
        if (!summary) {
          txAnalysisTarget.replaceChildren(empty("No transaction analysis reports yet."));
          return;
        }

        const runtimeRows = renderTxAnalysisRuntimeRows(runtime);
        const chainRows = Object.keys(summary.byChain || {}).map((chain) =>
          row("tx-analysis-item", "Chain · " + chain, String(summary.byChain[chain]), "reports"),
        );
        const failureRows = Object.keys(summary.failureReasons || {}).map((reason) =>
          row("tx-analysis-item", "Failure · " + reason, String(summary.failureReasons[reason]), "reports"),
        );
        const ruleRows = Object.keys(summary.byRuleVersion || {}).map((version) =>
          row("tx-analysis-item", "Rule · " + version, String(summary.byRuleVersion[version]), "reports"),
        );
        const reviewRows = Object.keys(summary.byReviewStatus || {}).map((status) =>
          row("tx-analysis-item", "Review · " + status, String(summary.byReviewStatus[status]), "reports"),
        );
        const latestRows = (summary.latestReports || []).slice(0, 5).map((report) =>
          rowWithMetaNodes(
            "tx-analysis-item",
            report.status + " · " + report.chain,
            report.txHash,
            [
              text(report.reason || report.verdict || report.generatedAt || ""),
              report.targetTraderAddress ? text("Trader " + report.targetTraderAddress) : undefined,
              report.transactionTime ? text("Time " + report.transactionTime) : undefined,
              report.routerAddress ? text("Router " + report.routerAddress) : undefined,
              report.unsupportedExplorerHost ? text("Unsupported explorer " + report.unsupportedExplorerHost) : undefined,
              report.unsupportedChainHint ? text("Unsupported chain " + report.unsupportedChainHint) : undefined,
              report.analysisRuleVersion ? text("Rule " + report.analysisRuleVersion) : undefined,
              link("Report", report.reportUrl),
              link("Screenshot", report.screenshotUrl),
              screenshotMarkerNode(report),
              link("Explorer", report.explorerUrl),
              link("XXYY", report.xxyyPoolUrl),
              ...probeAttemptNodes(report),
              ...relatedTransactionLinks(report),
              ...reportReviewNodes(report),
            ],
          ),
        );

        txAnalysisTarget.replaceChildren(
          ...runtimeRows,
          row("tx-analysis-item", "Total", String(summary.totalCount || 0), ""),
          row("tx-analysis-item", "Success", String(summary.successCount || 0), ""),
          row("tx-analysis-item", "Failure", String(summary.failureCount || 0), ""),
          ...(chainRows.length === 0 ? [empty("No chain reports yet.")] : chainRows),
          ...reviewRows,
          ...failureRows,
          ...ruleRows,
          ...latestRows,
        );
      }

      async function loadKnowledgeCandidates(options) {
        const token = tokenInput.value.trim();
        if (!token) {
          knowledgeCandidateStatus.textContent = "Ops token is required.";
          tokenInput.focus();
          return;
        }

        const params = new URLSearchParams();
        params.set("status", knowledgeCandidateStatusFilter.value);
        if (knowledgeCandidateType.value) {
          params.set("type", knowledgeCandidateType.value);
        }
        if (knowledgeCandidateSource.value) {
          params.set("source", knowledgeCandidateSource.value);
        }
        if (options?.qualitySignalClusterKey) {
          params.set("qualitySignalClusterKey", options.qualitySignalClusterKey);
        }
        const limit = knowledgeCandidateLimit.value.trim();
        if (limit) {
          params.set("limit", limit);
        }

        knowledgeCandidateSubmit.disabled = true;
        knowledgeCandidateStatus.textContent =
          "Loading " + formatCandidateSourceLabel(knowledgeCandidateSource.value);
        try {
          const response = await fetch("/api/knowledge/candidates?" + params.toString(), {
            headers: { Authorization: "Bearer " + token },
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.message || "Unable to load knowledge candidates.");
          }

          currentKnowledgeCandidates = payload.candidates || [];
          renderKnowledgeCandidates(currentKnowledgeCandidates);
          knowledgeCandidateStatus.textContent =
            String((payload.candidates || []).length) + " candidates";
        } catch (error) {
          knowledgeCandidateStatus.textContent =
            error instanceof Error ? error.message : String(error);
        } finally {
          knowledgeCandidateSubmit.disabled = false;
        }
      }

      function renderKnowledgeCandidates(candidates) {
        if (candidates.length === 0) {
          knowledgeCandidatesTarget.replaceChildren(
            empty("No needs-review candidates for this source."),
          );
          return;
        }

        knowledgeCandidatesTarget.replaceChildren(
          ...candidates.map((candidate) =>
            rowWithMetaNodes(
              "knowledge-candidate-item",
              candidate.question || candidate.id,
              candidate.riskLevel + " · " + candidate.type,
              [
                candidate.proposedAnswer ? text(candidate.proposedAnswer) : undefined,
                text("Status " + candidate.status),
                text("ID " + candidate.id),
                text("Source " + knowledgeCandidateSourcesLabel(candidate.sourceRefs || [])),
                candidate.confidence === undefined
                  ? undefined
                  : text("Confidence " + Math.round(candidate.confidence * 100) + "%"),
                candidate.updatedAt ? text("Updated " + candidate.updatedAt) : undefined,
                candidate.redactionReport?.riskFlags?.length
                  ? text("Flags " + candidate.redactionReport.riskFlags.join(", "))
                  : undefined,
                candidate.reviewer ? text("Reviewer " + candidate.reviewer) : undefined,
                candidate.reviewNotes ? text("Review notes " + candidate.reviewNotes) : undefined,
                createKnowledgeCandidateReviewForm(candidate),
              ],
            ),
          ),
        );
      }

      function createKnowledgeCandidateReviewForm(candidate) {
        if (!candidate.id) {
          return undefined;
        }

        const form = document.createElement("form");
        form.className = "report-review-form";

        const reviewerLabel = document.createElement("label");
        reviewerLabel.textContent = "Reviewer";
        const reviewer = document.createElement("input");
        reviewer.name = "reviewer";
        reviewer.autocomplete = "off";
        reviewer.value = candidate.reviewer || "";
        reviewerLabel.append(reviewer);

        const notesLabel = document.createElement("label");
        notesLabel.textContent = "Notes";
        const notes = document.createElement("input");
        notes.name = "notes";
        notes.autocomplete = "off";
        notes.value = candidate.reviewNotes || "";
        notesLabel.append(notes);

        const mergedIntoCandidateLabel = document.createElement("label");
        mergedIntoCandidateLabel.textContent = "Merge target";
        const mergedIntoCandidateId = document.createElement("input");
        mergedIntoCandidateId.name = "mergedIntoCandidateId";
        mergedIntoCandidateId.autocomplete = "off";
        mergedIntoCandidateId.placeholder = "candidate id";
        mergedIntoCandidateLabel.append(mergedIntoCandidateId);

        const statusTarget = document.createElement("div");
        statusTarget.className = "report-review-status";
        statusTarget.setAttribute("role", "status");
        statusTarget.setAttribute("aria-live", "polite");

        const approve = createKnowledgeCandidateReviewActionButton(candidate, {
          action: "approve",
          mergedIntoCandidateId,
          notes,
          reviewer,
          statusTarget,
        });
        approve.textContent = "Approve";

        const reject = createKnowledgeCandidateReviewActionButton(candidate, {
          action: "reject",
          mergedIntoCandidateId,
          notes,
          reviewer,
          statusTarget,
        });
        reject.textContent = "Reject";

        const requestChanges = createKnowledgeCandidateReviewActionButton(candidate, {
          action: "request_changes",
          mergedIntoCandidateId,
          notes,
          reviewer,
          statusTarget,
        });
        requestChanges.textContent = "Request changes";

        const mergeDuplicate = createKnowledgeCandidateReviewActionButton(candidate, {
          action: "merge_duplicate",
          mergedIntoCandidateId,
          notes,
          reviewer,
          statusTarget,
        });
        mergeDuplicate.textContent = "Merge duplicate";

        form.addEventListener("submit", (event) => {
          event.preventDefault();
        });
        form.append(
          reviewerLabel,
          notesLabel,
          mergedIntoCandidateLabel,
          approve,
          reject,
          requestChanges,
          mergeDuplicate,
          statusTarget,
        );
        return form;
      }

      function createKnowledgeCandidateReviewActionButton(candidate, options) {
        const button = document.createElement("button");
        button.type = "button";

        button.addEventListener("click", async () => {
          const token = tokenInput.value.trim();
          if (!token) {
            options.statusTarget.textContent = "Ops token is required.";
            tokenInput.focus();
            return;
          }
          if (!options.reviewer.value.trim()) {
            options.statusTarget.textContent = "Reviewer is required.";
            options.reviewer.focus();
            return;
          }
          if (
            options.action === "merge_duplicate" &&
            !options.mergedIntoCandidateId.value.trim()
          ) {
            options.statusTarget.textContent = "Merge target is required.";
            options.mergedIntoCandidateId.focus();
            return;
          }

          button.disabled = true;
          options.statusTarget.textContent = "Saving";
          try {
            const reviewed = await updateKnowledgeCandidateReview(
              candidate,
              {
                action: options.action,
                mergedIntoCandidateId: options.mergedIntoCandidateId.value.trim(),
                notes: options.notes.value.trim(),
                reviewer: options.reviewer.value.trim(),
              },
              options.statusTarget,
            );
            currentKnowledgeCandidates = currentKnowledgeCandidates
              .map((item) => (item.id === reviewed.id ? reviewed : item))
              .filter((item) => item.status === knowledgeCandidateStatusFilter.value);
            renderKnowledgeCandidates(currentKnowledgeCandidates);
            knowledgeCandidateStatus.textContent =
              "Saved " +
              reviewed.status +
              " · " +
              String(currentKnowledgeCandidates.length) +
              " candidates";
          } catch (error) {
            options.statusTarget.textContent =
              error instanceof Error ? error.message : String(error);
          } finally {
            button.disabled = false;
          }
        });

        return button;
      }

      async function updateKnowledgeCandidateReview(candidate, payload, statusTarget) {
        const requestPayload = {
          action: payload.action,
          reviewer: payload.reviewer,
          ...(payload.notes ? { notes: payload.notes } : {}),
          ...(payload.action === "merge_duplicate"
            ? { mergedIntoCandidateId: payload.mergedIntoCandidateId }
            : {}),
        };
        const response = await fetch("/api/knowledge/candidates/" + encodeURIComponent(candidate.id) + "/review", {
          method: "PATCH",
          headers: {
            Authorization: "Bearer " + tokenInput.value.trim(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestPayload),
        });
        const responsePayload = await response.json();
        if (!response.ok) {
          throw new Error(responsePayload.message || "Unable to save candidate review.");
        }

        statusTarget.textContent = "Saved";
        return responsePayload.candidate;
      }

      function knowledgeCandidateSourcesLabel(sourceRefs) {
        const sources = Array.from(
          new Set(sourceRefs.map((sourceRef) => formatCandidateSourceLabel(sourceRef.source))),
        ).filter(Boolean);
        return sources.length > 0
          ? sources.join(", ")
          : formatCandidateSourceLabel(knowledgeCandidateSource.value);
      }

      function formatCandidateSourceLabel(source) {
        if (source === "answer_feedback") {
          return "Answer feedback";
        }
        if (source === "answer_quality_signal") {
          return "Quality signals";
        }
        if (source === "telegram") {
          return "Telegram support";
        }

        return String(source || "all sources");
      }

      function renderTxAnalysisRuntimeRows(runtime) {
        if (!runtime) {
          return [];
        }

        const browser = runtime.browser || {};
        return [
          row(
            "tx-analysis-item",
            "Runtime · provider",
            runtime.provider || "none",
            "Reviewer " + (runtime.reviewer || "none") + " · Store " + (runtime.reportStore || "file"),
          ),
          row(
            "tx-analysis-item",
            "Browser concurrency",
            String(browser.maxConcurrency ?? "unknown"),
            "Headless " + formatBoolean(browser.headless),
          ),
          row(
            "tx-analysis-item",
            "Browser retry",
            String(browser.maxRetries ?? "unknown"),
            "Timeout failures",
          ),
          row(
            "tx-analysis-item",
            "Browser timeout",
            browser.timeoutMs === undefined ? "unknown" : String(browser.timeoutMs) + "ms",
            browser.discoverUrl ? "Discover " + browser.discoverUrl : "Discover default",
          ),
        ];
      }

      function formatBoolean(value) {
        return value === true ? "on" : "off";
      }

      async function loadTxReports() {
        const params = new URLSearchParams();
        const txHash = txReportHash.value.trim();
        const chain = txReportChain.value.trim();
        const reportStatus = txReportStatus.value;
        const reviewStatus = txReportReviewStatus.value;
        const assignee = txReportAssignee.value.trim();
        const reason = txReportReason.value;
        const limit = txReportLimit.value.trim();

        if (txHash) {
          params.set("txHash", txHash);
        }
        if (chain) {
          params.set("chain", chain);
        }
        if (reportStatus) {
          params.set("status", reportStatus);
        }
        if (reviewStatus) {
          params.set("reviewStatus", reviewStatus);
        }
        if (assignee) {
          params.set("assignee", assignee);
        }
        if (reason) {
          params.set("reason", reason);
        }
        if (limit) {
          params.set("limit", limit);
        }

        txReportSubmit.disabled = true;
        txReportSearchStatus.textContent = "Searching";
        try {
          const response = await fetch("/api/tx-analysis/reports?" + params.toString());
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.message || "Unable to load reports.");
          }
          renderTxReportResults(payload.reports || []);
          txReportSearchStatus.textContent = String((payload.reports || []).length) + " reports";
        } catch (error) {
          txReportSearchStatus.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          txReportSubmit.disabled = false;
        }
      }

      function renderTxReportResults(reports) {
        currentTxReports = reports;
        if (reports.length === 0) {
          txReportResultsTarget.replaceChildren(empty("No matching reports."));
          updateSelectedTxReportCount();
          return;
        }

        txReportResultsTarget.replaceChildren(
          ...reports.map((report) =>
            rowWithMetaNodes(
              "tx-analysis-item",
              report.status + " · " + report.chain,
              report.txHash,
              [
                createTxReportSelectionNode(report),
                text(report.reason || report.verdict || report.message || report.generatedAt || ""),
                report.targetTraderAddress ? text("Trader " + report.targetTraderAddress) : undefined,
                report.transactionTime ? text("Time " + report.transactionTime) : undefined,
                report.routerAddress ? text("Router " + report.routerAddress) : undefined,
                report.unsupportedExplorerHost ? text("Unsupported explorer " + report.unsupportedExplorerHost) : undefined,
                report.unsupportedChainHint ? text("Unsupported chain " + report.unsupportedChainHint) : undefined,
                report.analysisRuleVersion ? text("Rule " + report.analysisRuleVersion) : undefined,
                link("Report", report.reportUrl),
                link("Screenshot", report.screenshotUrl),
                screenshotMarkerNode(report),
                link("Explorer", report.explorerUrl),
                link("XXYY", report.xxyyPoolUrl),
                ...probeAttemptNodes(report),
                ...relatedTransactionLinks(report),
                ...reportReviewNodes(report),
              ],
            ),
          ),
        );
        updateSelectedTxReportCount();
      }

      function reportReviewNodes(report) {
        const review = report.review || {};
        return [
          text("Review " + (review.status || "open")),
          review.assignee ? text("Assignee " + review.assignee) : undefined,
          review.note ? text("Note " + review.note) : undefined,
          review.updatedAt ? text("Reviewed " + review.updatedAt) : undefined,
          createReportReviewForm(report),
        ].filter(Boolean);
      }

      function createTxReportSelectionNode(report) {
        const reportId = reportReviewId(report);
        if (!reportId) {
          return undefined;
        }

        const label = document.createElement("label");
        label.className = "tx-report-select";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = reportId;
        checkbox.addEventListener("change", updateSelectedTxReportCount);
        label.append(checkbox, text("Select"));
        return label;
      }

      function selectedTxReportIds() {
        return Array.from(txReportResultsTarget.querySelectorAll(".tx-report-select input:checked"))
          .map((checkbox) => checkbox.value)
          .filter(Boolean);
      }

      function updateSelectedTxReportCount() {
        const count = selectedTxReportIds().length;
        txReportBulkStatus.textContent = String(count) + " selected";
      }

      async function updateBulkReportReview(action) {
        const token = tokenInput.value.trim();
        if (!token) {
          txReportBulkStatus.textContent = "Ops token is required.";
          tokenInput.focus();
          return;
        }
        const ids = selectedTxReportIds();
        if (ids.length === 0) {
          txReportBulkStatus.textContent = "Select at least one report.";
          return;
        }
        if (action === "claim" && !txReportBulkAssignee.value.trim()) {
          txReportBulkStatus.textContent = "Assignee is required to claim.";
          txReportBulkAssignee.focus();
          return;
        }
        if (action === "close" && !txReportBulkNote.value.trim()) {
          txReportBulkStatus.textContent = "Note is required to close.";
          txReportBulkNote.focus();
          return;
        }

        for (const button of txReportBulkButtons) {
          button.disabled = true;
        }
        txReportBulkStatus.textContent = "Saving";
        try {
          const response = await fetch("/api/tx-analysis/reports/review", {
            method: "PATCH",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action,
              assignee: txReportBulkAssignee.value.trim(),
              ids: selectedTxReportIds(),
              note: txReportBulkNote.value.trim(),
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.message || "Unable to save reviews.");
          }

          const reviewsById = new Map((payload.reviews || []).map((item) => [item.id, item.review]));
          currentTxReports = currentTxReports.map((report) => {
            const reportId = reportReviewId(report);
            const review = reviewsById.get(reportId);
            return review === undefined ? report : { ...report, review };
          });
          renderTxReportResults(currentTxReports);
          txReportBulkStatus.textContent =
            "Saved " +
            String(payload.updatedCount || 0) +
            " · Missing " +
            String(payload.notFoundCount || 0);
        } catch (error) {
          txReportBulkStatus.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          for (const button of txReportBulkButtons) {
            button.disabled = false;
          }
        }
      }

      function createReportReviewForm(report) {
        const reportId = reportReviewId(report);
        if (!reportId) {
          return undefined;
        }

        const review = report.review || {};
        const form = document.createElement("form");
        form.className = "report-review-form";

        const statusLabel = document.createElement("label");
        statusLabel.textContent = "Review";
        const status = document.createElement("select");
        status.name = "review-status";
        for (const optionConfig of [
          { value: "open", label: "Open" },
          { value: "in_review", label: "In review" },
          { value: "closed", label: "Closed" },
        ]) {
          const option = document.createElement("option");
          option.value = optionConfig.value;
          option.textContent = optionConfig.label;
          status.append(option);
        }
        status.value = review.status || "open";
        statusLabel.append(status);

        const assigneeLabel = document.createElement("label");
        assigneeLabel.textContent = "Assignee";
        const assignee = document.createElement("input");
        assignee.name = "assignee";
        assignee.autocomplete = "off";
        assignee.value = review.assignee || "";
        assigneeLabel.append(assignee);

        const noteLabel = document.createElement("label");
        noteLabel.textContent = "Note";
        const note = document.createElement("input");
        note.name = "note";
        note.autocomplete = "off";
        note.value = review.note || "";
        noteLabel.append(note);

        const submit = document.createElement("button");
        submit.type = "submit";
        submit.textContent = "Save";

        const statusTarget = document.createElement("div");
        statusTarget.className = "report-review-status";
        statusTarget.setAttribute("role", "status");
        statusTarget.setAttribute("aria-live", "polite");

        const claim = createReportReviewWorkflowButton(report, {
          action: "claim",
          assignee,
          note,
          status,
          statusTarget,
        });
        claim.textContent = "Claim";

        const close = createReportReviewWorkflowButton(report, {
          action: "close",
          assignee,
          note,
          status,
          statusTarget,
        });
        close.textContent = "Close";

        const reopen = createReportReviewWorkflowButton(report, {
          action: "reopen",
          assignee,
          note,
          status,
          statusTarget,
        });
        reopen.textContent = "Reopen";

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const token = tokenInput.value.trim();
          if (!token) {
            statusTarget.textContent = "Ops token is required.";
            tokenInput.focus();
            return;
          }

          submit.disabled = true;
          statusTarget.textContent = "Saving";
          try {
            const reviewResult = await updateReportReview(
              report,
              {
                assignee: assignee.value,
                note: note.value,
                status: status.value,
              },
              statusTarget,
            );
            status.value = reviewResult.status;
            assignee.value = reviewResult.assignee || "";
            note.value = reviewResult.note || "";
            statusTarget.textContent = "Saved · " + reviewResult.status;
          } catch (error) {
            statusTarget.textContent = error instanceof Error ? error.message : String(error);
          } finally {
            submit.disabled = false;
          }
        });

        form.append(statusLabel, assigneeLabel, noteLabel, submit, claim, close, reopen, statusTarget);
        return form;
      }

      function createReportReviewWorkflowButton(report, options) {
        const button = document.createElement("button");
        button.type = "button";

        button.addEventListener("click", async () => {
          const token = tokenInput.value.trim();
          if (!token) {
            options.statusTarget.textContent = "Ops token is required.";
            tokenInput.focus();
            return;
          }
          if (options.action === "claim" && !options.assignee.value.trim()) {
            options.statusTarget.textContent = "Assignee is required to claim.";
            options.assignee.focus();
            return;
          }
          if (options.action === "close" && !options.note.value.trim()) {
            options.statusTarget.textContent = "Note is required to close.";
            options.note.focus();
            return;
          }

          button.disabled = true;
          options.statusTarget.textContent = "Saving";
          try {
            const reviewResult = await updateReportReview(
              report,
              {
                action: options.action,
                assignee: options.assignee.value.trim(),
                note: options.note.value.trim(),
              },
              options.statusTarget,
            );
            options.status.value = reviewResult.status;
            options.assignee.value = reviewResult.assignee || "";
            options.note.value = reviewResult.note || "";
            options.statusTarget.textContent = "Saved · " + reviewResult.status;
          } catch (error) {
            options.statusTarget.textContent = error instanceof Error ? error.message : String(error);
          } finally {
            button.disabled = false;
          }
        });

        return button;
      }

      async function updateReportReview(report, payload, statusTarget) {
        const reportId = reportReviewId(report);
        if (!reportId) {
          throw new Error("Report cannot be updated.");
        }

        const token = tokenInput.value.trim();
        const response = await fetch("/api/tx-analysis/reports/" + encodeURIComponent(reportId) + "/review", {
          method: "PATCH",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const responsePayload = await response.json();
        if (!response.ok) {
          throw new Error(responsePayload.message || "Unable to save review.");
        }

        report.review = responsePayload.review;
        statusTarget.textContent = "Saved";
        return responsePayload.review;
      }

      function reportReviewId(report) {
        const reportUrl = report.reportUrl || "";
        if (!reportUrl) {
          return "";
        }

        let pathname = reportUrl;
        try {
          pathname = new URL(reportUrl, window.location.origin).pathname;
        } catch (_error) {
          pathname = reportUrl;
        }

        const prefix = "/api/tx-analysis/reports/";
        if (!pathname.startsWith(prefix)) {
          return "";
        }

        const id = pathname.slice(prefix.length).split(/[?#]/u)[0];
        if (!id || id.includes("/")) {
          return "";
        }

        try {
          return decodeURIComponent(id);
        } catch (_error) {
          return id;
        }
      }

      function relatedTransactionLinks(report) {
        return (report.relatedTransactions || [])
          .map(
            (transaction) =>
              link(relatedTransactionLabel(transaction), transaction.explorerUrl) ||
              text(relatedTransactionLabel(transaction)),
          )
          .filter(Boolean);
      }

      function relatedTransactionLabel(transaction) {
        const side = formatTradeSideLabel(transaction.side);
        return [
          roleLabel(transaction.role),
          side,
          transaction.traderAddress ? "Trader " + transaction.traderAddress : "",
          transaction.timestamp ? "Time " + transaction.timestamp : "",
        ]
          .filter(Boolean)
          .join(" · ");
      }

      function screenshotMarkerNode(report) {
        if (report.screenshotTargetRowMarked === true) {
          return text("Target row marked");
        }
        if (report.screenshotTargetRowMarked === false) {
          return text("Target row unmarked");
        }

        return undefined;
      }

      function probeAttemptNodes(report) {
        return (report.probeAttempts || [])
          .map((attempt) =>
            text(
              "Probe " +
                formatChainLabel(attempt.chain) +
                " · " +
                formatProbeReason(attempt.reason),
            ),
          )
          .filter(Boolean);
      }

      function formatChainLabel(chain) {
        if (chain === "solana") {
          return "Solana";
        }
        if (chain === "base") {
          return "Base";
        }
        if (chain === "ethereum") {
          return "Ethereum";
        }
        if (chain === "bsc") {
          return "BSC";
        }

        return "Unknown";
      }

      function formatProbeReason(reason) {
        if (reason === "browser_verification_required") {
          return "browser verification";
        }
        if (reason === "provider_unavailable") {
          return "provider unavailable";
        }
        if (reason === "timeout") {
          return "timeout";
        }
        if (reason === "tx_not_found") {
          return "tx not found";
        }
        if (reason === "tx_failed") {
          return "tx failed";
        }
        if (reason === "tx_pending") {
          return "tx pending";
        }
        if (reason === "pool_not_found") {
          return "pool not found";
        }
        if (reason === "target_trade_not_found") {
          return "target trade not found";
        }
        if (reason === "screenshot_unavailable") {
          return "screenshot unavailable";
        }
        if (reason === "unsupported_chain") {
          return "unsupported chain";
        }
        if (reason === "invalid_reference") {
          return "invalid reference";
        }
        if (reason === "not_configured") {
          return "not configured";
        }

        return String(reason || "unknown");
      }

      function roleLabel(role) {
        if (role === "front_run") {
          return "Front";
        }
        if (role === "user") {
          return "User";
        }
        if (role === "back_run") {
          return "Back";
        }

        return "Related";
      }

      function formatTradeSideLabel(side) {
        if (side === "buy") {
          return "Buy";
        }
        if (side === "sell") {
          return "Sell";
        }
        if (side === "unknown") {
          return "Unknown side";
        }

        return "";
      }

      function metric(label, value, state) {
        const item = document.createElement("article");
        item.className = "metric " + state;

        const labelNode = document.createElement("div");
        labelNode.className = "metric-label";
        labelNode.textContent = label;

        const valueNode = document.createElement("div");
        valueNode.className = "metric-value";
        valueNode.textContent = String(value);

        item.append(labelNode, valueNode);
        return item;
      }

      function row(className, title, value, meta) {
        const item = document.createElement("article");
        item.className = className;

        const titleNode = document.createElement("div");
        titleNode.className = "row-title";
        const titleText = document.createElement("span");
        titleText.textContent = title;
        const valueText = document.createElement("span");
        valueText.textContent = value;
        titleNode.append(titleText, valueText);

        const metaNode = document.createElement("div");
        metaNode.className = "row-meta";
        metaNode.textContent = meta;

        item.append(titleNode, metaNode);
        return item;
      }

      function rowWithMetaNodes(className, title, value, metaNodes) {
        const item = row(className, title, value, "");
        const metaNode = item.querySelector(".row-meta");
        metaNode.replaceChildren(...metaNodes.filter(Boolean));
        return item;
      }

      function text(value) {
        const item = document.createElement("span");
        item.textContent = value;
        return item;
      }

      function link(label, url) {
        if (!url) {
          return undefined;
        }

        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.target = "_blank";
        anchor.rel = "noreferrer";
        anchor.textContent = label;
        return anchor;
      }

      function empty(text) {
        const item = document.createElement("div");
        item.className = "empty";
        item.textContent = text;
        return item;
      }
    </script>
  </body>
</html>`;
}

export function startStaticWebServer(
  port = Number(process.env.PORT ?? 3001),
): ReturnType<typeof createServer> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET' || !['/', '/ops'].includes(requestUrl.pathname)) {
      response.statusCode = 404;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(`${JSON.stringify({ error: 'not_found' })}\n`);
      return;
    }

    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(requestUrl.pathname === '/ops' ? renderOpsPage() : renderChatPage());
  });

  server.listen(port, () => {
    process.stdout.write(`XXYY Ask web listening on http://localhost:${port}\n`);
  });

  return server;
}

function isDirectRun(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  startStaticWebServer();
}
