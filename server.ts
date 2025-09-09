// server.ts — שרת Deno מלא: סטטי + API + מאגר מקומי + אוטוקומפליט בלי כפילויות + הערכת מחירים רק כשאין נתון
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
const GOOGLE_API_KEY   = Deno.env.get("GOOGLE_API_KEY")   ?? "";
const SERPAPI_KEY      = Deno.env.get("SERPAPI_KEY")      ?? ""; // לא משתמשים יותר, נשאר תאימות
const OPENAI_API_KEY   = Deno.env.get("OPENAI_API_KEY")   ?? "";
const OPENAI_MODEL     = Deno.env.get("OPENAI_MODEL")     ?? "gpt-4o-mini";

const CACHE_TTL_MS     = Number(Deno.env.get("CACHE_TTL_MS") ?? "180000");
const GEO_TTL_MS       = Number(Deno.env.get("GEO_TTL_MS")   ?? "900000");
const PLACES_TTL_MS    = Number(Deno.env.get("PLACES_TTL_MS")?? "900000");
const MAX_SUPERMARKETS = Number(Deno.env.get("MAX_SUPERMARKETS") ?? "20");
const MAX_RESULTS_PER_CHAIN = Number(Deno.env.get("MAX_RESULTS_PER_CHAIN") ?? "10");
const MOCK_MODE        = (Deno.env.get("MOCK_MODE") ?? "0") === "1";

////////////////////////////////////////////////////////////////
// 1) UTILS: JSON, CORS, LOG, ID, CACHE, RATE LIMIT, NET, DIST
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
const RATE = new Map<string, { n: number; exp: number }>();
function rateLimit(key: string, max = 200, windowMs = 60_000) {
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

// מרחק (Haversine)
function toRad(d: number) { return (d * Math.PI) / 180; }
function haversineKm(a: {lat:number; lng:number}, b: {lat:number; lng:number}) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sa = Math.sin(dLat/2)**2 +
             Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1-sa));
}

////////////////////////////////////////////////////////////////
// 2) PRODUCTS fallback (products.json) — לא חובה
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
// 3) LOCAL TSV/CSV DB (sorted) + binsearch + load-all-chains
////////////////////////////////////////////////////////////////
type LocalRow = { name: string; price: number; size?: string; brand?: string; chain?: string };

function stripBOM(s: string) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}
function detectDelimiter(line: string) {
  if (line.includes("\t")) return "\t";
  if (line.includes(",")) return ",";
  if (line.includes(";")) return ";";
  return "\t";
}
function smartSplit(line: string, delim: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (ch === '"'){ if (q && line[i+1] === '"'){ cur+='"'; i++; } else { q=!q; } }
    else if (ch === delim && !q){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur);
  return out.map(s=>s.trim());
}
function normalizeKey(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g," ");
}
function pickIndex(headers: string[], candidates: string[]) {
  const norm = headers.map(normalizeKey);
  for (const c of candidates) {
    const i = norm.indexOf(normalizeKey(c));
    if (i>=0) return i;
  }
  for (let i=0;i<norm.length;i++){
    for (const c of candidates) if (norm[i].includes(normalizeKey(c))) return i;
  }
  return -1;
}
async function readLocalTSV(path: string, chainHint?: string): Promise<LocalRow[]> {
  try {
    const raw = await Deno.readTextFile(path);
    const txt = stripBOM(raw).replace(/\r\n/g,"\n").replace(/\r/g,"\n");
    const lines = txt.split("\n").filter(Boolean);
    if (!lines.length) return [];
    const delim = detectDelimiter(lines[0]);
    const headers = smartSplit(lines[0], delim);
    let iName  = pickIndex(headers, ["item_name","שם מוצר","product","name","item","שם"]);
    let iPrice = pickIndex(headers, ["itemprice","price","מחיר"]);
    let iSize  = pickIndex(headers, ["size","גודל","נפח","משקל"]);
    let iBrand = pickIndex(headers, ["brand","מותג"]);
    if (iName < 0) { iName = 0; } // no header → col 0 is name
    const out: LocalRow[] = [];
    for (let i=1;i<lines.length;i++){
      const cols = smartSplit(lines[i], delim);
      const name = (cols[iName] ?? "").trim();
      if (!name) continue;
      const priceNum = Number(String(cols[iPrice] ?? "").replace(/[^\d.]/g,""));
      const price = isFinite(priceNum) ? priceNum : NaN;
      out.push({
        name,
        price: price,
        size:  iSize>=0  ? (cols[iSize]  ?? "").trim() : undefined,
        brand: iBrand>=0 ? (cols[iBrand] ?? "").trim() : undefined,
        chain: chainHint
      });
    }
    out.sort((a,b)=> a.name.localeCompare(b.name,"he"));
    return out;
  } catch {
    return [];
  }
}

