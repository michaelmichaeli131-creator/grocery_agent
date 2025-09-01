// server.ts — PRO: סטטי + API עם Places משופר, SerpAPI מרובה-מועמדים, LLM נירמול/איחוד,
// קאש, רטריי, קונקרנציה, החזרת top3 וגם baskets מלאים.

// לוקאלית בלבד (.env). ב-Deno Deploy מגדירים Environment Variables בלוח הבקרה.
if (!Deno.env.get("DENO_DEPLOYMENT_ID")) {
  try {
    const { load } = await import("https://deno.land/std@0.201.0/dotenv/mod.ts");
    load({ export: true });
  } catch {}
}

/* ===================== ENV & CONSTANTS ===================== */
const PORT = Number(Deno.env.get("PORT") ?? "8000");
const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") ?? "";
const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? ""; // אופציונלי
const MAX_SUPERMARKETS = Number(Deno.env.get("MAX_SUPERMARKETS") ?? "20");
const SERPAPI_MAX_CANDIDATES = Number(Deno.env.get("SERPAPI_MAX_CANDIDATES") ?? "6");
const SERPAPI_CONCURRENCY = Number(Deno.env.get("SERPAPI_CONCURRENCY") ?? "4");
const CACHE_TTL_MS = Number(Deno.env.get("CACHE_TTL_MS") ?? "120000"); // 2 דקות
const GEO_TTL_MS = Number(Deno.env.get("GEO_TTL_MS") ?? "600000"); // 10 דקות
const PLACES_TTL_MS = Number(Deno.env.get("PLACES_TTL_MS") ?? "600000"); // 10 דקות
const LLM_ENABLE_NORMALIZE = (Deno.env.get("LLM_ENABLE_NORMALIZE") ?? "1") === "1";
const LLM_ENABLE_CONSOLIDATE = (Deno.env.get("LLM_ENABLE_CONSOLIDATE") ?? "1") === "1";

/* ===================== UTILITIES ===================== */
type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
async function fetchWithRetry(url: string, init: RequestInit = {}, tries = 3, backoffMs = 400) {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      lastErr = e;
      await sleep(backoffMs * (i + 1));
    }
  }
  throw lastErr;
}
async function safeJson(url: string, init?: RequestInit, tries = 3) {
  const r = await fetchWithRetry(url, init, tries);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { throw new Error(`Invalid JSON from ${url}`); }
}

// In-memory cache
const memCache = new Map<string, { exp: number; data: unknown }>();
function cacheGet<T>(k: string): T | null {
  const rec = memCache.get(k);
  if (!rec) return null;
  if (Date.now() > rec.exp) { memCache.delete(k); return null; }
  return rec.data as T;
}
function cacheSet(k: string, data: unknown, ttl = CACHE_TTL_MS) {
  memCache.set(k, { exp: Date.now() + ttl, data });
}

/* ===================== CHAINS MAP & HELPERS ===================== */
type NearbyShop = {
  chain: string;
  name: string;
  address?: string;
  lat: number; lng: number;
  place_id: string;
  rating?: number;
};

const CHAIN_MAP: Record<string, string[]> = {
  "Shufersal": ["shufersal.co.il","שופרסל","shufersal"],
  "Rami Levy": ["ramilevy.co.il","רמי לוי","rami levy"],
  "Yohananof": ["yoh.co.il","יוחננוף","yohananof"],
  "Victory": ["victoryonline.co.il","ויקטורי","victory"],
  "Tiv Taam": ["tivtaam.co.il","טיב טעם","tiv taam"],
  "Yenot Bitan": ["yenotbitan.co.il","יינות ביתן","yenot bitan"],
  "Mahsanei Hashuk": ["hashuk.co.il","מחסני השוק","mahsanei hashuk"],
  "Super-Pharm": ["super-pharm.co.il","סופר-פארם","super pharm"],
  "Mega": ["mega.co.il","מגה","mega"],
};

function normalizeChainName(raw: string): string {
  const n = (raw || "").toLowerCase();
  for (const chain in CHAIN_MAP) {
    if (CHAIN_MAP[chain].some(alias => n.includes(alias.toLowerCase()))) return chain;
  }
  return raw || "Unknown";
}

