import { getCache, setCache } from "./cache.ts";

const GOOGLE_MAPS_API_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY")!;

async function fetchJson(url: string, opts: RequestInit = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

export async function geocodeAddress(address: string) {
  const key = `geocode:${address}`;
  const cached = getCache(key);
  if (cached) return cached;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
  const json = await fetchJson(url);
  if (json.status !== "OK" || !json.results?.length) throw new Error("Geocode failed");
  const loc = json.results[0].geometry.location;
  setCache(key, loc, 5 * 60_000);
  return loc; // {lat, lng}
}

export async function findSupermarkets(lat: number, lng: number, radiusMeters: number, allowedChains: string[] = []) {
  const key = `nearby:${lat}:${lng}:${radiusMeters}:${allowedChains.join(",")}`;
  const cached = getCache(key);
  if (cached) return cached;

  const type = "grocery_or_supermarket";
  const keyword = allowedChains.length ? `&keyword=${encodeURIComponent(allowedChains.join("|"))}` : "";
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radiusMeters}&type=${type}${keyword}&key=${GOOGLE_MAPS_API_KEY}`;

  const json = await fetchJson(url);
  const results = (json.results || []).map((r: any) => ({
    name: r.name,
    place_id: r.place_id,
    address: r.vicinity ?? r.formatted_address ?? "",
    location: r.geometry?.location
  }));
  setCache(key, results, 2 * 60_000);
  return results as Array<{name:string; place_id:string; address:string; location:{lat:number; lng:number}}>;
}
