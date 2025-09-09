// deno run -A scripts/build_products.ts
// יוצר public/products.json מאוסף קובצי TSV תחת public/data/
const DATA_DIR = "public/data";
const OUT_FILE = "public/products.json";

function detectDelim(line: string) {
  if (line.includes("\t")) return "\t";
  if (line.includes(",")) return ",";
  if (line.includes(";")) return ";";
  return "\t";
}
function smartSplit(line: string, delim: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (ch === '"'){ if (q && line[i+1] === '"'){ cur+='"'; i++; } else { q=!q; } }
    else if (ch === delim && !q){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur);
  return out.map(s=>s.trim());
}
function pickIndex(headers: string[], names: string[]) {
  const H = headers.map(h=>h.trim().toLowerCase());
  for (const n of names.map(x=>x.toLowerCase())) {
    const i = H.indexOf(n); if (i>=0) return i;
  }
  // חפש מכיל
  for (let i=0;i<H.length;i++){
    for (const n of names) if (H[i].includes(n.toLowerCase())) return i;
  }
  return -1;
}
function norm(s:string){ return (s||"").toLowerCase().replace(/[״"׳']/g,"").replace(/\s+/g," ").trim(); }
function guessSizeFromName(name: string, fallback?: string) {
  const s = name.toLowerCase();
  const mL = s.match(/(\d+(?:\.\d+)?)\s*l\b/);
  const mMl = s.match(/(\d{2,4})\s*ml\b/);
  const mKg = s.match(/(\d+(?:\.\d+)?)\s*kg\b/);
  const mG  = s.match(/(\d{2,4})\s*g\b/);
  if (mL) return mL[1]+"L";
  if (mMl) return (Number(mMl[1])/1000)+"L";
  if (mKg) return mKg[1]+"kg";
  if (mG)  return (Number(mG[1])/1000)+"kg";
  return fallback || "";
}

const entries = new Map<string, {
  id: string; label: string; canonical: string; default_size?: string; brand?: string; tags?: string[];
}>();

for await (const f of Deno.readDir(DATA_DIR)) {
  if (!f.isFile) continue;
  if (!/\.(tsv|csv)$/i.test(f.name)) continue;

  const raw = await Deno.readTextFile(`${DATA_DIR}/${f.name}`);
  const lines = raw.replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n").filter(Boolean);
  if (!lines.length) continue;
  const delim = detectDelim(lines[0]);
  const headers = smartSplit(lines[0], delim);

  const iName  = pickIndex(headers, ["item_name","name","שם","product"]);
  const iBrand = pickIndex(headers, ["brand","מותג"]);
  const iSize  = pickIndex(headers, ["size","נפח","גודל","משקל"]);

  for (let i=1;i<lines.length;i++){
    const cols = smartSplit(lines[i], delim);
    const name = (cols[iName] ?? "").trim();
    if (!name) continue;
    const brand = iBrand>=0 ? (cols[iBrand] ?? "").trim() : "";
    const size  = iSize>=0  ? (cols[iSize]  ?? "").trim() : "";

    const key = norm(name);
    if (entries.has(key)) continue;

    entries.set(key, {
      id: `p_${entries.size+1}`,
      label: name,
      canonical: name,
      default_size: guessSizeFromName(name, size || undefined) || undefined,
      brand: brand || undefined,
      tags: ["LocalDB"]
    });
  }
}

const arr = Array.from(entries.values()).sort((a,b)=> a.label.localeCompare(b.label,"he"));
await Deno.writeTextFile(OUT_FILE, JSON.stringify(arr, null, 2));
console.log(`Wrote ${arr.length} products to ${OUT_FILE}`);
