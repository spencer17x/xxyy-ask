import { describe, expect, it } from 'vitest';

import { createApiHeaders } from './api-auth.js';

describe('createApiHeaders', () => {
  it('uses only JSON content type when no token is entered', () => {
    expect(createApiHeaders()).toEqual({ 'Content-Type': 'application/json' });
    expect(createApiHeaders('   ')).toEqual({ 'Content-Type': 'application/json' });
  });

  it('adds a trimmed bearer token when one is entered', () => {
    expect(createApiHeaders('  chat-secret  ')).toEqual({
      Authorization: 'Bearer chat-secret',
      'Content-Type': 'application/json',
    });
  });
});
