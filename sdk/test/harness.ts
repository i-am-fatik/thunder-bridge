import { vi } from "vitest";

export type Routes = Record<string, () => Response>;

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

export function stubFetch(routes: Routes): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const route = routes[url];
      if (route === undefined) throw new Error(`nothing is mounted at ${url}`);
      return route();
    }),
  );
  return calls;
}
