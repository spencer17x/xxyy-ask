import { describe, expect, it, vi } from 'vitest';

import { KnowledgeAdminApiError, knowledgeAdminRequest } from './admin-api.js';

describe('knowledgeAdminRequest', () => {
  it('sends the bearer token and JSON payload only to the protected admin namespace', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ candidate: { id: 'candidate-1' } }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await knowledgeAdminRequest('secret-token', '/candidates/candidate-1', {
      body: { question: '更新后的问题' },
      fetchImpl,
      method: 'PATCH',
    });

    expect(fetchImpl).toHaveBeenCalledWith('/admin/api/candidates/candidate-1', {
      body: JSON.stringify({ question: '更新后的问题' }),
      headers: {
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      },
      method: 'PATCH',
    });
  });

  it('returns a typed error without including the administrator token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'forbidden', message: 'Insufficient role.' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 403,
      }),
    );

    const error = await knowledgeAdminRequest('secret-token', '/publications', {
      fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KnowledgeAdminApiError);
    expect(error).toMatchObject({ code: 'forbidden', message: 'Insufficient role.', status: 403 });
    expect(JSON.stringify(error)).not.toContain('secret-token');
  });
});
