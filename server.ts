// server.ts — PRO+Sources+CHP
// - Places משופר (עוד סוגים + TextSearch).
// - SerpAPI Shopping עם יותר מועמדים + הצגת מקור (merchant+domain+link).
// - SerpAPI Google Web ל-CHP (site:chp.co.il) כחיזוק מקורות, כולל חילוץ מחיר אם קיים.
// - LLM (אופציונלי) לנירמול/בחירה, בלי "המצאות" מחירים.
// - החזרה של baskets מלא + top3. ה-Frontend מציג מקור לכל פריט.

// .env לוקאלי בלבד
if (!Deno.env.get("DENO_DEPLOYMENT_ID")) {
  try {
    const { load } = await import("https://deno.land/std@0.201.0/dotenv/mod.ts");
    load({ export: true });
  } catch {}
}

/* ========= ENV ========= */
const PORT = Number(Deno.env.get("PORT") ?? "8000");
const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") ?? "";
const SERPAPI_KEY = Deno.env.get("SERPAPI_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const MAX_SUPERMARKETS = Number(Deno.env.get("MAX_SUPERMARKETS") ?? "20");
const SERPAPI_MAX_CANDIDATES = Number(Deno.env.get("SERPAPI_MAX_CANDIDATES") ?? "12"); // ⬅️ הוגדל
const SERPAPI_CONCURRENCY = Number(Deno.env.get("SERPAPI_CONCURRENCY") ?? "5");
const CACHE_TTL_MS = Number(Deno.env.get("CACHE_TTL_MS") ?? "180000"); // 3m
const GEO_TTL_MS = Number(Deno.env.get("GEO_TTL_MS") ?? "900000"); // 15m
const PLACES_TTL_MS = Number(Deno.env.get("PLACES_TTL_MS") ?? "900000"); // 15m

const LLM_ENABLE_NORMALIZE = (Deno.env.get("LLM_ENABLE_NORMALIZE") ?? "1") === "1";
const LLM_ENABLE_CONSOLIDATE = (Deno.env.get("LLM_ENABLE_CONSOLIDATE") ?? "1") === "1";

// CHP web search toggle
const ENABLE_CHP = (Deno.env.get("ENABLE_CHP") ?? "1") === "1";
const CHP_SITE = Deno.env.get("CHP_SITE") ?? "chp.co.il";

/* ========= UTILS ========= */
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
function hostnameFromUrl(u?: string): string | undefined {
  try { return u ? new URL(u).hostname.replace(/^www\./,'') : undefined; } catch { return undefined; }
}
function extractNumber(x: unknown): number | null {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const n = Number(x.replace(/[^\d.]/g, ""));
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

// cache
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

/* ========= CHAINS ========= */
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

/* ========= GOOGLE MAPS ========= */
async function geocode(address: string) {
  const ck = `geo:${address}`;
  const hit = cacheGet<any>(ck);
  if (hit) return hit;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`;
  const data = await safeJson(url, {}, 3);
  const loc = data?.results?.[0]?.geometry?.location;
  if (!loc) throw new Error("Address not found");
  cacheSet(ck, loc, GEO_TTL_MS);
  return loc;
}

async function placesNearbyAllPages(lat: number, lng: number, radius: number, type: string) {
  const all: any[] = [];
  let pagetoken: string | undefined;
  for (let i = 0; i < 3; i++) {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=${type}&key=${GOOGLE_API_KEY}${pagetoken ? `&pagetoken=${pagetoken}` : ""}`;
    const data = await safeJson(url, {}, 3);
    all.push(...(data?.results ?? []));
    pagetoken = data?.next_page_token;
    if (!pagetoken) break;
    await sleep(2000);
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
  const known = all.filter(s => CHAIN_MAP[s.chain]);
  const result = (known.length ? known : all).slice(0, MAX_SUPERMARKETS);
  cacheSet(ck, result, PLACES_TTL_MS);
  return result;
}

/* ========= SERPAPI SHOPPING + CHP ========= */
type PriceCandidate = {
  itemQuery: string;
  title: string;
  description?: string;
  price: number | null;
  currency: string;
  link?: string;
  merchant?: string;
  domain?: string;
  source: "serpapi" | "chp";
};

function candidateFromShopping(r: any, query: string): PriceCandidate | null {
  const price =
    extractNumber(r?.extracted_price) ??
    extractNumber(r?.price) ??
    extractNumber(r?.prices?.[0]?.price) ??
    extractNumber(r?.prices?.[0]?.extracted_price);

  const title = String(r?.title ?? "");
  const desc = String(r?.snippet ?? r?.description ?? "") || undefined;
  const currency = r?.currency ?? r?.prices?.[0]?.currency ?? "ILS";
  const link = r?.link;
  return {
    itemQuery: query,
    title,
    description: desc,
    price: price ?? null,
    currency,
    link,
    merchant: r?.source ?? r?.merchant ?? r?.seller ?? undefined,
    domain: hostnameFromUrl(link),
    source: "serpapi",
  };
}

async function serpShoppingCandidates(query: string, chain: string): Promise<PriceCandidate[]> {
  const q = `${query} ${chain}`;
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(q)}&hl=iw&gl=il&num=50&api_key=${SERPAPI_KEY}`;
  const data = await safeJson(url, {}, 3);
  const results: any[] = data?.shopping_results ?? [];
  if (!results.length) return [];

  const aliases = CHAIN_MAP[chain] ?? [];
  const filtered = results.filter((r) => {
    if (!aliases.length) return true;
    const merchant = String(r?.source ?? r?.merchant ?? r?.seller ?? "").toLowerCase();
    const title = String(r?.title ?? "").toLowerCase();
    const linkHost = hostnameFromUrl(r?.link) ?? "";
    return aliases.some(a =>
      merchant.includes(a.toLowerCase()) || title.includes(a.toLowerCase()) || linkHost.includes(a.toLowerCase())
    );
  });

  const pool = (filtered.length ? filtered : results)
    .map(r => candidateFromShopping(r, query))
    .filter(Boolean) as PriceCandidate[];

  // ייחוד לפי (title+domain) כדי לגוון ספקים
  const uniq = new Map<string, PriceCandidate>();
  for (const c of pool) {
    const key = `${(c.title||"").toLowerCase()}|${c.domain ?? ""}`;
    if (!uniq.has(key)) uniq.set(key, c);
    if (uniq.size >= SERPAPI_MAX_CANDIDATES) break;
  }
  return Array.from(uniq.values());
}

// CHP דרך SerpAPI Google (site:chp.co.il). מייצר מועמדים עם מקור=chp.
// מנסה לחלץ מחיר מה-snippet (₪); אם אין—מחיר null (עדיין מציג מקור+קישור).
async function serpChpCandidates(query: string, chain?: string): Promise<PriceCandidate[]> {
  if (!ENABLE_CHP) return [];
  const ck = `chp:${query}:${chain ?? ""}`;
  const hit = cacheGet<PriceCandidate[]>(ck);
  if (hit) return hit;

  const siteQ = `site:${CHP_SITE} ${query} ${chain ?? ""}`.trim();
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(siteQ)}&hl=iw&gl=il&num=10&api_key=${SERPAPI_KEY}`;
  const data = await safeJson(url, {}, 3);
  const results: any[] = data?.organic_results ?? [];
  const out: PriceCandidate[] = [];

  const priceRe = /(\d+(?:[.,]\d{1,2})?)\s*₪/; // חילוץ “₪”
  for (const r of results) {
    const title = String(r?.title ?? "");
    const snippet = String(r?.snippet ?? r?.rich_snippet?.top?.extensions?.join(" ") ?? "");
    const link = r?.link;
    const m = snippet.match(priceRe);
    const price = m ? extractNumber(m[1]) : null;

    out.push({
      itemQuery: query,
      title,
      description: snippet || undefined,
      price, // יכול להיות null אם אין ₪ בטקסט
      currency: "ILS",
      link,
      merchant: "CHP",
      domain: hostnameFromUrl(link),
      source: "chp",
    });
    if (out.length >= Math.max(6, SERPAPI_MAX_CANDIDATES - 2)) break;
  }

  cacheSet(ck, out, CACHE_TTL_MS);
  return out;
}

/* ========= LLM HELPERS ========= */
async function normalizeItemsWithLLM(items: string[]): Promise<string[]> {
  if (!OPENAI_API_KEY || !LLM_ENABLE_NORMALIZE) return items;
  const prompt = [
    "Normalize the following grocery items (Hebrew/English) into concise search queries.",
    "Keep sizes/brands if present. Output ONLY JSON {\"items\": [..]}.",
    `Items: ${JSON.stringify(items)}`
  ].join("\n");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.2, response_format:{type:"json_object"}, messages:[{role:"user",content:prompt}] }),
  });
  if (!r.ok) return items;
  const j = await r.json();
  try {
    const obj = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
    return Array.isArray(obj?.items) ? obj.items.map((s: any) => String(s)) : items;
  } catch { return items; }
}

