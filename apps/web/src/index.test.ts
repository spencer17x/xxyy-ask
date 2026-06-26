import { describe, expect, it } from 'vitest';
import { request } from 'node:http';

import { renderChatPage, startStaticWebServer } from './index.js';

describe('renderChatPage', () => {
  it('renders the Vite React application shell', () => {
    const html = renderChatPage();

    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<link rel="stylesheet" href="/web-assets/index.css" />');
    expect(html).toContain('<script type="module" src="/web-assets/index.js"></script>');
    expect(html).not.toContain('fetch("/api/chat/stream"');
    expect(html).not.toContain('innerHTML =');
  });

  it('keeps production app assets separate from transaction media assets', () => {
    const html = renderChatPage();

    expect(html).toContain('/web-assets/index.js');
    expect(html).not.toContain('/assets/index.js');
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

      const response = await get(address.port, '/' + 'ops');

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
