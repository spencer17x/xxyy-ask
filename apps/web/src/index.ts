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

        bubble.append(answer);
        const messageRecord = {
          answer,
          attachments,
          citationCount: 0,
          citations,
          hasContent: !options.streaming,
          intentValue: "unknown",
          meta,
          node,
          question: options.question || options.text || "",
          rawAnswer: options.text || "",
        };
        if (role === "assistant") {
          bubble.append(meta, citations, attachments);
        }
        node.append(avatar, bubble);
        messages.append(node);
        scrollMessagesToBottom();

        return messageRecord;
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

export function startStaticWebServer(
  port = Number(process.env.PORT ?? 3001),
): ReturnType<typeof createServer> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET' || requestUrl.pathname !== '/') {
      response.statusCode = 404;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(`${JSON.stringify({ error: 'not_found' })}\n`);
      return;
    }

    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(renderChatPage());
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
