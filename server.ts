// server.ts — CartCompare AI (שרת מלא, כולל מאגר TSV ממוינים + חיפוש בינארי + קדימות LocalDB)

////////////////////////////////////////////////////////////////
// 0) ENV + CONFIG
////////////////////////////////////////////////////////////////
if (!Deno.env.get("DENO_DEPLOYMENT_ID")) {
  try {
    const { load } = await import("https://deno.land/std@0.201.0/dotenv/mod.ts");
    load({ export: true });
  } catch {}
}

const PORT = Number(Deno.env.get("PORT") ?? "8000");
const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") ?? "";
const SERPAPI_KEY    = Deno.env.get("SERPAPI_KEY")    ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL   = Deno.env.get("OPENAI_MODEL")   ?? "gpt-4o-mini";

// קבצי TSV ממוינים (UTF-8, TAB). אפשר להצביע גם ל-URL חיצוני, אבל כאן נקרא מקומי.
const MERGED_TSV_URL = Deno.env.get("MERGED_TSV_URL") ?? "public/data/prices_merged_sorted.tsv";
const RL_TSV_URL     = Deno.env.get("RL_TSV_URL")     ?? "public/data/rami_levy_sorted.tsv";
const SHU_TSV_URL     = Deno.env.get("SHU_TSV_URL")    ?? "public/data/shufersal_sorted.tsv";
const TIV_TSV_URL    = Deno.env.get("TIV_TSV_URL")    ?? "public/data/tiv_taam_sorted.tsv";

const CACHE_TTL_MS         = Number(Deno.env.get("CACHE_TTL_MS") ?? "180000");
const GEO_TTL_MS           = Number(Deno.env.get("GEO_TTL_MS")   ?? "900000");
const PLACES_TTL_MS        = Number(Deno.env.get("PLACES_TTL_MS")?? "900000");
const MAX_SUPERMARKETS     = Number(Deno.env.get("MAX_SUPERMARKETS") ?? "20");
const MAX_RESULTS_PER_CHAIN= Number(Deno.env.get("MAX_RESULTS_PER_CHAIN") ?? "10");
const MOCK_MODE            = (Deno.env.get("MOCK_MODE") ?? "0") === "1";

////////////////////////////////////////////////////////////////
// 1) UTILS: JSON, CORS, LOG, ID, CACHE, RATE LIMIT, NET
////////////////////////////////////////////////////////////////
function json(body: unknown, status = 200, extraHeaders: Record<string,string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}
function text(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
function corsPreflight(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
        "access-control-max-age": "86400",
      },
    });
  }
  return null;
}
const rid = () => Math.random().toString(36).slice(2,10);
const log = (...args: any[]) => console.log(new Date().toISOString(), ...args);

type CacheRec = { exp: number; data: unknown };
const memCache = new Map<string, CacheRec>();
function cacheGet<T>(k: string): T | null {
  const rec = memCache.get(k);
  if (!rec) return null;
  if (Date.now() > rec.exp) { memCache.delete(k); return null; }
  return rec.data as T;
}
function cacheSet(k: string, data: unknown, ttl = CACHE_TTL_MS) {
  memCache.set(k, { exp: Date.now() + ttl, data });
}
function meters(km: number) { return Math.max(100, Math.round(km * 1000)); }

const RATE = new Map<string, { n: number; exp: number }>();
function rateLimit(key: string, max = 120, windowMs = 60_000) {
  const now = Date.now();
  const rec = RATE.get(key);
  if (!rec || now > rec.exp) {
    RATE.set(key, { n: 1, exp: now + windowMs });
    return true;
  }
  if (rec.n >= max) return false;
  rec.n++;
  return true;
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function fetchWithRetry(url: string, init: RequestInit = {}, tries = 3, backoffMs = 400, timeoutMs = 15000) {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
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
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error(`Invalid JSON from ${url}`); }
}

////////////////////////////////////////////////////////////////
// 2) PRODUCTS: load public/products.json for autocomplete (משלים LocalDB)
////////////////////////////////////////////////////////////////
type ProductRow = {
  id: string;
  label: string;
  canonical: string;
  default_size?: string;
  tags?: string[];
  synonyms?: string[];
  brand?: string;
};
let PRODUCTS: ProductRow[] = [];
try {
  const raw = await Deno.readTextFile("public/products.json");
  const arr = JSON.parse(raw);
  PRODUCTS = Array.isArray(arr) ? arr : [];
  log("products.json loaded:", PRODUCTS.length);
} catch { log("products.json not found"); PRODUCTS = []; }

