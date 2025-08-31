export const handler = () => {
  const vars = ["OPENAI_API_KEY","GOOGLE_API_KEY","SERPAPI_KEY"];
  return new Response(
    JSON.stringify({
      ok: vars.every(k => !!Deno.env.get(k)),
      present: Object.fromEntries(vars.map(k => [k, !!Deno.env.get(k)])),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};
