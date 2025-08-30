type CacheItem = { value: any; expiresAt: number };
const cache = new Map<string, CacheItem>();

const DEFAULT_TTL = Number(Deno.env.get("CACHE_TTL_MS") ?? 60_000);

export function setCache(key: string, value: any, ttlMs = DEFAULT_TTL) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
export function getCache<T = any>(key: string): T | null {
  const it = cache.get(key);
  if (!it) return null;
  if (Date.now() > it.expiresAt) { cache.delete(key); return null; }
  return it.value as T;
}