/* ===================== GOOGLE MAPS ===================== */
async function geocode(address: string) {
  const ck = `geo:${address}`;
  const hit = cacheGet<any>(ck);
  if (hit) return hit;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`;
  const data = await safeJson(url, {}, 3);
  const loc = data?.results?.[0]?.geometry?.location;
  if (!loc) throw new Error("Address not found");
  cacheSet(ck, loc, GEO_TTL_MS);
  return loc; // { lat, lng }
}

async function placesNearbyAllPages(lat: number, lng: number, radius: number, type: string) {
  const all: any[] = [];
  let pagetoken: string | undefined;
  for (let i = 0; i < 3; i++) { // עד 3 עמודים
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=${type}&key=${GOOGLE_API_KEY}${pagetoken ? `&pagetoken=${pagetoken}` : ""}`;
    const data = await safeJson(url, {}, 3);
    all.push(...(data?.results ?? []));
    pagetoken = data?.next_page_token;
    if (!pagetoken) break;
    await sleep(2000); // לפי דרישת Places לפני שימוש ב-page_token
  }
  return all;
}

async function placesTextSearch(lat: number, lng: number, radius: number, query: string) {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=${lat},${lng}&radius=${radius}&key=${GOOGLE_API_KEY}`;
  const data = await safeJson(url, {}, 3);
  return data?.results ?? [];
}

async function findNearbySupermarkets(address: string, radiusKm: number): Promise<NearbyShop[]> {
  if (!GOOGLE_API_KEY) throw new Error("Missing GOOGLE_API_KEY");
  const { lat, lng } = await geocode(address);
  const radius = Math.round(radiusKm * 1000);
  const ck = `places:${lat},${lng}:${radius}`;
  const cached = cacheGet<NearbyShop[]>(ck);
  if (cached) return cached;

  const types = ["supermarket", "grocery_or_supermarket", "store"];
  const seen = new Map<string, NearbyShop>();

  for (const t of types) {
    const arr = await placesNearbyAllPages(lat, lng, radius, t);
    for (const r of arr) {
      const place_id = r?.place_id;
      if (!place_id) continue;
      const name = r?.name ?? "";
      seen.set(place_id, {
        chain: normalizeChainName(name),
        name,
        address: r?.vicinity,
        lat: r?.geometry?.location?.lat,
        lng: r?.geometry?.location?.lng,
        place_id,
        rating: r?.rating,
      });
    }
  }

  // הרחבה עם TextSearch "supermarket" לקבלת תוצאות נוספות
  const txt = await placesTextSearch(lat, lng, radius, "supermarket");
  for (const r of txt) {
    const place_id = r?.place_id;
    if (!place_id) continue;
    if (seen.has(place_id)) continue;
    const name = r?.name ?? "";
    seen.set(place_id, {
      chain: normalizeChainName(name),
      name,
      address: r?.formatted_address ?? r?.vicinity,
      lat: r?.geometry?.location?.lat,
      lng: r?.geometry?.location?.lng,
      place_id,
      rating: r?.rating,
    });
  }

  const all = Array.from(seen.values());
  // העדף רשתות שממופות ב-CHAIN_MAP
  const known = all.filter(s => CHAIN_MAP[s.chain]);
  const result = (known.length ? known : all).slice(0, MAX_SUPERMARKETS);
  cacheSet(ck, result, PLACES_TTL_MS);
  return result;
}

/* ===================== SERPAPI (Google Shopping) ===================== */
type PriceCandidate = {
  itemQuery: string;
  title: string;
  description?: string;
  price: number | null;
  currency: string;
  link?: string;
  merchant?: string;
  source: "serpapi";
};

function extractNumber(x: unknown): number | null {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const n = Number(x.replace(/[^\d.]/g, ""));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
function candidateFromSerp(r: any, query: string): PriceCandidate | null {
  const price =
    extractNumber(r?.extracted_price) ??
    extractNumber(r?.price) ??
    extractNumber(r?.prices?.[0]?.price) ??
    extractNumber(r?.prices?.[0]?.extracted_price);

  const title = String(r?.title ?? "");
  const desc = String(r?.snippet ?? r?.description ?? "") || undefined;
  const currency = r?.currency ?? r?.prices?.[0]?.currency ?? "ILS";
  return {
    itemQuery: query,
    title,
    description: desc,
    price: price ?? null,
    currency,
    link: r?.link,
    merchant: r?.source ?? r?.merchant ?? r?.seller ?? undefined,
    source: "serpapi",
  };
}

async function serpSearchCandidatesForChain(query: string, chain: string): Promise<PriceCandidate[]> {
  if (!SERPAPI_KEY) throw new Error("Missing SERPAPI_KEY");
  const ck = `serp:${chain}:${query}`;
  const hit = cacheGet<PriceCandidate[]>(ck);
  if (hit) return hit;

  const q = `${query} ${chain}`;
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(q)}&hl=iw&gl=il&num=40&api_key=${SERPAPI_KEY}`;
  const data = await safeJson(url, {}, 3);
  const results: any[] = data?.shopping_results ?? [];
  if (!results.length) { cacheSet(ck, [], CACHE_TTL_MS); return []; }

  const aliases = CHAIN_MAP[chain] ?? [];
  const filtered = results.filter((r) => {
    if (!aliases.length) return true;
    const merchant = String(r?.source ?? r?.merchant ?? r?.seller ?? "").toLowerCase();
    const title = String(r?.title ?? "").toLowerCase();
    return aliases.some(a => merchant.includes(a.toLowerCase()) || title.includes(a.toLowerCase()));
  });

  const pool = (filtered.length ? filtered : results)
    .map(r => candidateFromSerp(r, query))
    .filter(Boolean) as PriceCandidate[];

  const out = pool.slice(0, SERPAPI_MAX_CANDIDATES);
  cacheSet(ck, out, CACHE_TTL_MS);
  return out;
}

