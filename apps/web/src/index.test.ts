import { describe, expect, it } from 'vitest';
import { request } from 'node:http';

import { renderChatPage, startStaticWebServer } from './index.js';

describe('renderChatPage', () => {
  it('renders a polished support workbench that streams chat and shows citations', () => {
    const html = renderChatPage();

    expect(html).toContain('class="app-shell"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('class="quick-prompt"');
    expect(html).toContain('id="messages"');
    expect(html).toContain('<form id="chat-form"');
    expect(html).toContain('<textarea id="message"');
    expect(html).toContain('fetch("/api/chat/stream"');
    expect(html).toContain('body.getReader()');
    expect(html).toContain('appendMessage("assistant"');
    expect(html).toContain('renderCitations(assistantMessage.citations');
    expect(html).toContain('renderAttachments(assistantMessage.attachments');
    expect(html).toContain('document.createElement("video")');
    expect(html).toContain('document.createElement("img")');
    expect(html).toContain('.attachment img');
    expect(html).not.toContain('className = "feedback-actions"');
    expect(html).not.toContain('fetch("/api/' + 'feedback"');
  });

  it('does not render citation payloads with innerHTML', () => {
    const html = renderChatPage();

    expect(html).not.toContain('citations.innerHTML = (payload.citations || [])');
  });

  it('renders streamed assistant markdown safely after metadata arrives', () => {
    const html = renderChatPage();

    expect(html).toContain('assistantMessage.rawAnswer += payload.delta || ""');
    expect(html).toContain('renderMarkdown(assistantMessage.answer, assistantMessage.rawAnswer)');
    expect(html).toContain('function renderMarkdown(target, markdown)');
    expect(html).toContain('function appendInlineMarkdown(parent, text)');
    expect(html).not.toContain('assistantMessage.answer.innerHTML');
    expect(html).not.toContain('innerHTML =');
  });

  it('starts a fresh backend session when the chat is cleared', () => {
    const html = renderChatPage();

    expect(html).toContain('let sessionId = getSessionId();');
    expect(html).toContain('sessionId = resetSessionId();');
    expect(html).toContain('function resetSessionId()');
    expect(html).toContain('window.localStorage.setItem(key, next)');
  });

  it('does not pretend to handle API routes in standalone mode', async () => {
    const server = startStaticWebServer(0);
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected test server to bind to a TCP port');
      }

      const response = await post(address.port, '/api/chat');

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('<!doctype html>');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('does not serve the removed ops route in standalone mode', async () => {
    const server = startStaticWebServer(0);
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected test server to bind to a TCP port');
      }

      const response = await get(address.port, '/ops');

      expect(response.statusCode).toBe(404);
      expect(response.body).toContain('"not_found"');
      expect(response.body).not.toContain('<!doctype html>');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});

function post(port: number, path: string): Promise<{ body: string; statusCode: number }> {
  return requestServer(port, path, 'POST');
}

function get(port: number, path: string): Promise<{ body: string; statusCode: number }> {
  return requestServer(port, path, 'GET');
}

function requestServer(
  port: number,
  path: string,
  method: 'GET' | 'POST',
): Promise<{ body: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'localhost',
        method,
        path,
        port,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ body, statusCode: res.statusCode ?? 0 });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
