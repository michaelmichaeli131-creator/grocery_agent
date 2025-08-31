// server.ts — שרת Deno פשוט: סטטי + REST API
// מביא סופרים קרובים (Google Places), מועמדים למחירים (SerpAPI / Google Shopping),
// מעביר ל-LLM לאיחוד ובחירה לפי שם/תיאור, ומחזיר Top-3 ללקוח.
// חשוב: לא "ממציאים" מחירים; ה-LLM בוחר רק מתוך מועמדים שסופקו.

// לוקאלית בלבד (ב-Deno Deploy אין .env)
if (!Deno.env.get("DENO_DEPLOYMENT_ID")) {
  try {
    const { load } = await import("https://deno.land/std@0.201.0/dotenv/mod.ts");
    load({ export: true });
  } catch {}
}

const PORT = Number(Deno.env.get("PORT") ?? "8000");
const GOOGLE_API_KEY = Deno.env.get("GOOGLE_API_KEY") ?? "";
const SERPAPI_KEY   = Deno.env.get("SERPAPI_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const CACHE_TTL_MS  = Number(Deno.env.get("CACHE_TTL_MS") ?? "60000");
const MAX_SUPERMARKETS = Number(Deno.env.get("MAX_SUPERMARKETS") ?? "10");
const SERPAPI_CONCURRENCY = Number(Deno.env.get("SERPAPI_CONCURRENCY") ?? "3");
const SERPAPI_MAX_CANDIDATES = Number(Deno.env.get("SERPAPI_MAX_CANDIDATES") ?? "5");
const USE_CHP_FALLBACK = (Deno.env.get("USE_CHP_FALLBACK") ?? "0") === "1"; // hook בלבד כרגע

// ---------- Utilities ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
async function safeJson(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) {
    console.error("FETCH FAIL", { url, status: r.status, body: text.slice(0, 500) });
    throw new Error(`Upstream ${r.status} for ${url}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON from ${url}`); }
}
const memCache = new Map<string, { exp: number; data: unknown }>();
function cacheGet<T>(k: string): T | null {
  const hit = memCache.get(k);
  if (!hit) return null;
  if (Date.now() > hit.exp) { memCache.delete(k); return null; }
  return hit.data as T;
}
function cacheSet(k: string, data: unknown, ttl = CACHE_TTL_MS) {
  memCache.set(k, { exp: Date.now() + ttl, data });
}

// ---------- Google Places ----------
const KNOWN_CHAINS = [
  // HE
  "שופרסל","רמי לוי","יינות ביתן","ויקטורי","יוחננוף","טיב טעם","סופר-פארם","סופר פארם","מגה","מחסני השוק",
  // EN
  "Shufersal","Rami Levy","Yohananof","Victory","Tiv Taam","Super-Pharm","Mega","Mahsanei Hashuk",
];

type NearbyShop = {
  chain: string;           // נורמליזציה גסה לשם הרשת
  name: string;            // השם כפי שחוזר מגוגל
  address?: string;        // vicinity
  lat: number; lng: number;
  place_id: string;
  rating?: number;
};

function normalizeChainName(name: string): string {
  const n = (name || "").toLowerCase();
  const map: Record<string,string> = {
    "שופרסל": "Shufersal", "shufersal": "Shufersal",
    "רמי לוי": "Rami Levy", "rami levy": "Rami Levy",
    "יוחננוף": "Yohananof", "yohananof": "Yohananof",
    "ויקטורי": "Victory",  "victory": "Victory",
    "טיב טעם": "Tiv Taam", "tiv taam": "Tiv Taam",
    "יינות ביתן": "Yenot Bitan", "yenot bitan": "Yenot Bitan",
    "סופר פארם": "Super-Pharm", "סופר-פארם":"Super-Pharm", "super-pharm":"Super-Pharm", "super pharm":"Super-Pharm",
    "mega": "Mega", "מגה":"Mega",
    "מחסני השוק":"Mahsanei Hashuk","mahsanei hashuk":"Mahsanei Hashuk",
  };
  for (const k in map) if (n.includes(k)) return map[k];
  for (const c of KNOWN_CHAINS) if (n.includes(c.toLowerCase())) return c;
  return name;
}

