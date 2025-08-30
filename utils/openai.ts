const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

// אפשר להשתמש או ב-Responses API או ב-Chat Completions.
// כאן: Chat Completions עם gpt-4o ודרישה ל-JSON בלבד.

export async function parseAndUnify(payload: {
  location: {lat:number; lng:number};
  requested_items: string[];
  supermarkets: any[];
  language: "he" | "en";
}) {
  const system = `
You are a strict JSON parser for grocery basket comparison.
Input includes:
- location {lat,lng}
- requested_items: array of strings
- supermarkets: array; each has {supermarket, items:[{query, serp:[{title, price, currency, link, source}], pricez: html_snippet_or_null}]}

TASK:
1) For EACH supermarket, try to extract a numeric price per requested item from serp results (prefer exact/same product size).
2) If no reliable numeric price is present, set price = null.
3) Compute total_price as the sum of available numeric prices (skip nulls). If none available, total_price = null.
4) Output EXACT JSON (no markdown): 
{
  "results": [
    {
      "supermarket": "name",
      "total_price": number|null,
      "currency": "ILS",
      "items": [
        {"name":"...", "price": number|null, "source":"SerpApi|Pricez|Mixed", "link": "url|null"}
      ]
    }
  ]
}
5) Sort results by total_price ascending, nulls last.
6) NEVER invent prices; never guess. Use only numeric prices you saw in serp. Ignore pricez snippet unless you can clearly extract a numeric price (if not sure, leave null).
`;

  const user = JSON.stringify(payload);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0,
      response_format: { type: "json_object" } // מבקש JSON קשיח
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${txt}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(content);
  } catch {
    return { results: [] };
  }
}