/* ===================== LLM HELPERS ===================== */
// נירמול פריטים (אופציונלי) — החזרת מחרוזות נקיות וקצרות (ללא המצאת מחירים)
async function normalizeItemsWithLLM(items: string[]): Promise<string[]> {
  if (!OPENAI_API_KEY || !LLM_ENABLE_NORMALIZE) return items;
  const prompt = [
    "Normalize the following grocery items (Hebrew or English) into short generic product queries.",
    "Preserve explicit sizes/brands if provided (e.g., '1.5L', '6-pack', 'Coca-Cola Zero 1.5L').",
    "Return ONLY a JSON array of strings. No explanations.",
    `Items: ${JSON.stringify(items)}`
  ].join("\n");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) return items;
  const j = await r.json();
  try {
    const content = j?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    const arr = parsed?.items ?? parsed;
    return Array.isArray(arr) ? arr.map((s: any) => String(s)) : items;
  } catch { return items; }
}

// איחוד/בחירה עם LLM — בוחר את המועמד המתאים פר תיאור/גודל ומחשב טופ-3 (ללא המצאות)
type ChainPricing = { chain: string; items: { query: string; candidates: PriceCandidate[] }[]; };
async function consolidateWithLLM(nearby: NearbyShop[], multi: ChainPricing[]) {
  if (!OPENAI_API_KEY || !LLM_ENABLE_CONSOLIDATE) return null;
  const sys = [
    "You are a strict JSON generator for shopping basket comparison.",
    "You MUST NOT invent prices. Only select from provided candidates.",
    "For each requested item in each chain, choose the best candidate by title/description relevance (size/brand).",
    "If no suitable candidate exists, set price:null and substitute:true for that line.",
    "Output pure JSON with keys: top3 (array), baskets (array), warnings (array).",
    "Each basket: { chain, shop_display_name, total, currency:'ILS', breakdown:[{ item, chosen_title, description, price|null, currency:'ILS', substitute:boolean, source:'serpapi', link?, merchant? }], location:{ name,address,lat,lng } }",
    "Consider only chains that appear in NEARBY_SHOPS input.",
    "Do NOT browse the web. Do NOT estimate prices.",
  ].join("\n");

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
        { type: "text", text: "NEARBY_SHOPS JSON:" },
        { type: "text", text: JSON.stringify(nearby).slice(0, 100000) },
        { type: "text", text: "\nCHAIN_PRICING_CANDIDATES JSON:" },
        { type: "text", text: JSON.stringify(multi).slice(0, 100000) },
      ]},
    ],
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) return null;
  const j = await r.json();
  try {
    const content = j?.choices?.[0]?.message?.content ?? "{}";
    return JSON.parse(content);
  } catch { return null; }
}

/* ===================== PRICING PIPELINE ===================== */
async function buildCandidates(items: string[], chains: string[]): Promise<ChainPricing[]> {
  const out: ChainPricing[] = chains.map((chain) => ({ chain, items: [] }));

  // פייפליין עם קונקרנציה מוגבלת
  const queue: Promise<void>[] = [];
  for (const pack of out) {
    for (const q of items) {
      const task = (async () => {
        const cands = await serpSearchCandidatesForChain(q, pack.chain).catch(() => []);
        pack.items.push({ query: q, candidates: cands });
        await sleep(150);
      })();
      queue.push(task);
      if (queue.length % SERPAPI_CONCURRENCY === 0) {
        await Promise.race(queue.slice(-SERPAPI_CONCURRENCY));
      }
    }
  }
  await Promise.all(queue);
  return out;
}

