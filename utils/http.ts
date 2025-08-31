// grocery_agent/utils/http.ts

export async function safeJson(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) {
    console.error("FETCH FAIL", { url, status: r.status, body: text.slice(0, 500) });
    throw new Error(`Upstream ${r.status} for ${url}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error("JSON parse fail", { url, text: text.slice(0, 200) });
    throw new Error(`Invalid JSON from ${url}`);
  }
}
