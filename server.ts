// server.ts
import { Application, Router, Context } from "https://deno.land/x/oak@v12.5.0/mod.ts";
import { config as loadEnv } from "https://deno.land/std@0.201.0/dotenv/mod.ts";

const env = await loadEnv({ export: true });
const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") ?? env.GOOGLE_API_KEY;
const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY") ?? env.SERPAPI_KEY;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? env.OPENAI_API_KEY;
const PORT = Number(Deno.env.get("PORT") ?? env.PORT ?? 8000);
const CACHE_TTL_MS = Number(Deno.env.get("CACHE_TTL_MS") ?? env.CACHE_TTL_MS ?? 60_000);
const MAX_SUPERMARKETS = Number(Deno.env.get("MAX_SUPERMARKETS") ?? env.MAX_SUPERMARKETS ?? 6);

if (!GOOGLE_API_KEY || !SERPAPI_KEY || !OPENAI_API_KEY) {
  console.error("Set GOOGLE_API_KEY, SERPAPI_KEY and OPENAI_API_KEY in env");
  Deno.exit(1);
}

const app = new Application();
const router = new Router();

/* ---------------------
   Simple in-memory cache
   --------------------- */
type CacheItem = { value: any; expiresAt: number };
const cache = new Map<string, CacheItem>();
function setCache(key: string, val: any, ttl = CACHE_TTL_MS) {
  cache.set(key, { value: val, expiresAt: Date.now() + ttl });
}
function getCache(key: string) {
  const it = cache.get(key);
  if (!it) return null;
  if (Date.now() > it.expiresAt) { cache.delete(key); return null; }
  return it.value;
}

/* ---------------------
   Helpers
   --------------------- */
async function fetchJson(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Request failed ${res.status} ${txt}`);
  }
  return await res.json();
}

/* 1) Geocode address */
async function geocode(address: string) {
  const key = `geocode:${address}`;
  const cached = getCache(key);
  if (cached) return cached;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`;
  const json = await fetchJson(url);
  if (!json.results || json.results.length === 0) throw new Error("Geocode: no results");
  const loc = json.results[0].geometry.location;
  setCache(key, loc, 5 * 60_000);
  return loc;
}

/* 2) Find supermarkets via Google Places Nearby Search (New) */
async function findSupermarkets(lat: number, lng: number, radiusMeters: number, chainFilter: string[] = []) {
  const key = `nearby:${lat}:${lng}:${radiusMeters}:${chainFilter.join(",")}`;
  const cached = getCache(key);
  if (cached) return cached;

  // Nearby Search (New) supports POST; but the old endpoint is used across many examples.
  // We'll call the 'nearbysearch' webservice for simplicity:
  const type = "grocery_or_supermarket";
  const keyword = chainFilter.length ? `&keyword=${encodeURIComponent(chainFilter.join("|"))}` : "";
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radiusMeters}&type=${type}${keyword}&key=${GOOGLE_API_KEY}`;

  const json = await fetchJson(url);
  const results = (json.results || []).map((r: any) => ({
    name: r.name,
    place_id: r.place_id,
    address: r.vicinity ?? r.formatted_address,
    location: r.geometry?.location,
  }));
  setCache(key, results, 2 * 60_000);
  return results;
}

/* 3) SerpApi Google Shopping query for product (optionally filter by merchant) */
async function serpApiSearch(product: string, merchant?: string) {
  const key = `serp:${product}:${merchant ?? ""}`;
  const cached = getCache(key);
  if (cached) return cached;

  const base = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(product)}&api_key=${SERPAPI_KEY}`;
  const url = merchant ? base + `&merchant=${encodeURIComponent(merchant)}` : base;
  const json = await fetchJson(url);
  // Normalize shopping results
  const items = (json.shopping_results || []).map((it: any) => ({
    title: it.title,
    price: it.extracted_price ?? it.price ?? null,
    currency: it.currency ?? "ILS",
    link: it.product_link ?? it.link ?? null,
    source: it.source ?? it.merchant ?? null
  }));
  setCache(key, items, 30_000);
  return items;
}

