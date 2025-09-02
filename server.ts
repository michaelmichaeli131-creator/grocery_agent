// server.ts — עם Debug משופר + Fallback לג׳יאוקודינג (Nominatim) + אנדפוינטים לדיבוג

// טעינת ENV מקומית בהרצה לא-Deploy
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
const SERPAPI_MAX_CANDIDATES = Number(Deno.env.get("SERPAPI_MAX_CANDIDATES") ?? "16");
const SERPAPI_CONCURRENCY = Number(Deno.env.get("SERPAPI_CONCURRENCY") ?? "6");
const CACHE_TTL_MS = Number(Deno.env.get("CACHE_TTL_MS") ?? "180000"); // 3m
const GEO_TTL_MS = Number(Deno.env.get("GEO_TTL_MS") ?? "900000");
const PLACES_TTL_MS = Number(Deno.env.get("PLACES_TTL_MS") ?? "900000");

const ENABLE_CHP = (Deno.env.get("ENABLE_CHP") ?? "1") === "1";
const CHP_SITE = Deno.env.get("CHP_SITE") ?? "chp.co.il";
const PRICEZ_SITE = Deno.env.get("PRICEZ_SITE") ?? "pricez.co.il";
const ZAP_SITE = Deno.env.get("ZAP_SITE") ?? "zap.co.il";
const CHP_WEIGHT = Number(Deno.env.get("CHP_WEIGHT") ?? "1.4");

// LLM flags
const LLM_ENABLE_NORMALIZE = (Deno.env.get("LLM_ENABLE_NORMALIZE") ?? "1") === "1";
const LLM_ENABLE_SELECT = (Deno.env.get("LLM_ENABLE_SELECT") ?? "1") === "1";
const LLM_ENABLE_CONSOLIDATE = (Deno.env.get("LLM_ENABLE_CONSOLIDATE") ?? "1") === "1";

// Schema.org scrape limits
const SCHEMA_SCRAPE_MAX_PER_ITEM = Number(Deno.env.get("SCHEMA_SCRAPE_MAX_PER_ITEM") ?? "2");
const SCHEMA_TIMEOUT_MS = Number(Deno.env.get("SCHEMA_TIMEOUT_MS") ?? "7000");

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
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(to);
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
async function safeText(url: string, init?: RequestInit, tries = 2, timeoutMs = SCHEMA_TIMEOUT_MS) {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
      await sleep(300 * (i + 1));
    }
  }
  throw lastErr;
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

/* ========= CHAINS & BRANDS ========= */
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
  "Rami Levy": ["ramilevy.co.il","רמי לוי","rami levy","rami-levy"],
  "Yohananof": ["yoh.co.il","יוחננוף","yohananof"],
  "Victory": ["victoryonline.co.il","ויקטורי","victory"],
  "Tiv Taam": ["tivtaam.co.il","טיב טעם","tiv taam"],
  "Yenot Bitan": ["yenotbitan.co.il","יינות ביתן","yenot bitan","yenot-bitan"],
  "Mahsanei Hashuk": ["hashuk.co.il","מחסני השוק","mahsanei hashuk","hashuk"],
  "Mega": ["mega.co.il","מגה","mega"],
};
const BRAND_KEYWORDS = [
  "coca cola","קוקה קולה","coca-cola","pepsi","פפסי","mei eden","מי עדן","neviot","נביעות",
  "barilla","ברילה","osem","אוסם","san benedetto","סאן בנדטו","sprite","ספרייט","fuse tea","פיוז",
  "schweppes","שוופס","tnuva","תנובה","sugat","סוגת","pasta del verona","דה ורונה"
];
function normalizeChainName(raw: string): string {
  const n = (raw || "").toLowerCase();
  for (const chain in CHAIN_MAP) {
    if (CHAIN_MAP[chain].some(alias => n.includes(alias.toLowerCase()))) return chain;
  }
  return raw || "Unknown";
}
function detectBrand(str?: string): string | undefined {
  if (!str) return undefined;
  const s = str.toLowerCase();
  const hit = BRAND_KEYWORDS.find(b => s.includes(b));
  return hit ? hit : undefined;
}