////////////////////////////////////////////////////////////////
// 3) TEXT NORMALIZATION + SIZE/FORM PARSING + AUTOCOMPLETE BASE
////////////////////////////////////////////////////////////////
function norm(s: string) {
  return (s||"")
    .toLowerCase()
    .replace(/[״"׳']/g,"")
    .replace(/[\u05BE\u05F3\u05F4]/g," ")
    .replace(/[^\p{L}\p{N}\s.×x%–-]/gu," ")
    .replace(/\s+/g," ")
    .trim();
}
const SIZE_TOKENS = [
  { rx: /\b(\d+(?:\.\d+)?)\s*(?:l|ל|ליטר)\b/gi, tag: (v:string)=>`${v}l` },
  { rx: /\b(\d{2,4})\s*(?:ml|מ(?:יל)?(?:י)?ל)\b/gi, tag: (v:string)=>`${v}ml` },
  { rx: /\b(\d{2,4})\s*(?:g|גר?ם)\b/gi, tag: (v:string)=>`${v}g` },
  { rx: /\b(\d+(?:\.\d+)?)\s*(?:kg|ק(?:\"|״)?ג)\b/gi, tag: (v:string)=>`${v}kg` },
  { rx: /\b(\d{1,2})\s*[x×]\s*(\d+(?:\.\d+)?)\s*(l|ל|ליטר)\b/gi, tag: (a:string,b:string)=>`${a}x${b}l` },
  { rx: /\b(\d{1,2})\s*[x×]\s*(\d{2,4})\s*ml\b/gi, tag: (a:string,b:string)=>`${a}x${b}ml` }
];
const FORM_TOKENS = [
  { rx: /\bפחית\b|\bcan(s)?\b/gi, tag: "can" },
  { rx: /\bבקבוק\b/gi, tag: "bottle" },
  { rx: /\bשישיה\b|\bשישיית\b|\b6x\b/gi, tag: "sixpack" },
  { rx: /\bאריזה\b|\bpack\b/gi, tag: "pack" }
];
function extractQuerySizeAndForm(q: string) {
  const n = norm(q);
  const sizeTags = new Set<string>();
  for (const t of SIZE_TOKENS) {
    n.replace(t.rx, (...m: string[])=>{
      sizeTags.add((t.tag as any)(m[1], m[2]));
      return "";
    });
  }
  const formTags = new Set<string>();
  for (const f of FORM_TOKENS) if (f.rx.test(n)) formTags.add(f.tag as string);
  return { n, sizeTags, formTags };
}
function scoreRow(q: string, row: ProductRow) {
  const { n, sizeTags, formTags } = extractQuerySizeAndForm(q);
  const bag = new Set<string>([
    norm(row.label),
    norm(row.canonical),
    norm(row.brand||""),
    ...(row.tags||[]).map(norm),
    ...(row.synonyms||[]).map(norm),
    norm(row.default_size||"")
  ].filter(Boolean));
  let s = 0;
  for (const token of bag) {
    if (!token) continue;
    if (token.startsWith(n)) s += 5;
    else if (token.includes(n)) s += 3;
  }
  if (row.brand && /(coca|קוקה|pepsi|פפסי|barilla|אוסם|tnuva|תנובה|neviot|מי עדן|mei.?eden|fairy|elite|wissotzky)/i.test(row.brand)) s += 2;
  const rowTokens = [
    norm(row.default_size||""),
    ...((row.tags||[]).map(norm)),
    ...((row.synonyms||[]).map(norm)),
    norm(row.canonical)
  ].join(" ");
  for (const tag of sizeTags) if (rowTokens.includes(tag)) s += 6;
  for (const form of formTags) if (rowTokens.includes(form)) s += 3;
  if (sizeTags.size > 0) {
    let any = false;
    for (const tag of sizeTags) if (rowTokens.includes(tag)) { any = true; break; }
    if (!any) s -= 2;
  }
  return s;
}
function suggestFromProductsJson(q: string, limit = 12) {
  if (!q || !q.trim() || PRODUCTS.length === 0) return [];
  const scored = PRODUCTS.map(r => ({ r, s: scoreRow(q, r) }))
    .filter(x => x.s > 0)
    .sort((a,b)=> b.s - a.s)
    .slice(0, limit)
    .map(x => x.r);
  return scored;
}

////////////////////////////////////////////////////////////////
// 4) MAPS: Geocode + Nearby Places
////////////////////////////////////////////////////////////////
type LatLng = { lat: number; lng: number };
type NearbyShop = { chain: string; name: string; address?: string; lat: number; lng: number; place_id: string; rating?: number };

const CHAIN_MAP: Record<string, string[]> = {
  "Shufersal": ["shufersal.co.il","שופרסל","shufersal"],
  "Rami Levy": ["ramilevy.co.il","רמי לוי","rami-levy","rami levy"],
  "Yohananof": ["yoh.co.il","יוחננוף","yohananof"],
  "Victory": ["victoryonline.co.il","ויקטורי","victory"],
  "Tiv Taam": ["tivtaam.co.il","טיב טעם","tiv taam"],
  "Yenot Bitan": ["yenotbitan.co.il","יינות ביתן","yenot bitan","yenot-bitan"],
  "Mahsanei Hashuk": ["hashuk.co.il","מחסני השוק","mahsanei hashuk","hashuk"],
  "Mega": ["mega.co.il","מגה","mega"]
};
function normalizeChainName(raw: string): string {
  const n = (raw || "").toLowerCase();
  for (const chain in CHAIN_MAP) {
    if (CHAIN_MAP[chain].some(alias => n.includes(alias.toLowerCase()))) return chain;
  }
  return raw || "Unknown";
}

async function geocodeAddress(address: string, includeDebug = false): Promise<LatLng & Record<string, unknown>> {
  const ck = `geo:${address}`;
  const hit = cacheGet<any>(ck);
  if (hit) return hit;

  let provider = "google";
  let gData: any = null;
  let loc: LatLng | null = null;

  if (GOOGLE_API_KEY) {
    const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`;
    try {
      gData = await safeJson(gUrl, {}, 3);
      const p = gData?.results?.[0]?.geometry?.location;
      if (p?.lat && p?.lng) loc = { lat: p.lat, lng: p.lng };
    } catch {}
  }

  if (!loc) {
    provider = "nominatim";
    const nUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1&addressdetails=0`;
    try {
      const nArr = await safeJson(nUrl, { headers: { "User-Agent": "cartcompare-ai/1.0" } }, 2);
      const first = Array.isArray(nArr) ? nArr[0] : null;
      if (first?.lat && first?.lon) loc = { lat: Number(first.lat), lng: Number(first.lon) };
      gData = { nominatim: first };
    } catch {}
  }

  if (!loc) {
    const err = includeDebug
      ? { message: "Address not found", geocode_debug: { provider, data: gData } }
      : { message: "Address not found" };
    throw Object.assign(new Error(err.message), err);
  }

  const out = includeDebug ? { ...loc, _debug: { provider } } : loc;
  cacheSet(ck, out, GEO_TTL_MS);
  return out;
}

async function placesNearbyAllPages(lat: number, lng: number, radiusMeters: number, type: string) {
  if (!GOOGLE_API_KEY) return [];
  const all: any[] = [];
  let pagetoken: string | undefined;
  for (let i = 0; i < 3; i++) {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radiusMeters}&type=${type}&key=${GOOGLE_API_KEY}${pagetoken ? `&pagetoken=${pagetoken}` : ""}`;
    const data = await safeJson(url, {}, 3);
    all.push(...(data?.results ?? []));
    pagetoken = data?.next_page_token;
    if (!pagetoken) break;
    await sleep(2000);
  }
  return all;
}
async function placesTextSearch(lat: number, lng: number, radiusMeters: number, query: string) {
  if (!GOOGLE_API_KEY) return [];
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=${lat},${lng}&radius=${radiusMeters}&key=${GOOGLE_API_KEY}`;
  const data = await safeJson(url, {}, 3);
  return data?.results ?? [];
}
async function findNearbySupermarketsByLatLng(lat: number, lng: number, radiusKm: number): Promise<NearbyShop[]> {
  const radius = meters(radiusKm);
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
    const pid = r?.place_id;
    if (!pid) continue;
    if (seen.has(pid)) continue;
    const name = r?.name ?? "";
    seen.set(pid, {
      chain: normalizeChainName(name),
      name,
      address: r?.formatted_address ?? r?.vicinity,
      lat: r?.geometry?.location?.lat,
      lng: r?.geometry?.location?.lng,
      place_id: pid,
      rating: r?.rating,
    });
  }

  const all = Array.from(seen.values());
  const known = all.filter(s => CHAIN_MAP[s.chain]);
  const result = (known.length ? known : all).slice(0, MAX_SUPERMARKETS);
  cacheSet(ck, result, PLACES_TTL_MS);
  return result;
}

////////////////////////////////////////////////////////////////
// 5) PROVIDERS: Shopping data (SerpAPI), CHP/Pricez fetchers
////////////////////////////////////////////////////////////////
type FoundOffer = {
  title: string;
  price?: number;
  currency?: string;
  brand?: string;
  size_text?: string;
  url?: string;
  domain?: string;
  merchant?: string;
  observed_price_text?: string;
};
function domainOf(url?: string) {
  try { return url ? new URL(url).hostname.replace(/^www\./,'') : undefined; } catch { return undefined; }
}
async function providerSerpApi(query: string, hl = "he", gl = "il", num = 10): Promise<FoundOffer[]> {
  if (!SERPAPI_KEY || MOCK_MODE) return [];
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&num=${num}&api_key=${SERPAPI_KEY}`;
  const data = await safeJson(url, {}, 2).catch(() => null);
  const items = data?.shopping_results ?? [];
  const out: FoundOffer[] = [];
  for (const it of items) {
    const p = typeof it?.price === 'string' ? Number(String(it.price).replace(/[^\d.]/g,'')) : it?.price;
    out.push({
      title: it?.title,
      price: (isFinite(p) && p>0) ? p : undefined,
      currency: "₪",
      brand: it?.source ?? it?.merchant,
      size_text: undefined,
      url: it?.link,
      domain: domainOf(it?.link),
      merchant: it?.source ?? it?.merchant,
      observed_price_text: it?.extracted_price ? String(it?.extracted_price) : (it?.price ? String(it.price) : undefined),
    });
  }
  return out;
}
async function providerCHP(query: string): Promise<FoundOffer[]> {
  if (MOCK_MODE) return [];
  const url = `https://www.chp.co.il/Search?q=${encodeURIComponent(query)}`;
  try {
    const html = await (await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 2)).text();
    const offers: FoundOffer[] = [];
    const re = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*product[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const href = m[1].startsWith("http") ? m[1] : `https://www.chp.co.il${m[1]}`;
      const block = m[2];
      const title = (block.match(/class="[^"]*title[^"]*"[^>]*>(.*?)</i)?.[1] ?? "").replace(/<[^>]+>/g,"").trim();
      const priceText = (block.match(/class="[^"]*price[^"]*"[^>]*>(.*?)</i)?.[1] ?? "").replace(/<[^>]+>/g,"").trim();
      const priceNum = Number(priceText.replace(/[^\d.]/g,''));
      offers.push({
        title, price: isFinite(priceNum) && priceNum>0 ? priceNum : undefined,
        currency: "₪",
        url: href,
        domain: domainOf(href),
        merchant: "CHP",
        observed_price_text: priceText || undefined,
      });
      if (offers.length >= MAX_RESULTS_PER_CHAIN) break;
    }
    return offers;
  } catch { return []; }
}
async function providerPricez(query: string): Promise<FoundOffer[]> {
  if (MOCK_MODE) return [];
  const url = `https://www.pricez.co.il/search?q=${encodeURIComponent(query)}`;
  try {
    const html = await (await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 2)).text();
    const offers: FoundOffer[] = [];
    const re = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*(?:prod|product)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const href = m[1].startsWith("http") ? m[1] : `https://www.pricez.co.il${m[1]}`;
      const block = m[2];
      const title = (block.match(/>([^<]{5,100})</)?.[1] ?? "").trim();
      const priceText = (block.match(/(?:₪|\bprice\b)[^<]{0,12}(\d+(?:\.\d+)?)/i)?.[1] ?? "");
      const priceNum = Number(priceText.replace(/[^\d.]/g,''));
      offers.push({
        title, price: isFinite(priceNum) && priceNum>0 ? priceNum : undefined,
        currency: "₪",
        url: href,
        domain: domainOf(href),
        merchant: "Pricez",
        observed_price_text: priceText ? `₪${priceText}` : undefined,
      });
      if (offers.length >= MAX_RESULTS_PER_CHAIN) break;
    }
    return offers;
  } catch { return []; }
}

////////////////////////////////////////////////////////////////
// 6) LLM Consolidation
////////////////////////////////////////////////////////////////
type LlmItemInput = {
  user_item: string;
  candidates: FoundOffer[];
};
type LlmItemOut = {
  item: string;
  product_name?: string;
  product_brand?: string;
  size_text?: string;
  price?: number;
  currency?: string;
  source_url?: string;
  domain?: string;
  merchant?: string;
  observed_price_text?: string;
  confidence_pct?: number;
  substitute?: boolean;
  description?: string;
  unit_per_liter?: number;
  unit_per_kg?: number;
};
async function consolidateWithOpenAI(items: LlmItemInput[]): Promise<LlmItemOut[]> {
  if (!OPENAI_API_KEY) return [];
  const sys = `
You are a strict shopping data consolidator. Rules:
- DO NOT invent prices or sizes.
- Use ONLY the candidate entries provided (urls/titles/prices).
- Prefer Israeli major supermarket chains.
- Map sizes (1.5L, 330ml, 500g, 1kg, 6x330ml) from title text.
- If price not numeric in candidates, set no price.
- Output JSON array only. Fields: item, product_name, product_brand, size_text, price, currency, source_url, domain, merchant, observed_price_text, confidence_pct (0..100), substitute (bool), description, unit_per_liter, unit_per_kg.
- If nothing fits, return entry with substitute=true and no price.
`;
  const user = { items };
  const body = {
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys.trim() },
      { role: "user", content: JSON.stringify(user) }
    ]
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "authorization": `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }).then(x=>x.json()).catch(()=>null as any);

  const txt = r?.choices?.[0]?.message?.content ?? "";
  try {
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch { return []; }
}

////////////////////////////////////////////////////////////////
// 7) LOCAL TSV (ממוינים) + חיפוש בינארי + קדימות
////////////////////////////////////////////////////////////////
type LocalRow = { itemname: string; itemprice: number; size?: string; brand?: string; chain?: string };
type LocalChainDB = { chain: string; rows: LocalRow[] }; // MUST be sorted by itemname (א-ב)
const LOCAL: { merged?: LocalRow[]; chains: Record<string, LocalChainDB> } = { chains: {} };

async function readSortedTSV(path: string): Promise<LocalRow[]> {
  try {
    const txt = await Deno.readTextFile(path);
    const lines = txt.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const header = lines.shift()!.split("\t").map(s=>s.trim().toLowerCase());
    const iName  = header.indexOf("itemname");
    const iPrice = header.indexOf("itemprice");
    const iSize  = header.indexOf("size");
    const iBrand = header.indexOf("brand");
    const iChain = header.indexOf("chain");
    const out: LocalRow[] = [];
    for (const line of lines) {
      const cols = line.split("\t");
      const itemname = (cols[iName]  ?? "").trim();
      const itemprice= Number((cols[iPrice] ?? "").trim());
      if (!itemname || !isFinite(itemprice)) continue;
      out.push({
        itemname,
        itemprice,
        size:  iSize>=0  ? (cols[iSize]  ?? "").trim() : undefined,
        brand: iBrand>=0 ? (cols[iBrand] ?? "").trim() : undefined,
        chain: iChain>=0 ? (cols[iChain] ?? "").trim() : undefined,
      });
    }
    out.sort((a,b)=> a.itemname.localeCompare(b.itemname, "he"));
    return out;
  } catch { return []; }
}
function normQ(s: string){ return (s||"").toLowerCase().replace(/\s+/g," ").trim(); }
function lowerBoundPrefix(arr: LocalRow[], q: string): number {
  let lo=0, hi=arr.length;
  while(lo<hi){
    const mid=(lo+hi)>>1;
    if (arr[mid].itemname.toLowerCase() < q) lo = mid+1; else hi = mid;
  }
  return lo;
}
function collectPrefix(arr: LocalRow[], prefix: string, limit=12): LocalRow[] {
  if (!prefix) return [];
  const q = prefix.toLowerCase();
  let i = lowerBoundPrefix(arr, q);
  const out: LocalRow[] = [];
  while (i < arr.length && out.length < limit) {
    const s = arr[i].itemname.toLowerCase();
    if (!s.startsWith(q)) break;
    out.push(arr[i]); i++;
  }
  return out;
}
async function loadLocalDB() {
  const merged = await readSortedTSV(MERGED_TSV_URL);
  LOCAL.merged = merged.length ? merged : undefined;

  const rl  = await readSortedTSV(RL_TSV_URL);
  const shu = await readSortedTSV(SHU_TSV_URL);
  const tiv = await readSortedTSV(TIV_TSV_URL);
  if (rl.length)  LOCAL.chains["Rami Levy"] = { chain: "Rami Levy", rows: rl };
  if (shu.length) LOCAL.chains["Shufersal"] = { chain: "Shufersal", rows: shu };
  if (tiv.length) LOCAL.chains["Tiv Taam"]   = { chain: "Tiv Taam", rows: tiv };

  log("Local TSV loaded:", {
    merged: LOCAL.merged?.length ?? 0,
    rl: rl.length, shu: shu.length, tiv: tiv.length
  });
}
await loadLocalDB();

function pickLocalMatch(name: string): {row: LocalRow, chain?: string} | null {
  const q = normQ(name);
  if (LOCAL.merged?.length) {
    const lb = lowerBoundPrefix(LOCAL.merged, q);
    if (lb < LOCAL.merged.length && LOCAL.merged[lb].itemname.toLowerCase() === q)
      return { row: LOCAL.merged[lb], chain: LOCAL.merged[lb].chain };
    const pref = collectPrefix(LOCAL.merged, q, 1)[0];
    if (pref) return { row: pref, chain: pref.chain };
  }
  for (const [chain, db] of Object.entries(LOCAL.chains)) {
    const lb = lowerBoundPrefix(db.rows, q);
    if (lb < db.rows.length && db.rows[lb].itemname.toLowerCase() === q)
      return { row: db.rows[lb], chain };
    const pref = collectPrefix(db.rows, q, 1)[0];
    if (pref) return { row: pref, chain };
  }
  return null;
}

////////////////////////////////////////////////////////////////
// 8) PLAN PIPELINE
////////////////////////////////////////////////////////////////
type PlanReq = {
  address?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  items?: string[];
  include_debug?: boolean;
};
type LlmItemOutFull = LlmItemOut; // alias
type Basket = {
  chain: string;
  shop_display_name?: string;
  total?: number;
  match_overall?: number;
  coverage?: number;
  location?: { lat: number; lng: number; address?: string };
  breakdown: LlmItemOutFull[];
};
function computeUnits(e: LlmItemOutFull) {
  const price = e.price;
  if (!price) return;
  const m = (e.size_text||"").toLowerCase();
  let liters = 0, kg = 0;
  let k: RegExpMatchArray | null;
  if ((k = m.match(/(\d+(?:\.\d+)?)\s*l/))) liters = Number(k[1]);
  if ((k = m.match(/(\d{2,4})\s*ml/))) liters = Number(k[1]) / 1000;
  if ((k = m.match(/(\d+(?:\.\d+)?)\s*kg/))) kg = Number(k[1]);
  if ((k = m.match(/(\d{2,4})\s*g/))) kg = Number(k[1]) / 1000;
  if (liters>0) e.unit_per_liter = Number((price / liters).toFixed(2));
  if (kg>0) e.unit_per_kg = Number((price / kg).toFixed(2));
}

async function planHandler(req: PlanReq) {
  const include_debug = !!req.include_debug;

  let lat = Number(req.lat || 0), lng = Number(req.lng || 0);
  let centerFrom = "gps";
  if ((!lat || !lng) && req.address) {
    centerFrom = "address";
    const loc = await geocodeAddress(req.address, include_debug);
    lat = loc.lat; lng = loc.lng;
  }
  if (!lat || !lng) throw Object.assign(new Error("Address not found"), { reason: "NO_LATLNG" });

  const radiusKm = Number(req.radiusKm || 10);
  const shops = await findNearbySupermarketsByLatLng(lat, lng, radiusKm);
  if (!shops.length) return { ok:true, baskets: [], debug: include_debug ? { centerFrom, lat, lng } : undefined };

  const userItems = Array.isArray(req.items) ? req.items.filter(Boolean) : [];
  if (!userItems.length) return { ok:false, error:"No items", code:"NO_ITEMS" };

  const baskets: Basket[] = [];
  for (const s of shops) {
    const chain = s.chain || "Unknown";
    const breakdown: LlmItemOutFull[] = [];

    for (const item of userItems) {
      // 1) קדימות LocalDB
      const local = pickLocalMatch(item);
      if (local?.row) {
        const r = local.row;
        const e: LlmItemOutFull = {
          item,
          product_name: r.itemname,
          product_brand: r.brand || undefined,
          size_text: r.size || undefined,
          price: r.itemprice,
          currency: "₪",
          source_url: undefined,
          domain: "localdb",
          merchant: local.chain || r.chain || "LocalDB",
          observed_price_text: String(r.itemprice),
          confidence_pct: 100,
          substitute: false
        };
        computeUnits(e);
        breakdown.push(e);
        continue;
      }

      // 2) ספקי רשת אם אין מקומי
      const offers: FoundOffer[] = [];
      try { offers.push(...await providerCHP(item)); } catch {}
      try { offers.push(...await providerPricez(item)); } catch {}
      try { offers.push(...await providerSerpApi(item, "he", "il", MAX_RESULTS_PER_CHAIN)); } catch {}

      if (!offers.length) {
        breakdown.push({ item, substitute: true, confidence_pct: 0 });
        continue;
      }

      if (!OPENAI_API_KEY) {
        const withPrice = offers.filter(o => typeof o.price === "number");
        const chosen = withPrice[0] || offers[0];
        const outE: LlmItemOutFull = {
          item,
          product_name: chosen?.title,
          product_brand: chosen?.brand,
          size_text: undefined,
          price: chosen?.price,
          currency: chosen?.currency || "₪",
          source_url: chosen?.url,
          domain: chosen?.domain,
          merchant: chosen?.merchant,
          observed_price_text: chosen?.observed_price_text,
          confidence_pct: typeof chosen?.price === "number" ? 65 : 30,
          substitute: false
        };
        computeUnits(outE);
        breakdown.push(outE);
      } else {
        const llmOut = await consolidateWithOpenAI([{ user_item: item, candidates: offers }]).catch(()=>[]) as LlmItemOutFull[];
        const first = llmOut?.[0];
        if (first) { computeUnits(first); breakdown.push(first); }
        else breakdown.push({ item, substitute: true, confidence_pct: 0 });
      }
    }

    // סכום/כיסוי/דיוק
    const prices = breakdown.map(b=> b.price).filter((x): x is number => typeof x === "number" && isFinite(x));
    const total = prices.reduce((a,b)=> a+b, 0);
    const coverage = breakdown.filter(b=> typeof b.price === "number").length / breakdown.length;
    const match_overall = breakdown.reduce((a,b)=> a + (typeof b.confidence_pct === "number" ? b.confidence_pct : 50), 0) / (breakdown.length * 100);

    baskets.push({
      chain,
      shop_display_name: `${s.name}`,
      total: prices.length ? Number(total.toFixed(2)) : undefined,
      match_overall,
      coverage,
      location: { lat: s.lat, lng: s.lng, address: s.address },
      breakdown
    });
  }

  baskets.sort((a,b)=>{
    const ta = typeof a.total === "number" ? a.total : Number.POSITIVE_INFINITY;
    const tb = typeof b.total === "number" ? b.total : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    const ca = a.coverage ?? 0, cb = b.coverage ?? 0;
    if (cb !== ca) return cb - ca;
    const ma = a.match_overall ?? 0, mb = b.match_overall ?? 0;
    return mb - ma;
  });

  return { ok: true, baskets, debug: include_debug ? { centerFrom, lat, lng, shops } : undefined };
}

////////////////////////////////////////////////////////////////
// 9) ROUTER: APIs + Static
////////////////////////////////////////////////////////////////
async function handleApi(req: Request) {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const { pathname, searchParams } = new URL(req.url);
  const ip = req.headers.get("x-forwarded-for") || "0.0.0.0";
  const key = `${ip}:${pathname}`;
  if (!rateLimit(key, 120, 60_000)) return json({ ok:false, error:"Too Many Requests" }, 429);

  if (pathname === "/api/health") {
    return json({ ok:true, status:"alive", products_loaded: PRODUCTS.length, MOCK_MODE, has_GOOGLE_API_KEY: !!GOOGLE_API_KEY, has_SERPAPI_KEY: !!SERPAPI_KEY, has_OPENAI_API_KEY: !!OPENAI_API_KEY });
  }

  if (pathname === "/api/suggest") {
    const q = searchParams.get("q") ?? "";
    const limit = Number(searchParams.get("limit") ?? "12");
    const out: any[] = [];

    // קודם LocalDB (merged אם קיים; אחרת איחוד רשתות) — חיפוש בינארי לפריפיקס
    const sourceArrays: LocalRow[][] = LOCAL.merged
      ? [LOCAL.merged]
      : Object.values(LOCAL.chains).map(c=>c.rows);

    const seen = new Set<string>();
    for (const arr of sourceArrays) {
      for (const r of collectPrefix(arr, q, limit)) {
        const key = r.itemname.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: `localdb:${key}`,
          label: r.itemname,
          canonical: r.itemname,
          default_size: r.size || "",
          brand: r.brand || "",
          tags: ["LocalDB"]
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }

    // אם חסר—נשלים גם מ-products.json
    if (out.length < limit && PRODUCTS.length) {
      const more = suggestFromProductsJson(q, limit - out.length).map(r=>({
        ...r,
        tags: Array.isArray(r.tags) ? r.tags : []
      }));
      out.push(...more);
    }
    return json({ ok: true, suggestions: out.slice(0, limit) });
  }

  if (pathname === "/api/debug/geocode") {
    const address = searchParams.get("address") ?? "";
    if (!address) return json({ ok:false, error:"Missing address" }, 400);
    try {
      const loc = await geocodeAddress(address, true);
      return json({ ok:true, loc });
    } catch (e: any) {
      return json({ ok:false, error: e?.message || "Geocode failed", debug: e?.geocode_debug || null }, 500);
    }
  }

  if (pathname === "/api/debug/places") {
    const lat = Number(searchParams.get("lat") ?? "0");
    const lng = Number(searchParams.get("lng") ?? "0");
    const radiusKm = Number(searchParams.get("radiusKm") ?? "10");
    if (!lat || !lng) return json({ ok:false, error:"Missing lat/lng" }, 400);
    try {
      const places = await findNearbySupermarketsByLatLng(lat, lng, radiusKm);
      return json({ ok:true, places });
    } catch (e: any) {
      return json({ ok:false, error: e?.message || "Places failed" }, 500);
    }
  }

  if (pathname === "/api/debug/env") {
    return json({
      ok: true,
      PORT,
      has_GOOGLE_API_KEY: !!GOOGLE_API_KEY,
      has_SERPAPI_KEY: !!SERPAPI_KEY,
      has_OPENAI_API_KEY: !!OPENAI_API_KEY,
      MOCK_MODE
    });
  }

  if (pathname === "/api/plan" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as PlanReq;
    try {
      const out = await planHandler(body);
      return json(out, out.ok ? 200 : 422);
    } catch (e: any) {
      const msg = e?.message || "Plan failed";
      return json({ ok:false, error: msg }, 500);
    }
  }

  return json({ ok:false, error:"Not found" }, 404);
}

async function serveStatic(pathname: string) {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  try {
    const file = await Deno.readFile(`public${filePath}`);
    const ext = (filePath.split(".").pop() ?? "").toLowerCase();
    const ct = ({
      html: "text/html; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      css: "text/css; charset=utf-8",
      json: "application/json; charset=utf-8",
      tsv: "text/tab-separated-values; charset=utf-8",
      csv: "text/csv; charset=utf-8",
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml",
      webp: "image/webp",
      txt: "text/plain; charset=utf-8"
    } as Record<string, string>)[ext] ?? "application/octet-stream";
    return new Response(file, { headers: { "content-type": ct, "access-control-allow-origin": "*" } });
  } catch {
    return new Response("Not Found", { status: 404, headers: { "access-control-allow-origin": "*" } });
  }
}

Deno.serve({ port: PORT }, async (req) => {
  const id = rid();
  const { pathname } = new URL(req.url);
  try {
    if (pathname.startsWith("/api/")) {
      const res = await handleApi(req);
      log("[API]", id, req.method, pathname, res.status);
      return res;
    }
    const res = await serveStatic(pathname);
    log("[STATIC]", id, pathname, res.status);
    return res;
  } catch (e) {
    log("[FATAL]", id, pathname, e);
    return json({ ok:false, error:"Internal Server Error" }, 500);
  }
});
