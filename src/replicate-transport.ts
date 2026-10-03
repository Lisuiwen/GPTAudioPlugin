import Replicate from "replicate";

// A network wait timeout is not a cancellation confirmation. The workflow stores
// submission_unknown after an ambiguous creation response and never retries it as
// a new prediction automatically. Cancel-After bounds the remote computation.
export function predictionClient(token: string): Replicate {
  const networkFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    const method = init?.method || (input instanceof Request ? input.method : "GET");
    if (url.hostname === "api.replicate.com" && method === "POST" && /\/predictions$/.test(url.pathname)) {
      headers.set("Cancel-After", "10m");
    }
    const timeout = AbortSignal.timeout(method === "GET" ? 30000 : 120000);
    const supplied = init?.signal || (input instanceof Request ? input.signal : undefined);
    return fetch(input, { ...init, headers, signal: supplied ? AbortSignal.any([supplied, timeout]) : timeout });
  };
  return new Replicate({ auth: token, fetch: networkFetch });
}
