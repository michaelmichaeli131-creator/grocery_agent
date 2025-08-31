export function requireEnv(name: string, def?: string) {
  const v = Deno.env.get(name) ?? def;
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const ENV = {
  OPENAI: () => requireEnv("OPENAI_API_KEY"),
  GOOGLE: () => requireEnv("GOOGLE_API_KEY"),
  SERPAPI: () => requireEnv("SERPAPI_KEY"),
  PORT: () => Deno.env.get("PORT") ?? "8000",
  CACHE_TTL_MS: () => Deno.env.get("CACHE_TTL_MS") ?? "60000",
  MAX_SUPERMARKETS: () => Deno.env.get("MAX_SUPERMARKETS") ?? "10",
};