async function geocodeAddress(address: string) {
  const ck = `geo:${address}`;
  const cached = cacheGet<any>(ck);
  if (cached) return cached;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`;
  const json = await safeJson(url);
  const loc = json?.results?.[0]?.geometry?.location;
  if (!loc) throw new Error("Address not found");
  cacheSet(ck, loc);
  return loc; // { lat, lng }
}

async function findNearbySupermarkets(address: string, radiusKm: number): Promise<NearbyShop[]> {
  if (!GOOGLE_API_KEY) throw new Error("Missing GOOGLE_API_KEY");
  const { lat, lng } = await geocodeAddress(address);
  const radius = Math.round(radiusKm * 1000);

  const ck = `places:${lat},${lng}:${radius}`;
  const cached = cacheGet<NearbyShop[]>(ck);
  if (cached) return cached;

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=supermarket&key=${GOOGLE_API_KEY}`;
  const data = await safeJson(url);
  const base = (data?.results ?? []).map((r: any) => {
    const name: string = r?.name ?? "";
    const chain = normalizeChainName(name);
    return {
      chain,
      name,
      address: r?.vicinity,
      lat: r?.geometry?.location?.lat,
      lng: r?.geometry?.location?.lng,
      place_id: r?.place_id,
      rating: r?.rating,
    } as NearbyShop;
  });

  const known = base.filter(b => KNOWN_CHAINS.some(c => b.name.toLowerCase().includes(c.toLowerCase())));
  const result = (known.length ? known : base).slice(0, MAX_SUPERMARKETS);
  cacheSet(ck, result);
  return result;
}

// ---------- SerpAPI / Google Shopping ----------
type PriceCandidate = {
  itemQuery: string;        // מה שהמשתמש ביקש (שאילתא)
  title: string;            // שם המוצר בתוצאות
  description?: string;     // תיאור/סניפט אם קיים
  price: number;
  currency: string;
  link?: string;
  merchant?: string;
  source: "serpapi"|"chp";
};
type ChainPricing = {
  chain: string;
  items: {
    query: string;
    candidates: PriceCandidate[];
  }[];
};

