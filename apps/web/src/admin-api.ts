export class KnowledgeAdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'KnowledgeAdminApiError';
  }
}

export async function knowledgeAdminRequest<T>(
  token: string,
  path: string,
  options: {
    body?: unknown;
    method?: 'GET' | 'PATCH' | 'POST';
    fetchImpl?: typeof fetch;
  } = {},
): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(`/admin/api${path}`, {
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    method: options.method ?? 'GET',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    throw new KnowledgeAdminApiError(
      typeof payload.message === 'string' ? payload.message : 'Knowledge administration failed.',
      response.status,
      typeof payload.error === 'string' ? payload.error : undefined,
    );
  }
  return payload as T;
}
