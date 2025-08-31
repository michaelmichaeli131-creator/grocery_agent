// dev.ts
import dev from "$fresh/dev.ts";
// אם יש לך fresh.config.ts:
import config from "./fresh.config.ts";

await dev(import.meta.url, "./main.ts", config);

// אם אין לך fresh.config.ts, מחק את שתי השורות עם config ושמור על:
// await dev(import.meta.url, "./main.ts");
