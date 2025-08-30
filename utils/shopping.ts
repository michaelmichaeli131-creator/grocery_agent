import { getCache, setCache } from "./cache.ts";

const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY")!;

async function fetchJson(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function serpApiShopping(q: string, language = "he") {
  const key = `serp:${language}:${q}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(q)}&hl=${language}&api_key=${SERPAPI_KEY}`;
  const json = await fetchJson(url);
  const items = (json.shopping_results || []).map((it: any) => ({
    title: it.title,
    price: it.extracted_price ?? null,
    currency: it.currency ?? "ILS",
    link: it.product_link ?? it.link ?? null,
    source: it.source ?? it.merchant ?? null
  }));
  setCache(key, items, 30_000);
  return items;
}

async function fetchPricezSnippet(product: string, language = "he") {
  const key = `pricez:${language}:${product}`;
  const cached = getCache(key);
  if (cached) return cached;
  try {
    const url = `https://www.pricez.co.il/Search?query=${encodeURIComponent(product)}`;
    const res = await fetch(url, { headers: { "User-Agent": "grocery-agent/1.0 (+contact@example.com)" } });
    if (!res.ok) return null;
    const text = await res.text();
    const snippet = text.slice(0, 4000); // snippet only; בייצור — לנתח DOM
    setCache(key, snippet, 60_000);
    return snippet;
  } catch {
    return null;
  }
}

export async function queryStoreItems(
  stores: Array<{name:string; place_id:string; address:string; location:{lat:number; lng:number}}>,
  items: string[],
  language = "he"
) {
  const results: any[] = [];

  // הגבלת מקביליות פשוטה
  const concurrency = 6;
  let running = 0;
  const queue: Array<() => Promise<void>> = [];

  function throttle<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise(async (resolve) => {
      const exec = async () => {
        running++;
        try {
          resolve(await fn());
        } finally {
          running--;
          if (queue.length) queue.shift()!();
        }
      };
      if (running < concurrency) exec();
      else queue.push(exec);
    });
  }

  for (const store of stores) {
    const entry: any = { supermarket: store.name, place_id: store.place_id, address: store.address, location: store.location, items: [] };

    for (const item of items) {
      await throttle(async () => {
        const q = `${item} ${store.name}`;
        const serp = await serpApiShopping(q, language).catch(() => []);
        const pricez = await fetchPricezSnippet(item, language).catch(() => null);
        entry.items.push({ query: item, serp, pricez });
      });
    }
    results.push(entry);
  }

  return results;
}
