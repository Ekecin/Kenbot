// A tiny in-memory fixed-window limiter. It is a first line of defence on one server instance;
// serverless hosts run many instances and restart them, so for hard guarantees use a shared
// store (for example Upstash Redis or a Supabase table) behind the same function.

type Bucket = { count: number; resetAt: number };
const store = new Map<string, Bucket>();

function sweep(now: number): void {
  if (store.size < 4000) return;
  for (const [key, bucket] of store) if (bucket.resetAt < now) store.delete(key);
}

/** Count `cost` against `key`. Returns false (and counts nothing) if that would exceed `limit`. */
export function allow(key: string, limit: number, windowMs: number, cost = 1): boolean {
  const now = Date.now();
  sweep(now);
  const bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (cost > limit) return false;
    store.set(key, { count: cost, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count + cost > limit) return false;
  bucket.count += cost;
  return true;
}
