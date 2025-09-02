// server.ts — PRO++
// • /api/plan מקבל address או lat/lng (+radiusKm, items)
// • Google Geocode/Places (Nearby + TextSearch, כמה סוגי type)
// • SerpAPI: Google Shopping + Google Web (CHP עם משקל גבוה + Pricez/Zap)
// • הרחבת שאילתות לכל פריט (וריאציות), נירמול LLM (אופציונלי, בלי להמציא מחירים)
// • דירוג מועמדים עם ציון אמינות (confidence) לפי מקור/דומיין/תאימות מותג/נפח/מחיר
// • בחירה LLM (אם זמין) או בחירה לוקאלית חכמה (שילוב מחיר+ציון)
// • מחזיר סל מלא לכל סופר + פרטים להצגה + GPS location
// • קאש בזיכרון, קונקרנציה, retries

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
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? ""; // optional

const MAX_SUPERMARKETS = Number(Deno.env.get("MAX_SUPERMARKETS") ?? "20");
const SERPAPI_MAX_CANDIDATES = Number(Deno.env.get("SERPAPI_MAX_CANDIDATES") ?? "14");
const SERPAPI_CONCURRENCY = Number(Deno.env.get("SERPAPI_CONCURRENCY") ?? "6");
const CACHE_TTL_MS = Number(Deno.env.get("CACHE_TTL_MS") ?? "180000"); // 3m
const GEO_TTL_MS = Number(Deno.env.get("GEO_TTL_MS") ?? "900000"); // 15m
const PLACES_TTL_MS = Number(Deno.env.get("PLACES_TTL_MS") ?? "900000"); // 15m

const LLM_ENABLE_NORMALIZE = (Deno.env.get("LLM_ENABLE_NORMALIZE") ?? "1") === "1";
const LLM_ENABLE_CONSOLIDATE = (Deno.env.get("LLM_ENABLE_CONSOLIDATE") ?? "1") === "1";

