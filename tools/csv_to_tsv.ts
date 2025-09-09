// deno run -A tools/csv_to_tsv.ts <input.csv> <out_dir>
// Converts a pivot CSV (item_name + price columns per chain) into per-chain sorted TSVs and a merged TSV.

import { parse } from "https://deno.land/std@0.201.0/csv/parse.ts";

type ChainKey =
  | "Dor Alon"
  | "Hazi Hinam"
  | "Rami Levi"
  | "Shufersal"
  | "Super Yehuda"
  | "Tiv Taam"
  | "Yellow"
  | "Yohananof"
  | "city market";

const CHAINS: ChainKey[] = [
  "Rami Levi",
  "Shufersal",
  "Tiv Taam",
  "Yohananof",
  "Dor Alon",
  "Hazi Hinam",
  "Super Yehuda",
  "Yellow",
  "city market",
];

const EXCEL_HEADER_ALIASES: Record<ChainKey, string[]> = {
  "Dor Alon":    ["Dor Alon [shkel]", "Dor Alon", "דור אלון", "dor alon", "dor_alon"],
  "Hazi Hinam":  ["Hazi Hinam [shkel]", "Hazi Hinam", "חצי חינם", "hazi hinam", "hazi_hinam"],
  "Rami Levi":   ["Rami Levi [shkel]", "Rami Levi", "רמי לוי", "rami levi", "rami_levi"],
  "Shufersal":   ["Shufersal [shkel]", "Shufersal", "שופרסל", "shufersal"],
  "Super Yehuda":["Super Yehuda [shkel]", "Super Yehuda", "סופר יהודה", "super yehuda", "super_yehuda"],
  "Tiv Taam":    ["Tiv Taam [shkel]", "Tiv Taam", "טיב טעם", "tiv taam", "tiv_taam"],
  "Yellow":      ["Yellow [shkel]", "Yellow", "yellow"],
  "Yohananof":   ["Yohananof [shkel]", "Yohananof", "יוחננוף", "yohananof"],
  "city market": ["city market [shkel]", "city market", "סיטי מרקט", "city market", "city_market"],
};

const ITEM_NAME_ALIASES = ["item_name", "item", "product", "שם מוצר", "שם"];

const OUT_FILE_BY_CHAIN: Record<ChainKey, string> = {
  "Rami Levi":    "rami_levy_sorted.tsv",
  "Shufersal":    "shufersal_sorted.tsv",
  "Tiv Taam":     "tiv_taam_sorted.tsv",
  "Yohananof":    "yohananof_sorted.tsv",
  "Dor Alon":     "dor_alon_sorted.tsv",
  "Hazi Hinam":   "hazi_hinam_sorted.tsv",
  "Super Yehuda": "super_yehuda_sorted.tsv",
  "Yellow":       "yellow_sorted.tsv",
  "city market":  "city_market_sorted.tsv",
};