/* ========= GOOGLE MAPS ========= */
async function geocodeAddress(address: string, includeDebug = false) {
  const ck = `geo:${address}`;
  const hit = cacheGet<any>(ck);
  if (hit) return hit;

  const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`;
  let gData: any = null;
  let loc: any = null;
  let provider = "google";

  try {
    gData = await safeJson(gUrl, {}, 3);
    loc = gData?.results?.[0]?.geometry?.location;
  } catch (_) {
    // ננסה fallback
  }

  // Fallback ל־Nominatim אם אין תוצאה מגוגל
  if (!loc) {
    const nUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1&addressdetails=0`;
    try {
      const nArr = await safeJson(nUrl, { headers: { "User-Agent": "cartcompare-ai/1.0" } }, 2);
      const first = Array.isArray(nArr) ? nArr[0] : null;
      if (first?.lat && first?.lon) {
        loc = { lat: Number(first.lat), lng: Number(first.lon) };
        provider = "nominatim";
        gData = { nominatim: first };
      }
    } catch (_) { /* ignore */ }
  }

  if (!loc) {
    const err = includeDebug
      ? { message: "Address not found", geocode_debug: { url: gUrl, google_response_snippet: gData?.status ?? gData?.error_message ?? null } }
      : { message: "Address not found" };
    const e = Object.assign(new Error(err.message), { debug: (err as any).geocode_debug });
    throw e;
  }

  const out = includeDebug ? { ...loc, _debug: { provider, google_status: gData?.status ?? null } } : loc;
  cacheSet(ck, out, GEO_TTL_MS);
  return out;
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
async function findNearbySupermarketsByLatLng(lat: number, lng: number, radiusKm: number): Promise<NearbyShop[]> {
  if (!GOOGLE_API_KEY) throw new Error("Missing GOOGLE_API_KEY");
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
async function findNearbySupermarkets(address: string, radiusKm: number, includeDebug=false) {
  const { lat, lng } = await geocodeAddress(address, includeDebug) as any;
  return findNearbySupermarketsByLatLng(lat, lng, radiusKm);
}

/* ========= SERPAPI SHOPPING + WEB ========= */
type PriceCandidate = {
  itemQuery: string;
  title: string;
  description?: string;
  price: number | null;
  currency: string;
  link?: string;
  merchant?: string;
  domain?: string;
  source: "shopping" | "chp" | "web";
  product_brand?: string;
  schema_brand?: string | null;
  schema_gtin?: string | null;
  schema_name?: string | null;
  size_text?: string | null;
  unit_ml?: number | null;
  unit_g?: number | null;
  unit_per_liter?: number | null;
  unit_per_kg?: number | null;
  consensus_count?: number;
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
    source: "shopping",
    product_brand: detectBrand(title) ?? detectBrand(desc),
    schema_brand: null,
    schema_gtin: null,
    schema_name: null,
    size_text: null,
    unit_ml: null,
    unit_g: null,
    unit_per_liter: null,
    unit_per_kg: null,
    consensus_count: 0,
  };
}
function candidateFromWeb(eng: any, query: string, sourceTag: "chp"|"web"): PriceCandidate {
  const title = String(eng?.title ?? "");
  const snippet = String(eng?.snippet ?? eng?.rich_snippet?.top?.extensions?.join(" ") ?? "");
  const link = eng?.link;
  const m = snippet.match(/(\d+(?:[.,]\d{1,2})?)\s*₪/);
  const price = m ? extractNumber(m[1]) : null;
  return {
    itemQuery: query,
    title,
    description: snippet || undefined,
    price,
    currency: "ILS",
    link,
    merchant: (sourceTag === "chp") ? "CHP" : hostnameFromUrl(link),
    domain: hostnameFromUrl(link),
    source: sourceTag,
    product_brand: detectBrand(title) ?? detectBrand(snippet),
    schema_brand: null,
    schema_gtin: null,
    schema_name: null,
    size_text: null,
    unit_ml: null,
    unit_g: null,
    unit_per_liter: null,
    unit_per_kg: null,
    consensus_count: 0,
  };
}

async function serpShoppingCandidates(query: string, chain?: string): Promise<PriceCandidate[]> {
  const q = chain ? `${query} ${chain}` : query;
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(q)}&hl=iw&gl=il&num=50&api_key=${SERPAPI_KEY}`;
  const data = await safeJson(url, {}, 3);
  const results: any[] = data?.shopping_results ?? [];
  if (!results.length) return [];

  const aliases = chain ? (CHAIN_MAP[chain] ?? []) : [];
  const filtered = results.filter((r) => {
    if (!aliases.length) return true;
    const merchant = String(r?.source ?? r?.merchant ?? r?.seller ?? "").toLowerCase();
    const title = String(r?.title ?? "").toLowerCase();
    const linkHost = (hostnameFromUrl(r?.link) ?? "").toLowerCase();
    return aliases.some(a => merchant.includes(a.toLowerCase()) || title.includes(a.toLowerCase()) || linkHost.includes(a.toLowerCase()));
  });

  const pool = (filtered.length ? filtered : results)
    .map(r => candidateFromShopping(r, query))
    .filter(Boolean) as PriceCandidate[];

  const uniq = new Map<string, PriceCandidate>();
  for (const c of pool) {
    const key = `${(c.title||"").toLowerCase()}|${c.domain ?? ""}`;
    if (!uniq.has(key)) uniq.set(key, c);
    if (uniq.size >= SERPAPI_MAX_CANDIDATES) break;
  }
  return Array.from(uniq.values());
}
async function serpSiteCandidates(site: string, query: string, chain?: string, limit = 10, tag: "chp"|"web" = "web"): Promise<PriceCandidate[]> {
  const siteQ = `site:${site} ${query} ${chain ?? ""}`.trim();
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(siteQ)}&hl=iw&gl=il&num=${limit}&api_key=${SERPAPI_KEY}`;
  const data = await safeJson(url, {}, 3);
  const results: any[] = data?.organic_results ?? [];
  const out: PriceCandidate[] = [];
  for (const r of results) {
    out.push(candidateFromWeb(r, query, site === CHP_SITE ? "chp" : tag));
    if (out.length >= limit) break;
  }
  return out;
}

