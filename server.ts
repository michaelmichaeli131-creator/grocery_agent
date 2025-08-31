// grocery_agent/server.ts
// שרת Deno מינימלי: מגיש סטטי מ-public/ + API ל-flow שביקשת.

// בלוק dotenv ללוקאל בלבד (ב-Deno Deploy אין קובץ .env)
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
const CACHE_TTL_MS  = Number(Deno.env.get("CACHE_TTL_MS") ?? "60000");   // 60s
const MAX_SUPERMARKETS = Number(Deno.env.get("MAX_SUPERMARKETS") ?? "10");
const SERPAPI_CONCURRENCY = Number(Deno.env.get("SERPAPI_CONCURRENCY") ?? "3");
const USE_CHP_FALLBACK = (Deno.env.get("USE_CHP_FALLBACK") ?? "0") === "1"; // כרגע hook בלבד

// ---------- Utilities ----------
type Json = Record<string, unknown>;
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

// ---------- Google Places: מציאת סופרים ----------
const KNOWN_CHAINS = [
  // HE
  "שופרסל","רמי לוי","יינות ביתן","ויקטורי","יוחננוף","טיב טעם","סופר-פארם","סופר פארם","מגה","מחסני השוק",
  // EN
  "Shufersal","Rami Levy","Yohananof","Victory","Tiv Taam","Super-Pharm","Mega","Mahsanei Hashuk",
];

type NearbyShop = {
  chain: string;           // שם רשת מזוהה (נורמליזציה גסה)
  name: string;            // שם המקום כפי שגוגל מחזיר
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
  // אם לא זוהה: נסה להתאים לשמות מוכרים
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

  // העדף רשתות מוכרות, קח עד 10
  const known = base.filter(b => KNOWN_CHAINS.some(c => b.name.toLowerCase().includes(c.toLowerCase())));
  const result = (known.length ? known : base).slice(0, MAX_SUPERMARKETS);
  cacheSet(ck, result);
  return result;
}

// ---------- SerpAPI (Google Shopping) ----------
type PriceRow = { item: string; price: number; currency: string; title?: string; link?: string; shop?: string; source?: "serpapi"|"chp" };

function normalizePrice(p: any): PriceRow | null {
  const currency = p?.currency ?? p?.prices?.[0]?.currency ?? "ILS";
  let priceNum: number | null = null;
  if (typeof p?.extracted_price === "number") priceNum = p.extracted_price;
  const t = p?.price ?? p?.prices?.[0]?.price ?? "";
  if (priceNum == null && typeof t === "string") {
    const num = Number(t.replace(/[^\d.]/g, ""));
    if (!Number.isNaN(num)) priceNum = num;
  }
  if (typeof t === "number") priceNum = t;
  if (priceNum == null) return null;
  return {
    item: p?.title ?? "",
    price: priceNum,
    currency,
    title: p?.title,
    link: p?.link,
    shop: p?.source ?? p?.merchant ?? p?.seller ?? "",
    source: "serpapi",
  };
}

