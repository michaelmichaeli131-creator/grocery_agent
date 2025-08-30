/// <reference no-default-lib="true" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="dom.asynciterable" />
/// <reference lib="dom.webworker" />

import "https://deno.land/std@0.201.0/dotenv/load.ts"; // לוקאלית .env; על Deploy משתמשים ב-Env Vars
import { start } from "$fresh/server.ts";
import manifest from "./fresh.gen.ts";

// אם fresh.gen.ts עדיין לא נוצר מקומית — הרצה עם deno task dev תיצור אותו.
// ב-Deno Deploy בחירת Framework=Fresh מטפלת בזה אוטומטית.

await start(manifest);