// ==== מיפוי רשתות (aliases) ====
const CHAIN_MAP: Record<string, string[]> = {
  "Shufersal":   ["שופרסל","shufersal","shufersal.co.il"],
  "Rami Levi":   ["רמי לוי","rami levi","ramilevy","rami-levy","ramilevy.co.il"],
  "Tiv Taam":    ["טיב טעם","tiv taam","tivtaam","tivtaam.co.il"],
  "Yohananof":   ["יוחננוף","yohananof","yoh.co.il"],
  "Victory":     ["ויקטורי","victory","victoryonline.co.il"],
  "Hazi Hinam":  ["חצי חינם","hazi hinam","hazihinam"],
  "Dor Alon":    ["דור אלון","dor alon","alonit","doralon"],
  "Super Yehuda":["סופר יהודה","super yehuda"],
  "Yellow":      ["yellow","yellow.co.il"],
  "City Market": ["סיטי מרקט","city market"]
};
function normalizeChainName(raw: string): string {
  const n = (raw || "").toLowerCase();
  for (const chain in CHAIN_MAP) {
    if (CHAIN_MAP[chain].some(alias => n.includes(alias.toLowerCase()))) return chain;
  }
  const exact = Object.keys(CHAIN_MAP).find(k => k.toLowerCase() === n);
  return exact || raw || "Unknown";
}

// ==== טוענים את כל הקבצים ב-public/data שמסתיימים ב _sorted.(tsv|csv) ====
const LOCAL_DB: Record<string, LocalRow[]> = {};
for await (const f of Deno.readDir("public/data")) {
  if (!f.isFile) continue;
  if (!/_sorted\.(tsv|csv)$/i.test(f.name)) continue;

  const path = `public/data/${f.name}`;
  const lower = f.name.toLowerCase();
  let chainGuess = "";
  if (lower.includes("hazi") || lower.includes("חצי")) chainGuess = "Hazi Hinam";
  else if (lower.includes("dor") && lower.includes("alon")) chainGuess = "Dor Alon";
  else if (lower.includes("yehuda")) chainGuess = "Super Yehuda";
  else if (lower.includes("yellow")) chainGuess = "Yellow";
  else if (lower.includes("city") && lower.includes("market")) chainGuess = "City Market";
  else if (lower.includes("yoh")) chainGuess = "Yohananof";
  else if (lower.includes("victory")) chainGuess = "Victory";
  else if (lower.includes("rami")) chainGuess = "Rami Levi";
  else if (lower.includes("shuf")) chainGuess = "Shufersal";
  else if (lower.includes("tiv")) chainGuess = "Tiv Taam";

  const rows = await readLocalTSV(path, chainGuess);
  if (!rows.length) continue;
  if (!LOCAL_DB[chainGuess]) LOCAL_DB[chainGuess] = [];
  LOCAL_DB[chainGuess].push(...rows);
  LOCAL_DB[chainGuess].sort((a,b)=> a.name.localeCompare(b.name, "he"));
}

// ==== אינדקס כולל לכל הרשתות ====
const LOCAL_ALL: LocalRow[] = Object.values(LOCAL_DB).flat().sort((a,b)=> a.name.localeCompare(b.name,"he"));

// ==== פונקציות binsearch על מערך ממוין ====
function binFindExactOrPrefix(sorted: LocalRow[], q: string): LocalRow | null {
  if (!sorted?.length || !q) return null;
  const target = q.trim().toLowerCase();
  let lo=0, hi=sorted.length-1, best: LocalRow|null = null;
  while (lo<=hi){
    const mid=(lo+hi)>>1;
    const name=sorted[mid].name.toLowerCase();
    if (name===target) return sorted[mid];
    if (name.startsWith(target)) { best=sorted[mid]; hi=mid-1; }
    else if (name<target) lo=mid+1; else hi=mid-1;
  }
  return best;
}
function binCollectPrefix(sorted: LocalRow[], q: string, limit=20): LocalRow[] {
  const base = binFindExactOrPrefix(sorted, q);
  if (!base) return [];
  const target = q.trim().toLowerCase();
  // lower bound for prefix
  let lo=0, hi=sorted.length;
  while (lo<hi){
    const mid=(lo+hi)>>1;
    if (sorted[mid].name.toLowerCase().localeCompare(target,"he")<0) lo=mid+1;
    else hi=mid;
  }
  const out: LocalRow[] = [];
  for (let i=lo; i<sorted.length && out.length<limit; i++) {
    const n = sorted[i].name.toLowerCase();
    if (n.startsWith(target)) out.push(sorted[i]); else break;
  }
  return out;
}

