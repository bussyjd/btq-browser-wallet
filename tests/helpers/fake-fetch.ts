/**
 * A `fetch` double that answers from recorded explorer fixtures.
 * Routes are matched on pathname + query so paging can be exercised.
 */
export interface FakeResponse {
  status: number;
  body: unknown;
}

export interface FakeFetchCall {
  url: string;
  method: string;
  body?: string;
}

export function fakeFetch(
  routes: (url: URL, init?: RequestInit) => FakeResponse | undefined,
): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    calls.push({
      url: raw,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    const answer = routes(new URL(raw), init);
    if (!answer) throw new Error(`no fake route for ${raw}`);
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: async () => {
        if (answer.body === undefined) throw new Error('not json');
        return answer.body;
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}