type ChainPricing = { chain: string; items: { query: string; candidates: PriceCandidate[] }[]; };

async function consolidateWithLLM(nearby: NearbyShop[], multi: ChainPricing[]) {
  if (!OPENAI_API_KEY || !LLM_ENABLE_CONSOLIDATE) return null;
  const sys = [
    "You are a strict JSON generator for shopping basket comparison.",
    "Do NOT invent prices. Select only from provided candidates (serpapi/chp).",
    "For each requested item per chain, choose best candidate by title/description relevance (brand/size).",
    "If nothing fits, set price:null, substitute:true.",
    "Output JSON with keys: top3 (array), baskets (array), warnings (array).",
    "Each basket: { chain, shop_display_name, total, currency:'ILS', breakdown:[{ item, chosen_title, description, price|null, currency:'ILS', substitute:boolean, source:'serpapi'|'chp', link?, merchant?, domain? }], location:{ name,address,lat,lng } }",
    "Only consider chains present in NEARBY_SHOPS.",
    "No browsing the web.",
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
    return JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
  } catch { return null; }
}

/* ========= PIPELINE ========= */
async function buildCandidates(items: string[], chains: string[]): Promise<ChainPricing[]> {
  const out: ChainPricing[] = chains.map((chain) => ({ chain, items: [] }));

  const queue: Promise<void>[] = [];
  for (const pack of out) {
    for (const q of items) {
      const task = (async () => {
        const ck = `cand:${pack.chain}:${q}`;
        let cands = cacheGet<PriceCandidate[]>(ck);
        if (!cands) {
          const shopCands = await serpShoppingCandidates(q, pack.chain).catch(() => []);
          const chpCands = await serpChpCandidates(q, pack.chain).catch(() => []);
          // מיזוג, שמירה על גיוון דומיינים
          const merged = [...shopCands, ...chpCands];
          const seenKey = new Set<string>();
          cands = [];
          for (const c of merged) {
            const key = `${(c.title||"").toLowerCase()}|${c.domain ?? ""}|${c.source}`;
            if (seenKey.has(key)) continue;
            seenKey.add(key);
            cands.push(c);
            if (cands.length >= SERPAPI_MAX_CANDIDATES) break;
          }
          cacheSet(ck, cands);
        }
        pack.items.push({ query: q, candidates: cands });
        await sleep(120);
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
  const baskets = multi.map((pack) => {
    const breakdown = pack.items.map(({ query, candidates }) => {
      // בחר הזול ביותר עם מחיר, ואם אין—קח הראשון כתחליף (price:null)
      let best: PriceCandidate | null = null;
      for (const c of candidates) {
        if (c.price == null) continue;
        if (!best || c.price < (best.price ?? Infinity)) best = c;
      }
      const chosen = best ?? candidates[0] ?? null;
      if (!chosen) {
        return { item: query, chosen_title: query, description: null, price: null, currency: "ILS", substitute: true, source: "serpapi" as const };
      }
      return {
        item: query,
        chosen_title: chosen.title,
        description: chosen.description ?? null,
        price: chosen.price,
        currency: chosen.currency,
        substitute: chosen.price == null,
        source: chosen.source,
        link: chosen.link,
        merchant: chosen.merchant ?? null,
        domain: chosen.domain ?? hostnameFromUrl(chosen.link),
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

/* ========= API ========= */
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
          ENABLE_CHP: ENABLE_CHP,
        },
      });
    }

    if (pathname === "/api/plan" && req.method === "POST") {
      const { address, radiusKm = 15, items = [] } = await req.json();
      if (!address || !Array.isArray(items) || items.length === 0) {
        return json({ ok: false, error: "Missing address or items" }, 400);
      }

      const nearby = await findNearbySupermarkets(address, Number(radiusKm));
      const chains = Array.from(new Set(nearby.map(n => n.chain))).slice(0, MAX_SUPERMARKETS);

      const normalized = await normalizeItemsWithLLM(items);
      const multi = await buildCandidates(normalized, chains);

      const llm = await consolidateWithLLM(nearby, multi).catch(() => null);
      if (llm?.baskets?.length) {
        const baskets = llm.baskets.sort((a: any, b: any) => (a.total ?? Infinity) - (b.total ?? Infinity));
        const top3 = (llm.top3?.length ? llm.top3 : baskets.slice(0, 3));
        return json({ ok: true, mode: "llm", top3, baskets, warnings: llm.warnings ?? [] });
      }

      const { baskets, top3 } = localPickBaskets(nearby, multi);
      return json({ ok: true, mode: "local", top3, baskets, warnings: ["LLM unavailable; local cheapest selection used"] });
    }

    return json({ ok: false, error: "Not found" }, 404);
  } catch (e) {
    console.error("API ERROR:", e);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
}

/* ========= STATIC ========= */
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
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml",
    } as Record<string, string>)[ext] ?? "application/octet-stream";
    return new Response(file, { headers: { "content-type": ct } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

/* ========= SERVER ========= */
Deno.serve({ port: PORT }, (req) => {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith("/api/")) return handleApi(req);
  return serveStatic(pathname);
});
