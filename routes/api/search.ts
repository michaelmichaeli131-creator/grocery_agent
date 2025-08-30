import { Handlers } from "$fresh/server.ts";
import { geocodeAddress, findSupermarkets } from "../../utils/maps.ts";
import { queryStoreItems } from "../../utils/shopping.ts";
import { parseAndUnify } from "../../utils/openai.ts";

const MAX_SUPERMARKETS = Number(Deno.env.get("MAX_SUPERMARKETS") ?? 6);

// רשתות ידועות — למיקוד ולהימנע ממכולות קטנות
const KNOWN_CHAINS = [
  "שופרסל", "רמי לוי", "ויקטורי", "יינות ביתן", "טיב טעם",
  "אושר עד", "חצי חינם", "קרפור", "Carrefour", "יינות-ביתן", "יוחננוף", "מחסני השוק"
];

export const handler: Handlers = {
  async POST(req) {
    try {
      const { items, address, radius_km = 3, language = "he" } = await req.json();

      if (!items || !address) {
        return new Response(JSON.stringify({ error: "address and items are required" }), { status: 400 });
      }

      // 1) Geocode
      const loc = await geocodeAddress(address);

      // 2) Find supermarkets (filtered by known chains)
      const supermarkets = await findSupermarkets(loc.lat, loc.lng, Math.round(Number(radius_km) * 1000), KNOWN_CHAINS);
      const selected = supermarkets.slice(0, MAX_SUPERMARKETS);
      if (selected.length === 0) {
        return new Response(JSON.stringify({ error: "לא נמצאו סניפי רשתות מוכרות ברדיוס" }), { status: 404 });
      }

      // 3) For each supermarket, query prices for each item via SerpApi (Google Shopping) + Pricez snippet
      const list = String(items).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const perStore = await queryStoreItems(selected, list, language);

      // 4) Unify + rank via OpenAI (strict JSON, no invented prices)
      const unified = await parseAndUnify({
        location: loc,
        requested_items: list,
        supermarkets: perStore,
        language
      });

      return new Response(
        JSON.stringify({ meta: { ts: new Date().toISOString() }, input: { address, radius_km, language }, results: unified }),
        { headers: { "Content-Type": "application/json" } }
      );

    } catch (err: any) {
      console.error("search error:", err?.message || err);
      return new Response(JSON.stringify({ error: "server_error", detail: String(err?.message || err) }), { status: 500 });
    }
  }
};