/* ========= SIZE & UNIT PRICE ========= */
type ParsedSize = { unit_ml?: number; unit_g?: number; pack_qty?: number; size_text?: string };
function parseSizeFromText(s?: string): ParsedSize {
  const out: ParsedSize = {};
  const text = (s || "").toLowerCase();
  const mPack = text.match(/(\d+)\s*(?:pack|x|יח'|בקבוקים|שיש(?:י|ייה))/);
  if (mPack) out.pack_qty = Number(mPack[1]);
  const mML = text.match(/(\d+(?:[.,]\d+)?)\s*ml/);
  const mL1 = text.match(/(\d+(?:[.,]\d+)?)\s*l(?!b)/);
  const mL2 = text.match(/(\d+(?:[.,]\d+)?)\s*(?:ליטר|ל׳|ל)\b/);
  if (mML) out.unit_ml = Math.round(Number(mML[1].replace(",", ".")));
  else if (mL1 || mL2) {
    const v = Number((mL1?.[1] ?? mL2?.[1] ?? "0").replace(",", "."));
    out.unit_ml = Math.round(v * 1000);
  }
  const mG = text.match(/(\d+(?:[.,]\d+)?)\s*g\b/);
  const mKG = text.match(/(\d+(?:[.,]\d+)?)\s*kg\b/);
  const mGHeb = text.match(/(\d+(?:[.,]\d+)?)\s*גר?ם/);
  const mKGHeb = text.match(/(\d+(?:[.,]\d+)?)\s*ק(?:ילו)?ג(?:רם)?/);
  if (mG || mGHeb) out.unit_g = Math.round(Number((mG?.[1] ?? mGHeb?.[1] ?? "0").replace(",", ".")));
  else if (mKG || mKGHeb) {
    const v = Number((mKG?.[1] ?? mKGHeb?.[1] ?? "0").replace(",", "."));
    out.unit_g = Math.round(v * 1000);
  }
  if (!out.unit_ml && !out.unit_g && !out.pack_qty) {
    const m15 = text.match(/\b1[.,]?5\b/);
    if (m15 && /קולה|cola|water|מים|משקה|drink|soda|sparkling|mineral/.test(text)) out.unit_ml = 1500;
    if (/פסטה|pasta/.test(text)) out.unit_g = 500;
  }
  out.size_text = s;
  return out;
}
function computeUnitPrice(price: number | null | undefined, sz: ParsedSize) {
  if (price == null || Number.isNaN(price)) return { unit_per_liter: null, unit_per_kg: null };
  let perL: number | null = null, perKG: number | null = null;
  if (sz.unit_ml) perL = (price / (sz.unit_ml / 1000));
  if (sz.unit_g) perKG = (price / (sz.unit_g / 1000));
  return { unit_per_liter: perL, unit_per_kg: perKG };
}

/* ========= SCHEMA.ORG SCRAPE ========= */
function pickProductFromSchema(json: any): any | null {
  if (!json) return null;
  const arr = Array.isArray(json) ? json : (json["@graph"] ?? []);
  const list = Array.isArray(arr) ? arr : [json];
  for (const obj of list) {
    const type = Array.isArray(obj?.["@type"]) ? obj["@type"] : [obj?.["@type"]];
    if (type && type.includes("Product")) return obj;
  }
  return null;
}
function tryJsonParse(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}
async function scrapeSchemaOrgProduct(url?: string): Promise<{
  brand?: string | null; gtin?: string | null; name?: string | null;
  offers_price?: number | null; currency?: string | null; size_text?: string | null;
} | null> {
  if (!url) return null;
  try {
    const html = await safeText(url, {}, 2, SCHEMA_TIMEOUT_MS);
    const blocks = Array.from(html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ));
    for (const m of blocks) {
      const raw = (m[1] || "").trim();
      const json = tryJsonParse(raw);
      if (!json) continue;
      const prod = pickProductFromSchema(json);
      if (!prod) continue;
      const brand = typeof prod.brand === "string" ? prod.brand : (prod.brand?.name ?? null);
      const gtin = prod.gtin ?? prod.gtin13 ?? prod.gtin14 ?? prod.gtin12 ?? prod.sku ?? null;
      const name = prod.name ?? null;
      const price = extractNumber(prod.offers?.price) ?? extractNumber(prod.offers?.lowPrice);
      const currency = prod.offers?.priceCurrency ?? prod.offers?.priceCurrency ?? null;
      const size_text = prod.size ?? prod.weight ?? prod.netContent ?? null;
      return { brand, gtin, name, offers_price: price ?? null, currency, size_text };
    }
    const gtinHit = html.match(/\b(\d{13})\b/);
    if (gtinHit) return { brand: null, gtin: gtinHit[1], name: null, offers_price: null, currency: null, size_text: null };
  } catch {}
  return null;
}

/* ========= QUERY VARIANTS ========= */
async function normalizeItemsWithLLM(items: string[]): Promise<string[]> {
  if (!OPENAI_API_KEY || !LLM_ENABLE_NORMALIZE) return items;
  const rules = [
    "חובה להחזיר JSON בלבד בצורה: {\"items\":[\"...\"]}",
    "השלם פריטים גנריים לנפח/משקל סטנדרטי בישראל:",
    "• קולה/משקה תוסס -> 1.5L",
    "• מים מינרלים -> 1.5L / שישייה (6×1.5L) אם יש רמז",
    "• פסטה יבשה -> 500 גרם",
    "שמור מותגים אם צוינו; אם לא, הוסף מותגים מובילים (ברילה/אוסם לפסטה; Coca-Cola לקולה) כווריאציות נפרדות.",
  ].join("\n");
  const prompt = `${rules}\nItems: ${JSON.stringify(items)}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.1, response_format:{type:"json_object"}, messages:[{role:"user",content:prompt}] }),
  });
  if (!r.ok) return items;
  const j = await r.json();
  try {
    const obj = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
    return Array.isArray(obj?.items) ? obj.items.map((s: any) => String(s)) : items;
  } catch { return items; }
}
function heuristicVariants(q: string): string[] {
  const out = new Set<string>();
  const base = q.trim();
  out.add(base);
  if (/^קוקה.?קולה$|^coca.?cola$/i.test(base)) { out.add(`${base} 1.5L`); out.add("Coca Cola 1.5L"); }
  if (/^פסטה$/i.test(base)) { out.add("פסטה 500 גרם"); out.add("Pasta 500g"); out.add("ברילה פסטה 500 גרם"); out.add("אוסם פסטה 500 גרם"); }
  if (/מים|mineral water|נביעות|מי עדן/i.test(base) && !/l|ליטר|ml/i.test(base)) { out.add(`${base} 1.5L`); }
  if (/(קוקה|coca)/i.test(base)) { out.add(base.replace(/קוקה.?קולה/i, "Coca Cola")); out.add("Coca Cola 1.5L"); }
  if (/(נביעות|neviot)/i.test(base)) { out.add(base.replace(/נביעות/i, "Neviot")); }
  if (/(מי עדן|mei.?eden)/i.test(base)) { out.add(base.replace(/מי.?עדן/i, "Mei Eden")); }
  if (/(ברילה|barilla)/i.test(base)) { out.add(base.replace(/ברילה/i, "Barilla")); }
  if (/מים/i.test(base)) out.add(base + " mineral water");
  if (/פסטה|pasta/i.test(base)) { out.add(base + " pasta"); out.add(base + " 500g"); }
  if (!/1\.?5\s*l|1500\s*ml|500\s*g/i.test(base)) {
    if (/cola|קולה|משקה/i.test(base)) out.add(base + " 1.5L");
    if (/פסטה|pasta/i.test(base)) out.add(base + " 500g");
  }
  return Array.from(out).slice(0, 6);
}

/* ========= OUTLIERS & CONSENSUS ========= */
function iqrFilter(prices: number[]) {
  const arr = prices.slice().sort((a,b)=>a-b);
  const q1 = arr[Math.floor((arr.length - 1) * 0.25)];
  const q3 = arr[Math.floor((arr.length - 1) * 0.75)];
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  return { low, high };
}
function applyOutlierFilter(cands: PriceCandidate[]) {
  const vals = cands.map(c => c.price).filter((p): p is number => typeof p === "number");
  if (vals.length < 6) return cands;
  const { low, high } = iqrFilter(vals);
  const kept = cands.filter(c => {
    if (c.price == null) return true;
    return c.price >= low && c.price <= high;
  });
  return kept.length >= 3 ? kept : cands;
}
function applyConsensus(cands: PriceCandidate[]) {
  const withPrice = cands.filter(c => typeof c.price === "number") as Required<Pick<PriceCandidate,"price">> & PriceCandidate[];
  for (const c of withPrice) {
    const near = withPrice.filter(x =>
      x !== c &&
      Math.abs((x.price! - c.price!) / c.price!) <= 0.05 &&
      (x.domain ?? "") !== (c.domain ?? "")
    );
    c.consensus_count = near.length;
  }
  return cands;
}

/* ========= CONFIDENCE ========= */
function sizeTokens(q: string) {
  const t: string[] = [];
  const litre = q.match(/(\d+(?:[.,]\d+)?)\s*(?:l|ליטר|ל׳|ל)/i);
  const pack = q.match(/(\d+)\s*(?:pack|x|שיש(?:י|ייה)|בקבוקים|יח')/i);
  const gram = q.match(/(\d+(?:[.,]\d+)?)\s*(?:g|גר?ם)/i);
  const kg = q.match(/(\d+(?:[.,]\d+)?)\s*(?:kg|ק(?:ילו)?ג)/i);
  if (litre) t.push((litre[1]+"l").replace(",",".")); 
  if (gram) t.push((gram[1]+"g").replace(",",".")); 
  if (kg) t.push((kg[1]+"kg").replace(",",".")); 
  if (pack) t.push(pack[1]+"pack");
  return t;
}
function computeConfidence(c: PriceCandidate, query: string, chain?: string): number {
  let score = 0;
  if (c.source === "chp") score += 0.35 * CHP_WEIGHT;
  else if (c.source === "shopping") score += 0.25;
  else score += 0.18;

  if (c.price != null) score += 0.22; else score += 0.08;

  if (chain && CHAIN_MAP[chain]) {
    const aliases = CHAIN_MAP[chain].map(s => s.toLowerCase());
    const d = (c.domain ?? "").toLowerCase();
    const m = (c.merchant ?? "").toLowerCase();
    if (aliases.some(a => d.includes(a) || m.includes(a))) score += 0.18;
  }

  const qBrand = detectBrand(query);
  const brandHit = (c.product_brand || c.schema_brand || "").toLowerCase();
  if (qBrand && brandHit.includes(qBrand)) score += 0.12;

  const tok = sizeTokens(query);
  const hay = ((c.title ?? "") + " " + (c.description ?? "") + " " + (c.size_text ?? "")).toLowerCase();
  if (tok.some(t => hay.includes(t.replace("l","")) || hay.includes(t))) score += 0.1;

  if (c.schema_gtin) score += 0.12;

  if ((c.consensus_count ?? 0) >= 2) score += 0.12;

  score = Math.min(score, 0.99);
  return Math.round(score * 100);
}

/* ========= LLM (בחירה אופציונלית למועמד) ========= */
async function llmSelectBest(query: string, chain: string | undefined, candidates: PriceCandidate[]) {
  if (!OPENAI_API_KEY || !LLM_ENABLE_SELECT || candidates.length === 0) return null;

  const prelim = candidates.slice().map(c => ({ c, conf: computeConfidence(c, query, chain) }));
  prelim.sort((a,b)=>{
    const ap = a.c.price ?? Infinity, bp = b.c.price ?? Infinity;
    const aw = (a.c.source === "chp" ? CHP_WEIGHT : 1);
    const bw = (b.c.source === "chp" ? 1.0 * CHP_WEIGHT : 1);
    const aUnit = a.c.unit_per_liter ?? a.c.unit_per_kg ?? ap;
    const bUnit = b.c.unit_per_liter ?? b.c.unit_per_kg ?? bp;
    const ascore = (a.conf * aw) - (isFinite(aUnit) ? aUnit : 0);
    const bscore = (b.conf * bw) - (isFinite(bUnit) ? bUnit : 0);
    return bscore - ascore;
  });
  const top = prelim.slice(0, 8).map(x => x.c);

  const tool = {
    type: "function",
    function: {
      name: "select_best",
      description: "בחר את המועמד המתאים ביותר מבלי להמציא נתונים חדשים",
      parameters: {
        type: "object",
        properties: {
          candidate_index: { type: "integer", description: "האינדקס של המועמד ב-arr שסופק (0..N-1)" },
          reason: { type: "string" }
        },
        required: ["candidate_index"]
      }
    }
  };

  const messages = [
    { role: "system", content: [
      "בחר אך ורק מתוך המועמדים שסופקו. אל תמציא מחירים או מוצרים.",
      "העדף התאמה ל-brand/size ו-CHP אם דומה.",
      "החזר רק function call ל-select_best."
    ].join("\n") },
    { role: "user", content: `Query: ${query}\nChain: ${chain ?? "-"}\nCandidates:\n` + JSON.stringify(top, null, 2) }
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages,
      tools: [tool],
      tool_choice: { type: "function", function: { name: "select_best" } }
    })
  });
  if (!r.ok) return null;
  const j = await r.json();
  const call = j?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call?.function?.arguments) return null;
  try {
    const args = JSON.parse(call.function.arguments);
    const idx = Math.max(0, Math.min(top.length-1, Number(args.candidate_index)));
    return top[idx];
  } catch {
    return null;
  }
}

/* ========= PIPELINE ========= */
type LineChoice = {
  item: string;
  chosen_title: string;
  description?: string | null;
  price: number | null;
  currency: string;
  substitute: boolean;
  source: "shopping"|"chp"|"web";
  link?: string;
  merchant?: string | null;
  domain?: string | null;
  product_brand?: string | null;
  product_name?: string | null;
  schema_brand?: string | null;
  schema_gtin?: string | null;
  size_text?: string | null;
  unit_per_liter?: number | null;
  unit_per_kg?: number | null;
  confidence_pct: number;
  source_url?: string | null;
};

type ChainPricing = { chain: string; items: { query: string; candidates: PriceCandidate[] }[]; };

async function enrichWithSchema(cands: PriceCandidate[], maxFetch = SCHEMA_SCRAPE_MAX_PER_ITEM) {
  const scored = cands.slice().map(c => ({ c, s:
    (c.source === "chp" ? 2 : 1) + (c.product_brand ? 0.5 : 0) + (c.price != null ? 0.3 : 0)
  }));
  scored.sort((a,b)=>b.s - a.s);
  const targets = scored.slice(0, maxFetch).map(x => x.c);

  for (const c of targets) {
    if (!c.link) continue;
    const s = await scrapeSchemaOrgProduct(c.link).catch(()=>null);
    if (s) {
      c.schema_brand = s.brand ?? c.schema_brand ?? null;
      c.schema_gtin = s.gtin ?? c.schema_gtin ?? null;
      c.schema_name = s.name ?? c.schema_name ?? null;
      c.size_text = s.size_text ?? c.size_text ?? null;
      if (s.offers_price && !c.price) c.price = s.offers_price;
      if (s.currency && !c.currency) c.currency = s.currency!;
    }
    const sz = parseSizeFromText([c.size_text, c.title, c.description].filter(Boolean).join(" "));
    const unit = computeUnitPrice(c.price, sz);
    c.unit_ml = sz.unit_ml ?? null;
    c.unit_g = sz.unit_g ?? null;
    c.unit_per_liter = unit.unit_per_liter;
    c.unit_per_kg = unit.unit_per_kg;
  }
  for (const c of cands) {
    if (c.unit_per_kg != null || c.unit_per_liter != null) continue;
    const sz = parseSizeFromText([c.size_text, c.title, c.description].filter(Boolean).join(" "));
    const unit = computeUnitPrice(c.price, sz);
    c.unit_ml = sz.unit_ml ?? null;
    c.unit_g = sz.unit_g ?? null;
    c.unit_per_liter = unit.unit_per_liter;
    c.unit_per_kg = unit.unit_per_kg;
  }
  return cands;
}

async function buildCandidates(items: string[], chains: string[]): Promise<ChainPricing[]> {
  const out: ChainPricing[] = chains.map((chain) => ({ chain, items: [] }));
  const queue: Promise<void>[] = [];

  for (const pack of out) {
    for (const q0 of items) {
      const variants = [...new Set([q0, ...heuristicVariants(q0)])];
      const task = (async () => {
        let cands: PriceCandidate[] = [];
        for (const v of variants) {
          const a = await serpShoppingCandidates(v, pack.chain).catch(() => []);
          const b = await serpShoppingCandidates(v, undefined).catch(() => []);
          cands.push(...a, ...b);
          await sleep(100);
        }
        for (const v of variants) {
          if (ENABLE_CHP) {
            const chp = await serpSiteCandidates(CHP_SITE, v, pack.chain, 12, "chp").catch(() => []);
            cands.push(...chp);
          }
          const pz = await serpSiteCandidates(PRICEZ_SITE, v, pack.chain, 8, "web").catch(() => []);
          const zap = await serpSiteCandidates(ZAP_SITE, v, pack.chain, 8, "web").catch(() => []);
          cands.push(...pz, ...zap);
          if (CHAIN_MAP[pack.chain]) {
            for (const alias of CHAIN_MAP[pack.chain]) {
              if (alias.includes(".co")) {
                const siteC = await serpSiteCandidates(alias, v, pack.chain, 6, "web").catch(()=>[]);
                cands.push(...siteC);
              }
            }
          }
          await sleep(60);
        }

        const uniq = new Map<string, PriceCandidate>();
        for (const c of cands) {
          const key = `${(c.title||"").toLowerCase()}|${c.domain ?? ""}|${c.source}`;
          if (!uniq.has(key)) uniq.set(key, c);
          if (uniq.size >= SERPAPI_MAX_CANDIDATES) break;
        }
        let merged = Array.from(uniq.values());
        merged = applyOutlierFilter(merged);
        merged = await enrichWithSchema(merged, SCHEMA_SCRAPE_MAX_PER_ITEM);
        merged = applyConsensus(merged);

        pack.items.push({ query: q0, candidates: merged });
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

function chooseBestLocal(query: string, chain: string | undefined, candidates: PriceCandidate[]): LineChoice {
  const scored = candidates.map(c => ({
    c, conf: computeConfidence(c, query, chain)
  }));

  scored.sort((a,b)=>{
    const ap = a.c.price ?? Infinity, bp = b.c.price ?? Infinity;
    const aw = (a.c.source === "chp" ? CHP_WEIGHT : 1);
    const bw = (b.c.source === "chp" ? CHP_WEIGHT : 1);
    const aUnit = a.c.unit_per_liter ?? a.c.unit_per_kg ?? ap;
    const bUnit = b.c.unit_per_liter ?? b.c.unit_per_kg ?? bp;
    const ascore = (a.conf * aw) - (isFinite(aUnit) ? aUnit : 0);
    const bscore = (b.conf * bw) - (isFinite(bUnit) ? bUnit : 0);
    return bscore - ascore;
  });

  const best = scored[0]?.c as PriceCandidate | undefined;
  if (!best) {
    return {
      item: query, chosen_title: query, description: null,
      price: null, currency: "ILS", substitute: true, source: "web",
      link: undefined, merchant: null, domain: null,
      product_brand: null, product_name: null, schema_brand: null, schema_gtin: null, size_text: null,
      unit_per_liter: null, unit_per_kg: null,
      confidence_pct: 20, source_url: null
    };
  }
  const conf = computeConfidence(best, query, chain);
  const prodName = best.schema_name ?? best.title ?? null;
  return {
    item: query,
    chosen_title: best.title,
    description: best.description ?? null,
    price: best.price,
    currency: best.currency,
    substitute: best.price == null,
    source: best.source,
    link: best.link,
    merchant: best.merchant ?? null,
    domain: best.domain ?? hostnameFromUrl(best.link) ?? null,
    product_brand: best.product_brand ?? best.schema_brand ?? detectBrand(best.title) ?? null,
    product_name: prodName,
    schema_brand: best.schema_brand ?? null,
    schema_gtin: best.schema_gtin ?? null,
    size_text: best.size_text ?? null,
    unit_per_liter: best.unit_per_liter ?? null,
    unit_per_kg: best.unit_per_kg ?? null,
    confidence_pct: conf,
    source_url: best.link ?? null,
  };
}

async function consolidateWithLLM(nearby: NearbyShop[], multi: ChainPricing[]) {
  if (!OPENAI_API_KEY || !LLM_ENABLE_CONSOLIDATE) return null;
  const sys = [
    "You are a strict JSON generator for shopping basket comparison.",
    "Do NOT invent prices. Only pick from provided candidates.",
    "Prefer CHP results if equally relevant.",
    "For each item/chain choose best candidate by brand/size relevance; if none fits, price:null, substitute:true.",
    "Return JSON with keys: baskets (array). Each basket: { chain, shop_display_name, total, currency:'ILS',",
    "breakdown:[{ item, chosen_title, description, price|null, currency:'ILS', substitute, source, link?, merchant?, domain?, product_brand?, product_name?, schema_brand?, schema_gtin?, size_text?, unit_per_liter?, unit_per_kg?, confidence_pct }],",
    "location:{ name,address,lat,lng } }",
  ].join("\n");

  const prepared = multi.map(pack => ({
    chain: pack.chain,
    items: pack.items.map(({query, candidates}) => ({
      query,
      candidates: candidates.map(c => ({
        title: c.title, description: c.description, price: c.price, currency: c.currency,
        link: c.link, merchant: c.merchant, domain: c.domain, source: c.source,
        product_brand: c.product_brand, schema_brand: c.schema_brand, schema_gtin: c.schema_gtin,
        size_text: c.size_text, unit_per_liter: c.unit_per_liter, unit_per_kg: c.unit_per_kg,
        confidence_pct_local: computeConfidence(c, query, pack.chain),
      })),
    })),
  }));

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
        { type:"text", text:"NEARBY_SHOPS JSON:" },
        { type:"text", text: JSON.stringify(nearby).slice(0, 80000) },
        { type:"text", text:"\nCHAIN_PRICING_CANDIDATES + LOCAL_CONF JSON:" },
        { type:"text", text: JSON.stringify(prepared).slice(0, 80000) },
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

function localPickBaskets(nearby: NearbyShop[], multi: ChainPricing[]) {
  const baskets = multi.map((pack) => {
    const breakdown: LineChoice[] = [];
    for (const { query, candidates } of pack.items) {
      const local = chooseBestLocal(query, pack.chain, candidates);
      breakdown.push(local);
    }
    const total = breakdown.reduce((s, b) => s + (b.price ?? 0), 0);
    const avgConf = breakdown.length ? (breakdown.reduce((s,b)=>s+b.confidence_pct,0) / (100*breakdown.length)) : 0;
    const loc = nearby.find(n => n.chain === pack.chain) || null;
    return {
      chain: pack.chain,
      shop_display_name: loc?.name ?? pack.chain,
      total,
      currency: "ILS",
      match_overall: avgConf, // 0..1
      coverage: breakdown.length ? (breakdown.filter(b=>b.price!=null).length / breakdown.length) : 0,
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
          ENABLE_CHP,
        },
      });
    }

    // דיבוג: ג׳יאוקודינג
    if (pathname === "/api/debug/geocode") {
      const url = new URL(req.url);
      const address = url.searchParams.get("address") || "";
      if (!address) return json({ ok:false, error:"missing address" }, 400);
      try {
        const loc = await geocodeAddress(address, true);
        return json({ ok:true, address, loc });
      } catch (e) {
        return json({ ok:false, error:(e as Error).message, debug: (e as any).debug ?? null }, 500);
      }
    }

    // דיבוג: מקומות ליד
    if (pathname === "/api/debug/places") {
      const url = new URL(req.url);
      const lat = Number(url.searchParams.get("lat") ?? NaN);
      const lng = Number(url.searchParams.get("lng") ?? NaN);
      const radiusKm = Number(url.searchParams.get("radiusKm") ?? "10");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ ok:false, error:"missing lat/lng" }, 400);
      const places = await findNearbySupermarketsByLatLng(lat, lng, radiusKm);
      return json({ ok:true, count: places.length, places });
    }

    if (pathname === "/api/plan" && req.method === "POST") {
      const body = await req.json();
      const { address, radiusKm = 15, items = [], lat, lng, include_debug = false } = body ?? {};
      if ((!address && (typeof lat!=="number" || typeof lng!=="number")) || !Array.isArray(items) || items.length===0) {
        return json({ ok:false, error:"Missing address/latlng or items" }, 400);
      }

      // 1) סופרים בסביבה (כולל דיבוג אם צריך)
      let nearby: NearbyShop[] = [];
      let geoDbg: any = null;
      if (typeof lat === "number" && typeof lng === "number") {
        nearby = await findNearbySupermarketsByLatLng(lat, lng, Number(radiusKm));
      } else {
        try {
          const { lat: glat, lng: glng, _debug } = await geocodeAddress(String(address), include_debug) as any;
          geoDbg = _debug ?? null;
          nearby = await findNearbySupermarketsByLatLng(glat, glng, Number(radiusKm));
        } catch (e) {
          return json({
            ok:false,
            error:(e as Error).message,
            ...(include_debug ? { debug: { geocode: (e as any).debug ?? null } } : {})
          }, 500);
        }
      }

      const chains = Array.from(new Set(nearby.map(n => n.chain))).slice(0, MAX_SUPERMARKETS);

      // 2) נירמול פריטים (LLM אופציונלי)
      const normalized = await normalizeItemsWithLLM(items);

      // 3) איסוף מועמדים לכל פריט/רשת
      const multi = await buildCandidates(normalized, chains);

      // 4) איחוד עם LLM (אופציונלי)
      const llm = await consolidateWithLLM(nearby, multi).catch(() => null);
      if (llm?.baskets?.length) {
        const baskets = llm.baskets.sort((a: any, b: any) => (a.total ?? Infinity) - (b.total ?? Infinity));
        const top3 = baskets.slice(0, 3);
        return json({ ok: true, mode: "llm", top3, baskets, ...(include_debug ? { debug: { geocode: geoDbg } } : {}) });
      }

      // 5) בחירה מקומית
      const { baskets, top3 } = localPickBaskets(nearby, multi);
      return json({ ok: true, mode: "local", top3, baskets, ...(include_debug ? { debug: { geocode: geoDbg } } : {}) });
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
      webp: "image/webp",
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