/* 4) Pricez / CHP — gentle fetch placeholders (in prod: integrate commercial APIs or signed endpoints) */
async function fetchPricezSnippet(product: string) {
  const key = `pricez:${product}`;
  const cached = getCache(key);
  if (cached) return cached;
  try {
    const url = `https://www.pricez.co.il/Search?query=${encodeURIComponent(product)}`;
    const res = await fetch(url, { headers: { "User-Agent": "grocery-compare-bot/1.0 (+your-email@example.com)" }});
    if (!res.ok) return null;
    const text = await res.text();
    const snippet = text.slice(0, 3000);
    setCache(key, snippet, 60_000);
    return snippet;
  } catch (e) {
    console.warn("pricez fetch err", e);
    return null;
  }
}

/* 5) Call OpenAI Responses API to parse & unify JSON */
async function openaiParseUnified(payload: any) {
  const url = "https://api.openai.com/v1/responses";
  // system instruction: strict JSON, do not invent prices
  const systemPrompt = `You are a strict JSON parser. Input is an object containing:
- location (lat,lng)
- requested_items (array)
- supermarkets (array) where each has items with serp results and pricez snippet
Produce EXACT JSON: { results: [ { supermarket, total_price (number|null), currency, distance_km|null, items: [ { name, price (number|null), source, link|null } ] } ] }
Do NOT invent numeric prices. If price not found set price:null. Sort results by total_price ascending (nulls last). Respond with JSON only.`;

  const body = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(payload) }
    ],
    temperature: 0,
    max_tokens: 1500
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error("OpenAI error: " + res.status + " " + t);
  }
  const json = await res.json();
  // safe extraction: Responses API may include output textual content at json.output
  // Try to find text content and parse as JSON
  let text = "";
  if (json.output && Array.isArray(json.output)) {
    for (const o of json.output) {
      if (o.content && Array.isArray(o.content)) {
        for (const c of o.content) {
          if (c.type === "output_text" && c.text) text += c.text;
          else if (c.type === "message" && c.text) text += c.text;
        }
      }
    }
  } else if (json.choices && json.choices[0]?.message?.content) {
    text = json.choices[0].message.content;
  } else {
    text = JSON.stringify(json);
  }

  // Try parse
  try {
    return JSON.parse(text);
  } catch (e) {
    return { error: "openai_parse_failed", raw: text };
  }
}

/* ---------------------
   Main /api/search handler
   --------------------- */
router.post("/api/search", async (ctx: Context) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { address, radius_km = 2, items = [], language = "he", chain_filter = [] } = body;
    if (!address || !Array.isArray(items) || items.length === 0) {
      ctx.response.status = 400;
      ctx.response.body = { error: "address and items[] required" };
      return;
    }

    const loc = await geocode(address);
    const radiusMeters = Math.round(radius_km * 1000);
    const supermarkets = await findSupermarkets(loc.lat, loc.lng, radiusMeters, chain_filter);
    const candidates = supermarkets.slice(0, MAX_SUPERMARKETS);

    // For each supermarket, for each item run SerpApi + Pricez snippet in parallel (bounded concurrency)
    const concurrency = 6;
    const sem = { running: 0 };
    async function throttle<T>(fn: () => Promise<T>): Promise<T> {
      while (sem.running >= concurrency) await new Promise(r => setTimeout(r, 50));
      sem.running++;
      try {
        return await fn();
      } finally {
        sem.running--;
      }
    }

    const supermarketEntries: any[] = [];
    for (const sm of candidates) {
      const entry: any = { supermarket: sm.name, place_id: sm.place_id, address: sm.address, location: sm.location, items: [] };
      for (const it of items) {
        const job = async () => {
          const serp = await serpApiSearch(it, sm.name).catch(() => []);
          const pricez = await fetchPricezSnippet(it).catch(() => null);
          return { query: it, serp, pricez };
        };
        const result = await throttle(job);
        entry.items.push(result);
      }
      supermarketEntries.push(entry);
    }

    // Build payload for OpenAI
    const payload = { location: loc, requested_items: items, supermarkets: supermarketEntries };
    const parsed = await openaiParseUnified(payload);

    ctx.response.status = 200;
    ctx.response.body = { meta: { ts: new Date().toISOString() }, input: { address, radius_km, items }, parsed };

  } catch (e) {
    console.error("search error", e);
    ctx.response.status = 500;
    ctx.response.body = { error: e.message };
  }
});

/* static client */
router.get("/", async (ctx) => {
  ctx.response.headers.set("content-type", "text/html; charset=utf-8");
  ctx.response.body = await Deno.readTextFile("./static/index.html");
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server listening on http://localhost:" + PORT);
await app.listen({ port: PORT });