function norm(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[״"׳']/g, "")
    .replace(/[\u05BE\u05F3\u05F4]/g, " ")
    .replace(/[^\p{L}\p{N}\s.×x%–-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNum(x: unknown): number | null {
  if (x == null) return null;
  const s = String(x).replace("₪", "").replace(",", "").trim();
  const clean = s.replace(/[^\d.]/g, "");
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
}

function chainFilename(chain: ChainKey): string {
  return OUT_FILE_BY_CHAIN[chain];
}

function resolveItemHeader(headers: string[]): string | null {
  const hNorm = headers.map(norm);
  for (const alias of ITEM_NAME_ALIASES) {
    const idx = hNorm.indexOf(norm(alias));
    if (idx >= 0) return headers[idx];
  }
  // fallback: first column
  return headers.length ? headers[0] : null;
}

function resolveHeaderForChain(headers: string[], chain: ChainKey): string | null {
  const hNorm = headers.map(norm);
  // exact match on alias
  for (const alias of EXCEL_HEADER_ALIASES[chain]) {
    const idx = hNorm.indexOf(norm(alias));
    if (idx >= 0) return headers[idx];
  }
  // loose contains fallback
  const token = norm(chain);
  for (let i = 0; i < headers.length; i++) {
    if (hNorm[i].includes(token)) return headers[i];
  }
  return null;
}

function toTSV(rows: { item_name: string; itemprice: number }[]): string {
  const header = "item_name\titemprice";
  const lines = rows.map((r) => `${r.item_name}\t${r.itemprice}`);
  return [header, ...lines].join("\n") + "\n";
}

async function main() {
  const [input, outDir] = Deno.args;
  if (!input || !outDir) {
    console.error("Usage: deno run -A tools/csv_to_tsv.ts <input.csv> <out_dir>");
    Deno.exit(2);
  }

  await Deno.mkdir(outDir, { recursive: true });

  // Load CSV
  const csvText = await Deno.readTextFile(input);
  const rows = parse(csvText, { skipFirstRow: false, columns: true }) as Record<string, string>[];

  if (!rows.length) {
    console.error("❌ CSV is empty.");
    Deno.exit(1);
  }

  const headers = Object.keys(rows[0]);
  if (!headers.length) {
    console.error("❌ No headers detected.");
    Deno.exit(1);
  }

  const itemHeader = resolveItemHeader(headers);
  if (!itemHeader) {
    console.error("❌ Could not resolve item_name column.");
    Deno.exit(1);
  }

  // Map chain -> column name
  const headerByChain = new Map<ChainKey, string>();
  for (const chain of CHAINS) {
    const col = resolveHeaderForChain(headers, chain);
    if (col) headerByChain.set(chain, col);
  }

  if (headerByChain.size === 0) {
    console.error("❌ No chain columns resolved. Check your CSV headers.");
    console.error("   Detected headers:", headers);
    Deno.exit(1);
  }

  // Collect per-chain rows
  const perChain: Record<ChainKey, { item_name: string; itemprice: number }[]> = {
    "Rami Levi":   [],
    "Shufersal":   [],
    "Tiv Taam":    [],
    "Yohananof":   [],
    "Dor Alon":    [],
    "Hazi Hinam":  [],
    "Super Yehuda":[],
    "Yellow":      [],
    "city market": [],
  };

  for (const row of rows) {
    const itemRaw = String(row[itemHeader] ?? "").trim();
    if (!itemRaw) continue;

    for (const chain of CHAINS) {
      const col = headerByChain.get(chain);
      if (!col) continue;
      const val = row[col];
      const num = toNum(val);
      if (num == null) continue;
      perChain[chain].push({ item_name: itemRaw, itemprice: num });
    }
  }

  // Sort & write per-chain TSV
  for (const chain of CHAINS) {
    const arr = perChain[chain];
    if (!arr.length) continue;
    arr.sort((a, b) => a.item_name.localeCompare(b.item_name, "he"));
    const tsv = toTSV(arr);
    const path = `${outDir}/${chainFilename(chain)}`;
    await Deno.writeTextFile(path, tsv);
    console.log(`✔ ${chain}: ${arr.length} rows → ${path}`);
  }

  // Merged (optional)
  const merged: { item_name: string; itemprice: number; chain: ChainKey }[] = [];
  for (const chain of CHAINS) {
    for (const r of perChain[chain]) merged.push({ ...r, chain });
  }
  if (merged.length) {
    merged.sort((a, b) => {
      const n = a.item_name.localeCompare(b.item_name, "he");
      return n !== 0 ? n : a.chain.localeCompare(b.chain, "he");
    });
    const mergedTSV = ["item_name\titemprice\tchain", ...merged.map(r => `${r.item_name}\t${r.itemprice}\t${r.chain}`)].join("\n") + "\n";
    const mergedPath = `${outDir}/prices_merged_sorted.tsv`;
    await Deno.writeTextFile(mergedPath, mergedTSV);
    console.log(`✔ merged: ${merged.length} rows → ${mergedPath}`);
  }

  console.log("🎉 Done.");
}

if (import.meta.main) {
  main();
}