function _normPriceNum(anyPrice: any): number | null {
  if (typeof anyPrice === "number") return anyPrice;
  if (typeof anyPrice === "string") {
    const n = Number(anyPrice.replace(/[^\d.]/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return null;
}
function _candidateFromSerp(p: any, query: string): PriceCandidate | null {
  const priceNum =
    (typeof p?.extracted_price === "number" && p.extracted_price) ||
    _normPriceNum(p?.price) ||
    _normPriceNum(p?.prices?.[0]?.price) ||
    _normPriceNum(p?.prices?.[0]?.extracted_price);

  if (priceNum == null) return null;
  const title = String(p?.title ?? "").trim();
  const description = String(p?.snippet ?? p?.description ?? "").trim() || undefined;

  return {
    itemQuery: query,
    title,
    description,
    price: priceNum,
    currency: p?.currency ?? p?.prices?.[0]?.currency ?? "ILS",
    link: p?.link,
    merchant: p?.source ?? p?.merchant ?? p?.seller ?? undefined,
    source: "serpapi",
  };
}
async function serpSearchCandidatesForChain(query: string, chain: string): Promise<PriceCandidate[]> {
  if (!SERPAPI_KEY) throw new Error("Missing SERPAPI_KEY");
  const q = `${query} ${chain}`;
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(q)}&hl=iw&gl=il&num=20&api_key=${SERPAPI_KEY}`;
  const data = await safeJson(url);
  const products: any[] = data?.shopping_results ?? [];
  if (!products.length) return [];

  const lowerChain = chain.toLowerCase();
  const preferred = products.filter((p) => {
    const m = (p?.source ?? p?.merchant ?? p?.seller ?? "").toString().toLowerCase();
    return m.includes(lowerChain);
  });

  const pool = (preferred.length ? preferred : products)
    .map((p) => _candidateFromSerp(p, query))
    .filter(Boolean) as PriceCandidate[];

  return pool.slice(0, SERPAPI_MAX_CANDIDATES);
}

// CHP fallback (כרגע hook בלבד)
async function chpFallbackPrice(_query: string, _chain: string): Promise<PriceCandidate | null> {
  if (!USE_CHP_FALLBACK) return null;
  // TODO: לממש באופן חוקי/מאושר. כרגע לא מחזירים דבר כדי לא "להמציא".
  return null;
}

async function priceBasketMulti(items: string[], chains: string[]): Promise<ChainPricing[]> {
  const out: ChainPricing[] = chains.map((chain) => ({ chain, items: [] }));

  const tasks: Promise<void>[] = [];
  for (const pack of out) {
    for (const q of items) {
      tasks.push((async () => {
        const ck = `cands:${pack.chain}:${q}`;
        let cands = cacheGet<PriceCandidate[]>(ck);
        if (!cands) {
          try {
            cands = await serpSearchCandidatesForChain(q, pack.chain);
            if (!cands?.length) {
              const fallback = await chpFallbackPrice(q, pack.chain);
              cands = fallback ? [fallback] : [];
            }
            cacheSet(ck, cands);
          } catch (e) {
            console.error("PRICE LOOKUP FAIL", { chain: pack.chain, item: q, e: String(e) });
            cands = [];
          }
          await sleep(250); // מניעת 429
        }
        pack.items.push({ query: q, candidates: cands });
      })());
      if (tasks.length % SERPAPI_CONCURRENCY === 0) {
        await Promise.race(tasks.slice(-SERPAPI_CONCURRENCY));
      }
    }
  }
  await Promise.all(tasks);

  return out;
}

// ---------- LLM consolidation ----------
function localPickTop3(nearby: NearbyShop[], multi: ChainPricing[]) {
  const ranked = multi.map((pack) => {
    const breakdown: PriceCandidate[] = [];
    for (const it of pack.items) {
      const best = it.candidates.length
        ? it.candidates.reduce((a, b) => (a.price <= b.price ? a : b))
        : { itemQuery: it.query, title: it.query, description: "תחליף (לא נמצאה התאמה)", price: NaN, currency: "ILS", source: "serpapi" } as PriceCandidate;
      breakdown.push(best);
    }
    const total = breakdown.reduce((s, c) => s + (Number.isFinite(c.price) ? c.price : 0), 0);
    return { chain: pack.chain, total, breakdown };
  }).sort((a, b) => (a.total || Infinity) - (b.total || Infinity));

  const top3 = ranked.slice(0, 3).map((r) => {
    const loc = nearby.find(n => n.chain === r.chain) || null;
    return {
      chain: r.chain,
      shop_display_name: loc?.name ?? r.chain,
      total: r.total,
      currency: "ILS",
      breakdown: r.breakdown.map(b => ({
        item: b.itemQuery,
        chosen_title: b.title,
        description: b.description ?? null,
        price: Number.isFinite(b.price) ? b.price : null,
        currency: b.currency,
        substitute: !Number.isFinite(b.price),
        source: b.source,
        link: b.link,
        merchant: b.merchant ?? null,
      })),
      location: loc ? { name: loc.name, address: loc.address, lat: loc.lat, lng: loc.lng } : null,
    };
  });

  return { top3, mode: "local" as const, warnings: [] as string[] };
}

async function consolidateWithLLM_v2(nearby: NearbyShop[], multi: ChainPricing[]) {
  if (!OPENAI_API_KEY) return null;

  const sys = [
    "You are a strict JSON generator for shopping basket comparison.",
    "You MUST NOT invent prices. Only select from the given candidates.",
    "For each requested item, you get multiple candidates per chain.",
    "Pick the best matching candidate by title/description (size/brand if specified by the query).",
    "If no suitable candidate exists for an item in a chain, mark substitute:true and set price:null.",
    "Output pure JSON with keys: top3 (array of 3), warnings (array).",
    "Each top3 element: { chain, shop_display_name, total, currency:'ILS', breakdown:[{ item, chosen_title, description, price|null, currency:'ILS', substitute:boolean, source, link?, merchant? }], location:{name,address,lat,lng} }",
    "Only consider chains that appear in NEARBY_SHOPS.",
    "Do NOT browse the web. Do NOT estimate prices.",
  ].join("\n");

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: [
          { type: "text", text: "NEARBY_SHOPS JSON:" },
          { type: "text", text: JSON.stringify(nearby).slice(0, 100000) },
          { type: "text", text: "\nCHAIN_PRICING_CANDIDATES JSON:" },
          { type: "text", text: JSON.stringify(multi).slice(0, 100000) },
        ],
      },
    ],
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    console.error("OPENAI FAIL", r.status, await r.text().catch(() => ""));
    return null;
  }
  const json = await r.json();
  try {
    return JSON.parse(json?.choices?.[0]?.message?.content ?? "{}");
  } catch {
    return null;
  }
}

// ---------- API Router ----------
async function handleApi(req: Request) {
  const { pathname } = new URL(req.url);

  try {
    if (pathname === "/api/health") {
      const present = {
        GOOGLE_API_KEY: !!GOOGLE_API_KEY,
        SERPAPI_KEY: !!SERPAPI_KEY,
        OPENAI_API_KEY: !!OPENAI_API_KEY,
      };
      return json({ ok: true, present });
    }

    if (pathname === "/api/plan" && req.method === "POST") {
      const { address, radiusKm = 5, items = [] } = await req.json();
      if (!address || !Array.isArray(items) || items.length === 0) {
        return json({ ok: false, error: "Missing address or items" }, 400);
      }

      const nearby = await findNearbySupermarkets(address, Number(radiusKm));
      const chains = Array.from(new Set(nearby.map(n => n.chain))).slice(0, MAX_SUPERMARKETS);

      const multi = await priceBasketMulti(items, chains);

      const llm = await consolidateWithLLM_v2(nearby, multi).catch(() => null);
      if (llm?.top3?.length) return json({ ok: true, mode: "llm", ...llm });

      const fallback = localPickTop3(nearby, multi);
      return json({ ok: true, ...fallback });
    }

    return json({ ok: false, error: "Not found" }, 404);
  } catch (e) {
    console.error("API ERROR:", e);
    return json({ ok: false, error: (e as Error).message }, 500);
  }
}

// ---------- Static files ----------
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

// ---------- Server ----------
Deno.serve({ port: PORT }, (req) => {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith("/api/")) return handleApi(req);
  return serveStatic(pathname);
});
