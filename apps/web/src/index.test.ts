import { describe, expect, it } from 'vitest';

import { renderChatPage } from './index.js';

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
});