async function serpSearchItemForChain(query: string, chain: string): Promise<PriceRow | null> {
  if (!SERPAPI_KEY) throw new Error("Missing SERPAPI_KEY");
  const q = `${query} ${chain}`;
  const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(q)}&hl=iw&gl=il&num=10&api_key=${SERPAPI_KEY}`;
  const data = await safeJson(url);
  const products: any[] = data?.shopping_results ?? [];
  if (!products.length) return null;

  // העדף התאמות לפי merchant/source שמכילים את שם הרשת
  const lower = chain.toLowerCase();
  const filtered = products.filter((p) => {
    const m = (p?.source ?? p?.merchant ?? p?.seller ?? "").toString().toLowerCase();
    return m.includes(lower);
  });
  const candidate = filtered[0] ?? products[0];
  const row = normalizePrice(candidate);
  return row;
}

// ---------- CHP fallback (HOOK בלבד כרגע) ----------
async function chpFallbackPrice(query: string, chain: string): Promise<PriceRow | null> {
  if (!USE_CHP_FALLBACK) return null;
  // TODO: לממש שאיבה מ-CHP בצורה שמותר לפי התנאים שלהם (אין API רשמי; מומלץ להשיג הרשאה/שכבת פרוקסי חוקית).
  // כרגע מחזיר null כדי לא "להמציא" שום מחיר.
  return null;
}

// ---------- Pricing aggregation ----------
async function priceBasket(items: string[], chains: string[]) {
  const result: { chain: string; total: number; breakdown: PriceRow[] }[] = [];

  // תור עם קונקרנציה נמוכה כדי לא להיתקע על ריבוי בקשות
  const queue: (() => Promise<void>)[] = [];
  const pushTask = (fn: () => Promise<void>) => queue.push(fn);
  const runQueue = async () => {
    const running: Promise<void>[] = [];
    while (queue.length) {
      while (running.length < SERPAPI_CONCURRENCY && queue.length) {
        const task = queue.shift()!;
        const p = task().finally(() => {
          const i = running.indexOf(p);
          if (i >= 0) running.splice(i, 1);
        });
        running.push(p);
      }
      if (running.length) await Promise.race(running);
    }
    await Promise.all(running);
  };

  const perChain: Record<string, PriceRow[]> = {};
  for (const chain of chains) perChain[chain] = [];

  for (const chain of chains) {
    for (const item of items) {
      pushTask(async () => {
        const ck = `price:${chain}:${item}`;
        let row = cacheGet<PriceRow>(ck);
        if (!row) {
          try {
            row = await serpSearchItemForChain(item, chain);
            if (!row) row = await chpFallbackPrice(item, chain);
            if (row) cacheSet(ck, row);
          } catch (e) {
            console.error("PRICE LOOKUP FAIL", { chain, item, e: String(e) });
          }
          await sleep(250);
        }
        perChain[chain].push(row ?? { item, price: NaN, currency: "ILS", source: "serpapi" });
      });
    }
  }

  await runQueue();

  for (const chain of chains) {
    const breakdown = perChain[chain];
    const total = breakdown.reduce((acc, r) => acc + (Number.isFinite(r.price) ? r.price : 0), 0);
    result.push({ chain, total, breakdown });
  }

  // מיין מקומי (למקרה שה-LLM ייפול)
  const rankedLocal = [...result].sort((a, b) => (a.total || Infinity) - (b.total || Infinity));
  return { result, rankedLocal };
}

// ---------- OpenAI LLM: איגוד ותיעדוף ----------
async function consolidateWithLLM(nearby: NearbyShop[], priced: { chain: string; total: number; breakdown: PriceRow[] }[]) {
  if (!OPENAI_API_KEY) return null;
  const sys = [
    "You are a strict JSON generator for shopping basket comparison.",
    "You MUST NOT invent prices. Only use the numeric prices provided in input.",
    "If an item price is NaN/missing, keep it null and include a warning.",
    "Output MUST be pure JSON (object) with keys: top3 (array of 3), warnings (array).",
    "Each element of top3: { chain, shop_display_name, total, currency:'ILS', breakdown:[{item, price|null, currency:'ILS', source, link?}], location:{name,address,lat,lng} }",
    "Pick shops that appear in 'nearby' first; if priced list includes other chains not nearby, ignore them.",
    "Do not browse the web. Do not estimate. Keep missing items as null.",
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
          { type: "text", text: "\nCHAIN_PRICES JSON:" },
          { type: "text", text: JSON.stringify(priced).slice(0, 100000) },
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
    const tt = await r.text().catch(() => "");
    console.error("OPENAI FAIL", r.status, tt.slice(0, 500));
    return null;
  }
  const json = await r.json();
  const content = json?.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(content);
  } catch {
    console.error("OPENAI PARSE FAIL content:", content.slice(0, 300));
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

      const { result: priced, rankedLocal } = await priceBasket(items, chains);

      // LLM לא "ממציא" כלום; רק מסדר JSON. אם נפל—נחזור לפורמט לוקאלי.
      const llm = await consolidateWithLLM(nearby, priced).catch(() => null);

      if (llm?.top3?.length) {
        return json({ ok: true, mode: "llm", ...llm });
      } else {
        // Fallback: טופ 3 לפי חישוב לוקאלי
        const top3 = rankedLocal.slice(0, 3).map((r) => {
          const loc = nearby.find(n => n.chain === r.chain) || null;
          return {
            chain: r.chain,
            shop_display_name: loc?.name ?? r.chain,
            total: r.total,
            currency: "ILS",
            breakdown: r.breakdown.map(b => ({
              item: b.item, price: Number.isFinite(b.price) ? b.price : null,
              currency: "ILS", source: b.source, link: b.link,
            })),
            location: loc ? { name: loc.name, address: loc.address, lat: loc.lat, lng: loc.lng } : null,
          };
        });
        return json({ ok: true, mode: "local", top3, warnings: ["LLM consolidation failed or disabled"] });
      }
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
