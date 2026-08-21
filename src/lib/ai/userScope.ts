import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request AI caller identity.
 *
 * `/api/ai/*` uses the service-role key, which bypasses RLS. Every retrieval
 * path, tool query, and SECURITY DEFINER RPC must therefore take an explicit
 * user id from a verified JWT — never from the request body. This store is
 * how tool executors (which don't all take a userId param) see that id.
 *
 * Enter it with `runAsUser` at the API-route boundary. `uid()` throws if a
 * query runs outside that scope, so a missed wrap fails closed instead of
 * searching the whole corpus.
 */
const aiUser = new AsyncLocalStorage<string>();

export function runAsUser<T>(userId: string, fn: () => T): T {
  return aiUser.run(userId, fn);
}

export function uid(): string {
  const id = aiUser.getStore();
  if (!id) {
    throw new Error("AI data access outside user scope");
  }
  return id;
}
