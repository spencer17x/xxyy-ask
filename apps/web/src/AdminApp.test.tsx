import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdminApp } from './AdminApp.js';

describe('AdminApp', () => {
  it('renders a fail-closed token login before loading any governance data', () => {
    const markup = renderToStaticMarkup(createElement(AdminApp));

    expect(markup).toContain('知识库管理后台');
    expect(markup).toContain('管理令牌');
    expect(markup).toContain('KNOWLEDGE_ADMIN_TOKENS_JSON');
    expect(markup).not.toContain('知识候选审核');
  });
});