function localPickBaskets(nearby: NearbyShop[], multi: ChainPricing[]) {
  // בוחר לכל פריט את המועמד הזול ביותר (אם אין — substitute)
  const baskets = multi.map((pack) => {
    const breakdown = pack.items.map(({ query, candidates }) => {
      let best: PriceCandidate | null = null;
      for (const c of candidates) {
        if (c.price == null) continue;
        if (!best || c.price < (best.price ?? Infinity)) best = c;
      }
      if (!best) {
        const c0 = candidates[0];
        return {
          item: query,
          chosen_title: c0?.title ?? query,
          description: c0?.description ?? null,
          price: null,
          currency: (c0?.currency ?? "ILS"),
          substitute: true,
          source: "serpapi",
          link: c0?.link,
          merchant: c0?.merchant ?? null,
        };
      }
      return {
        item: query,
        chosen_title: best.title,
        description: best.description ?? null,
        price: best.price,
        currency: best.currency,
        substitute: false,
        source: "serpapi",
        link: best.link,
        merchant: best.merchant ?? null,
      };
    });

    const total = breakdown.reduce((s, b) => s + (b.price ?? 0), 0);
    const loc = nearby.find(n => n.chain === pack.chain) || null;
    return {
      chain: pack.chain,
      shop_display_name: loc?.name ?? pack.chain,
      total,
      currency: "ILS",
      breakdown,
      location: loc ? { name: loc.name, address: loc.address, lat: loc.lat, lng: loc.lng } : null,
    };
  });

  baskets.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
  const top3 = baskets.slice(0, 3);
  return { baskets, top3 };
}

/* ===================== API ROUTER ===================== */
async function handleApi(req: Request) {
  const { pathname } = new URL(req.url);

  try {
    if (pathname === "/api/health") {
      return json({
        ok: true,
        present: {
          GOOGLE_API_KEY: !!GOOGLE_API_KEY,
          SERPAPI_KEY: !!SERPAPI_KEY,
          OPENAI_API_KEY: !!OPENAI_API_KEY,
        },
      });
    }

    if (pathname === "/api/plan" && req.method === "POST") {
      const { address, radiusKm = 15, items = [] } = await req.json();
      if (!address || !Array.isArray(items) || items.length === 0) {
        return json({ ok: false, error: "Missing address or items" }, 400);
      }

      // 1) מצא סופרים/רשתות בקרבת הכתובת
      const nearby = await findNearbySupermarkets(address, Number(radiusKm));
      const chains = Array.from(new Set(nearby.map(n => n.chain))).slice(0, MAX_SUPERMARKETS);

      // 2) נירמול שאילתות (אופציונלי עם LLM)
      const normalizedItems = await normalizeItemsWithLLM(items);

      // 3) איסוף מועמדים לכל פריט/רשת
      const multi = await buildCandidates(normalizedItems, chains);

      // 4) איחוד עם LLM (בחירה על סמך תיאור/גודל), אם אפשר
      const llm = await consolidateWithLLM(nearby, multi).catch(() => null);
      if (llm?.baskets?.length) {
        // ודא מיון טופ-3
        const baskets = llm.baskets.sort((a: any, b: any) => (a.total ?? Infinity) - (b.total ?? Infinity));
        const top3 = (llm.top3?.length ? llm.top3 : baskets.slice(0, 3));
        return json({ ok: true, mode: "llm", top3, baskets, warnings: llm.warnings ?? [] });
      }

      // 5) Fallback לוקאלי
      const { baskets, top3 } = localPickBaskets(nearby, multi);
      return json({ ok: true, mode: "local", top3, baskets, warnings: ["LLM disabled/unavailable; using local cheapest candidates"] });
    }

    return json({ ok: false, error: "Not found" }, 404);
  } catch (e) {
    console.error("API ERROR:", e);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
}

/* ===================== STATIC SERVER ===================== */
async function serveStatic(pathname: string) {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const url = new URL(`file://${Deno.cwd()}/public${filePath}`);
  try {
    const file = await Deno.readFile(url);
    const ext = (filePath.split(".").pop() ?? "").toLowerCase();
    const ct = ({
      html: "text/html; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      css: "text/css; charset=utf-8",
      json: "application/json; charset=utf-8",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      svg: "image/svg+xml",
    } as Record<string, string>)[ext] ?? "application/octet-stream";
    return new Response(file, { headers: { "content-type": ct } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

/* ===================== SERVER ===================== */
Deno.serve({ port: PORT }, (req) => {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith("/api/")) return handleApi(req);
  return serveStatic(pathname);
});