// Web sources weighting
const ENABLE_CHP = (Deno.env.get("ENABLE_CHP") ?? "1") === "1";
const CHP_SITE = Deno.env.get("CHP_SITE") ?? "chp.co.il";
const CHP_WEIGHT = Number(Deno.env.get("CHP_WEIGHT") ?? "1.4"); // משקל יתר ל-CHP
const PRICEZ_SITE = Deno.env.get("PRICEZ_SITE") ?? "pricez.co.il";
const ZAP_SITE = Deno.env.get("ZAP_SITE") ?? "zap.co.il";

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
  "Rami Levy": ["ramilevy.co.il","רמי לוי","rami levy"],
  "Yohananof": ["yoh.co.il","יוחננוף","yohananof"],
  "Victory": ["victoryonline.co.il","ויקטורי","victory"],
  "Tiv Taam": ["tivtaam.co.il","טיב טעם","tiv taam"],
  "Yenot Bitan": ["yenotbitan.co.il","יינות ביתן","yenot bitan"],
  "Mahsanei Hashuk": ["hashuk.co.il","מחסני השוק","mahsanei hashuk"],
  "Super-Pharm": ["super-pharm.co.il","סופר-פארם","super pharm"],
  "Mega": ["mega.co.il","מגה","mega"],
};
const BRAND_KEYWORDS = [
  "coca cola","קוקה קולה","coca-cola","pepsi","פפסי","mei eden","מי עדן","neviot","נביעות",
  "barilla","ברילה","osem","אוסם","san benedetto","סאן בנדטו","sprite","ספרייט","fuse tea","פיוז",
  "schweppes","שוופס","taam","תנובה","sugat","סוגת","pasta del verona","דה ורונה"
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
async function geocodeAddress(address: string) {
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
async function findNearbySupermarkets(address: string, radiusKm: number) {
  const { lat, lng } = await geocodeAddress(address);
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
    product_brand: detectBrand(title),
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

  // ייחוד לפי (title+domain)
  const uniq = new Map<string, PriceCandidate>();
  for (const c of pool) {
    const key = `${(c.title||"").toLowerCase()}|${c.domain ?? ""}`;
    if (!uniq.has(key)) uniq.set(key, c);
    if (uniq.size >= SERPAPI_MAX_CANDIDATES) break;
  }
  return Array.from(uniq.values());
}

function candidateFromWeb(eng: any, query: string, sourceTag: "chp"|"web"): PriceCandidate {
  const title = String(eng?.title ?? "");
  const snippet = String(eng?.snippet ?? eng?.rich_snippet?.top?.extensions?.join(" ") ?? "");
  const link = eng?.link;
  // נסה לחלץ ₪ מה-snippet
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
    product_brand: detectBrand(title),
  };
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

/* ========= QUERY VARIANTS ========= */
async function normalizeItemsWithLLM(items: string[]): Promise<string[]> {
  if (!OPENAI_API_KEY || !LLM_ENABLE_NORMALIZE) return items;
  const prompt = [
    "Normalize the following grocery items (Hebrew/English) into concise product queries.",
    "Keep sizes/brands if present (e.g., '1.5L', '6-pack', brand names). Return JSON {\"items\":[...]} only.",
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
function heuristicVariants(q: string): string[] {
  const out = new Set<string>();
  const base = q.trim();
  out.add(base);
  // תוספת נפח באנגלית אם יש ליטר
  if (/1\.5|1.5|2|0\.5|0.5/.test(base) && !/l|ליטר|ml/i.test(base)) {
    out.add(base + " 1.5L");
  }
  // מותג באנגלית/עברית פשוט
  if (/(קוקה|coca)/i.test(base)) { out.add(base.replace(/קוקה.?קולה/i, "Coca Cola")); out.add("Coca Cola 1.5L"); }
  if (/(נביעות|neviot)/i.test(base)) { out.add(base.replace(/נביעות/i, "Neviot")); }
  if (/(מי עדן|mei.?eden)/i.test(base)) { out.add(base.replace(/מי.?עדן/i, "Mei Eden")); }
  if (/(ברילה|barilla)/i.test(base)) { out.add(base.replace(/ברילה/i, "Barilla")); }
  // מילות מפתח כלליות
  if (/מים/i.test(base)) out.add(base + " mineral water");
  if (/פסטה/i.test(base)) out.add(base + " pasta");
  return Array.from(out).slice(0, 5);
}

/* ========= CONFIDENCE SCORING ========= */
function sizeTokens(q: string) {
  const t: string[] = [];
  const litre = q.match(/(\d+(?:[.,]\d+)?)\s*(?:l|ליטר|ל׳|ל)/i);
  const pack = q.match(/(\d+)\s*(?:pack|x|שישייה|בקבוקים|יח')/i);
  if (litre) t.push(litre[1] + "l");
  if (pack) t.push(pack[1] + "pack");
  return t;
}
function computeConfidence(c: PriceCandidate, query: string, chain?: string): number {
  let score = 0;
  // מקור
  if (c.source === "chp") score += 0.4 * CHP_WEIGHT;
  else if (c.source === "shopping") score += 0.25;
  else score += 0.2;

  // מחיר קיים
  if (c.price != null) score += 0.25; else score += 0.1;

  // אם הדומיין מתאים לרשת
  if (chain && CHAIN_MAP[chain]) {
    const aliases = CHAIN_MAP[chain].map(s => s.toLowerCase());
    const d = (c.domain ?? "").toLowerCase();
    const m = (c.merchant ?? "").toLowerCase();
    if (aliases.some(a => d.includes(a) || m.includes(a))) score += 0.2;
  }

  // התאמת מותג
  const qBrand = detectBrand(query);
  if (qBrand && c.product_brand && c.product_brand.includes(qBrand)) score += 0.15;

  // התאמת גודל/נפח
  const tok = sizeTokens(query);
  const hay = ((c.title ?? "") + " " + (c.description ?? "")).toLowerCase();
  if (tok.some(t => hay.includes(t.replace("l","")) || hay.includes(t))) score += 0.1;

  score = Math.min(score, 0.99);
  return Math.round(score * 100); // %
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
  confidence_pct: number;       // ⬅️ חדש
  source_url?: string | null;   // ⬅️ חדש (שווה ל-link)
};

type ChainPricing = { chain: string; items: { query: string; candidates: PriceCandidate[] }[]; };

async function buildCandidates(items: string[], chains: string[]): Promise<ChainPricing[]> {
  const out: ChainPricing[] = chains.map((chain) => ({ chain, items: [] }));
  const queue: Promise<void>[] = [];

  for (const pack of out) {
    for (const q0 of items) {
      // וריאציות לשאילתה
      const variants = [...new Set([q0, ...heuristicVariants(q0)])];
      const task = (async () => {
        const cands: PriceCandidate[] = [];

        // 1) Shopping עם ובלי שם רשת
        for (const v of variants) {
          const a = await serpShoppingCandidates(v, pack.chain).catch(() => []);
          const b = await serpShoppingCandidates(v, undefined).catch(() => []);
          cands.push(...a, ...b);
          await sleep(100);
        }

        // 2) Web sources (CHP + Pricez + Zap)
        for (const v of variants) {
          if (ENABLE_CHP) {
            const chp = await serpSiteCandidates(CHP_SITE, v, pack.chain, 10, "chp").catch(() => []);
            cands.push(...chp);
          }
          const pz = await serpSiteCandidates(PRICEZ_SITE, v, pack.chain, 6, "web").catch(() => []);
          const zap = await serpSiteCandidates(ZAP_SITE, v, pack.chain, 6, "web").catch(() => []);
          cands.push(...pz, ...zap);
          await sleep(80);
        }

        // מיזוג, שימור גיוון דומיינים
        const uniq = new Map<string, PriceCandidate>();
        for (const c of cands) {
          const key = `${(c.title||"").toLowerCase()}|${c.domain ?? ""}|${c.source}`;
          if (!uniq.has(key)) uniq.set(key, c);
          if (uniq.size >= SERPAPI_MAX_CANDIDATES) break;
        }
        pack.items.push({ query: q0, candidates: Array.from(uniq.values()) });
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
  // ציון אמינות
  const scored = candidates.map(c => ({
    c,
    conf: computeConfidence(c, query, chain)
  }));

  // פונקציית מטריצת מחיר/אמינות (מעדיף CHP)
  scored.sort((a, b) => {
    const ap = a.c.price ?? Infinity, bp = b.c.price ?? Infinity;
    const aw = (a.c.source === "chp" ? CHP_WEIGHT : 1);
    const bw = (b.c.source === "chp" ? CHP_WEIGHT : 1);
    // משלב מחיר נמוך + אמינות גבוהה (עם משקל CHP)
    const ascore = (a.conf * aw) - (isFinite(ap) ? ap : 0);
    const bscore = (b.conf * bw) - (isFinite(bp) ? bp : 0);
    return bscore - ascore;
  });

  const best = scored[0]?.c as PriceCandidate | undefined;
  if (!best) {
    return {
      item: query, chosen_title: query, description: null,
      price: null, currency: "ILS", substitute: true, source: "web",
      link: undefined, merchant: null, domain: null,
      product_brand: null, product_name: null, confidence_pct: 20, source_url: null
    };
  }
  const conf = computeConfidence(best, query, chain);
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
    product_brand: best.product_brand ?? detectBrand(best.title) ?? null,
    product_name: best.title ?? null,
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
    "breakdown:[{ item, chosen_title, description, price|null, currency:'ILS', substitute, source, link?, merchant?, domain?, product_brand?, product_name?, confidence_pct }],",
    "location:{ name,address,lat,lng } }",
  ].join("\n");

  // כדי למנוע “המצאות” — נעביר גם הציונים המקומיים שלנו
  const prepared = multi.map(pack => ({
    chain: pack.chain,
    items: pack.items.map(({query, candidates}) => ({
      query,
      candidates: candidates.map(c => ({
        ...c,
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
        { type:"text", text: JSON.stringify(nearby).slice(0, 100000) },
        { type:"text", text:"\nCHAIN_PRICING_CANDIDATES + LOCAL_CONF JSON:" },
        { type:"text", text: JSON.stringify(prepared).slice(0, 100000) },
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
    const breakdown: LineChoice[] = pack.items.map(({ query, candidates }) =>
      chooseBestLocal(query, pack.chain, candidates)
    );

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

    if (pathname === "/api/plan" && req.method === "POST") {
      const body = await req.json();
      const { address, radiusKm = 15, items = [], lat, lng } = body ?? {};
      if ((!address && (typeof lat!=="number" || typeof lng!=="number")) || !Array.isArray(items) || items.length===0) {
        return json({ ok:false, error:"Missing address/latlng or items" }, 400);
      }

      // 1) אתור סופרים לפי כתובת או GPS
      const nearby = (typeof lat==="number" && typeof lng==="number")
        ? await findNearbySupermarketsByLatLng(lat, lng, Number(radiusKm))
        : await findNearbySupermarkets(String(address), Number(radiusKm));

      const chains = Array.from(new Set(nearby.map(n => n.chain))).slice(0, MAX_SUPERMARKETS);

      // 2) נירמול פריטים (LLM אופציונלי) + וריאציות היוריסטיות
      const normalized = await normalizeItemsWithLLM(items);
      // 3) איסוף מועמדים לכל פריט/רשת (Shopping+Web עם CHP)
      const multi = await buildCandidates(normalized, chains);

      // 4) איחוד LLM אם זמין
      const llm = await consolidateWithLLM(nearby, multi).catch(() => null);
      if (llm?.baskets?.length) {
        const baskets = llm.baskets.sort((a: any, b: any) => (a.total ?? Infinity) - (b.total ?? Infinity));
        const top3 = baskets.slice(0, 3);
        return json({ ok: true, mode: "llm", top3, baskets });
      }

      // 5) בחירה לוקאלית
      const { baskets, top3 } = localPickBaskets(nearby, multi);
      return json({ ok: true, mode: "local", top3, baskets });
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
