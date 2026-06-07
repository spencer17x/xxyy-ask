import { describe, expect, it } from 'vitest';
import { request } from 'node:http';

import { renderChatPage, renderOpsPage, startStaticWebServer } from './index.js';

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
    expect(html).toContain('className = "feedback-actions"');
    expect(html).toContain('fetch("/api/feedback"');
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

  it('submits the raw assistant answer in feedback after markdown rendering', () => {
    const html = renderChatPage();

    expect(html).toContain(
      'answer: assistantMessage.rawAnswer || assistantMessage.answer.textContent || ""',
    );
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
});

describe('renderOpsPage', () => {
  it('renders an ops dashboard that fetches protected summary data', () => {
    const html = renderOpsPage();

    expect(html).toContain('XXYY Ops');
    expect(html).toContain('id="ops-token"');
    expect(html).toContain('fetch("/api/ops/summary"');
    expect(html).toContain('Authorization: "Bearer " + token');
    expect(html).toContain('renderHealth(summary.health)');
    expect(html).toContain('renderKnowledge(summary.knowledge)');
    expect(html).toContain('renderFeedback(summary.feedback)');
  });

  it('does not hardcode an ops token in the page', () => {
    const html = renderOpsPage();

    expect(html).not.toContain('API_OPS_TOKEN');
    expect(html).not.toContain('secret-token');
  });
});

function post(port: number, path: string): Promise<{ body: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: 'localhost',
        method: 'POST',
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
