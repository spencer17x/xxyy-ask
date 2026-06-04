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
        background: #f7f8fa;
        color: #18212f;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
      }

      main {
        width: min(960px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0;
      }

      header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
        border-bottom: 1px solid #d9dee8;
        padding-bottom: 16px;
      }

      h1 {
        margin: 0;
        font-size: 22px;
        font-weight: 650;
        letter-spacing: 0;
      }

      .status {
        min-height: 22px;
        color: #556170;
        font-size: 14px;
      }

      .conversation {
        display: grid;
        grid-template-columns: 1fr;
        gap: 16px;
        margin-top: 24px;
      }

      .panel {
        border: 1px solid #d9dee8;
        border-radius: 8px;
        background: #ffffff;
      }

      .answer {
        min-height: 220px;
        padding: 20px;
        line-height: 1.7;
        white-space: pre-wrap;
      }

      .citations {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 16px 20px 20px;
        border-top: 1px solid #eef1f5;
      }

      .citation {
        display: grid;
        gap: 4px;
        padding: 10px 0;
        border-bottom: 1px solid #eef1f5;
      }

      .citation:last-child {
        border-bottom: 0;
      }

      .citation-title {
        color: #18212f;
        font-size: 14px;
        font-weight: 650;
      }

      .citation-meta {
        overflow-wrap: anywhere;
        color: #556170;
        font-size: 12px;
      }

      form {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        margin-top: 16px;
      }

      textarea {
        min-height: 88px;
        resize: vertical;
        border: 1px solid #c8d0dc;
        border-radius: 8px;
        padding: 12px;
        color: #18212f;
        font: inherit;
        line-height: 1.5;
      }

      button {
        min-width: 96px;
        border: 0;
        border-radius: 8px;
        background: #176b5b;
        color: white;
        cursor: pointer;
        font: inherit;
        font-weight: 650;
      }

      button:disabled {
        cursor: progress;
        opacity: 0.65;
      }

      @media (max-width: 640px) {
        main {
          width: min(100vw - 20px, 960px);
          padding: 16px 0;
        }

        header,
        form {
          grid-template-columns: 1fr;
        }

        header {
          display: grid;
        }

        button {
          min-height: 44px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>XXYY Ask</h1>
        <div id="status" class="status" role="status" aria-live="polite"></div>
      </header>
      <section class="conversation" aria-label="chat">
        <div class="panel">
          <div id="answer" class="answer">Ready.</div>
          <div id="citations" class="citations" aria-label="citations"></div>
        </div>
        <form id="chat-form">
          <textarea id="message" name="message" placeholder="XXYY Pro 有哪些权益？" required></textarea>
          <button id="send" type="submit">Send</button>
        </form>
      </section>
    </main>
    <script>
      const form = document.querySelector("#chat-form");
      const message = document.querySelector("#message");
      const answer = document.querySelector("#answer");
      const citations = document.querySelector("#citations");
      const status = document.querySelector("#status");
      const send = document.querySelector("#send");

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = message.value.trim();
        if (!text) return;

        send.disabled = true;
        status.textContent = "Sending";
        answer.textContent = "";
        citations.replaceChildren();

        try {
          const response = await fetch("/api/chat/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, channel: "web" }),
          });
          if (!response.ok) {
            const payload = await response.json();
            throw new Error(payload.message || "Request failed.");
          }
          if (!response.body) {
            throw new Error("Streaming response is unavailable.");
          }

          await readChatStream(response.body);
        } catch (error) {
          answer.textContent = error instanceof Error ? error.message : String(error);
          status.textContent = "Error";
        } finally {
          send.disabled = false;
        }
      });

      async function readChatStream(body) {
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
            handleSseBlock(block);
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
          handleSseBlock(buffer);
        }
      }

      function handleSseBlock(block) {
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
          answer.textContent += payload.delta || "";
          status.textContent = "Receiving";
          return;
        }

        if (eventName === "metadata") {
          renderCitations(payload.citations || []);
          status.textContent = payload.intent + " · " + Number(payload.confidence).toFixed(2);
          return;
        }

        if (eventName === "error") {
          throw new Error(payload.message || "Request failed.");
        }
      }

      function renderCitations(nextCitations) {
        citations.replaceChildren(
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
            excerpt.textContent = citation.excerpt;

            article.append(title, meta, excerpt);
            return article;
          }),
        );
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