// ==== נורמליזציה אגרסיבית לשמות (לדדופ/מיפוי עקבי) ====
function normName(s: string) {
  return (s||"")
    .toLowerCase()
    .replace(/[״"׳']/g,"")
    .replace(/[\-–—_/.,()]/g," ")
    .replace(/\s+/g," ")
    .trim();
}

// ==== Maps לנורמליזציה ====
const LOCAL_MAP: Record<string, Map<string, LocalRow>> = {};
for (const [chain, rows] of Object.entries(LOCAL_DB)) {
  const m = new Map<string, LocalRow>();
  for (const r of rows) {
    const k = normName(r.name);
    if (!m.has(k)) m.set(k, r);
  }
  LOCAL_MAP[chain] = m;
}
const LOCAL_ALL_MAP = new Map<string, LocalRow[]>();
for (const r of LOCAL_ALL) {
  const k = normName(r.name);
  if (!LOCAL_ALL_MAP.has(k)) LOCAL_ALL_MAP.set(k, []);
  LOCAL_ALL_MAP.get(k)!.push(r);
}

////////////////////////////////////////////////////////////////
// 4) TEXT NORMALIZATION + AUTOCOMPLETE (dedup)
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
function scoreRow(q: string, row: ProductRow) {
  const n = norm(q);
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
  return s;
}
function suggestFromProducts(q: string, limit = 12) {
  if (!q || !q.trim() || PRODUCTS.length === 0) return [];
  return PRODUCTS.map(r => ({ r, s: scoreRow(q, r) }))
    .filter(x => x.s > 0)
    .sort((a,b)=> b.s - a.s)
    .slice(0, limit)
    .map(x => x.r);
}
function dedupSuggestions(list: ProductRow[]) {
  const seen = new Set<string>();
  const out: ProductRow[] = [];
  for (const s of list) {
    const key = normName(s.label || s.canonical || s.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
function suggestFromLocal(q: string, limit=12) {
  if (!q || !q.trim() || LOCAL_ALL.length===0) return [];
  const rows = binCollectPrefix(LOCAL_ALL, q, limit*2);
  const uniq: Record<string, LocalRow> = {};
  for (const r of rows) {
    const k = normName(r.name);
    if (!uniq[k]) uniq[k] = r;
  }
  const arr = Object.values(uniq).slice(0, limit);
  return arr.map((r,i)=>({
    id: `local_${i}_${r.name}`,
    label: r.name,
    canonical: r.name,
    default_size: r.size,
    brand: r.brand,
    tags: ["LocalDB"]
  }));
}

////////////////////////////////////////////////////////////////
// 5) MAPS (ג׳יאוקוד/חנויות קרובות) — בסיסי; אפשר להקל
////////////////////////////////////////////////////////////////
type LatLng = { lat: number; lng: number };
type NearbyShop = { chain: string; name: string; address?: string; lat: number; lng: number; place_id: string; rating?: number };

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
function meters(km: number) { return Math.max(100, Math.round(km * 1000)); }
async function findNearbySupermarketsByLatLng(lat: number, lng: number, radiusKm: number): Promise<NearbyShop[]> {
  const radius = meters(radiusKm);
  const ck = `places:${lat},${lng}:${radius}`;
  const cached = cacheGet<NearbyShop[]>(ck);
  if (cached) return cached;

  // אם אין Google API key—פשוט נחזיר רשימת "רשתות ידועות" בלי מיקום אמיתי
  if (!GOOGLE_API_KEY) {
    const pseudo: NearbyShop[] = Object.keys(CHAIN_MAP).slice(0, MAX_SUPERMARKETS).map((chain, i) => ({
      chain,
      name: chain,
      address: "—",
      lat, lng,
      place_id: `pseudo_${chain}_${i}`
    }));
    cacheSet(ck, pseudo, PLACES_TTL_MS);
    return pseudo;
  }

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
// 6) PLAN PIPELINE + ESTIMATE (רק כשאין נתון)
////////////////////////////////////////////////////////////////
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
  // עזר לקליינט
  estimated?: boolean; // true אם זה מחיר מוערך (אין נתון בטבלה)
};
function computeUnits(e: LlmItemOut) {
  const price = e.price;
  if (!price) return;
  const m = (e.size_text||"").toLowerCase();
  let liters = 0, kg = 0; let k: RegExpMatchArray | null;
  if ((k = m.match(/(\d+(?:\.\d+)?)\s*l/))) liters = Number(k[1]);
  if ((k = m.match(/(\d{2,4})\s*ml/))) liters = Number(k[1]) / 1000;
  if ((k = m.match(/(\d+(?:\.\d+)?)\s*kg/))) kg = Number(k[1]);
  if ((k = m.match(/(\d{2,4})\s*g/))) kg = Number(k[1]) / 1000;
  if (liters>0) e.unit_per_liter = price / liters;
  if (kg>0) e.unit_per_kg = price / kg;
}
function mean(nums: number[]) { return nums.reduce((a,b)=>a+b,0) / nums.length; }

type PlanReq = {
  address?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  items?: string[];
  include_debug?: boolean;
};
type Basket = {
  chain: string;
  shop_display_name?: string;
  total?: number;
  match_overall?: number;
  coverage?: number;
  location?: { lat: number; lng: number; address?: string };
  breakdown: LlmItemOut[];
  distance_km?: number;
};

async function estimatePriceForItem(item: string, chain: string): Promise<LlmItemOut> {
  const key = normName(item);
  const candidates = LOCAL_ALL_MAP.get(key) || [];
  const prices = candidates.map(x=> x.price).filter(p => typeof p === "number" && isFinite(p) && p>0) as number[];
  const baseAvg = prices.length ? mean(prices) : undefined;

  // אופציונלי: לשפר בעזרת LLM — לא חובה
  let llmGuess: number | undefined = undefined;
  if (OPENAI_API_KEY) {
    try {
      const sys = "Give a single realistic retail price in ILS for the given grocery item in Israel. Numbers only.";
      const body = {
        model: OPENAI_MODEL, temperature: 0,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: `Item: ${item}\nCountry: Israel\nCurrency: ILS` }
        ]
      };
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "authorization": `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then(x=>x.json()).catch(()=>null as any);
      const txt = (r?.choices?.[0]?.message?.content || "").replace(/[^\d.]/g,"").trim();
      const num = Number(txt);
      if (isFinite(num) && num>0) llmGuess = num;
    } catch {}
  }

  let estimated = llmGuess ?? baseAvg ?? 10;
  if (baseAvg) estimated = Math.max(estimated, baseAvg * 1.08); // הבטחה: מעל הממוצע
  estimated = Math.round(estimated * 100) / 100;

  const out: LlmItemOut = {
    item,
    product_name: item,
    price: estimated,
    currency: "₪",
    merchant: chain,
    confidence_pct: baseAvg ? 45 : 40,
    substitute: false,
    description: "מחיר מוערך (אין נתון בטבלה)",
    estimated: true
  };
  computeUnits(out);
  return out;
}

async function planHandler(req: PlanReq) {
  const include_debug = !!req.include_debug;

  // קלט/מיקום
  let lat = Number(req.lat || 0), lng = Number(req.lng || 0);
  let centerFrom = "gps";
  if ((!lat || !lng) && req.address) {
    centerFrom = "address";
    const loc = await geocodeAddress(req.address, include_debug);
    lat = loc.lat; lng = loc.lng;
  }
  if (!lat || !lng) throw Object.assign(new Error("Address not found"), { reason: "NO_LATLNG" });

  const userLoc = { lat, lng };
  const radiusKm = Number(req.radiusKm || 10);
  const shops = await findNearbySupermarketsByLatLng(lat, lng, radiusKm);
  if (!shops.length) return { ok:true, baskets: [], debug: include_debug ? { centerFrom, lat, lng } : undefined };

  const userItems = Array.isArray(req.items) ? req.items.filter(Boolean) : [];
  if (!userItems.length) return { ok:false, error:"No items", code:"NO_ITEMS" };

  const baskets: Basket[] = [];
  const resolveCache = new Map<string, LlmItemOut>(); // עקביות באותה ריצה: chain|normItem → result

  for (const s of shops) {
    const chain = s.chain || "Unknown";
    const breakdown: LlmItemOut[] = [];
    const localMap = LOCAL_MAP[chain];

    for (const item of userItems) {
      const nkey = normName(item);
      const cacheKey = `${chain}|${nkey}`;
      const cached = resolveCache.get(cacheKey);
      if (cached) { breakdown.push(cached); continue; }

      // קודם כל: ניסיון נתון מהרשת עצמה
      const localHit = localMap?.get(nkey);
      if (localHit && isFinite(localHit.price)) {
        const out: LlmItemOut = {
          item,
          product_name: localHit.name,
          price: localHit.price,
          currency: "₪",
          merchant: chain,
          confidence_pct: 100,
          substitute: false,
          size_text: localHit.size
        };
        computeUnits(out);
        resolveCache.set(cacheKey, out);
        breakdown.push(out);
        continue;
      }

      // אין נתון—הערכה בלבד (LLM/ממוצע; תמיד מעל ממוצע אם קיים)
      const est = await estimatePriceForItem(item, chain);
      resolveCache.set(cacheKey, est);
      breakdown.push(est);
    }

    // סיכומים
    const prices = breakdown.map(b=> b.price).filter((x): x is number => typeof x === "number" && isFinite(x));
    const total = prices.reduce((a,b)=> a+b, 0);
    const coverage = breakdown.filter(b=> typeof b.price === "number").length / breakdown.length;
    const match_overall = breakdown.reduce((a,b)=> a + (typeof b.confidence_pct === "number" ? b.confidence_pct : 50), 0) / (breakdown.length * 100);
    const distKm = (typeof s.lat === "number" && typeof s.lng === "number")
      ? Number(haversineKm(userLoc, { lat: s.lat, lng: s.lng }).toFixed(2))
      : undefined;

    baskets.push({
      chain,
      shop_display_name: `${s.name}`,
      total: prices.length ? Number(total.toFixed(2)) : undefined,
      match_overall,
      coverage,
      location: { lat: s.lat, lng: s.lng, address: s.address },
      breakdown,
      distance_km: distKm
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
// 7) ROUTER: APIs + Static
////////////////////////////////////////////////////////////////
async function handleApi(req: Request) {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const { pathname, searchParams } = new URL(req.url);
  const ip = req.headers.get("x-forwarded-for") || "0.0.0.0";
  const key = `${ip}:${pathname}`;
  if (!rateLimit(key, 400, 60_000)) return json({ ok:false, error:"Too Many Requests" }, 429);

  if (pathname === "/api/health") {
    return json({
      ok:true,
      status:"alive",
      products_loaded: PRODUCTS.length,
      chains: Object.keys(LOCAL_DB),
      counts: Object.fromEntries(Object.entries(LOCAL_DB).map(([k,v])=>[k, v.length])),
      total_rows: LOCAL_ALL.length,
      MOCK_MODE,
      GOOGLE_API_KEY: !!GOOGLE_API_KEY,
      SERPAPI_KEY: !!SERPAPI_KEY,
      OPENAI_API_KEY: !!OPENAI_API_KEY
    });
  }

  if (pathname === "/api/suggest") {
    const q = searchParams.get("q") ?? "";
    const limit = Number(searchParams.get("limit") ?? "12");
    const local = suggestFromLocal(q, limit);
    if (local.length >= limit) return json({ ok:true, suggestions: dedupSuggestions(local).slice(0,limit) });
    const rest = suggestFromProducts(q, Math.max(0, limit - local.length));
    const merged = dedupSuggestions([...local, ...rest]);
    return json({ ok:true, suggestions: merged.slice(0,limit) });
  }

  if (pathname === "/api/plan" && req.method === "POST") {
    const body = await req.text();
    let parsed: PlanReq = {};
    try { parsed = JSON.parse(body||"{}"); } catch {
      return json({ ok:false, error:"Invalid JSON body" }, 400);
    }
    try {
      const out = await planHandler(parsed);
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
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml",
      webp: "image/webp", gif: "image/gif",
      txt: "text/plain; charset=utf-8",
      tsv: "text/tab-separated-values; charset=utf-8",
      csv: "text/csv; charset=utf-8"
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
